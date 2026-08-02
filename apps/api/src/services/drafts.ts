import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
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
import type { Db, DbExecutor } from "../db";
import { approvalDecisions, drafts, generations, type DraftRow } from "../db/schema";
import { draftApprovalFingerprint } from "./draft-approval-fingerprint";

// `select` is needed alongside the writes so an approval can read the draft's
// stored mediaJson to fingerprint it, without widening the public Draft type.
type DraftWriteDb = Pick<DbExecutor, "insert" | "update" | "select">;

/** Who performed a draft action — a user, or the worker's system identity. */
export interface DraftActor {
  userId: string | null;
  label: string;
  /**
   * Sprint 52 (D2c) — was this decision made by a person?
   *
   * Deliberately explicit and required: it cannot be inferred from `userId`
   * (the signed email and Telegram approve links carry no user id yet are a
   * founder pressing a button) and must never be sniffed from `label`, which
   * is display copy and would break silently when reworded. A new call site
   * has to state which it is.
   *
   * Humans: a signed-in user, the email one-click approver, the Telegram
   * approver. Not humans: the system/worker actor and the public-API machine
   * credential. Only a human approval records a content fingerprint, which is
   * what keeps `autoApprove` and API keys from collapsing the publish gate.
   */
  human: boolean;
}

export class InvalidTransitionError extends Error {
  constructor(from: ApprovalState, action: ApprovalAction) {
    super(`Cannot ${action} a draft in state "${from}".`);
    this.name = "InvalidTransitionError";
  }
}

function rowToDraft(row: DraftRow): Draft {
  const {
    automationKey: _automationKey,
    reviewJson,
    mediaJson,
    ...rest
  } = row;
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
  db: DraftWriteDb,
  draft: { id: string; workspaceId: string },
  actor: DraftActor,
  action: ApprovalAction,
  fromState: ApprovalState,
  toState: ApprovalState,
  contentSnapshot: string | null = null,
  /**
   * Sprint 52 — sha256 of exactly what was approved. Callers pass this only
   * for a human `approve`; everything else leaves it null.
   */
  contentFingerprint: string | null = null,
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
      contentFingerprint,
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
  return db.transaction((tx) => {
    const row = insertSubmittedDraft(tx, input, actor, null, false);
    if (!row) throw new Error("draft_insert_failed");
    return rowToDraft(row);
  });
}

function insertSubmittedDraft(
  db: DbExecutor,
  input: SubmitDraftInput,
  actor: DraftActor,
  automationKey: string | null,
  ignoreConflict: boolean,
): DraftRow | null {
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
    automationKey,
    reviewJson: sourceReviewJson,
    mediaJson: input.media && input.media.length > 0 ? JSON.stringify(input.media) : null,
    createdAt: now,
    updatedAt: now,
  };
  const insert = db.insert(drafts).values(row);
  const inserted = ignoreConflict
    ? insert.onConflictDoNothing().returning().get()
    : insert.returning().get();
  if (!inserted) return null;
  logDecision(db, row, actor, "submit", "draft", toState);
  return inserted;
}

export function automaticDraftKey(input: {
  workspaceId: string;
  signalId: string;
  campaignId: string;
  channel: Channel;
}): string {
  return [
    "automation:v1",
    input.workspaceId,
    input.signalId,
    input.campaignId,
    input.channel,
  ].join(":");
}

export interface AutomaticDraftCommit {
  draft: Draft;
  created: boolean;
  autoApproved: boolean;
}

export function submitAutomaticDraft(
  db: Db,
  input: SubmitDraftInput & {
    automationKey: string;
    autoApprove: boolean;
  },
  actor: DraftActor,
): AutomaticDraftCommit {
  return db.transaction((tx) => {
    const inserted = insertSubmittedDraft(
      tx,
      input,
      actor,
      input.automationKey,
      true,
    );
    if (!inserted) {
      const existing = tx
        .select()
        .from(drafts)
        .where(eq(drafts.automationKey, input.automationKey))
        .get();
      if (!existing) throw new Error("automatic_draft_conflict");
      return {
        draft: rowToDraft(existing),
        created: false,
        autoApproved: false,
      };
    }

    let draft = rowToDraft(inserted);
    if (input.autoApprove) {
      draft = applyDraftActionInTransaction(
        tx,
        draft,
        "approve",
        actor,
      );
    }
    return {
      draft,
      created: true,
      autoApproved: input.autoApprove,
    };
  });
}

