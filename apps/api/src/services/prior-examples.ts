// Sprint 66 (PRD Move 4b): retrieval few-shot from the workspace's own
// approval history — the most similar approved outputs and the most
// instructive rejections, with the best available "why" for each rejection.
// Leaf module by design: learning + drizzle only, no agent imports (the
// Sprint 65 import-cycle lesson), so the resolver seam and the pipeline
// engine can both call it without closing a loop through agents/tools.

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Channel, TaskType } from "@tuezday/contracts";
import { rankTexts, type ResolveExamples } from "@tuezday/brain";
import type { Db } from "../db";
import { approvalDecisions, draftRevisionTurns } from "../db/schema";
import { listTrainingExamples, type TrainingExample } from "./learning";

const APPROVED_LIMIT = 3;
const REJECTED_LIMIT = 2;
const CONTENT_CHARS = 600;
const REASON_CHARS = 300;

export interface PriorExamplesQuery {
  /** Similarity query — typically the triggering signal's content. */
  query: string;
  channel?: Channel;
  taskType?: TaskType;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function isApproved(e: TrainingExample): boolean {
  return e.decision === "approved" || e.rating === "accepted";
}

function isInstructive(e: TrainingExample): boolean {
  return (
    e.decision === "rejected" ||
    e.rating === "rejected" ||
    e.rating === "needs_edit" ||
    // Approved-after-edit: the content delta is itself the lesson.
    e.wasEdited
  );
}

function outcomeOf(e: TrainingExample): string {
  if (e.decision === "rejected" || e.rating === "rejected") return "rejected";
  if (e.rating === "needs_edit") return "needs edit";
  return "edited before approval";
}

/** BM25-rank candidates by the query; recency (list order) when nothing scores. */
function rankOrRecency(query: string, candidates: TrainingExample[]): TrainingExample[] {
  const ranked = rankTexts(
    query,
    candidates.map((e) => ({ id: `${e.kind}:${e.id}`, text: e.content })),
  );
  if (ranked.length === 0) return candidates;
  const byId = new Map(candidates.map((e) => [`${e.kind}:${e.id}`, e]));
  const hits = ranked.map((r) => byId.get(r.id)!);
  // BM25 only returns term matches — append the rest in recency order so a
  // sparse match never starves the example slots.
  const seen = new Set(hits.map((e) => `${e.kind}:${e.id}`));
  return [...hits, ...candidates.filter((e) => !seen.has(`${e.kind}:${e.id}`))];
}

/**
 * The best available "why" per rejected draft, in preference order: the
 * stored reject reason (Sprint 66), else the human's conversational-editor
 * instructions — the only written rationale that existed before Sprint 66.
 */
async function reasonsFor(db: Db, workspaceId: string, draftIds: string[]): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  if (draftIds.length === 0) return reasons;
  const decisionRows = await db
    .select({
      draftId: approvalDecisions.draftId,
      reason: approvalDecisions.reason,
    })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.workspaceId, workspaceId),
        inArray(approvalDecisions.draftId, draftIds),
        eq(approvalDecisions.action, "reject"),
        isNotNull(approvalDecisions.reason),
      ),
    )
    .orderBy(desc(approvalDecisions.createdAt))
    .all();
  for (const row of decisionRows) {
    if (!reasons.has(row.draftId) && row.reason) {
      reasons.set(row.draftId, clip(row.reason, REASON_CHARS));
    }
  }
  const missing = draftIds.filter((id) => !reasons.has(id));
  if (missing.length === 0) return reasons;
  const turns = await db
    .select({
      draftId: draftRevisionTurns.draftId,
      instruction: draftRevisionTurns.instruction,
    })
    .from(draftRevisionTurns)
    .where(
      and(
        eq(draftRevisionTurns.workspaceId, workspaceId),
        inArray(draftRevisionTurns.draftId, missing),
      ),
    )
    .orderBy(draftRevisionTurns.createdAt)
    .all();
  for (const turn of turns) {
    if (!reasons.has(turn.draftId)) {
      reasons.set(turn.draftId, clip(turn.instruction, REASON_CHARS));
    }
  }
  return reasons;
}

/**
 * Retrieve the few-shot bundle: up to 3 most similar approved outputs and the
 * 2 most instructive rejections. "Most instructive" = has a written why
 * first, then similarity. Returns null when the workspace has no usable
 * history under these filters — the caller supplies the exclusion reason.
 */
export async function retrievePriorExamples(
  db: Db,
  workspaceId: string,
  input: PriorExamplesQuery,
): Promise<ResolveExamples | null> {
  const all = (await listTrainingExamples(db, workspaceId))
    .filter((e) => !input.taskType || e.taskType === input.taskType)
    .filter((e) => !input.channel || e.channel === input.channel);

  const approved = rankOrRecency(input.query, all.filter(isApproved)).slice(
    0,
    APPROVED_LIMIT,
  );

  // Reason lookup is two IN queries — bound the candidate pool so a large
  // workspace never fans a workspace-wide id list into SQLite.
  const rejectedCandidates = rankOrRecency(input.query, all.filter(isInstructive)).slice(0, 20);
  const reasons = await reasonsFor(
    db,
    workspaceId,
    rejectedCandidates.filter((e) => e.kind === "decision").map((e) => e.id),
  );
  const rejected = rejectedCandidates
    .map((e, index) => ({
      example: e,
      index,
      reason: e.kind === "decision" ? (reasons.get(e.id) ?? null) : null,
    }))
    // A written why teaches more than similarity does — reasoned first.
    .sort((a, b) => Number(b.reason !== null) - Number(a.reason !== null) || a.index - b.index)
    .slice(0, REJECTED_LIMIT);

  if (approved.length === 0 && rejected.length === 0) return null;
  return {
    query: input.query,
    approved: approved.map((e) => ({
      content: clip(e.content, CONTENT_CHARS),
      wasEdited: e.wasEdited,
    })),
    rejected: rejected.map(({ example, reason }) => ({
      content: clip(example.content, CONTENT_CHARS),
      reason,
      outcome: outcomeOf(example),
    })),
  };
}
