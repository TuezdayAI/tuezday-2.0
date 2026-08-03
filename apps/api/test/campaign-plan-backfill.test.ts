import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { campaignPlanRevisions } from "../src/db/schema";
import { backfillMissingCampaignPlans } from "../src/services/campaign-plan-backfill";
import { getCurrentCampaignPlan } from "../src/services/campaign-plans";
import { buildAuthedApp, createTestDb, registerUser, asUser } from "./helpers";

/**
 * Sprint 53 Task 3 — the hard prerequisite for Task 4.
 *
 * Task 4 stops `composeCampaignOverlay` emitting the legacy structured block,
 * so a campaign with no plan at that moment would lose objective/KPI/pillars
 * from every prompt. Every campaign must therefore arrive at Task 4 with an
 * active plan revision — and the sweep that guarantees it must be safe to run
 * on every boot, forever.
 */
describe("campaign plan backfill (Sprint 53)", () => {
  const apps: TuezdayApp[] = [];

  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  async function seedCampaigns(db: Db, names: string[]) {
    const app = await buildAuthedApp({ db });
    apps.push(app);
    const workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Backfillable" } })
    ).json().id;
    const campaignIds: string[] = [];
    for (const name of names) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: {
          name,
          objective: `Objective for ${name}`,
          kpi: "Qualified conversations",
          pillars: [`${name} pillar`],
          overlay: `${name} house style.`,
        },
      });
      expect(res.statusCode).toBe(201);
      campaignIds.push(res.json().id);
    }
    return { app, workspaceId, campaignIds };
  }

  function revisionCount(db: Db, campaignId: string): number {
    return db
      .select()
      .from(campaignPlanRevisions)
      .where(eq(campaignPlanRevisions.campaignId, campaignId))
      .all().length;
  }

  it("gives every planless campaign an active plan carrying its legacy strategy", async () => {
    const db = createTestDb();
    const { workspaceId, campaignIds } = await seedCampaigns(db, ["Alpha", "Beta", "Gamma"]);

    const summary = backfillMissingCampaignPlans(db);
    expect(summary.scanned).toBe(3);
    expect(summary.planned).toBe(3);
    expect(summary.failed).toEqual([]);

    for (const campaignId of campaignIds) {
      const detail = getCurrentCampaignPlan(db, workspaceId, campaignId);
      expect(detail).toBeDefined();
      expect(detail!.plan.status).toBe("active");
      expect(detail!.plan.objective).toMatch(/^Objective for /);
      expect(detail!.plan.pillars).toHaveLength(1);
      // Sprint 53 review, C1: the overlay is **not** copied into the plan. It
      // never moved — `composeCampaignOverlay` still emits it as the campaign
      // section's additional instruction — so seeding `guidance` with it put
      // the same bytes in two sections of every campaign-scoped prompt, and
      // left a second copy to drift on the next edit.
      expect(detail!.plan.guidance).toBe("");
    }
  });

  it("is idempotent — a second sweep creates no duplicate or spurious revision", async () => {
    const db = createTestDb();
    const { workspaceId, campaignIds } = await seedCampaigns(db, ["Alpha", "Beta"]);

    backfillMissingCampaignPlans(db);
    const before = campaignIds.map((id) => ({
      id,
      revisions: revisionCount(db, id),
      planId: getCurrentCampaignPlan(db, workspaceId, id)!.plan.id,
    }));

    const second = backfillMissingCampaignPlans(db);
    expect(second.scanned).toBe(0);
    expect(second.planned).toBe(0);

    for (const snapshot of before) {
      expect(revisionCount(db, snapshot.id)).toBe(snapshot.revisions);
      expect(getCurrentCampaignPlan(db, workspaceId, snapshot.id)!.plan.id).toBe(snapshot.planId);
    }
  });

  it("leaves a campaign that already has a human-authored plan untouched", async () => {
    const db = createTestDb();
    const { app, workspaceId, campaignIds } = await seedCampaigns(db, ["Curated"]);
    const campaignId = campaignIds[0]!;
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/plan/revisions`,
      payload: { objective: "Hand written", startAt: null, endAt: null, pillars: ["Mine"] },
    });
    expect(created.statusCode).toBe(201);

    const summary = backfillMissingCampaignPlans(db);
    expect(summary.scanned).toBe(0);
    // The draft is still the only revision: the sweep neither activated it nor
    // shoved a machine-made revision beside it.
    expect(revisionCount(db, campaignId)).toBe(1);
    expect(getCurrentCampaignPlan(db, workspaceId, campaignId)).toBeUndefined();
  });

  it("runs at boot, so an existing database is planned without an operator", async () => {
    const db = createTestDb();
    const { workspaceId, campaignIds } = await seedCampaigns(db, ["Legacy"]);
    const campaignId = campaignIds[0]!;
    expect(getCurrentCampaignPlan(db, workspaceId, campaignId)).toBeUndefined();

    // A later boot of the same database — exactly what a deploy does.
    const rebooted = await buildApp({ db });
    apps.push(rebooted);
    expect(getCurrentCampaignPlan(db, workspaceId, campaignId)?.plan.status).toBe("active");
    const afterFirstBoot = revisionCount(db, campaignId);

    const bootedAgain = await buildApp({ db });
    apps.push(bootedAgain);
    expect(revisionCount(db, campaignId)).toBe(afterFirstBoot);
  });

  it("sweeps every workspace, not just the first", async () => {
    const db = createTestDb();
    const app = await buildApp({ db });
    apps.push(app);
    const one = asUser(app, (await registerUser(app, "one@test.dev", "one")).token);
    const two = asUser(app, (await registerUser(app, "two@test.dev", "two")).token);

    const scoped: { workspaceId: string; campaignId: string }[] = [];
    for (const client of [one, two]) {
      const workspaceId = (
        await client.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
      ).json().id;
      const campaignId = (
        await client.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "Shared name", objective: "Ship" },
        })
      ).json().id;
      scoped.push({ workspaceId, campaignId });
    }

    const summary = backfillMissingCampaignPlans(db);
    expect(summary.scanned).toBe(2);
    for (const { workspaceId, campaignId } of scoped) {
      expect(getCurrentCampaignPlan(db, workspaceId, campaignId)?.plan.status).toBe("active");
    }
  });
});
