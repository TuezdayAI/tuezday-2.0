/**
 * GTM insights read-model (Sprint 34). Pure read-only aggregation over existing
 * tables — no writes, no new ingestion, no external integration. Composes
 * existing services (getCampaignAdMetrics from ads.ts) with direct DB reads.
 */
import { and, eq, sql } from "drizzle-orm";
import type {
  ApprovalState,
  Campaign,
  CampaignInsights,
  Channel,
  OutputRating,
  WorkspaceInsights,
} from "@tuezday/contracts";
import { APPROVAL_STATES, BRAIN_DOC_TYPES, CHANNELS, OUTPUT_RATINGS } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  brainDocuments,
  campaigns,
  drafts,
  engagementMetrics,
  generations,
  guidanceOverrides,
  inboxItems,
  launches,
  launchMessages,
  personas,
  publicationMetrics,
  publications,
} from "../db/schema";
import { getCampaignAdMetrics } from "./ads";
import { listCampaigns } from "./campaigns";

// ---------------------------------------------------------------------------
// Campaign insights
// ---------------------------------------------------------------------------

export function getCampaignInsights(db: Db, campaign: Campaign): CampaignInsights {
  const wid = campaign.workspaceId;
  const cid = campaign.id;

  // --- Paid (delegate) ---
  const adMetrics = getCampaignAdMetrics(db, campaign);

  // --- Quality: approval-state counts ---
  const draftRows = db
    .select({ state: drafts.state })
    .from(drafts)
    .where(and(eq(drafts.workspaceId, wid), eq(drafts.campaignId, cid)))
    .all();
  const draftCounts = Object.fromEntries(APPROVAL_STATES.map((s) => [s, 0])) as Record<
    ApprovalState,
    number
  >;
  for (const row of draftRows) draftCounts[row.state as ApprovalState] += 1;
  const reviewed = draftCounts.approved + draftCounts.rejected + draftCounts.edited;
  const approvalRate = reviewed > 0 ? draftCounts.approved / reviewed : 0;

  // --- Quality: output ratings ---
  const ratingRows = db
    .select({ rating: generations.rating })
    .from(generations)
    .where(
      and(
        eq(generations.workspaceId, wid),
        eq(generations.campaignId, cid),
        sql`${generations.rating} IS NOT NULL`,
      ),
    )
    .all();
  const ratings = Object.fromEntries(OUTPUT_RATINGS.map((r) => [r, 0])) as Record<
    OutputRating,
    number
  >;
  for (const row of ratingRows) {
    if (row.rating && row.rating in ratings) ratings[row.rating as OutputRating] += 1;
  }

  // --- Organic: publications through their drafts ---
  // publications has no campaignId; join through draftId → drafts.campaignId
  const pubRows = db
    .select({
      publicationId: publications.id,
      status: publications.status,
      channel: drafts.channel,
    })
    .from(publications)
    .innerJoin(drafts, eq(publications.draftId, drafts.id))
    .where(and(eq(drafts.workspaceId, wid), eq(drafts.campaignId, cid)))
    .all();

  let publishedCount = 0;
  let scheduledCount = 0;
  const pubIds: string[] = [];
  const publishedChannels = new Map<string, number>();

  for (const pub of pubRows) {
    if (pub.status === "published") {
      publishedCount++;
      pubIds.push(pub.publicationId);
      publishedChannels.set(pub.channel, (publishedChannels.get(pub.channel) ?? 0) + 1);
    } else if (pub.status === "scheduled") {
      scheduledCount++;
    }
  }

  // Platform-polled metrics (Sprint 29) — prefer 7d, fall back to 24h
  const platformTotals = { likes: 0, comments: 0, shares: 0, impressions: 0, clicks: 0 };
  if (pubIds.length > 0) {
    // Fetch all publication_metrics rows for these publications
    const pmRows = db
      .select()
      .from(publicationMetrics)
      .where(sql`${publicationMetrics.publicationId} IN (${sql.join(pubIds.map((id) => sql`${id}`), sql`, `)})`)
      .all();
    // Group by publicationId, prefer 7d
    const byPub = new Map<string, typeof pmRows[0]>();
    for (const row of pmRows) {
      const existing = byPub.get(row.publicationId);
      if (!existing || row.window === "7d") {
        byPub.set(row.publicationId, row);
      }
    }
    for (const row of byPub.values()) {
      platformTotals.likes += row.likes ?? 0;
      platformTotals.comments += row.comments ?? 0;
      platformTotals.shares += row.shares ?? 0;
      platformTotals.impressions += row.impressions ?? 0;
      platformTotals.clicks += row.clicks ?? 0;
    }
  }

  // Learning-loop engagement_metrics (separate from platform)
  // engagement_metrics links to campaign through draftId → drafts.campaignId
  const learningRows = db
    .select({
      impressions: engagementMetrics.impressions,
      engagements: engagementMetrics.engagements,
      clicks: engagementMetrics.clicks,
    })
    .from(engagementMetrics)
    .innerJoin(drafts, eq(engagementMetrics.draftId, drafts.id))
    .where(and(eq(drafts.workspaceId, wid), eq(drafts.campaignId, cid)))
    .all();
  const learningTotals = { impressions: 0, engagements: 0, clicks: 0 };
  for (const row of learningRows) {
    learningTotals.impressions += row.impressions ?? 0;
    learningTotals.engagements += row.engagements ?? 0;
    learningTotals.clicks += row.clicks ?? 0;
  }

  // --- Outbound: launches for this campaign ---
  const launchRows = db
    .select({ id: launches.id })
    .from(launches)
    .where(and(eq(launches.workspaceId, wid), eq(launches.campaignId, cid)))
    .all();
  const launchIds = launchRows.map((r) => r.id);
  let sentCount = 0;
  let failedCount = 0;
  const sentChannels = new Map<string, number>();

  if (launchIds.length > 0) {
    const msgRows = db
      .select({ id: launchMessages.id, status: launchMessages.status, channel: launchMessages.channel })
      .from(launchMessages)
      .where(sql`${launchMessages.launchId} IN (${sql.join(launchIds.map((id) => sql`${id}`), sql`, `)})`)
      .all();
    for (const msg of msgRows) {
      if (msg.status === "sent") {
        sentCount++;
        sentChannels.set(msg.channel, (sentChannels.get(msg.channel) ?? 0) + 1);
      } else if (msg.status === "failed") {
        failedCount++;
      }
    }
  }

  // Replies: inbox items linked to launch messages
  let repliedCount = 0;
  const repliedChannels = new Map<string, number>();
  if (launchIds.length > 0) {
    const replyRows = db
      .select({ channel: inboxItems.channel })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, wid),
          sql`${inboxItems.launchMessageId} IS NOT NULL`,
          sql`${inboxItems.launchMessageId} IN (
            SELECT ${launchMessages.id} FROM ${launchMessages}
            WHERE ${launchMessages.launchId} IN (${sql.join(launchIds.map((id) => sql`${id}`), sql`, `)})
          )`,
        ),
      )
      .all();
    repliedCount = replyRows.length;
    for (const row of replyRows) {
      repliedChannels.set(row.channel, (repliedChannels.get(row.channel) ?? 0) + 1);
    }
  }

  const replyRate = sentCount > 0 ? repliedCount / sentCount : 0;

  // --- By channel ---
  const channelData = new Map<
    string,
    { published: number; impressions: number; spendCents: number; sent: number; replied: number }
  >();
  const ensureChannel = (ch: string) => {
    if (!channelData.has(ch))
      channelData.set(ch, { published: 0, impressions: 0, spendCents: 0, sent: 0, replied: 0 });
    return channelData.get(ch)!;
  };

  // Publications by channel
  for (const [ch, count] of publishedChannels) {
    ensureChannel(ch).published += count;
  }

  // Platform impressions by channel (from publication channel)
  // We approximate: attribute all platform impressions to the channels that have publications
  // For a more granular view, we'd need per-publication-per-channel metrics
  // v1: attribute all platform impressions proportionally if multiple channels exist
  if (publishedCount > 0) {
    for (const [ch, count] of publishedChannels) {
      const share = count / publishedCount;
      ensureChannel(ch).impressions += Math.round(platformTotals.impressions * share);
    }
  }

  // Paid by channel (ads channel)
  if (adMetrics) {
    ensureChannel("ads").spendCents += adMetrics.totals.spendCents;
    ensureChannel("ads").impressions += adMetrics.totals.impressions;
  }

  // Outbound by channel
  for (const [ch, count] of sentChannels) {
    ensureChannel(ch).sent += count;
  }
  for (const [ch, count] of repliedChannels) {
    ensureChannel(ch).replied += count;
  }

  const byChannel = [...channelData.entries()]
    .map(([channel, data]) => ({ channel, ...data }))
    .filter((row) => row.published + row.impressions + row.spendCents + row.sent + row.replied > 0)
    .sort((a, b) => b.impressions + b.published - (a.impressions + a.published));

  return {
    campaign: { id: cid, name: campaign.name, status: campaign.status },
    paid: adMetrics,
    organic: {
      publishedCount,
      scheduledCount,
      platform: platformTotals,
      learning: learningTotals,
    },
    outbound: {
      launchCount: launchIds.length,
      sentCount,
      failedCount,
      repliedCount,
      replyRate: Math.round(replyRate * 10000) / 10000,
    },
    quality: {
      draftCounts: draftCounts as Record<string, number>,
      approvalRate: Math.round(approvalRate * 10000) / 10000,
      ratings: ratings as Record<string, number>,
    },
    byChannel,
  };
}

