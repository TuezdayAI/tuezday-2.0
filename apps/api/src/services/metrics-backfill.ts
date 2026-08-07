import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import {
  adCampaignMetrics,
  adCampaigns,
  drafts,
  engagementMetrics,
  publicationMetrics,
  publications,
} from "../db/schema";
import { recordMetricIfAbsent, type MetricInput } from "./metrics";

// Sprint 55 Task 4: backfill the three legacy metric stores into the unified
// fact table. Runs at boot AFTER the dual-write shipped (spec §2.4), so it is
// strictly insert-if-absent: the dual-write may already have recorded a
// fresher value on the same grain — the ads sync restates a rolling 28-day
// window every few hours — and a clobbering backfill would overwrite it with
// a staler legacy one. Idempotent by construction; size-independent (row
// batches stream per table, nothing is loaded per-workspace).

export interface MetricsBackfillSummary {
  scanned: number;
  inserted: number;
}

export async function backfillMetrics(db: Db): Promise<MetricsBackfillSummary> {
  let scanned = 0;
  let inserted = 0;

  const record = async (workspaceId: string, input: MetricInput) => {
    if (await recordMetricIfAbsent(db, workspaceId, input)) inserted += 1;
  };

  // --- Manual readings (point at recordedAt; channel subject, plus a
  // campaign-subject copy when the reading's draft belongs to a campaign —
  // resolved here at backfill time, matching what the legacy campaign-scoped
  // read derived through its drafts join) --------------------------------
  const manualRows = await db.select().from(engagementMetrics).all();
  const manualDraftIds = [...new Set(manualRows.map((r) => r.draftId).filter((d): d is string => !!d))];
  const campaignByDraftId = new Map(
    (manualDraftIds.length
      ? await db
          .select({ id: drafts.id, campaignId: drafts.campaignId })
          .from(drafts)
          .where(inArray(drafts.id, manualDraftIds))
          .all()
      : []
    ).map((d) => [d.id, d.campaignId]),
  );
  for (const row of manualRows) {
    scanned += 1;
    const base = {
      window: "point" as const,
      periodStart: row.recordedAt,
      source: "manual" as const,
      capturedAt: row.recordedAt,
    };
    const subjects: Array<{ subjectType: "channel" | "campaign"; subjectId: string }> = [
      { subjectType: "channel", subjectId: row.channel },
    ];
    const campaignId = row.draftId ? campaignByDraftId.get(row.draftId) : null;
    if (campaignId) subjects.push({ subjectType: "campaign", subjectId: campaignId });
    for (const subject of subjects) {
      await record(row.workspaceId, { ...base, ...subject, metricKey: "impressions", value: row.impressions });
      await record(row.workspaceId, { ...base, ...subject, metricKey: "engagements", value: row.engagements });
      await record(row.workspaceId, { ...base, ...subject, metricKey: "clicks", value: row.clicks });
    }
    // An all-null row backfills to zero facts — it exists for its prose, which
    // stays on the legacy table (never dropped; it feeds the learning prompt).
  }

  // --- Publication snapshots (cumulative at 24h/7d; periodStart = publishedAt)
  const pubMetricRows = await db.select().from(publicationMetrics).all();
  const pubIds = [...new Set(pubMetricRows.map((r) => r.publicationId))];
  const publishedAtById = new Map(
    (pubIds.length
      ? await db
          .select({ id: publications.id, publishedAt: publications.publishedAt })
          .from(publications)
          .where(inArray(publications.id, pubIds))
          .all()
      : []
    ).map((p) => [p.id, p.publishedAt]),
  );
  for (const row of pubMetricRows) {
    scanned += 1;
    const publishedAt = publishedAtById.get(row.publicationId);
    // A metric row whose publication is gone (or never published) has no
    // periodStart to anchor the cumulative window — skip rather than invent.
    if (publishedAt === null || publishedAt === undefined) continue;
    const base = {
      subjectType: "publication" as const,
      subjectId: row.publicationId,
      window: row.window as "24h" | "7d",
      periodStart: publishedAt,
      source: "captured" as const,
      capturedAt: row.capturedAt,
    };
    await record(row.workspaceId, { ...base, metricKey: "likes", value: row.likes });
    await record(row.workspaceId, { ...base, metricKey: "comments", value: row.comments });
    await record(row.workspaceId, { ...base, metricKey: "shares", value: row.shares });
    await record(row.workspaceId, { ...base, metricKey: "impressions", value: row.impressions });
    await record(row.workspaceId, { ...base, metricKey: "clicks", value: row.clicks });
  }

  // --- Ad daily buckets (1d keyed on the UTC day) ----------------------------
  const adRows = await db.select().from(adCampaignMetrics).all();
  const adCampaignIds = [...new Set(adRows.map((r) => r.adCampaignId))];
  const knownCampaigns = new Set(
    (adCampaignIds.length
      ? await db
          .select({ id: adCampaigns.id })
          .from(adCampaigns)
          .where(inArray(adCampaigns.id, adCampaignIds))
          .all()
      : []
    ).map((c) => c.id),
  );
  for (const row of adRows) {
    scanned += 1;
    if (!knownCampaigns.has(row.adCampaignId)) continue;
    const base = {
      subjectType: "ad_campaign" as const,
      subjectId: row.adCampaignId,
      window: "1d" as const,
      periodStart: Date.parse(`${row.date}T00:00:00.000Z`),
      source: row.source === "csv" ? ("imported" as const) : ("synced" as const),
      capturedAt: row.updatedAt,
    };
    await record(row.workspaceId, { ...base, metricKey: "spend", value: row.spendCents });
    await record(row.workspaceId, { ...base, metricKey: "impressions", value: row.impressions });
    await record(row.workspaceId, { ...base, metricKey: "clicks", value: row.clicks });
    await record(row.workspaceId, { ...base, metricKey: "conversions", value: row.conversions });
  }

  return { scanned, inserted };
}
