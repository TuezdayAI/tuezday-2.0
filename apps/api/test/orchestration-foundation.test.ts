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
    db = createTestDb();
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

  it("preserves one stable lane across immutable plan revisions", () => {
    const now = Date.now();
    const firstPlanId = randomUUID();
    const secondPlanId = randomUUID();
    const laneId = randomUUID();

    db.insert(campaignPlanRevisions)
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
      })
      .run();
    db.insert(campaignLanes)
      .values({
        id: laneId,
        workspaceId,
        campaignId,
        key: "founder-linkedin",
        name: "Founder LinkedIn",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(campaignLaneRevisions)
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
      })
      .run();

    db.insert(campaignPlanRevisions)
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
      })
      .run();
    db.insert(campaignLaneRevisions)
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
      })
      .run();
    db.update(campaigns)
      .set({ currentPlanRevisionId: secondPlanId })
      .where(eq(campaigns.id, campaignId))
      .run();

    const plans = db.select().from(campaignPlanRevisions).all();
    const laneRevisions = db.select().from(campaignLaneRevisions).all();
    const campaign = db.select().from(campaigns).get();

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

    it("numbers revisions monotonically and atomically supersedes the active plan", () => {
      const first = createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      upsertLaneRevision(db, workspaceId, campaignId, first.id, {
        ...laneInput,
        personaId,
      });
      const activatedFirst = activatePlanRevision(db, workspaceId, campaignId, first.id);
      expect(activatedFirst.plan.status).toBe("active");

      const second = createPlanRevision(
        db,
        workspaceId,
        campaignId,
        { ...planInput, pillars: ["GTM memory", "Proof"] },
        { userId: null },
      );
      upsertLaneRevision(db, workspaceId, campaignId, second.id, {
        ...laneInput,
        personaId,
        plannedQuantity: 3,
      });
      const activatedSecond = activatePlanRevision(db, workspaceId, campaignId, second.id);

      expect(second.revision).toBe(2);
      expect(activatedSecond.plan.status).toBe("active");
      expect(
        db.select().from(campaignPlanRevisions).all().find((plan) => plan.id === first.id)?.status,
      ).toBe("superseded");
      expect(getCurrentCampaignPlan(db, workspaceId, campaignId)?.plan.id).toBe(second.id);
    });

    it("reuses a stable lane key across plan revisions", () => {
      const first = createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      const firstLane = upsertLaneRevision(db, workspaceId, campaignId, first.id, {
        ...laneInput,
        personaId,
      });
      activatePlanRevision(db, workspaceId, campaignId, first.id);

      const second = createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      const secondLane = upsertLaneRevision(db, workspaceId, campaignId, second.id, {
        ...laneInput,
        personaId,
      });

      expect(secondLane.laneId).toBe(firstLane.laneId);
      expect(secondLane.id).not.toBe(firstLane.id);
    });

    it("refuses to mutate an active plan", () => {
      const plan = createPlanRevision(db, workspaceId, campaignId, planInput, { userId: null });
      upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
        ...laneInput,
        personaId,
      });
      activatePlanRevision(db, workspaceId, campaignId, plan.id);

      expect(() =>
        upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
          ...laneInput,
          personaId,
          plannedQuantity: 4,
        }),
      ).toThrow(PlanImmutableError);
    });

    it("rejects a campaign outside the requested workspace", () => {
      expect(() =>
        createPlanRevision(db, randomUUID(), campaignId, planInput, { userId: null }),
      ).toThrow(CampaignPlanNotFoundError);
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
      db.insert(connections)
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
        })
        .run();
      db.insert(postingCadences)
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
        })
        .run();

      const first = backfillCampaignControlPlane(db, workspaceId, campaignId);
      const second = backfillCampaignControlPlane(db, workspaceId, campaignId);
      const detail = getCurrentCampaignPlan(db, workspaceId, campaignId);

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

      const result = backfillCampaignControlPlane(db, workspaceId, campaignId);
      const summary = getCampaignControlPlaneSummary(db, workspaceId, campaignId);

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

    it("returns structured activation issues for an unavailable connection", async () => {
      const now = Date.now();
      const connectionId = randomUUID();
      db.insert(connections)
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
        })
        .run();
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
