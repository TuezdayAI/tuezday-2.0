import { describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers";
import type { Db } from "../src/db";
import {
  adAccounts,
  adCampaignMetrics,
  adCampaigns,
  connections,
  drafts,
  engagementMetrics,
  metrics,
  publicationMetrics,
  publications,
  workspaces,
} from "../src/db/schema";
import { backfillMetrics } from "../src/services/metrics-backfill";

// Sprint 55 Task 4: backfill the three legacy stores into the fact table.
// Runs AFTER dual-write ships (spec §2.4), so it must be insert-if-absent —
// a fresher dual-written value on the same grain must never be clobbered by
// a staler legacy one.

async function seed(db: Db) {
  const now = Date.now();
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, name: "WS", createdAt: now, updatedAt: now });
  return { workspaceId, now };
}

async function facts(db: Db, workspaceId: string) {
  return await db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId));
}

describe("backfillMetrics", () => {
  it("maps each store with its real semantics and is idempotent", async () => {
    const db = await createTestDb();
    const { workspaceId, now } = await seed(db);

    // Legacy manual reading (point) — one null metric, which must produce no row.
    await db.insert(engagementMetrics)
      .values({
        id: randomUUID(),
        workspaceId,
        draftId: null,
        channel: "linkedin",
        description: "",
        impressions: 500,
        engagements: null,
        clicks: 10,
        notes: "",
        recordedAt: now - 100_000,
        createdAt: now - 100_000,
      });

    // Legacy publication snapshot (cumulative at 24h). publications requires a
    // real draft + connection (NOT NULL FKs), so seed the minimal chain.
    const pubId = randomUUID();
    const publishedAt = now - 2 * 24 * 60 * 60 * 1000;
    const draftId = randomUUID();
    const connId = randomUUID();
    await db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        state: "approved",
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "post",
        originalContent: "post",
        createdAt: publishedAt,
        updatedAt: publishedAt,
      });
    await db.insert(connections)
      .values({
        id: connId,
        workspaceId,
        providerKey: "linkedin",
        status: "active",
        nangoConnectionId: "nango-bf",
        configJson: "{}",
        createdAt: publishedAt,
        updatedAt: publishedAt,
      });
    await db.insert(publications)
      .values({
        id: pubId,
        workspaceId,
        draftId,
        connectionId: connId,
        providerKey: "linkedin",
        target: "profile",
        title: "P1",
        status: "published",
        publishedAt,
        scheduledFor: publishedAt,
        createdAt: publishedAt,
        updatedAt: publishedAt,
      });
    await db.insert(publicationMetrics)
      .values({
        id: randomUUID(),
        workspaceId,
        publicationId: pubId,
        window: "24h",
        likes: 12,
        comments: 3,
        shares: null,
        impressions: 800,
        clicks: null,
        capturedAt: publishedAt + 25 * 60 * 60 * 1000,
        createdAt: publishedAt + 25 * 60 * 60 * 1000,
      });

    // Legacy ad daily bucket.
    const accountId = randomUUID();
    await db.insert(adAccounts)
      .values({
        id: accountId,
        workspaceId,
        connectionId: null,
        externalId: "act_1",
        name: "Main",
        currency: "USD",
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
      });
    const adCampaignId = randomUUID();
    await db.insert(adCampaigns)
      .values({
        id: adCampaignId,
        workspaceId,
        adAccountId: accountId,
        externalId: "cmp_1",
        name: "Spring",
        campaignId: null,
        lastSyncedAt: now,
        createdAt: now,
      });
    await db.insert(adCampaignMetrics)
      .values({
        id: randomUUID(),
        workspaceId,
        adCampaignId,
        date: "2026-07-30",
        spendCents: 1250,
        impressions: 4000,
        clicks: 80,
        conversions: 3,
        source: "csv",
        createdAt: now,
        updatedAt: now,
      });

    const first = await backfillMetrics(db);
    const rows = await facts(db, workspaceId);

    // manual: impressions + clicks (engagements was null → no row)
    const manual = rows.filter((r) => r.subjectType === "channel");
    expect(manual.map((r) => r.metricKey).sort()).toEqual(["clicks", "impressions"]);
    expect(manual[0]).toMatchObject({ window: "point", source: "manual", subjectId: "linkedin" });

    // capture: likes, comments, impressions (shares/clicks null → no rows),
    // periodStart = publishedAt, cumulative 24h window
    const captured = rows.filter((r) => r.subjectType === "publication");
    expect(captured.map((r) => r.metricKey).sort()).toEqual(["comments", "impressions", "likes"]);
    for (const r of captured) {
      expect(r).toMatchObject({ window: "24h", source: "captured", periodStart: publishedAt });
    }

    // ads: all four, 1d bucket keyed on the UTC day, csv → imported
    const ads = rows.filter((r) => r.subjectType === "ad_campaign");
    expect(ads.map((r) => r.metricKey).sort()).toEqual([
      "clicks",
      "conversions",
      "impressions",
      "spend",
    ]);
    for (const r of ads) {
      expect(r).toMatchObject({
        window: "1d",
        source: "imported",
        periodStart: Date.parse("2026-07-30T00:00:00.000Z"),
      });
    }

    // Idempotent: run again, nothing changes.
    const second = await backfillMetrics(db);
    expect(await facts(db, workspaceId)).toHaveLength(rows.length);
    expect(second.inserted).toBe(0);
    expect(first.inserted).toBe(rows.length);
  });

  it("never clobbers a fresher dual-written value on the same grain", async () => {
    const db = await createTestDb();
    const { workspaceId, now } = await seed(db);

    const accountId = randomUUID();
    await db.insert(adAccounts)
      .values({
        id: accountId,
        workspaceId,
        connectionId: null,
        externalId: "act_1",
        name: "Main",
        currency: "USD",
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
      });
    const adCampaignId = randomUUID();
    await db.insert(adCampaigns)
      .values({
        id: adCampaignId,
        workspaceId,
        adAccountId: accountId,
        externalId: "cmp_1",
        name: "Spring",
        campaignId: null,
        lastSyncedAt: now,
        createdAt: now,
      });
    // Legacy row holds a STALE value…
    await db.insert(adCampaignMetrics)
      .values({
        id: randomUUID(),
        workspaceId,
        adCampaignId,
        date: "2026-07-30",
        spendCents: 999,
        impressions: 1,
        clicks: 1,
        conversions: 1,
        source: "sync",
        createdAt: now,
        updatedAt: now,
      });
    // …while the dual-write already recorded the fresh one on the same grain.
    await db.insert(metrics)
      .values({
        id: randomUUID(),
        workspaceId,
        subjectType: "ad_campaign",
        subjectId: adCampaignId,
        metricKey: "spend",
        value: 2000,
        window: "1d",
        periodStart: Date.parse("2026-07-30T00:00:00.000Z"),
        source: "synced",
        capturedAt: now,
        createdAt: now,
      });

    await backfillMetrics(db);

    const spend = await db
      .select()
      .from(metrics)
      .where(and(eq(metrics.workspaceId, workspaceId), eq(metrics.metricKey, "spend")));
    expect(spend).toHaveLength(1);
    expect(spend[0]!.value).toBe(2000); // the fresher value survives
  });
});
