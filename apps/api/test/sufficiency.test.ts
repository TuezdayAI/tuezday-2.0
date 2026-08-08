import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  canonicalExternalStories,
  contentPackageEvents,
  contentPackages,
  laneEligibilityDecisions,
  sufficiencyAssessments,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { recordOccurrenceAndResolve } from "../src/services/canonical-stories";
import {
  angleHashOf,
  loadStoryRoutingContext,
} from "../src/services/opportunity-matching";
import {
  createPackageFromOpportunity,
  decidePackage,
  getPackageDetail,
} from "../src/services/content-packages";
import { compileRoutingProfile, updateRoutingPolicy } from "../src/services/routing-profiles";
import {
  ASSESSMENT_MAX_ATTEMPTS,
  runPackageAssessments,
  runPackagePipeline,
} from "../src/services/sufficiency";
import { buildAuthedApp, createTestDb } from "./helpers";

const RUN_OPTS = { limit: 10, leaseMs: 45_000, timeoutMs: 45_000 };

const planInput = {
  objective: "Build category awareness for GTM memory",
  kpi: "Qualified conversations",
  timeframe: "Q3",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory"],
  offers: ["Product demo"],
  ctas: ["Book a demo"],
  guidance: "Use customer evidence.",
};

const laneInput = {
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "",
  audienceId: null,
  // Widened so per-test lane overrides may use other channels.
  channel: "linkedin" as import("@tuezday/contracts").Channel,
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

type SufficiencyHandler = (prompt: string, sourceIds: string[]) => unknown;

/** Generate-only fake: generateStructured falls back to text + zod parse. */
function sufficiencyGateway(
  handler: SufficiencyHandler,
): LlmGateway & { calls: number } {
  const gateway = {
    calls: 0,
    async generate(params: { prompt: string }) {
      gateway.calls += 1;
      const sourceIds = [...params.prompt.matchAll(/SOURCE ([0-9a-f-]{36}) \(/g)].map(
        (m) => m[1]!,
      );
      return {
        text: JSON.stringify(await handler(params.prompt, sourceIds)),
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
  return gateway as LlmGateway & { calls: number };
}

function sufficientResponse(sourceIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    sufficient: true,
    confidence: 80,
    supportedClaims: [
      { claim: "Buyers dislike generic output.", sourceIds: sourceIds.slice(0, 1) },
    ],
    missingFacts: [],
    missingMedia: [],
    eligibleFormats: ["linkedin_post"],
    ineligibleFormats: [],
    researchActions: [],
    ...overrides,
  };
}

describe("sufficiency & lane eligibility (Sprint 62)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;
  let userId: string;
  let planRevisionId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({
      db,
      llm: sufficiencyGateway(() => ({ sufficient: false })),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Sufficiency" } })
    ).json().id;
    userId = (await app.inject({ method: "GET", url: "/auth/me" })).json().user.id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Category launch" },
      })
    ).json().id;
    planRevisionId = await activatePlan([{ ...laneInput }]);
  });

  afterEach(async () => {
    await app.close();
  });

  async function activatePlan(lanes: Array<typeof laneInput>): Promise<string> {
    const revision = await createPlanRevision(
      db,
      workspaceId,
      campaignId,
      planInput,
      { userId: null },
    );
    for (const lane of lanes) {
      await upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
        ...lane,
        personaId,
      });
    }
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);
    return revision.id;
  }

  async function seedStory(title: string): Promise<string> {
    await db.transaction(async (tx) => {
      await recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title,
          url: `https://ex.com/${randomUUID()}`,
          summary: "Discussion about generic AI output and GTM memory.",
          publishedAt: null,
        },
        observedAt: Date.now(),
      });
    });
    return ((await db
      .select({ id: canonicalExternalStories.id })
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.title, title)))[0])!.id;
  }

  async function seedOpportunity(
    storyId: string,
    angle: string,
    status: "qualified" | "auto_qualified" = "qualified",
  ): Promise<string> {
    const profile = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const story = ((await db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, storyId)))[0])!;
    const occurrenceIds = [...(await loadStoryRoutingContext(db, story)).activeOccurrenceIds];
    const id = randomUUID();
    const now = Date.now();
    await db.insert(campaignOpportunities)
      .values({
        id,
        workspaceId,
        canonicalStoryId: storyId,
        manualSignalId: null,
        campaignId,
        planRevisionId: profile.planRevisionId,
        routingProfileId: profile.id,
        status,
        angle,
        angleHash: angleHashOf(angle),
        workspaceRelevance: 85,
        campaignFit: 80,
        confidence: 75,
        actionability: 70,
        sourceTrust: 60,
        suggestedPersonaId: null,
        supportedClaimsJson: JSON.stringify([
          { claim: "Buyers dislike generic output.", occurrenceIds },
        ]),
        reason: "Fits the pillar.",
        matcherVersion: 1,
        policyJson: JSON.stringify({ band: "review", checks: [] }),
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
    return id;
  }

  async function seedPackage(title: string, angle: string): Promise<string> {
    const storyId = await seedStory(title);
    return await createPackageFromOpportunity(
      db,
      workspaceId,
      await seedOpportunity(storyId, angle),
      { userId },
    );
  }

  async function packageRow(packageId: string) {
    return ((await db
      .select()
      .from(contentPackages)
      .where(eq(contentPackages.id, packageId)))[0])!;
  }

  it("assesses a sufficient package into ready with eligibility recorded", async () => {
    const packageId = await seedPackage("Sufficient story", "A grounded angle");
    const llm = sufficiencyGateway((_prompt, sourceIds) => sufficientResponse(sourceIds));

    const run = await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run).toMatchObject({ assessed: 1, failures: 0 });

    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("ready");
    expect(detail.package.assessmentState).toBe("complete");
    expect(detail.package.latestVerdict).toBe("sufficient");
    expect(detail.assessments).toHaveLength(1);
    expect(detail.assessments[0]!.verdict).toBe("sufficient");
    expect(detail.assessments[0]!.supportedClaims).toHaveLength(1);

    expect(detail.eligibility).toHaveLength(1);
    const decision = detail.eligibility[0]!;
    expect(decision.eligible).toBe(true);
    expect(decision.format).toBe("linkedin_post");
    expect(decision.checks.every((c) => c.passed)).toBe(true);

    expect(detail.events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "assessing"],
      ["assessing", "ready"],
    ]);

    // Nothing due afterwards — the queue is idempotent.
    const again = await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    expect(again.claimed).toBe(0);
    expect(llm.calls).toBe(1);
  });

  it("stores research_needed verdicts as domain state with research actions", async () => {
    const packageId = await seedPackage("Insufficient story", "An ungrounded angle");
    const llm = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds, {
        sufficient: false,
        missingFacts: ["Pricing numbers"],
        researchActions: ["Find the pricing announcement"],
      }),
    );
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("research_needed");
    expect(detail.assessments[0]!.missingFacts).toEqual(["Pricing numbers"]);
    expect(detail.assessments[0]!.researchActions).toEqual([
      "Find the pricing announcement",
    ]);
    // No lane evaluation happens for insufficient packages (§7 flow).
    expect(detail.eligibility).toEqual([]);
  });

  it("never stores sufficient without a validated supported claim", async () => {
    const packageId = await seedPackage("Claimless story", "A claimless angle");
    const llm = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds, { supportedClaims: [] }),
    );
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("research_needed");
    expect(detail.assessments[0]!.verdict).toBe("research_needed");
  });

  it("treats invented source ids as retryable, parking at failed after the cap", async () => {
    const packageId = await seedPackage("Invented story", "An invented angle");
    const llm = sufficiencyGateway(() =>
      sufficientResponse([], {
        supportedClaims: [{ claim: "Made up.", sourceIds: [randomUUID()] }],
      }),
    );
    for (let attempt = 1; attempt <= ASSESSMENT_MAX_ATTEMPTS; attempt += 1) {
      const run = await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
      expect(run.failures).toBe(1);
      const row = await packageRow(packageId);
      expect(row.assessmentAttempts).toBe(attempt);
      expect(row.assessmentState).toBe(
        attempt >= ASSESSMENT_MAX_ATTEMPTS ? "failed" : "pending",
      );
      // Never a stored judgment (invariant 2).
      expect(row.status).toBe("assessing");
    }
    expect(
      await db
        .select()
        .from(sufficiencyAssessments)
        .where(eq(sufficiencyAssessments.packageId, packageId)),
    ).toEqual([]);
    // failed is infra-terminal until an operator reassess resets the queue.
    const parked = await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    expect(parked.claimed).toBe(0);
    await decidePackage(db, workspaceId, packageId, {
      action: "reassess",
      actorUserId: userId,
    });
    const reset = await packageRow(packageId);
    expect(reset.assessmentState).toBe("pending");
    expect(reset.assessmentAttempts).toBe(0);
  });

  it("treats malformed model output as retryable", async () => {
    const packageId = await seedPackage("Broken story", "A broken angle");
    const llm: LlmGateway = {
      async generate() {
        return { text: "not json at all", model: "fake", provider: "fake", durationMs: 1 };
      },
    };
    const run = await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run.failures).toBe(1);
    expect((await packageRow(packageId)).assessmentState).toBe("pending");
  });

  it("blocks media-requiring and unregistered formats with recorded rules", async () => {
    // A fresh plan revision with three lanes: one supported, one carousel
    // (requires media), one unregistered free-string format.
    planRevisionId = await activatePlan([
      { ...laneInput },
      {
        ...laneInput,
        key: "ig-carousel",
        name: "IG carousel",
        channel: "instagram" as const,
        format: "instagram_carousel",
      },
      {
        ...laneInput,
        key: "web-exotic",
        name: "Exotic",
        channel: "web" as const,
        format: "tiktok_video",
      },
    ]);
    const packageId = await seedPackage("Media story", "A media angle");
    const llm = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds, {
        eligibleFormats: ["linkedin_post", "instagram_carousel", "tiktok_video"],
      }),
    );
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("ready");
    expect(detail.eligibility).toHaveLength(3);
    const byFormat = new Map(detail.eligibility.map((d) => [d.format, d]));
    expect(byFormat.get("linkedin_post")!.eligible).toBe(true);
    const carousel = byFormat.get("instagram_carousel")!;
    expect(carousel.eligible).toBe(false);
    expect(
      carousel.checks.find((c) => c.rule === "media_available")!.passed,
    ).toBe(false);
    const exotic = byFormat.get("tiktok_video")!;
    expect(exotic.eligible).toBe(false);
    expect(
      exotic.checks.find((c) => c.rule === "format_registered")!.passed,
    ).toBe(false);
  });

  it("blocks the package when sufficiency clears no lane format", async () => {
    const packageId = await seedPackage("Blocked story", "A blocked angle");
    const llm = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds, { eligibleFormats: [] }),
    );
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("blocked");
    expect(detail.eligibility[0]!.eligible).toBe(false);
    expect(
      detail.eligibility[0]!.checks.find((c) => c.rule === "format_supported")!.passed,
    ).toBe(false);
    expect(detail.events.at(-1)).toMatchObject({
      fromStatus: "assessing",
      toStatus: "blocked",
    });
  });

  it("blocks a second package aiming the same angle at the same lane (§9.5)", async () => {
    const llm = sufficiencyGateway((_prompt, sourceIds) => sufficientResponse(sourceIds));
    const angle = "One angle to rule the lane";
    const first = await seedPackage("Repetition story A", angle);
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    expect((await packageRow(first)).status).toBe("ready");

    const second = await seedPackage("Repetition story B", angle);
    expect((await packageRow(second)).novelty).toBe(0);
    await runPackageAssessments(db, llm, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, second);
    expect(detail.package.status).toBe("blocked");
    expect(
      detail.eligibility[0]!.checks.find((c) => c.rule === "angle_novel_for_lane")!
        .passed,
    ).toBe(false);
  });

  it("auto-packages only auto_package-band campaigns (D-62.7)", async () => {
    const llm = sufficiencyGateway((_prompt, sourceIds) => sufficientResponse(sourceIds));
    const storyId = await seedStory("Auto story");
    const opportunityId = await seedOpportunity(storyId, "An auto angle", "auto_qualified");

    // Band review (default): the pipeline leaves auto_qualified untouched.
    let run = await runPackagePipeline(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run).toMatchObject({ packagesCreated: 0, packagesAssessed: 0 });

    await updateRoutingPolicy(db, workspaceId, campaignId, { band: "auto_package" });
    run = await runPackagePipeline(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run).toMatchObject({ packagesCreated: 1, packagesAssessed: 1, failures: 0 });

    const opportunity = ((await db
      .select()
      .from(campaignOpportunities)
      .where(eq(campaignOpportunities.id, opportunityId)))[0])!;
    expect(opportunity.status).toBe("package_created");
    const pkg = ((await db
      .select()
      .from(contentPackages)
      .where(eq(contentPackages.opportunityId, opportunityId)))[0])!;
    // System actor created it and the assessment already ran.
    expect(pkg.createdByUserId).toBeNull();
    expect(pkg.status).toBe("ready");
  });

  it("supports the reassess loop after research_needed (D-62.9)", async () => {
    const packageId = await seedPackage("Loop story", "A loop angle");
    const insufficient = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds, { sufficient: false }),
    );
    await runPackageAssessments(db, insufficient, { workspaceId, ...RUN_OPTS });
    expect((await packageRow(packageId)).status).toBe("research_needed");

    await decidePackage(db, workspaceId, packageId, {
      action: "reassess",
      actorUserId: userId,
    });
    expect((await packageRow(packageId)).status).toBe("assessing");

    const sufficient = sufficiencyGateway((_prompt, sourceIds) =>
      sufficientResponse(sourceIds),
    );
    await runPackageAssessments(db, sufficient, { workspaceId, ...RUN_OPTS });
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("ready");
    // Versioned, append-only history: both assessments retained.
    expect(detail.assessments.map((a) => a.assessmentVersion)).toEqual([2, 1]);
    // The second assessment re-evaluated eligibility independently.
    expect(
      await db
        .select()
        .from(laneEligibilityDecisions)
        .where(eq(laneEligibilityDecisions.packageId, packageId))
        .orderBy(asc(laneEligibilityDecisions.createdAt)),
    ).toHaveLength(1);
  });
});
