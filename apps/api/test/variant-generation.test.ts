import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Channel } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  canonicalExternalStories,
  contextSnapshots,
  deliverables,
  variants,
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
import { createPackageFromOpportunity } from "../src/services/content-packages";
import { compileRoutingProfile } from "../src/services/routing-profiles";
import { runPackageAssessments } from "../src/services/sufficiency";
import {
  decideDeliverable,
  fanOutPackage,
  getDeliverableDetail,
  getVariantSnapshot,
} from "../src/services/deliverables";
import {
  GENERATION_MAX_ATTEMPTS,
  runDeliverablePipeline,
  runVariantGeneration,
} from "../src/services/variant-generation";
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

const reactiveLane = {
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "",
  audienceId: null,
  channel: "linkedin" as Channel,
  format: "linkedin_post",
  publishingConnectionId: null,
  providerTarget: "feed",
  deliveryMode: "reactive" as const,
  plannedQuantity: 0,
  schedule: null,
  reactivePeriod: "week" as const,
  reactiveCap: 5,
  status: "active" as const,
};

function sufficiencyGateway(): LlmGateway {
  return {
    async generate(params: { prompt: string }) {
      const sourceIds = [...params.prompt.matchAll(/SOURCE ([0-9a-f-]{36}) \(/g)].map(
        (m) => m[1]!,
      );
      return {
        text: JSON.stringify({
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
        }),
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  } as LlmGateway;
}

/** Plain text generator; records every prompt it saw. */
function draftGateway(
  behavior: { fail?: boolean } = {},
): LlmGateway & { prompts: string[] } {
  const gateway = {
    prompts: [] as string[],
    async generate(params: { prompt: string }) {
      gateway.prompts.push(params.prompt);
      if (behavior.fail) throw new Error("gateway down");
      return {
        text: `Drafted post #${gateway.prompts.length}`,
        model: "fake-model",
        provider: "fake",
        durationMs: 7,
      };
    },
  };
  return gateway as unknown as LlmGateway & { prompts: string[] };
}

describe("variant generation & context snapshots (Sprint 63)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;
  let userId: string;
  let deliverableId: string;
  let packageId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Variants" } })
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

    const revision = await createPlanRevision(db, workspaceId, campaignId, planInput, {
      userId: null,
    });
    await upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
      ...reactiveLane,
      personaId,
    });
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);

    // Story → opportunity → package → assessed ready → fanned out.
    await db.transaction(async (tx) => {
      await recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title: "Generic AI output frustrates GTM teams",
          url: `https://ex.com/${randomUUID()}`,
          summary: "Buyers report fatigue with generic AI-generated outreach.",
          publishedAt: null,
        },
        observedAt: Date.now(),
      });
    });
    const story = (await db.select().from(canonicalExternalStories))[0]!;
    const profile = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const occurrenceIds = [...(await loadStoryRoutingContext(db, story)).activeOccurrenceIds];
    const opportunityId = randomUUID();
    const now = Date.now();
    await db.insert(campaignOpportunities)
      .values({
        id: opportunityId,
        workspaceId,
        canonicalStoryId: story.id,
        manualSignalId: null,
        campaignId,
        planRevisionId: profile.planRevisionId,
        routingProfileId: profile.id,
        status: "qualified",
        angle: "Position against generic AI output",
        angleHash: angleHashOf("Position against generic AI output"),
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
    packageId = await createPackageFromOpportunity(db, workspaceId, opportunityId, { userId });
    await runPackageAssessments(db, sufficiencyGateway(), { workspaceId, ...RUN_OPTS });
    await fanOutPackage(db, workspaceId, packageId, { userId });
    deliverableId = ((await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.packageId, packageId)))[0])!.id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function deliverableRow() {
    return ((await db.select().from(deliverables).where(eq(deliverables.id, deliverableId)))[0])!;
  }

  it("generates a variant with a full replayable context snapshot", async () => {
    const llm = draftGateway();
    const run = await runVariantGeneration(db, llm, { workspaceId, ...RUN_OPTS });
    expect(run).toMatchObject({ claimed: 1, generated: 1, failures: 0 });

    const row = await deliverableRow();
    expect(row.status).toBe("candidate_ready");
    expect(row.generationState).toBe("complete");
    expect(row.generatedAt).not.toBeNull();

    const detail = await getDeliverableDetail(db, workspaceId, deliverableId);
    expect(detail.variants).toHaveLength(1);
    const variant = detail.variants[0]!;
    expect(variant).toMatchObject({
      variantVersion: 1,
      status: "candidate",
      content: "Drafted post #1",
      model: "fake-model",
    });

    // The snapshot captures what the model saw: the resolved trace, the
    // prompt, and the grounding inputs.
    const snapshot = await getVariantSnapshot(db, workspaceId, deliverableId, variant.id);
    const resolved = snapshot.resolvedContext as {
      prompt: string;
      sections: Array<{ key: string; included: boolean }>;
    };
    expect(resolved.prompt).toBe(llm.prompts[0]);
    expect(resolved.sections.length).toBeGreaterThan(0);
    const inputs = snapshot.inputs as Record<string, unknown>;
    expect(inputs).toMatchObject({
      deliverableId,
      packageId,
      channel: "linkedin",
      format: "linkedin_post",
      taskType: "linkedin_post",
      angle: "Position against generic AI output",
    });
    expect(inputs["supportedClaims"]).toEqual(["Buyers dislike generic output."]);
    // The prompt carries the angle and the grounded claims.
    expect(resolved.prompt).toContain("Position against generic AI output");
    expect(resolved.prompt).toContain("Buyers dislike generic output.");

    // Event trail: … → generating → candidate_ready.
    expect(detail.events.map((event) => event.toStatus)).toEqual([
      "ready",
      "generating",
      "candidate_ready",
    ]);
  });

  it("regeneration appends the next version and never touches lineage", async () => {
    await runVariantGeneration(db, draftGateway(), { workspaceId, ...RUN_OPTS });
    await decideDeliverable(db, workspaceId, deliverableId, {
      action: "regenerate",
      actorUserId: userId,
    });
    expect((await deliverableRow()).generationState).toBe("pending");
    await runVariantGeneration(db, draftGateway(), { workspaceId, ...RUN_OPTS });

    const detail = await getDeliverableDetail(db, workspaceId, deliverableId);
    expect(detail.deliverable.status).toBe("candidate_ready");
    expect(detail.variants.map((variant) => variant.variantVersion)).toEqual([2, 1]);
    expect(detail.variants.every((variant) => variant.status === "candidate")).toBe(true);
    // Two snapshots, one per variant, both intact.
    expect(await db.select().from(contextSnapshots)).toHaveLength(2);
    expect(detail.variants[1]!.content).toBe("Drafted post #1");
  });

  it("select fulfills the deliverable and supersedes sibling candidates", async () => {
    await runVariantGeneration(db, draftGateway(), { workspaceId, ...RUN_OPTS });
    await decideDeliverable(db, workspaceId, deliverableId, {
      action: "regenerate",
      actorUserId: userId,
    });
    await runVariantGeneration(db, draftGateway(), { workspaceId, ...RUN_OPTS });

    const before = await getDeliverableDetail(db, workspaceId, deliverableId);
    const winner = before.variants.find((variant) => variant.variantVersion === 2)!;
    const detail = await decideDeliverable(db, workspaceId, deliverableId, {
      action: "select",
      variantId: winner.id,
      actorUserId: userId,
    });
    expect(detail.deliverable.status).toBe("fulfilled");
    const byVersion = new Map(
      detail.variants.map((variant) => [variant.variantVersion, variant]),
    );
    expect(byVersion.get(2)).toMatchObject({ status: "selected" });
    expect(byVersion.get(2)!.selectedAt).not.toBeNull();
    expect(byVersion.get(1)).toMatchObject({ status: "superseded" });

    // Fulfilled history is immutable: no cancel, no regenerate, no reselect.
    for (const action of ["cancel", "regenerate", "select"] as const) {
      await expect((async () =>
        await decideDeliverable(db, workspaceId, deliverableId, {
          action,
          variantId: byVersion.get(1)!.id,
          reason: "nope",
          actorUserId: userId,
        }))(),
      ).rejects.toThrow();
    }
  });

  it("failure paths are retryable and park failed at the cap, with no variant stored", async () => {
    const failing = draftGateway({ fail: true });
    for (let attempt = 1; attempt <= GENERATION_MAX_ATTEMPTS; attempt += 1) {
      const run = await runVariantGeneration(db, failing, { workspaceId, ...RUN_OPTS });
      expect(run).toMatchObject({ claimed: 1, generated: 0, failures: 1 });
      const row = await deliverableRow();
      expect(row.status).toBe("ready");
      expect(row.generationAttempts).toBe(attempt);
      expect(row.generationState).toBe(
        attempt >= GENERATION_MAX_ATTEMPTS ? "failed" : "pending",
      );
    }
    // Parked: nothing claims it any more.
    const idle = await runVariantGeneration(db, draftGateway(), { workspaceId, ...RUN_OPTS });
    expect(idle.claimed).toBe(0);
    expect(await db.select().from(variants)).toHaveLength(0);
    expect(await db.select().from(contextSnapshots)).toHaveLength(0);

    // Operator regenerate resets the queue and generation succeeds.
    await decideDeliverable(db, workspaceId, deliverableId, {
      action: "regenerate",
      actorUserId: userId,
    });
    const revived = await runVariantGeneration(db, draftGateway(), {
      workspaceId,
      ...RUN_OPTS,
    });
    expect(revived.generated).toBe(1);
    expect((await deliverableRow()).status).toBe("candidate_ready");
  });

  it("runDeliverablePipeline reports each phase", async () => {
    // The seeded deliverable is pending generation; no planned lanes exist,
    // and the package already fanned out in setup.
    const result = await runDeliverablePipeline(db, draftGateway(), {
      workspaceId,
      limit: 10,
      leaseMs: 45_000,
      timeoutMs: 45_000,
    });
    expect(result).toMatchObject({
      slotsMaterialized: 0,
      packagesFannedOut: 0,
      deliverablesCreated: 0,
      variantsGenerated: 1,
      staled: 0,
      failures: 0,
    });
  });
});
