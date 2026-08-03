import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { rankTexts } from "@tuezday/brain";
import { listDiscoveredItems } from "../../services/discovery";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.search_discovery_items;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 5;
const SUMMARY_CHARS = 400;

/**
 * Discovered items (external stories the discovery loop surfaced). Without a
 * query: score-ordered, the existing triage order. With a query: BM25 over
 * title + summary — lexical, stated openly; items carry no embeddings.
 */
export const searchDiscoveryItemsTool: Tool<Input, unknown> = {
  name: "search_discovery_items",
  description:
    "Search or list items the discovery loop found (external articles, posts, stories). Without a query returns the highest-scored items; with a query returns the best lexical matches over title + summary. Optionally filter by status (new, accepted, skipped, duplicate).",
  input,
  access: "read",
  async run(ctx, { query, status, limit }) {
    const items = listDiscoveredItems(ctx.db, ctx.workspaceId, status);
    const cap = limit ?? DEFAULT_LIMIT;

    let chosen = items;
    if (query) {
      const ranked = rankTexts(
        query,
        items.map((item) => ({ id: item.id, text: `${item.title}\n${item.summary}` })),
      );
      const byId = new Map(items.map((item) => [item.id, item]));
      chosen = ranked.map((r) => byId.get(r.id)!);
    }
    if (chosen.length === 0) {
      return {
        items: [],
        note: query
          ? "No discovery items matched the query terms."
          : "No discovery items with these filters yet.",
      };
    }
    return {
      items: chosen.slice(0, cap).map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        summary: compactText(item.summary, SUMMARY_CHARS),
        score: item.score,
        scoreReason: item.scoreReason,
        status: item.status,
        publishedAt: item.publishedAt,
        matches: item.matches.map((m) => ({
          personaName: m.personaName,
          campaignName: m.campaignName,
          score: m.score,
        })),
      })),
    };
  },
};
