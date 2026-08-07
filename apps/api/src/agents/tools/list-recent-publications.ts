import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { drafts } from "../../db/schema";
import { listPublications } from "../../services/publications";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.list_recent_publications_with_metrics;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 5;
const CONTENT_CHARS = 400;

/**
 * Recently published posts with their engagement snapshots
 * (publication_metrics, 24h/7d — not the legacy engagement_metrics store).
 * Campaign filter joins through the draft: publications carry no campaignId.
 */
export const listRecentPublicationsTool: Tool<Input, unknown> = {
  name: "list_recent_publications_with_metrics",
  description:
    "List the workspace's most recently published posts with their engagement metrics (likes, comments, shares, impressions, clicks at 24h and 7d). Optionally filter by channel or campaignId.",
  input,
  access: "read",
  async run(ctx, { limit, channel, campaignId }) {
    const draftCampaigns = campaignId
      ? new Set(
          (await ctx.db
            .select({ id: drafts.id })
            .from(drafts)
            .where(and(eq(drafts.workspaceId, ctx.workspaceId), eq(drafts.campaignId, campaignId)))
            .all())
            .map((row) => row.id),
        )
      : null;

    const published = (await listPublications(ctx.db, ctx.workspaceId))
      .filter((p) => p.status === "published")
      .filter((p) => !channel || p.draft?.channel === channel)
      .filter((p) => !draftCampaigns || (p.draft && draftCampaigns.has(p.draft.id)))
      .slice(0, limit ?? DEFAULT_LIMIT);

    if (published.length === 0) {
      return { publications: [], note: "No published posts match these filters yet." };
    }
    return {
      publications: published.map((p) => ({
        id: p.id,
        title: p.title,
        channel: p.draft?.channel ?? null,
        content: p.draft ? compactText(p.draft.content, CONTENT_CHARS) : null,
        publishedAt: p.publishedAt,
        externalUrl: p.externalUrl,
        metrics: p.metrics.map((m) => ({
          window: m.window,
          likes: m.likes,
          comments: m.comments,
          shares: m.shares,
          impressions: m.impressions,
          clicks: m.clicks,
        })),
      })),
    };
  },
};
