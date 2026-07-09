import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  transitionTo,
  type ApprovalAction,
  type ApprovalDecision,
  type ApprovalState,
  type Channel,
  type Draft,
  type GenerationReview,
  type LaunchMedia,
  type TaskType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { approvalDecisions, drafts, generations, type DraftRow } from "../db/schema";

/** Who performed a draft action — a user, or the worker's system identity. */
export interface DraftActor {
  userId: string | null;
  label: string;
}

export class InvalidTransitionError extends Error {
  constructor(from: ApprovalState, action: ApprovalAction) {
    super(`Cannot ${action} a draft in state "${from}".`);
    this.name = "InvalidTransitionError";
  }
}

function rowToDraft(row: DraftRow): Draft {
  const { reviewJson, mediaJson, ...rest } = row;
  return {
    ...rest,
    taskType: row.taskType as TaskType,
    channel: row.channel as Channel,
    state: row.state as ApprovalState,
    media: mediaJson ? (JSON.parse(mediaJson) as LaunchMedia[]) : null,
    review: reviewJson ? (JSON.parse(reviewJson) as GenerationReview) : null,
  };
}

function logDecision(
  db: Db,
  draft: { id: string; workspaceId: string },
  actor: DraftActor,
  action: ApprovalAction,
  fromState: ApprovalState,
  toState: ApprovalState,
  contentSnapshot: string | null = null,
): void {
  db.insert(approvalDecisions)
    .values({
      id: randomUUID(),
      draftId: draft.id,
      workspaceId: draft.workspaceId,
      action,
      fromState,
      toState,
      contentSnapshot,
      actor: actor.label,
      actorId: actor.userId,
      createdAt: Date.now(),
    })
    .run();
}

export interface SubmitDraftInput {
  workspaceId: string;
  sourceGenerationId: string;
  sourceSignalId?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  mediaContactId?: string | null;
  taskType: TaskType;
  channel: Channel;
  personaId: string | null;
  content: string;
  /** Rendered visuals (Sprint 41) — carousel/ad-image drafts attach these. */
  media?: LaunchMedia[] | null;
}

export function draftForGeneration(
  db: Db,
  workspaceId: string,
  generationId: string,
): Draft | undefined {
  const row = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.sourceGenerationId, generationId)))
    .get();
  return row ? rowToDraft(row) : undefined;
}

/** Create a draft from a generation and submit it into review in one step. */
export function submitDraft(db: Db, input: SubmitDraftInput, actor: DraftActor): Draft {
  const now = Date.now();
  const toState = transitionTo("draft", "submit")!;
  // Carry the source generation's pre-review (Sprint 22) onto the draft so the
  // approval queue is self-contained — the review shows in Review without a join.
  const sourceReviewJson = input.sourceGenerationId
    ? (db
        .select({ reviewJson: generations.reviewJson })
        .from(generations)
        .where(eq(generations.id, input.sourceGenerationId))
        .get()?.reviewJson ?? null)
    : null;
  const row: DraftRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    sourceGenerationId: input.sourceGenerationId,
    sourceSignalId: input.sourceSignalId ?? null,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    mediaContactId: input.mediaContactId ?? null,
    taskType: input.taskType,
    channel: input.channel,
    personaId: input.personaId,
    originalContent: input.content,
    content: input.content,
    state: toState,
    reviewJson: sourceReviewJson,
    mediaJson: input.media && input.media.length > 0 ? JSON.stringify(input.media) : null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(drafts).values(row).run();
  logDecision(db, row, actor, "submit", "draft", toState);
  return rowToDraft(row);
}

export function listDrafts(
  db: Db,
  workspaceId: string,
  state?: ApprovalState,
  campaignId?: string,
): Draft[] {
  const conditions = [eq(drafts.workspaceId, workspaceId)];
  if (state) conditions.push(eq(drafts.state, state));
  if (campaignId) conditions.push(eq(drafts.campaignId, campaignId));
  return db
    .select()
    .from(drafts)
    .where(and(...conditions))
    .orderBy(desc(drafts.createdAt))
    .all()
    .map(rowToDraft);
}

export function getDraft(db: Db, workspaceId: string, draftId: string): Draft | undefined {
  const row = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .get();
  return row ? rowToDraft(row) : undefined;
}

export function listDecisions(db: Db, draftId: string): ApprovalDecision[] {
  return db
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.draftId, draftId))
    .orderBy(asc(approvalDecisions.createdAt))
    .all()
    .map((row) => ({
      ...row,
      action: row.action as ApprovalAction,
      fromState: row.fromState as ApprovalState,
      toState: row.toState as ApprovalState,
    }));
}

/**
 * Apply a state-machine action to a draft. `newContent` is only meaningful
 * for `edit`. Throws InvalidTransitionError if the action is illegal.
 */
export function applyDraftAction(
  db: Db,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
): Draft {
  const toState = transitionTo(draft.state, action);
  if (!toState) throw new InvalidTransitionError(draft.state, action);

  const now = Date.now();
  const content = action === "edit" && newContent !== undefined ? newContent : draft.content;
  db.update(drafts)
    .set({ state: toState, content, updatedAt: now })
    .where(eq(drafts.id, draft.id))
    .run();
  logDecision(db, draft, actor, action, draft.state, toState, action === "edit" ? content : null);
  return { ...draft, state: toState, content, updatedAt: now };
}
