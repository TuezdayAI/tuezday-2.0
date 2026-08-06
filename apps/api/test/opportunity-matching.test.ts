import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { CampaignRoutingProfile } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  campaignOpportunityEvents,
  canonicalExternalStories,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { recordOccurrenceAndResolve } from "../src/services/canonical-stories";
import {
  OPPORTUNITY_CANDIDATE_LIMIT,
  ROUTING_MAX_ATTEMPTS,
  applyRoutingPolicy,
  expireDueOpportunities,
  runOpportunityRouting,
  selectCandidateProfiles,
} from "../src/services/opportunity-matching";
import { updateRoutingPolicy } from "../src/services/routing-profiles";
import { buildAuthedApp, createTestDb } from "./helpers";

const RUN_OPTS = { limit: 10, leaseMs: 45_000, timeoutMs: 45_000 };

const planInput = {
  objective: "Build category awareness for GTM memory",
  kpi: "Qualified conversations",
  timeframe: "Q3",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory", "generic AI output"],
  offers: ["Product demo"],
  ctas: ["Book a demo"],
  guidance: "Use customer evidence.",
};

const laneInput = {
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "",
  audienceId: null,
  channel: "linkedin" as const,
  format: "linkedin_post",
  publishingConnectionId: null,
  providerTarget: "feed",
  deliveryMode: "planned" as const,
  plannedQuantity: 2,
  schedule: { daysOfWeek: [2, 4], timeOfDay: "10:00", timezone: "Asia/Kolkata" },
  reactivePeriod: null,
  reactiveCap: null,
  status: "active" as const,
};

type MatcherHandler = (prompt: string, campaignIds: string[], occurrenceIds: string[]) => unknown;