// ---------------------------------------------------------------------------
// Workspace insights
// ---------------------------------------------------------------------------

export function getWorkspaceInsights(db: Db, workspaceId: string): WorkspaceInsights {
  const allCampaigns = listCampaigns(db, workspaceId);

  // Per-campaign compact rollups
  const campaignRollups: WorkspaceInsights["campaigns"] = [];
  const channelAgg = new Map<
    string,
    { published: number; impressions: number; spendCents: number; sent: number; replied: number }
  >();

  for (const campaign of allCampaigns) {
    const ci = getCampaignInsights(db, campaign);
    campaignRollups.push({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      spendCents: ci.paid?.totals.spendCents ?? 0,
      publishedCount: ci.organic.publishedCount,
      sentCount: ci.outbound.sentCount,
      approvalRate: ci.quality.approvalRate,
    });
    // Aggregate by-channel workspace-wide
    for (const ch of ci.byChannel) {
      const existing = channelAgg.get(ch.channel) ?? {
        published: 0,
        impressions: 0,
        spendCents: 0,
        sent: 0,
        replied: 0,
      };
      existing.published += ch.published;
      existing.impressions += ch.impressions;
      existing.spendCents += ch.spendCents;
      existing.sent += ch.sent;
      existing.replied += ch.replied;
      channelAgg.set(ch.channel, existing);
    }
  }

  const byChannel = [...channelAgg.entries()]
    .map(([channel, data]) => ({ channel, ...data }))
    .filter((row) => row.published + row.impressions + row.spendCents + row.sent + row.replied > 0)
    .sort((a, b) => b.impressions + b.published - (a.impressions + a.published));

  // Brain completeness
  const brainDocs = db
    .select({ docType: brainDocuments.docType, content: brainDocuments.content })
    .from(brainDocuments)
    .where(eq(brainDocuments.workspaceId, workspaceId))
    .all();
  const docsByType = new Map(brainDocs.map((d) => [d.docType, d.content]));
  const docs = BRAIN_DOC_TYPES.map((type) => ({
    type,
    filled: (docsByType.get(type) ?? "").trim().length > 0,
  }));
  const filledCount = docs.filter((d) => d.filled).length;

  const overlayCount = db
    .select({ count: sql<number>`count(*)` })
    .from(guidanceOverrides)
    .where(eq(guidanceOverrides.workspaceId, workspaceId))
    .get()?.count ?? 0;

  const personaCount = db
    .select({ count: sql<number>`count(*)` })
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId))
    .get()?.count ?? 0;

  const campaignCount = allCampaigns.length;

  const generationsTotal = db
    .select({ count: sql<number>`count(*)` })
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .get()?.count ?? 0;

  return {
    campaigns: campaignRollups,
    byChannel,
    brain: {
      docs,
      overlayCount,
      personaCount,
      campaignCount,
      generationsTotal,
      completenessPct: Math.round((filledCount / BRAIN_DOC_TYPES.length) * 100),
    },
  };
}

