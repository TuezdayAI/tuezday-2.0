import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { rankTexts } from "@tuezday/brain";
import { listTrainingExamples, type TrainingExample } from "../../services/learning";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.find_similar_approved_drafts;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 3;
const CONTENT_CHARS = 600;

function approvedExamples(examples: TrainingExample[]): TrainingExample[] {
  return examples.filter((e) => e.decision === "approved" || e.rating === "accepted");
}

/**
 * Human-approved outputs that resemble a query — style anchors for new
 * drafts. BM25-ranked (lexical, drafts carry no embeddings — stated in the
 * spec, not implied semantic parity with search_evidence); falls back to the
 * most recent approvals when nothing scores.
 */
export const findSimilarApprovedDraftsTool: Tool<Input, unknown> = {
  name: "find_similar_approved_drafts",
  description:
    "Find previously approved (human-accepted) drafts most similar to a query — use as style and structure anchors when drafting new content. Optionally filter by taskType or channel. wasEdited=true means a human polished it before approving; those edits are the voice to imitate.",
  input,
  access: "read",
  async run(ctx, { query, taskType, channel, limit }) {
    const candidates = approvedExamples(listTrainingExamples(ctx.db, ctx.workspaceId))
      .filter((e) => !taskType || e.taskType === taskType)
      .filter((e) => !channel || e.channel === channel);
    if (candidates.length === 0) {
      return { drafts: [], note: "No approved outputs with these filters yet." };
    }

    const ranked = rankTexts(
      query,
      candidates.map((e) => ({ id: `${e.kind}:${e.id}`, text: e.content })),
    );
    const byId = new Map(candidates.map((e) => [`${e.kind}:${e.id}`, e]));
    // BM25 finds nothing when no term matched — most recent approvals are
    // still useful style anchors, so fall back to recency with a note.
    const chosen =
      ranked.length > 0 ? ranked.map((r) => byId.get(r.id)!) : candidates;

    return {
      drafts: chosen.slice(0, limit ?? DEFAULT_LIMIT).map((e) => ({
        taskType: e.taskType,
        channel: e.channel,
        content: compactText(e.content, CONTENT_CHARS),
        wasEdited: e.wasEdited,
        approvedVia: e.kind === "decision" ? "approval" : "rating",
        createdAt: e.createdAt,
      })),
      ...(ranked.length === 0
        ? { note: "No approved draft matched the query terms; returning the most recent approvals instead." }
        : {}),
    };
  },
};