/** Generate-only fake: generateStructured falls back to text + zod parse. */
function matcherGateway(handler: MatcherHandler): LlmGateway & { calls: number } {
  const gateway = {
    calls: 0,
    async generate(params: { prompt: string }) {
      gateway.calls += 1;
      const campaignIds = [...params.prompt.matchAll(/CAMPAIGN ([0-9a-f-]{36}):/g)].map(
        (m) => m[1]!,
      );
      const occurrenceIds =
        params.prompt
          .match(/OCCURRENCE IDS: (.+)/)?.[1]
          ?.split(", ")
          .filter((id) => id !== "") ?? [];
      return {
        text: JSON.stringify(handler(params.prompt, campaignIds, occurrenceIds)),
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
  return gateway as LlmGateway & { calls: number };
}

function relevantEntry(campaignId: string, overrides: Record<string, unknown> = {}) {
  return {
    campaignId,
    relevant: true,
    workspaceRelevance: 85,
    campaignFit: 80,
    confidence: 75,
    actionability: 70,
    angle: `Angle for ${campaignId.slice(0, 8)}`,
    supportedClaims: [],
    suggestedPersonaId: null,
    expiresInDays: 7,
    reason: "Fits the pillar.",
    ...overrides,
  };
}

function makeProfile(overrides: {
  campaignId?: string;
  pillars?: string[];
  exclusions?: string[];
  endAt?: number | null;
}): CampaignRoutingProfile {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    campaignId: overrides.campaignId ?? randomUUID(),
    planRevisionId: randomUUID(),
    profileVersion: 1,
    profileFingerprint: "fp",
    routingBand: "review",
    minFit: 70,
    minConfidence: 60,
    minTrust: 0,
    compilerVersion: 1,
    payload: {
      campaignName: "Campaign",
      objective: "",
      kpi: "",
      timeframe: "",
      startAt: null,
      endAt: overrides.endAt ?? null,
      audiences: [],
      pillars: overrides.pillars ?? [],
      offers: [],
      ctas: [],
      guidance: "",
      personaIds: [],
      channels: [],
      formats: [],
      exclusions: overrides.exclusions ?? [],
    },
    createdAt: 1,
  };
}

describe("stage-1 candidate retrieval", () => {
  const storyText = "Buyers hate generic AI output and forget GTM memory";

  it("ranks by lexical overlap and caps the candidate set", () => {
    const strong = makeProfile({ pillars: ["generic AI output", "GTM memory"] });
    const medium = makeProfile({ pillars: ["GTM memory"] });
    const weak1 = makeProfile({ pillars: ["buyers"] });
    const weak2 = makeProfile({ pillars: ["unrelated topic"] });
    const selected = selectCandidateProfiles(
      [weak2, weak1, medium, strong],
      storyText,
      Date.now(),
    );
    expect(selected).toHaveLength(OPPORTUNITY_CANDIDATE_LIMIT);
    expect(selected[0]!.id).toBe(strong.id);
    expect(selected[1]!.id).toBe(medium.id);
  });

  it("applies hard exclusions and timeframe filters before ranking", () => {
    const excluded = makeProfile({ pillars: ["GTM memory"], exclusions: ["generic ai"] });
    const ended = makeProfile({ pillars: ["GTM memory"], endAt: Date.now() - 1 });
    const live = makeProfile({ pillars: ["GTM memory"] });
    const selected = selectCandidateProfiles([excluded, ended, live], storyText, Date.now());
    expect(selected.map((p) => p.id)).toEqual([live.id]);
  });
});

describe("policy-band disposition", () => {
  const scores = { campaignFit: 80, confidence: 75, sourceTrust: 60 };

  it("caps review-band dispositions at needs_review", () => {
    const profile = makeProfile({});
    expect(applyRoutingPolicy(profile, scores, undefined).status).toBe("needs_review");
    expect(
      applyRoutingPolicy(profile, { ...scores, campaignFit: 40 }, undefined).status,
    ).toBe("watchlisted");
  });

  it("auto-qualifies only when fit, confidence, and trust all clear", () => {
    const profile = { ...makeProfile({}), routingBand: "auto_package" as const };
    expect(applyRoutingPolicy(profile, scores, undefined).status).toBe("auto_qualified");
    expect(
      applyRoutingPolicy(profile, { ...scores, confidence: 30 }, undefined).status,
    ).toBe("needs_review");
    expect(
      applyRoutingPolicy(
        { ...profile, minTrust: 90 },
        scores,
        undefined,
      ).status,
    ).toBe("needs_review");
    expect(
      applyRoutingPolicy(profile, { ...scores, campaignFit: 10 }, undefined).status,
    ).toBe("watchlisted");
  });

  it("dismisses on exclusion hits with the check recorded", () => {
    const result = applyRoutingPolicy(makeProfile({}), scores, "crypto");
    expect(result.status).toBe("dismissed");
    expect(result.policy.checks[0]).toMatchObject({
      rule: "exclusion:crypto",
      passed: false,
    });
  });
});

describe("opportunity routing (Sprint 61)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignA: string;
  let campaignB: string;
  let personaId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({
      db,
      llm: matcherGateway(() => []),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Routing" } })
    ).json().id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
    campaignA = await createCampaign("Category launch");
    campaignB = await createCampaign("Evergreen founder voice");
    activatePlan(campaignA);
    activatePlan(campaignB, { pillars: ["founder lessons", "GTM memory"] });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createCampaign(name: string): Promise<string> {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name },
      })
    ).json().id;
  }

  function activatePlan(campaignId: string, overrides: Partial<typeof planInput> = {}) {
    const revision = createPlanRevision(
      db,
      workspaceId,
      campaignId,
      { ...planInput, ...overrides },
      { userId: null },
    );
    upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
      ...laneInput,
      personaId,
    });
    activatePlanRevision(db, workspaceId, campaignId, revision.id);
    return revision;
  }

  function seedStory(title: string, url: string): string {
    db.transaction((tx) => {
      recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title,
          url,
          summary: "Discussion about generic AI output and GTM memory.",
          publishedAt: null,
        },
        observedAt: Date.now(),
      });
    });
    return db
      .select({ id: canonicalExternalStories.id })
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.title, title))
      .get()!.id;
  }

  function storyRow(storyId: string) {
    return db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, storyId))
      .get()!;
  }

  function opportunitiesFor(storyId: string) {
    return db
      .select()
      .from(campaignOpportunities)
      .where(eq(campaignOpportunities.canonicalStoryId, storyId))
      .orderBy(asc(campaignOpportunities.createdAt), asc(campaignOpportunities.id))
      .all();
  }

  it("creates independent per-campaign opportunities and is idempotent", async () => {
    const storyId = seedStory("Buyers hate generic AI output", "https://ex.com/a");
    const llm = matcherGateway((_prompt, campaignIds) =>
      campaignIds.map((id) => relevantEntry(id)),
    );

    const run = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run.storiesRouted).toBe(1);
    expect(run.opportunitiesCreated).toBe(2);
    const rows = opportunitiesFor(storyId);
    expect(rows.map((r) => r.campaignId).sort()).toEqual([campaignA, campaignB].sort());
    // Default review band, fit 80 >= 70 → needs_review; judgment immutable.
    expect(rows.every((r) => r.status === "needs_review")).toBe(true);
    expect(rows.every((r) => r.matcherVersion === 1)).toBe(true);
    expect(storyRow(storyId).routingState).toBe("routed");

    // Creation + policy events per opportunity.
    const events = db
      .select()
      .from(campaignOpportunityEvents)
      .where(eq(campaignOpportunityEvents.opportunityId, rows[0]!.id))
      .orderBy(asc(campaignOpportunityEvents.createdAt))
      .all()
      // Same-millisecond pair: creation (fromStatus null) sorts first.
      .sort((a, b) => Number(a.fromStatus !== null) - Number(b.fromStatus !== null));
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "candidate"],
      ["candidate", "needs_review"],
    ]);

    // Unchanged inputs: nothing due, no second LLM call.
    const again = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(again.storiesConsidered).toBe(0);
    expect(llm.calls).toBe(1);
  });

  it("routes with no LLM call when no campaign is eligible", async () => {
    updateRoutingPolicy(db, workspaceId, campaignA, { band: "off" });
    updateRoutingPolicy(db, workspaceId, campaignB, { band: "off" });
    const storyId = seedStory("Off-band story", "https://ex.com/off");
    const llm = matcherGateway(() => []);
    const run = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run.storiesRouted).toBe(1);
    expect(llm.calls).toBe(0);
    expect(opportunitiesFor(storyId)).toEqual([]);
    expect(storyRow(storyId).routingState).toBe("routed");
  });

  it("applies auto_package disposition from the profile snapshot", async () => {
    updateRoutingPolicy(db, workspaceId, campaignA, { band: "auto_package" });
    updateRoutingPolicy(db, workspaceId, campaignB, { band: "off" });
    const storyId = seedStory("Auto-band story about GTM memory", "https://ex.com/auto");
    const llm = matcherGateway((_prompt, campaignIds) =>
      campaignIds.map((id) => relevantEntry(id)),
    );
    await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    const row = opportunitiesFor(storyId)[0]!;
    // fit 80 ≥ 70, confidence 75 ≥ 60, trust 60 ≥ 0 → auto_qualified.
    expect(row.status).toBe("auto_qualified");
    expect(JSON.parse(row.policyJson).band).toBe("auto_package");
  });

  it("keeps LLM failures retryable and never stores a no-match", async () => {
    const storyId = seedStory("Failure story about GTM memory", "https://ex.com/fail");
    // Invented campaign ID passes the schema but fails §9.2 validation.
    const llm = matcherGateway(() => [relevantEntry(randomUUID())]);

    for (let attempt = 1; attempt <= ROUTING_MAX_ATTEMPTS; attempt += 1) {
      const run = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
      expect(run.failures).toBe(1);
      expect(run.storiesRouted).toBe(0);
      const story = storyRow(storyId);
      expect(story.routingAttempts).toBe(attempt);
      expect(story.routingState).toBe(attempt < ROUTING_MAX_ATTEMPTS ? "pending" : "failed");
    }
    expect(opportunitiesFor(storyId)).toEqual([]);
    // Exhausted for this fingerprint: no further claims until inputs change.
    const after = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(after.storiesConsidered).toBe(0);
  });

  it("treats invented occurrence IDs and malformed output as retryable", async () => {
    const storyId = seedStory("Claim story about GTM memory", "https://ex.com/claims");
    const badClaims = matcherGateway((_prompt, campaignIds) => [
      relevantEntry(campaignIds[0]!, {
        supportedClaims: [{ claim: "Made up", occurrenceIds: [randomUUID()] }],
      }),
    ]);
    let run = await runOpportunityRouting(db, badClaims, { workspaceId, ...RUN_OPTS });
    expect(run.failures).toBe(1);
    expect(storyRow(storyId).routingState).toBe("pending");

    const malformed: LlmGateway = {
      async generate() {
        return { text: "not json at all", model: "fake", provider: "fake", durationMs: 1 };
      },
    };
    run = await runOpportunityRouting(db, malformed, { workspaceId, ...RUN_OPTS });
    expect(run.failures).toBe(1);
    expect(storyRow(storyId).routingState).toBe("pending");
    expect(opportunitiesFor(storyId)).toEqual([]);
  });

  it("validates suggested personas against the profile and stores claims", async () => {
    updateRoutingPolicy(db, workspaceId, campaignB, { band: "off" });
    const storyId = seedStory("Persona story about GTM memory", "https://ex.com/persona");
    const llm = matcherGateway((_prompt, campaignIds, occurrenceIds) => [
      relevantEntry(campaignIds[0]!, {
        suggestedPersonaId: personaId,
        supportedClaims: [{ claim: "Buyers complain", occurrenceIds }],
      }),
    ]);
    await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    const row = opportunitiesFor(storyId)[0]!;
    expect(row.suggestedPersonaId).toBe(personaId);
    expect(JSON.parse(row.supportedClaimsJson)[0].claim).toBe("Buyers complain");

    // An unknown persona is nulled, not failed — it is a recommendation only.
    const storyId2 = seedStory("Persona story two about GTM memory", "https://ex.com/persona2");
    const llm2 = matcherGateway((_prompt, campaignIds) => [
      relevantEntry(campaignIds[0]!, { suggestedPersonaId: randomUUID() }),
    ]);
    await runOpportunityRouting(db, llm2, { workspaceId, ...RUN_OPTS });
    expect(opportunitiesFor(storyId2)[0]!.suggestedPersonaId).toBeNull();
  });

  it("supersedes open opportunities when a newer plan revision decides", async () => {
    updateRoutingPolicy(db, workspaceId, campaignB, { band: "off" });
    const storyId = seedStory("Supersede story about GTM memory", "https://ex.com/supersede");
    const llm = matcherGateway((_prompt, campaignIds) =>
      campaignIds.map((id) => relevantEntry(id)),
    );
    await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    const first = opportunitiesFor(storyId)[0]!;
    expect(first.status).toBe("needs_review");

    // New plan revision → profile drift → story re-queued and re-decided.
    activatePlan(campaignA, { pillars: ["GTM memory", "proof"] });
    const run = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run.storiesRouted).toBe(1);
    const rows = opportunitiesFor(storyId);
    const superseded = rows.find((r) => r.id === first.id)!;
    const fresh = rows.find((r) => r.id !== first.id)!;
    expect(superseded.status).toBe("superseded");
    expect(fresh.status).toBe("needs_review");
    expect(fresh.planRevisionId).not.toBe(first.planRevisionId);
  });

  it("holds one open decision per story×campaign×revision (drift-noise control)", async () => {
    updateRoutingPolicy(db, workspaceId, campaignB, { band: "off" });
    const storyId = seedStory("Noise story about GTM memory", "https://ex.com/noise");
    let angleSuffix = "one";
    const llm = matcherGateway((_prompt, campaignIds) => [
      relevantEntry(campaignIds[0]!, { angle: `Different angle ${angleSuffix}` }),
    ]);
    await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    // Membership change (new corroborating occurrence) drifts the fingerprint.
    db.transaction((tx) => {
      recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed 2" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title: "Noise story about GTM memory",
          url: "https://ex.com/noise",
          summary: "Discussion about generic AI output and GTM memory.",
          publishedAt: null,
        },
        observedAt: Date.now(),
      });
    });
    angleSuffix = "two";
    const run = await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run.storiesRouted).toBe(1);
    // The open needs_review decision stands; no near-duplicate angle row.
    expect(opportunitiesFor(storyId)).toHaveLength(1);
  });

  it("expires open opportunities past their expiry and leaves dismissed alone", async () => {
    const storyId = seedStory("Expiry story about GTM memory", "https://ex.com/expiry");
    const llm = matcherGateway((_prompt, campaignIds) =>
      campaignIds.map((id) => relevantEntry(id)),
    );
    await runOpportunityRouting(db, llm, { workspaceId, ...RUN_OPTS });
    const rows = opportunitiesFor(storyId);
    const past = Date.now() - 60_000;
    db.update(campaignOpportunities)
      .set({ expiresAt: past })
      .where(eq(campaignOpportunities.id, rows[0]!.id))
      .run();
    db.update(campaignOpportunities)
      .set({ expiresAt: past, status: "dismissed" })
      .where(eq(campaignOpportunities.id, rows[1]!.id))
      .run();

    expect(expireDueOpportunities(db, workspaceId)).toBe(1);
    const after = opportunitiesFor(storyId);
    expect(after.find((r) => r.id === rows[0]!.id)!.status).toBe("expired");
    expect(after.find((r) => r.id === rows[1]!.id)!.status).toBe("dismissed");
  });
});
