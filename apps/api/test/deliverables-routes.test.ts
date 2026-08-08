import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Channel } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  canonicalExternalStories,
  deliverables,
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
import { fanOutPackage } from "../src/services/deliverables";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

const RUN_OPTS = { limit: 10, leaseMs: 45_000, timeoutMs: 45_000 };

const planInput = {
  objective: "Build category awareness",
  kpi: "Conversations",
  timeframe: "Q3",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory"],
  offers: [],
  ctas: [],
  guidance: "",
};

const lane = {
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

/** One gateway serving both shapes: sufficiency JSON and plain drafts. */
function dualGateway(): LlmGateway {
  return {
    async generate(params: { prompt: string }) {
      if (params.prompt.includes("<<<SOURCES>>>")) {
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
      }
      return { text: "Drafted post", model: "fake", provider: "fake", durationMs: 1 };
    },
  } as LlmGateway;
}

describe("deliverable routes (Sprint 63)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;
  let packageId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db, llm: dualGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Routes" } })
    ).json().id;
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
        payload: { name: "Launch" },
      })
    ).json().id;
    const revision = await createPlanRevision(db, workspaceId, campaignId, planInput, {
      userId: null,
    });
    await upsertLaneRevision(db, workspaceId, campaignId, revision.id, { ...lane, personaId });
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);

    await db.transaction(async (tx) => {
      await recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title: "A story",
          url: `https://ex.com/${randomUUID()}`,
          summary: "Buyers report fatigue with generic outreach.",
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
        angle: "An angle",
        angleHash: angleHashOf("An angle"),
        workspaceRelevance: 85,
        campaignFit: 80,
        confidence: 75,
        actionability: 70,
        sourceTrust: 60,
        suggestedPersonaId: null,
        supportedClaimsJson: JSON.stringify([
          { claim: "Buyers dislike generic output.", occurrenceIds },
        ]),
        reason: "Fits.",
        matcherVersion: 1,
        policyJson: JSON.stringify({ band: "review", checks: [] }),
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      });
    packageId = await createPackageFromOpportunity(db, workspaceId, opportunityId, {
      userId: null,
    });
    await runPackageAssessments(db, dualGateway(), { workspaceId, ...RUN_OPTS });
  });

  afterEach(async () => {
    await app.close();
  });

  async function firstDeliverableId(): Promise<string> {
    return (await db.select().from(deliverables))[0]!.id;
  }

  it("fan-out route creates deliverables from a ready package; 400 otherwise", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${packageId}/fan-out`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deliverablesCreated: 1, skipped: [] });

    // Cancel the package, fan-out is no longer legal.
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${packageId}/decision`,
      payload: { action: "cancel", reason: "done" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${packageId}/fan-out`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_state");

    const missing = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${randomUUID()}/fan-out`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists, details, generates, and serves the snapshot over HTTP", async () => {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${packageId}/fan-out`,
    });
    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/deliverables?status=ready`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    const deliverableId = list.json().deliverables[0].id;

    const generated = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/generate`,
    });
    expect(generated.statusCode).toBe(200);
    const detail = generated.json();
    expect(detail.deliverable.status).toBe("candidate_ready");
    expect(detail.variants).toHaveLength(1);

    // Not due any more: 409.
    const again = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/generate`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_due");

    const snapshot = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/variants/${detail.variants[0].id}/snapshot`,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().resolvedContext.prompt).toContain("An angle");

    const badVariant = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/variants/${randomUUID()}/snapshot`,
    });
    expect(badVariant.statusCode).toBe(404);
  });

  it("validates decisions and enforces the machine over HTTP", async () => {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${packageId}/fan-out`,
    });
    const deliverableId = await firstDeliverableId();

    // Schema: select without variantId, cancel without reason.
    for (const payload of [{ action: "select" }, { action: "cancel" }]) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/decision`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    }

    // Machine: selecting before any candidate exists.
    const early = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/decision`,
      payload: { action: "select", variantId: randomUUID() },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toBe("invalid_transition");

    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/generate`,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}`,
    });
    const variantId = detail.json().variants[0].id;
    const selected = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/decision`,
      payload: { action: "select", variantId },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().deliverable.status).toBe("fulfilled");

    const cancelFulfilled = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/${deliverableId}/decision`,
      payload: { action: "cancel", reason: "too late" },
    });
    expect(cancelFulfilled.statusCode).toBe(400);
    expect(cancelFulfilled.json().error).toBe("invalid_transition");
  });

  it("runs the bounded pipeline via the run route", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/deliverables/run`,
    });
    expect(res.statusCode).toBe(200);
    // Fan-out and generation both happen inside one run.
    expect(res.json()).toMatchObject({
      slotsMaterialized: 0,
      packagesFannedOut: 1,
      deliverablesCreated: 1,
      variantsGenerated: 1,
      staled: 0,
      failures: 0,
    });
  });

  it("hides workspaces and deliverables from non-members", async () => {
    await fanOutPackage(db, workspaceId, packageId, { userId: null });
    const deliverableId = await firstDeliverableId();
    const outsider = await registerUser(app, "outsider@example.com");
    for (const [method, url] of [
      ["GET", `/workspaces/${workspaceId}/deliverables`],
      ["GET", `/workspaces/${workspaceId}/deliverables/${deliverableId}`],
      ["POST", `/workspaces/${workspaceId}/deliverables/${deliverableId}/generate`],
      ["POST", `/workspaces/${workspaceId}/packages/${packageId}/fan-out`],
      ["POST", `/workspaces/${workspaceId}/deliverables/run`],
    ] as const) {
      const res = await asUser(app, outsider.token).inject({
        method,
        url,
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect([403, 404]).toContain(res.statusCode);
    }
  });
});
