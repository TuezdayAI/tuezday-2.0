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
} from "../src/db/schema";
import {
  CampaignPlanNotFoundError,
  PlanImmutableError,
  activatePlanRevision,
  createPlanRevision,
  getCurrentCampaignPlan,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
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
});