// ---------------------------------------------------------------------------
// CSV serializers
// ---------------------------------------------------------------------------

export function toCampaignInsightsCsv(insights: CampaignInsights): string {
  const lines: string[] = [];

  // Header: Summary row
  lines.push("Section,Metric,Value");

  // Paid
  if (insights.paid) {
    lines.push(`Paid,Spend (cents),${insights.paid.totals.spendCents}`);
    lines.push(`Paid,Impressions,${insights.paid.totals.impressions}`);
    lines.push(`Paid,Clicks,${insights.paid.totals.clicks}`);
    lines.push(`Paid,Conversions,${insights.paid.totals.conversions}`);
    if (insights.paid.totals.impressions > 0) {
      const ctr = ((insights.paid.totals.clicks / insights.paid.totals.impressions) * 100).toFixed(2);
      lines.push(`Paid,CTR (%),${ctr}`);
    }
    if (insights.paid.totals.clicks > 0) {
      const cpc = (insights.paid.totals.spendCents / insights.paid.totals.clicks / 100).toFixed(2);
      lines.push(`Paid,CPC,${cpc}`);
    }
    for (const ac of insights.paid.adCampaigns) {
      lines.push(
        `Paid - ${ac.name},Spend (${ac.currency} cents),${ac.totals.spendCents}`,
      );
    }
  }

  // Organic
  lines.push(`Organic,Published,${insights.organic.publishedCount}`);
  lines.push(`Organic,Scheduled,${insights.organic.scheduledCount}`);
  lines.push(`Organic - Platform,Likes,${insights.organic.platform.likes}`);
  lines.push(`Organic - Platform,Comments,${insights.organic.platform.comments}`);
  lines.push(`Organic - Platform,Shares,${insights.organic.platform.shares}`);
  lines.push(`Organic - Platform,Impressions,${insights.organic.platform.impressions}`);
  lines.push(`Organic - Platform,Clicks,${insights.organic.platform.clicks}`);
  lines.push(`Organic - Learning,Impressions,${insights.organic.learning.impressions}`);
  lines.push(`Organic - Learning,Engagements,${insights.organic.learning.engagements}`);
  lines.push(`Organic - Learning,Clicks,${insights.organic.learning.clicks}`);

  // Outbound
  lines.push(`Outbound,Launches,${insights.outbound.launchCount}`);
  lines.push(`Outbound,Sent,${insights.outbound.sentCount}`);
  lines.push(`Outbound,Failed,${insights.outbound.failedCount}`);
  lines.push(`Outbound,Replied,${insights.outbound.repliedCount}`);
  lines.push(`Outbound,Reply rate,${(insights.outbound.replyRate * 100).toFixed(2)}%`);

  // Quality
  for (const [state, count] of Object.entries(insights.quality.draftCounts)) {
    lines.push(`Quality - Drafts,${state},${count}`);
  }
  lines.push(`Quality,Approval rate,${(insights.quality.approvalRate * 100).toFixed(2)}%`);
  for (const [rating, count] of Object.entries(insights.quality.ratings)) {
    lines.push(`Quality - Ratings,${rating},${count}`);
  }

  // By channel
  if (insights.byChannel.length > 0) {
    lines.push("");
    lines.push("Channel,Published,Impressions,Spend (cents),Sent,Replied");
    for (const ch of insights.byChannel) {
      lines.push(`${ch.channel},${ch.published},${ch.impressions},${ch.spendCents},${ch.sent},${ch.replied}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function toWorkspaceInsightsCsv(insights: WorkspaceInsights): string {
  const lines: string[] = [];

  // Campaigns table
  lines.push("Campaign,Status,Spend (cents),Published,Sent,Approval Rate");
  for (const c of insights.campaigns) {
    lines.push(
      `"${c.name.replace(/"/g, '""')}",${c.status},${c.spendCents},${c.publishedCount},${c.sentCount},${(c.approvalRate * 100).toFixed(2)}%`,
    );
  }

  // Brain completeness
  lines.push("");
  lines.push("Brain,Metric,Value");
  for (const doc of insights.brain.docs) {
    lines.push(`Brain Doc,${doc.type},${doc.filled ? "filled" : "empty"}`);
  }
  lines.push(`Brain,Completeness,${insights.brain.completenessPct}%`);
  lines.push(`Brain,Overlays,${insights.brain.overlayCount}`);
  lines.push(`Brain,Personas,${insights.brain.personaCount}`);
  lines.push(`Brain,Campaigns,${insights.brain.campaignCount}`);
  lines.push(`Brain,Generations,${insights.brain.generationsTotal}`);

  return lines.join("\n") + "\n";
}
