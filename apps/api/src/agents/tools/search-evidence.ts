import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { retrieveEvidence } from "../../services/evidence";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.search_evidence;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 5;
const CHUNK_CHARS = 600;

/**
 * Workspace-scoped search over the evidence corpus, through the Tuezday
 * retrieval POLICY (blended similarity + recency + source weighting, per-doc
 * cap, near-duplicate dedup) — the same view generation gets, not a raw
 * store search. Sprint 57 registry upgrade of the Sprint 56 proof tool.
 */
export const searchEvidenceTool: Tool<Input, unknown> = {
  name: "search_evidence",
  description:
    "Search the workspace's evidence corpus (uploaded documents, saved research, published content) for passages relevant to a query. Returns the best-matching excerpts with their source document titles and relevance scores.",
  input,
  access: "read",
  async run(ctx, { query, limit }) {
    // The free query rides in as signalContent — the highest-priority term in
    // the retrieval query composer (same approach as the Sprint 42 copilot).
    const resolution = await retrieveEvidence(
      ctx.db,
      ctx.evidence,
      ctx.workspaceId,
      { taskType: "outbound_email", channel: "email", signalContent: query },
      true,
    );
    if (!resolution.evidence || resolution.evidence.chunks.length === 0) {
      return { results: [], note: resolution.exclusionReason ?? "No matching evidence." };
    }
    const results = resolution.evidence.chunks.slice(0, limit ?? DEFAULT_LIMIT).map((chunk) => ({
      title: chunk.title,
      kind: chunk.kind,
      text: compactText(chunk.text, CHUNK_CHARS),
      score: Number(chunk.score.toFixed(3)),
      // Provenance — the copilot builds its evidence citations from this.
      documentId: chunk.documentId,
    }));
    return { results };
  },
};
