import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { rankTexts } from "@tuezday/brain";
import { listPublications } from "../../services/publications";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.get_prior_posts_on_topic;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 5;
const CONTENT_CHARS = 500;

/**
 * What have we already published about X? Direct BM25 over published drafts'
 * content — complete coverage, lexical only (the evidence corpus does real
 * semantic search over published posts, but only founder-accepted ones; this
 * tool trades semantics for completeness and says so).
 */
export const getPriorPostsTool: Tool<Input, unknown> = {
  name: "get_prior_posts_on_topic",
  description:
    "Find posts this workspace has already published about a topic — use before drafting to avoid repeating ourselves and to reference what worked. Returns matching published posts with engagement metrics when available. Optionally filter by channel.",
  input,
  access: "read",
  async run(ctx, { topic, channel, limit }) {
    const published = (await listPublications(ctx.db, ctx.workspaceId))
      .filter((p) => p.status === "published" && p.draft !== null)
      .filter((p) => !channel || p.draft!.channel === channel);
    if (published.length === 0) {
      return { posts: [], note: "Nothing published yet with these filters." };
    }

    const ranked = rankTexts(
      topic,
      published.map((p) => ({ id: p.id, text: `${p.title}\n${p.draft!.content}` })),
    );
    if (ranked.length === 0) {
      return { posts: [], note: "No published post matched the topic terms." };
    }
    const byId = new Map(published.map((p) => [p.id, p]));
    return {
      posts: ranked.slice(0, limit ?? DEFAULT_LIMIT).map((r) => {
        const p = byId.get(r.id)!;
        return {
          id: p.id,
          title: p.title,
          channel: p.draft!.channel,
          content: compactText(p.draft!.content, CONTENT_CHARS),
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
        };
      }),
    };
  },
};
