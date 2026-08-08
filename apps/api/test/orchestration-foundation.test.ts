import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaignPlanRevisions,
  campaigns,
  connections,
  postingCadences,
} from "../src/db/schema";
import {
  CampaignPlanNotFoundError,
  PlanImmutableError,
  activatePlanRevision,
  createPlanRevision,
  getCurrentCampaignPlan,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import {
  backfillCampaignControlPlane,
  getCampaignControlPlaneSummary,
} from "../src/services/orchestration-backfill";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("orchestration foundation persistence", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Control Plane" } })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Evergreen founder voice" },
      })
    ).json().id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("preserves one stable lane across immutable plan revisions", async () => {
    const now = Date.now();
    const firstPlanId = randomUUID();
    const secondPlanId = randomUUID();
    const laneId = randomUUID();

    await db.insert(campaignPlanRevisions)
      .values({
        id: firstPlanId,
        workspaceId,
        campaignId,
        revision: 1,
        status: "superseded",
        objective: "Build category awareness",
        kpi: "Qualified conversations",
        startAt: null,
        endAt: null,
        audienceIdsJson: "[]",
        pillarsJson: '["GTM memory"]',
        offersJson: "[]",
        ctasJson: "[]",
        guidance: "",
        createdBy: null,
        createdAt: now,
        activatedAt: now,
      });
    await db.insert(campaignLanes)
      .values({
        id: laneId,
        workspaceId,
        campaignId,
        key: "founder-linkedin",
        name: "Founder LinkedIn",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    await db.insert(campaignLaneRevisions)
      .values({
        id: randomUUID(),
        workspaceId,
        laneId,
        planRevisionId: firstPlanId,
        personaId,
        audienceId: null,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: null,
        providerTarget: "feed",
        deliveryMode: "planned",
        plannedQuantity: 2,
        scheduleJson: JSON.stringify({
          daysOfWeek: [2, 4],
          timeOfDay: "10:00",
          timezone: "Asia/Kolkata",
        }),
        reactivePeriod: null,
        reactiveCap: null,
        status: "active",
        createdAt: now,
      });

    await db.insert(campaignPlanRevisions)
      .values({
        id: secondPlanId,
        workspaceId,
        campaignId,
        revision: 2,
        status: "active",
        objective: "Build category awareness",
        kpi: "Qualified conversations",
        startAt: null,
        endAt: null,
        audienceIdsJson: "[]",
        pillarsJson: '["GTM memory","Proof"]',
        offersJson: "[]",
        ctasJson: "[]",
        guidance: "",
        createdBy: null,
        createdAt: now + 1,
        activatedAt: now + 1,
      });
    await db.insert(campaignLaneRevisions)
      .values({
        id: randomUUID(),
        workspaceId,
        laneId,
        planRevisionId: secondPlanId,
        personaId,
        audienceId: null,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: null,
        providerTarget: "feed",
        deliveryMode: "planned_and_reactive",
        plannedQuantity: 3,
        scheduleJson: JSON.stringify({
          daysOfWeek: [1, 3, 5],
          timeOfDay: "10:00",
          timezone: "Asia/Kolkata",
        }),
        reactivePeriod: "week",
        reactiveCap: 2,
        status: "active",
        createdAt: now + 1,
      });
    await db.update(campaigns)
      .set({ currentPlanRevisionId: secondPlanId })
      .where(eq(campaigns.id, campaignId));

    const plans = await db.select().from(campaignPlanRevisions);
    const laneRevisions = await db.select().from(campaignLaneRevisions);
    const campaign = (await db.select().from(campaigns))[0];

    expect(plans.map((plan) => plan.revision)).toEqual([1, 2]);
    expect(laneRevisions).toHaveLength(2);
    expect(new Set(laneRevisions.map((revision) => revision.laneId))).toEqual(new Set([laneId]));
    expect(new Set(laneRevisions.map((revision) => revision.planRevisionId))).toEqual(
      new Set([firstPlanId, secondPlanId]),
    );
    expect(campaign?.currentPlanRevisionId).toBe(secondPlanId);
    expect(campaign?.origin).toBe("user");
    expect(campaign?.purpose).toBe("initiative");
  });

  describe("plan service", () => {
    const planInput = {
      objective: "Create qualified demand",
      kpi: "20 demo requests",
      timeframe: "Q3 2026",
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
      schedule: {
        daysOfWeek: [2, 4],
        timeOfDay: "10:00",
        timezone: "Asia/Kolkata",
      },
      reactivePeriod: null,
      reactiveCap: null,
      status: "active" as const,
    };

    it("numbers revisions monotonically and atomically supersedes the active plan", async () => {
      const first = await createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      await upsertLaneRevision(db, workspaceId, campaignId, first.id, {
        ...laneInput,
        personaId,
      });
      const activatedFirst = await activatePlanRevision(db, workspaceId, campaignId, first.id);
      expect(activatedFirst.plan.status).toBe("active");

      const second = await createPlanRevision(
        db,
        workspaceId,
        campaignId,
        { ...planInput, pillars: ["GTM memory", "Proof"] },
        { userId: null },
      );
      await upsertLaneRevision(db, workspaceId, campaignId, second.id, {
        ...laneInput,
        personaId,
        plannedQuantity: 3,
      });
      const activatedSecond = await activatePlanRevision(db, workspaceId, campaignId, second.id);

      expect(second.revision).toBe(2);
      expect(activatedSecond.plan.status).toBe("active");
      expect(
        (await db.select().from(campaignPlanRevisions)).find((plan) => plan.id === first.id)?.status,
      ).toBe("superseded");
      expect((await getCurrentCampaignPlan(db, workspaceId, campaignId))?.plan.id).toBe(second.id);
    });

    it("reuses a stable lane key across plan revisions", async () => {
      const first = await createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      const firstLane = await upsertLaneRevision(db, workspaceId, campaignId, first.id, {
        ...laneInput,
        personaId,
      });
      await activatePlanRevision(db, workspaceId, campaignId, first.id);

      const second = await createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      const secondLane = await upsertLaneRevision(db, workspaceId, campaignId, second.id, {
        ...laneInput,
        personaId,
      });

      expect(secondLane.laneId).toBe(firstLane.laneId);
      expect(secondLane.id).not.toBe(firstLane.id);
    });

    it("refuses to mutate an active plan", async () => {
      const plan = await createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      await upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
        ...laneInput,
        personaId,
      });
      await activatePlanRevision(db, workspaceId, campaignId, plan.id);

      await expect((async () =>
        await upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
          ...laneInput,
          personaId,
          plannedQuantity: 4,
        }))(),
      ).rejects.toThrow(PlanImmutableError);
    });

    it("rejects a campaign outside the requested workspace", async () => {
      await expect((async () =>
        await createPlanRevision(db, randomUUID(), campaignId, planInput, { userId: null }))(),
      ).rejects.toThrow(CampaignPlanNotFoundError);
    });
  });

  describe("legacy backfill", () => {
    it("backfills an unambiguous cadence and preserves the campaign timeframe", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}`,
        payload: {
          name: "Evergreen founder voice",
          timeframe: "Q3 2026",
          channels: ["linkedin"],
          personaIds: [personaId],
        },
      });
      const connectionId = randomUUID();
      const now = Date.now();
      await db.insert(connections)
        .values({
          id: connectionId,
          workspaceId,
          providerKey: "linkedin",
          nangoConnectionId: randomUUID(),
          configJson: "{}",
          displayName: "Founder LinkedIn",
          status: "connected",
          contentProfileJson: "{}",
          createdAt: now,
          updatedAt: now,
        });
      await db.insert(postingCadences)
        .values({
          id: randomUUID(),
          workspaceId,
          name: "Founder LinkedIn",
          campaignId,
          personaId,
          channel: "linkedin",
          connectionId,
          target: "feed",
          daysOfWeekJson: "[2,4]",
          timeOfDay: "10:00",
          timezone: "Asia/Kolkata",
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

      const first = await backfillCampaignControlPlane(db, workspaceId, campaignId);
      const second = await backfillCampaignControlPlane(db, workspaceId, campaignId);
      const detail = await getCurrentCampaignPlan(db, workspaceId, campaignId);

      expect(first.status).toBe("backfilled");
      expect(first.issues).toEqual([]);
      expect(second.status).toBe("already_backfilled");
      expect(second.planRevisionId).toBe(first.planRevisionId);
      expect(detail?.plan.timeframe).toBe("Q3 2026");
      expect(detail?.lanes).toHaveLength(1);
      expect(detail?.lanes[0]).toMatchObject({
        personaId,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: connectionId,
      });
    });

    it("flags campaign channels whose persona and account mapping cannot be inferred", async () => {
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}`,
        payload: {
          name: "Evergreen founder voice",
          channels: ["linkedin", "email"],
          personaIds: [personaId],
        },
      });

      const result = await backfillCampaignControlPlane(db, workspaceId, campaignId);
      const summary = await getCampaignControlPlaneSummary(db, workspaceId, campaignId);

      expect(result.status).toBe("needs_configuration");
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "execution_mapping_missing",
        "execution_mapping_missing",
      ]);
      expect(summary).toMatchObject({
        planRevision: 1,
        laneCount: 0,
        configurationIssueCount: 2,
      });
    });
  });

  describe("routes", () => {
    const revisionPayload = {
      objective: "Create qualified demand",
      kpi: "20 demo requests",
      timeframe: "Q3 2026",
      startAt: null,
      endAt: null,
      audienceIds: [],
      pillars: ["GTM memory"],
      offers: ["Product demo"],
      ctas: ["Book a demo"],
      guidance: "Use customer evidence.",
    };

    function lanePayload(over: Record<string, unknown> = {}) {
      return {
        key: "founder-linkedin",
        name: "Founder LinkedIn",
        personaId,
        audienceId: null,
        channel: "linkedin",
        format: "linkedin_post",
        publishingConnectionId: null,
        providerTarget: "feed",
        deliveryMode: "planned",
        plannedQuantity: 2,
        schedule: {
          daysOfWeek: [2, 4],
          timeOfDay: "10:00",
          timezone: "Asia/Kolkata",
        },
        reactivePeriod: null,
        reactiveCap: null,
        status: "active",
        ...over,
      };
    }

    it("creates, configures, activates, and reads a campaign plan", async () => {
      const revisionRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: revisionPayload,
      });
      expect(revisionRes.statusCode).toBe(201);
      const revision = revisionRes.json();

      const laneRes = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/lanes`,
        payload: lanePayload(),
      });
      expect(laneRes.statusCode).toBe(200);

      const activateRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/activate`,
      });
      expect(activateRes.statusCode).toBe(200);
      expect(activateRes.json().plan.status).toBe("active");

      const currentRes = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan`,
      });
      expect(currentRes.statusCode).toBe(200);
      expect(currentRes.json()).toMatchObject({
        plan: { id: revision.id, revision: 1, timeframe: "Q3 2026" },
        lanes: [{ personaId, channel: "linkedin" }],
      });

      const immutableRes = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/lanes`,
        payload: lanePayload({ plannedQuantity: 4 }),
      });
      expect(immutableRes.statusCode).toBe(409);
      expect(immutableRes.json().error).toBe("plan_immutable");
    });

    it("reads named lanes and revision history for the campaign workspace", async () => {
      const revisionRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: revisionPayload,
      });
      const revision = revisionRes.json();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/lanes`,
        payload: lanePayload(),
      });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/activate`,
      });

      const draftRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
        payload: { ...revisionPayload, objective: "Refined objective" },
      });
      expect(draftRes.statusCode).toBe(201);
      const draft = draftRes.json();

      const response = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/workspace`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        currentPlanRevisionId: revision.id,
        revisions: [
          {
            plan: { id: draft.id, revision: 2, status: "draft" },
            lanes: [{
              laneId: expect.any(String),
              key: "founder-linkedin",
              name: "Founder LinkedIn",
              channel: "linkedin",
            }],
          },
          {
            plan: { id: revision.id, revision: 1, status: "active" },
            lanes: [{ key: "founder-linkedin", name: "Founder LinkedIn", channel: "linkedin" }],
          },
        ],
        issues: [],
      });
    });

    it("keeps historical lane identity and stable production status unchanged until activation", async () => {
      const firstRevision = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
          payload: revisionPayload,
        })
      ).json();
      const firstLane = (
        await app.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${firstRevision.id}/lanes`,
          payload: lanePayload(),
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${firstRevision.id}/activate`,
      });

      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
          payload: { ...revisionPayload, objective: "Refined objective" },
        })
      ).json();
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${draft.id}/lanes`,
        payload: lanePayload({
          laneId: firstLane.laneId,
          key: "founder-proof",
          name: "Founder Proof",
          status: "retired",
        }),
      });

      const beforeActivation = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/workspace`,
        })
      ).json();
      expect(beforeActivation.revisions).toMatchObject([
        {
          plan: { id: draft.id, status: "draft" },
          lanes: [{ key: "founder-proof", name: "Founder Proof", status: "retired" }],
        },
        {
          plan: { id: firstRevision.id, status: "active" },
          lanes: [{ key: "founder-linkedin", name: "Founder LinkedIn", status: "active" }],
        },
      ]);
      expect((await db.select().from(campaignLanes).where(eq(campaignLanes.id, firstLane.laneId)))[0])
        .toMatchObject({
          key: "founder-linkedin",
          name: "Founder LinkedIn",
          status: "active",
        });

      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${draft.id}/activate`,
      });
      const afterActivation = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/workspace`,
        })
      ).json();
      expect(afterActivation.revisions[1]).toMatchObject({
        plan: { id: firstRevision.id, status: "superseded" },
        lanes: [{ key: "founder-linkedin", name: "Founder LinkedIn", status: "active" }],
      });
      expect((await db.select().from(campaignLanes).where(eq(campaignLanes.id, firstLane.laneId)))[0])
        .toMatchObject({ key: "founder-proof", name: "Founder Proof", status: "retired" });
    });

    it("returns structured activation issues for an unavailable connection", async () => {
      const now = Date.now();
      const connectionId = randomUUID();
      await db.insert(connections)
        .values({
          id: connectionId,
          workspaceId,
          providerKey: "linkedin",
          nangoConnectionId: randomUUID(),
          configJson: "{}",
          displayName: "Disconnected",
          status: "disconnected",
          contentProfileJson: "{}",
          createdAt: now,
          updatedAt: now,
        });
      const revision = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
          payload: revisionPayload,
        })
      ).json();
      const laneRes = await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/lanes`,
        payload: lanePayload({ publishingConnectionId: connectionId }),
      });
      expect(laneRes.statusCode).toBe(200);

      const activateRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions/${revision.id}/activate`,
      });
      expect(activateRes.statusCode).toBe(409);
      expect(activateRes.json()).toMatchObject({
        error: "plan_invalid",
        issues: [{ code: "connection_unavailable" }],
      });
    });
  });
});
