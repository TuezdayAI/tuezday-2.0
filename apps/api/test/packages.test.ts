import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
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
  angleHashOf,
  loadStoryRoutingContext,
} from "../src/services/opportunity-matching";
import { compileRoutingProfile } from "../src/services/routing-profiles";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

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

/** Generate-only fake that grounds claims in the offered SOURCE ids. */
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
  };
}

describe("package routes (Sprint 62)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: sufficiencyGateway() });
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
        payload: { name: "Category launch" },
      })
    ).json().id;
    const revision = await createPlanRevision(db, workspaceId, campaignId, planInput, {
      userId: null,
    });
    await upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
      ...laneInput,
      personaId,
    });
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedQualifiedOpportunity(title: string, angle: string): Promise<string> {
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
    const story = (await db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.title, title))
      .get())!;
    const profile = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const occurrenceIds = [...(await loadStoryRoutingContext(db, story)).activeOccurrenceIds];
    const id = randomUUID();
    const now = Date.now();
    await db.insert(campaignOpportunities)
      .values({
        id,
        workspaceId,
        canonicalStoryId: story.id,
        manualSignalId: null,
        campaignId,
        planRevisionId: profile.planRevisionId,
        routingProfileId: profile.id,
        status: "qualified",
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
      })
      .run();
    return id;
  }

  async function createPackage(title: string, angle: string) {
    const opportunityId = await seedQualifiedOpportunity(title, angle);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opportunityId}/package`,
    });
    expect(res.statusCode).toBe(201);
    return { opportunityId, detail: res.json() };
  }

  it("creates a package from a qualified opportunity and lists it", async () => {
    const { opportunityId, detail } = await createPackage("Route story", "Route angle");
    expect(detail.package.status).toBe("assessing");
    expect(detail.package.opportunityId).toBe(opportunityId);
    expect(detail.sources.map((s: { role: string }) => s.role).sort()).toEqual([
      "evidence",
      "trigger",
    ]);

    // Consuming is 1:1 — a second create is an invalid transition.
    const again = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opportunityId}/package`,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_transition");

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/packages`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    expect(list.json().packages[0].storyTitle).toBe("Route story");

    const missing = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${randomUUID()}/package`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("opportunity_not_found");
  });

  it("validates list query parameters", async () => {
    for (const query of ["?status=bogus", "?limit=0", "?limit=abc", "?offset=-1"]) {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/packages${query}`,
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    }
  });

  it("serves detail with 404 for unknown packages", async () => {
    const { detail } = await createPackage("Detail story", "Detail angle");
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    const missing = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/packages/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("package_not_found");
  });

  it("assesses synchronously, then reports not_due", async () => {
    const { detail } = await createPackage("Assess story", "Assess angle");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}/assess`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().package.status).toBe("ready");
    expect(res.json().package.latestVerdict).toBe("sufficient");
    expect(res.json().eligibility).toHaveLength(1);

    const again = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}/assess`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_due");
  });

  it("applies decisions through the machine with input validation", async () => {
    const { detail } = await createPackage("Decide story", "Decide angle");
    const noReason = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}/decision`,
      payload: { action: "cancel" },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe("invalid_input");

    const cancelled = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}/decision`,
      payload: { action: "cancel", reason: "not needed" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().package.status).toBe("cancelled");

    const illegal = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/${detail.package.id}/decision`,
      payload: { action: "reassess" },
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json().error).toBe("invalid_transition");
  });

  it("runs the bounded pipeline via the run route", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/packages/run`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      packagesCreated: 0,
      packagesAssessed: 0,
      failures: 0,
    });
  });

  it("keeps every package surface member-only", async () => {
    const { detail } = await createPackage("Guarded story", "Guarded angle");
    const outsider = await registerUser(app, "outsider@example.com");
    const stranger = asUser(app, outsider.token);
    const surfaces: Array<[string, string]> = [
      ["GET", `/workspaces/${workspaceId}/packages`],
      ["GET", `/workspaces/${workspaceId}/packages/${detail.package.id}`],
      ["POST", `/workspaces/${workspaceId}/packages/${detail.package.id}/decision`],
      ["POST", `/workspaces/${workspaceId}/packages/${detail.package.id}/assess`],
      ["POST", `/workspaces/${workspaceId}/packages/run`],
    ];
    for (const [method, url] of surfaces) {
      const res = await stranger.inject({
        method: method as "GET" | "POST",
        url,
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