/** Attach rendered visuals to an existing draft (Sprint 41 Part 5). */
export function setDraftMedia(
  db: Db,
  workspaceId: string,
  draftId: string,
  media: LaunchMedia[],
): Draft | undefined {
  const row = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .get();
  if (!row) return undefined;
  const now = Date.now();
  db.update(drafts)
    .set({ mediaJson: media.length > 0 ? JSON.stringify(media) : null, updatedAt: now })
    .where(eq(drafts.id, draftId))
    .run();
  return rowToDraft({ ...row, mediaJson: media.length > 0 ? JSON.stringify(media) : null, updatedAt: now });
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
 * The fingerprint of the content a **human** most recently approved for this
 * draft, or null when the approval cannot authorize anything on its own
 * (Sprint 52).
 *
 * Null means one of: the draft is not currently `approved`; it has never been
 * approved; or the newest approval was made by the system actor, which never
 * records a fingerprint (D2a).
 *
 * The caller compares the result against `draftApprovalFingerprint(draft)` —
 * a mismatch means the content changed after approval.
 */
export function latestHumanApprovalFingerprint(
  db: Db,
  workspaceId: string,
  draftId: string,
): string | null {
  const draft = db
    .select({ state: drafts.state })
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)))
    .get();
  if (draft?.state !== "approved") return null;

  const approveAction: ApprovalAction = "approve";
  const latest = db
    .select({ contentFingerprint: approvalDecisions.contentFingerprint })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.workspaceId, workspaceId),
        eq(approvalDecisions.draftId, draftId),
        eq(approvalDecisions.action, approveAction),
      ),
    )
    // createdAt is millisecond resolution, so two approvals logged in the same
    // millisecond tie. SQLite's implicit rowid is monotonic with insertion, so
    // it breaks the tie by true insertion order; the `id` column is a random
    // UUID and would order arbitrarily.
    //
    // Today this tie-break is belt-and-braces: `approved` is terminal in the
    // contracts state machine (no `edit`/`reject` edge out of it), so a draft
    // cannot reach a second approve decision through the API. Whoever migrates
    // this to Postgres may simply drop the rowid term rather than hunt for an
    // equivalent — unless an un-approve path has been added by then.
    .orderBy(desc(approvalDecisions.createdAt), sql`${approvalDecisions}.rowid desc`)
    .get();
  return latest?.contentFingerprint ?? null;
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
  return applyDraftActionInTransaction(db, draft, action, actor, newContent);
}

/** Apply a draft action through either the root DB or an active transaction. */
export function applyDraftActionInTransaction(
  db: DraftWriteDb,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
): Draft {
  const toState = transitionTo(draft.state, action);
  if (!toState) throw new InvalidTransitionError(draft.state, action);

  const now = Date.now();
  const content = action === "edit" && newContent !== undefined ? newContent : draft.content;

  // Sprint 52: record what a human approved, so a later publish can tell
  // whether the approval still covers the current content. Human approvals
  // only (see DraftActor.human) — a system/auto-approval or a public-API
  // approval leaves this null, which is what keeps `autoApprove` and machine
  // credentials from silently turning `human_required` into autonomous
  // publishing (D2a). Media comes from the stored row: reconstructing it from
  // the parsed Draft could re-serialize differently and break the match.
  const contentFingerprint =
    action === "approve" && actor.human
      ? draftApprovalFingerprint({
          id: draft.id,
          content,
          mediaJson:
            db
              .select({ mediaJson: drafts.mediaJson })
              .from(drafts)
              .where(and(eq(drafts.workspaceId, draft.workspaceId), eq(drafts.id, draft.id)))
              .get()?.mediaJson ?? null,
        })
      : null;

  db.update(drafts)
    .set({ state: toState, content, updatedAt: now })
    .where(eq(drafts.id, draft.id))
    .run();
  logDecision(
    db,
    draft,
    actor,
    action,
    draft.state,
    toState,
    action === "edit" ? content : null,
    contentFingerprint,
  );
  return { ...draft, state: toState, content, updatedAt: now };
}
