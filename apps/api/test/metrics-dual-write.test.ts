import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { adCampaigns, engagementMetrics, metrics, workspaces } from "../src/db/schema";
import { createMetric } from "../src/services/learning";
import { importAdsCsv } from "../src/services/ads";

// Sprint 55 Task 3: every legacy metric writer ALSO writes the unified fact
// table. The legacy write is untouched (rollback safety); these tests assert
// both rows exist and that the fact row carries the source's real semantics.
// The connected-sync path ("sync" → source "synced") is asserted inside the
// existing fabric-driven test in ads.test.ts; here the pure-DB seams are used.

async function seedWorkspace(db: Db): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(workspaces).values({ id, name: "WS", createdAt: now, updatedAt: now }).run();
  return id;
}

async function factRows(db: Db, workspaceId: string) {
  return await db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId)).all();
}

describe("manual entry dual-write (learning.createMetric)", () => {
  it("writes the legacy row AND channel-subject point facts, non-null values only", async () => {
    const db = createTestDb();
    const workspaceId = await seedWorkspace(db);
    const recordedAt = 1_754_000_000_000;

    await createMetric(db, workspaceId, {
      channel: "linkedin",
      description: "Launch post",
      impressions: 900,
      engagements: 45,
      notes: "",
      recordedAt,
    });

    const legacy = await db
      .select()
      .from(engagementMetrics)
      .where(eq(engagementMetrics.workspaceId, workspaceId))
      .all();
    expect(legacy).toHaveLength(1);

    // One fact per observed metric; clicks was absent, so no clicks row.
    const facts = await factRows(db, workspaceId);
    expect(facts.map((f) => f.metricKey).sort()).toEqual(["engagements", "impressions"]);
    for (const f of facts) {
      expect(f).toMatchObject({
        subjectType: "channel",
        subjectId: "linkedin",
        window: "point",
        periodStart: recordedAt,
        source: "manual",
      });
    }
  });

  it("an all-null manual row writes the legacy row and ZERO facts — absence is not zero", async () => {
    const db = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await createMetric(db, workspaceId, {
      channel: "x",
      description: "prose only",
      notes: "the founder's observation, which feeds the learning prompt",
    });
    expect(
      await db
        .select()
        .from(engagementMetrics)
        .where(eq(engagementMetrics.workspaceId, workspaceId))
        .all(),
    ).toHaveLength(1);
    expect(await factRows(db, workspaceId)).toHaveLength(0);
  });
});

describe("ads dual-write (importAdsCsv → upsertMetrics)", () => {
  const input = (spend: number) => ({
    accountName: "CSV import",
    currency: "USD",
    rows: [
      {
        campaignName: "Spring",
        date: "2026-07-30",
        spend,
        impressions: 4000,
        clicks: 80,
        conversions: 3,
      },
    ],
  });

  it("writes the legacy daily row AND 1d ad_campaign facts; re-import updates in place", async () => {
    const db = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await importAdsCsv(db, workspaceId, input(12.5));

    const campaign = (await db
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.workspaceId, workspaceId))
      .all())[0]!;
    let facts = await factRows(db, workspaceId);
    expect(facts.map((f) => f.metricKey).sort()).toEqual([
      "clicks",
      "conversions",
      "impressions",
      "spend",
    ]);
    const spend = facts.find((f) => f.metricKey === "spend")!;
    expect(spend).toMatchObject({
      subjectType: "ad_campaign",
      subjectId: campaign.id,
      value: 1250,
      window: "1d",
      periodStart: Date.parse("2026-07-30T00:00:00.000Z"),
      // The CSV path is an import, not a live provider sync.
      source: "imported",
    });

    // The same day restated with fresher numbers: update, never duplicate.
    await importAdsCsv(db, workspaceId, input(20));
    facts = await factRows(db, workspaceId);
    expect(facts).toHaveLength(4);
    expect(facts.find((f) => f.metricKey === "spend")!.value).toBe(2000);
  });
});
