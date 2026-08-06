import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  campaignRoutingProfileSchema,
  listOpportunitiesResponseSchema,
  opportunityDetailSchema,
  opportunityMatchRunResultSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { canonicalExternalStories } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { recordOccurrenceAndResolve } from "../src/services/canonical-stories";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

const planInput = {
  objective: "Build category awareness for GTM memory",
  kpi: "Qualified conversations",
  timeframe: "Q3",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory", "generic AI output"],
  offers: [],
  ctas: [],
  guidance: "",
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

/** Marks every candidate campaign relevant with a per-campaign angle. */
const routingLlm: LlmGateway = {
  async generate(params: { prompt: string }) {
    const campaignIds = [...params.prompt.matchAll(/CAMPAIGN ([0-9a-f-]{36}):/g)].map(
      (m) => m[1]!,
    );
    return {
      text: JSON.stringify(
        campaignIds.map((campaignId) => ({
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
        })),
      ),
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  },
};

describe("opportunity routes (Sprint 61)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignA: string;
  let campaignB: string;
  let personaId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: routingLlm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Opps" } })
    ).json().id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
    campaignA = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Category launch" },
      })
    ).json().id;
    campaignB = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Founder voice" },
      })
    ).json().id;
    for (const campaignId of [campaignA, campaignB]) {
      const revision = createPlanRevision(db, workspaceId, campaignId, planInput, {
        userId: null,
      });
      upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
        ...laneInput,
        personaId,
      });
      activatePlanRevision(db, workspaceId, campaignId, revision.id);
    }
  });

  afterEach(async () => {
    await app.close();
  });

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

  async function runMatch() {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/match`,
    });
    expect(res.statusCode).toBe(200);
    return opportunityMatchRunResultSchema.parse(res.json());
  }

  it("runs a founder-triggered match and lists campaign-scoped opportunities", async () => {
    seedStory("Buyers hate generic AI output", "https://ex.com/a");
    const run = await runMatch();
    expect(run.storiesRouted).toBe(1);
    expect(run.opportunitiesCreated).toBe(2);

    const list = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/opportunities`,
        })
      ).json(),
    );
    expect(list.total).toBe(2);
    expect(list.opportunities.map((o) => o.campaignId).sort()).toEqual(
      [campaignA, campaignB].sort(),
    );
    expect(list.opportunities[0]!.storyTitle).toBe("Buyers hate generic AI output");
    expect(list.opportunities[0]!.campaignName).toBeTruthy();

    const filtered = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/opportunities?campaignId=${campaignA}&status=needs_review`,
        })
      ).json(),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.opportunities[0]!.campaignId).toBe(campaignA);
  });

  it("validates list query input (Sprint 60 lesson)", async () => {
    for (const query of ["status=bogus", "limit=0", "limit=1.5", "offset=-1", "limit=abc"]) {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/opportunities?${query}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    }
  });

  it("serves detail with the exact profile version and audit events", async () => {
    seedStory("Detail story about GTM memory", "https://ex.com/detail");
    await runMatch();
    const list = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/opportunities` })
      ).json(),
    );
    const detail = opportunityDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/opportunities/${list.opportunities[0]!.id}`,
        })
      ).json(),
    );
    expect(detail.profile.id).toBe(detail.opportunity.routingProfileId);
    expect(detail.events.map((e) => e.toStatus)).toEqual(["candidate", "needs_review"]);
    expect(detail.opportunity.policy.checks.length).toBeGreaterThan(0);

    const missing = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/opportunities/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("opportunity_not_found");
  });

  it("dismissing for one campaign never touches the other (§6.1)", async () => {
    seedStory("Independence story about GTM memory", "https://ex.com/indep");
    await runMatch();
    const list = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/opportunities` })
      ).json(),
    );
    const forA = list.opportunities.find((o) => o.campaignId === campaignA)!;
    const forB = list.opportunities.find((o) => o.campaignId === campaignB)!;

    const dismissed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${forA.id}/decision`,
      payload: { action: "dismiss", reason: "Off strategy for this campaign" },
    });
    expect(dismissed.statusCode).toBe(200);
    const detailA = opportunityDetailSchema.parse(dismissed.json());
    expect(detailA.opportunity.status).toBe("dismissed");
    expect(detailA.opportunity.decidedByUserId).not.toBeNull();
    expect(detailA.opportunity.decisionReason).toBe("Off strategy for this campaign");

    const detailB = opportunityDetailSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/opportunities/${forB.id}`,
        })
      ).json(),
    );
    expect(detailB.opportunity.status).toBe("needs_review");
  });

  it("enforces the transition machine and decision-input rules", async () => {
    seedStory("Transition story about GTM memory", "https://ex.com/transitions");
    await runMatch();
    const list = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/opportunities` })
      ).json(),
    );
    const opp = list.opportunities[0]!;

    // dismiss/reopen without a reason is rejected by the input schema.
    const noReason = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opp.id}/decision`,
      payload: { action: "dismiss" },
    });
    expect(noReason.statusCode).toBe(400);

    const qualified = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opp.id}/decision`,
      payload: { action: "qualify" },
    });
    expect(opportunityDetailSchema.parse(qualified.json()).opportunity.status).toBe(
      "qualified",
    );

    // qualified → watchlisted is not a legal edge.
    const illegal = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opp.id}/decision`,
      payload: { action: "watch" },
    });
    expect(illegal.statusCode).toBe(400);
    expect(illegal.json().error).toBe("invalid_transition");

    // dismissed → reopen (undo) works and lands back in needs_review.
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opp.id}/decision`,
      payload: { action: "dismiss", reason: "changed my mind" },
    });
    const reopened = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/opportunities/${opp.id}/decision`,
      payload: { action: "reopen", reason: "actually useful" },
    });
    expect(opportunityDetailSchema.parse(reopened.json()).opportunity.status).toBe(
      "needs_review",
    );
  });

  it("serves and updates the campaign routing profile", async () => {
    const missingCampaign = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/campaigns/${randomUUID()}/routing-profile`,
    });
    expect(missingCampaign.statusCode).toBe(404);
    expect(missingCampaign.json().error).toBe("campaign_not_found");

    const planless = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "No plan yet" },
      })
    ).json().id;
    const noPlan = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/campaigns/${planless}/routing-profile`,
    });
    expect(noPlan.statusCode).toBe(404);
    expect(noPlan.json().error).toBe("no_active_plan");

    const profile = campaignRoutingProfileSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/campaigns/${campaignA}/routing-profile`,
        })
      ).json(),
    );
    expect(profile.payload.pillars).toEqual(["GTM memory", "generic AI output"]);

    const patched = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/campaigns/${campaignA}/routing-policy`,
      payload: { band: "auto_package", minConfidence: 50, exclusions: ["crypto"] },
    });
    expect(patched.statusCode).toBe(200);
    const updated = campaignRoutingProfileSchema.parse(patched.json().profile);
    expect(updated.profileVersion).toBe(profile.profileVersion + 1);
    expect(updated.routingBand).toBe("auto_package");
    expect(updated.minConfidence).toBe(50);
    expect(updated.payload.exclusions).toEqual(["crypto"]);

    const badPatch = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/campaigns/${campaignA}/routing-policy`,
      payload: { band: "warp_speed" },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it("keeps every surface workspace-guarded", async () => {
    seedStory("Guarded story about GTM memory", "https://ex.com/guard");
    await runMatch();
    const list = listOpportunitiesResponseSchema.parse(
      (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/opportunities` })
      ).json(),
    );
    const outsider = await registerUser(app, "outsider@example.com");
    const stranger = asUser(app, outsider.token);
    for (const [method, url] of [
      ["GET", `/workspaces/${workspaceId}/opportunities`],
      ["GET", `/workspaces/${workspaceId}/opportunities/${list.opportunities[0]!.id}`],
      [
        "POST",
        `/workspaces/${workspaceId}/opportunities/${list.opportunities[0]!.id}/decision`,
      ],
      ["GET", `/workspaces/${workspaceId}/campaigns/${campaignA}/routing-profile`],
      ["PATCH", `/workspaces/${workspaceId}/campaigns/${campaignA}/routing-policy`],
      ["POST", `/workspaces/${workspaceId}/opportunities/match`],
    ] as const) {
      const res = await stranger.inject({
        method,
        url,
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
