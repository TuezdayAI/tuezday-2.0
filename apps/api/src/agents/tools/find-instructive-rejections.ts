import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { rankTexts } from "@tuezday/brain";
import { draftRevisionTurns } from "../../db/schema";
import { listTrainingExamples, type TrainingExample } from "../../services/learning";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.find_instructive_rejections;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 3;
const CONTENT_CHARS = 400;
const INSTRUCTION_CHARS = 200;
const INSTRUCTIONS_PER_DRAFT = 3;

function instructiveExamples(examples: TrainingExample[]): TrainingExample[] {
  return examples.filter(
    (e) =>
      e.decision === "rejected" ||
      e.rating === "rejected" ||
      e.rating === "needs_edit" ||
      // Approved-after-edit: the content delta IS the instruction.
      e.wasEdited,
  );
}

/**
 * What humans rejected or corrected, and why — the "why" reconstructed from
 * what the schema actually holds: approval_decisions has no reason column,
 * so the signals are (a) the original-vs-final content delta on edited
 * drafts and (b) the human's conversational-editor instructions
 * (draft_revision_turns.instruction), the only written rationale that exists.
 */
export const findInstructiveRejectionsTool: Tool<Input, unknown> = {
  name: "find_instructive_rejections",
  description:
    "Learn from past mistakes before drafting: outputs humans rejected, rated needs-edit, or edited before approving. Each result carries the content, the human's edit (original vs final when edited), and any revision instructions the human gave the editor. Optionally filter by taskType/channel or rank by a query.",
  input,
  access: "read",
  async run(ctx, { query, taskType, channel, limit }) {
    const candidates = instructiveExamples(listTrainingExamples(ctx.db, ctx.workspaceId))
      .filter((e) => !taskType || e.taskType === taskType)
      .filter((e) => !channel || e.channel === channel);
    if (candidates.length === 0) {
      return { rejections: [], note: "No rejected or corrected outputs with these filters yet." };
    }

    let chosen = candidates;
    let unmatchedQuery = false;
    if (query) {
      const ranked = rankTexts(
        query,
        candidates.map((e) => ({ id: `${e.kind}:${e.id}`, text: e.content })),
      );
      if (ranked.length > 0) {
        const byId = new Map(candidates.map((e) => [`${e.kind}:${e.id}`, e]));
        chosen = ranked.map((r) => byId.get(r.id)!);
      } else {
        unmatchedQuery = true; // fall back to recency below
      }
    }
    const kept = chosen.slice(0, limit ?? DEFAULT_LIMIT);

    // The human's written editing instructions, where any exist.
    const draftIds = kept.filter((e) => e.kind === "decision").map((e) => e.id);
    const turnsByDraft = new Map<string, string[]>();
    if (draftIds.length > 0) {
      const turns = ctx.db
        .select({
          draftId: draftRevisionTurns.draftId,
          instruction: draftRevisionTurns.instruction,
        })
        .from(draftRevisionTurns)
        .where(
          and(
            eq(draftRevisionTurns.workspaceId, ctx.workspaceId),
            inArray(draftRevisionTurns.draftId, draftIds),
          ),
        )
        .orderBy(draftRevisionTurns.createdAt)
        .all();
      for (const turn of turns) {
        const list = turnsByDraft.get(turn.draftId) ?? [];
        if (list.length < INSTRUCTIONS_PER_DRAFT) {
          list.push(compactText(turn.instruction, INSTRUCTION_CHARS));
        }
        turnsByDraft.set(turn.draftId, list);
      }
    }

    return {
      rejections: kept.map((e) => ({
        taskType: e.taskType,
        channel: e.channel,
        outcome: e.decision ?? e.rating,
        wasEdited: e.wasEdited,
        content: compactText(e.content, CONTENT_CHARS),
        ...(e.originalContent
          ? { originalContent: compactText(e.originalContent, CONTENT_CHARS) }
          : {}),
        humanInstructions: e.kind === "decision" ? (turnsByDraft.get(e.id) ?? []) : [],
        createdAt: e.createdAt,
      })),
      ...(unmatchedQuery
        ? { note: "No result matched the query terms; returning the most recent corrections instead." }
        : {}),
    };
  },
};
