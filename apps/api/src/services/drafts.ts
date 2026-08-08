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
import { capturePreferenceEdit } from "./preference-edits";

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

async function logDecision(
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
  /** Sprint 66 — the human's stated rationale (today: optional on reject). */
  reason: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(approvalDecisions)
    .values({
      id,
      draftId: draft.id,
      workspaceId: draft.workspaceId,
      action,
      fromState,
      toState,
      contentSnapshot,
      contentFingerprint,
      actor: actor.label,
      actorId: actor.userId,
      reason,
      createdAt: Date.now(),
    });
  return id;
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

export async function draftForGeneration(
  db: Db,
  workspaceId: string,
  generationId: string,
): Promise<Draft | undefined> {
  const row = (await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.sourceGenerationId, generationId))))[0];
  return row ? rowToDraft(row) : undefined;
}

/** Create a draft from a generation and submit it into review in one step. */
export async function submitDraft(db: Db, input: SubmitDraftInput, actor: DraftActor): Promise<Draft> {
  return await db.transaction(async (tx) => await submitDraftInTransaction(tx, input, actor));
}

/**
 * Commit a submitted draft inside a caller-owned transaction. This keeps a
 * generated launch unit (generation, draft, approval receipt, message) atomic.
 */
export async function submitDraftInTransaction(
  db: DbExecutor,
  input: SubmitDraftInput,
  actor: DraftActor,
): Promise<Draft> {
  const row = await insertSubmittedDraft(db, input, actor, null, false);
  if (!row) throw new Error("draft_insert_failed");
  return rowToDraft(row);
}

async function insertSubmittedDraft(
  db: DbExecutor,
  input: SubmitDraftInput,
  actor: DraftActor,
  automationKey: string | null,
  ignoreConflict: boolean,
): Promise<DraftRow | null> {
  const now = Date.now();
  const toState = transitionTo("draft", "submit")!;
  // Carry the source generation's pre-review (Sprint 22) onto the draft so the
  // approval queue is self-contained — the review shows in Review without a join.
  const sourceReviewJson = input.sourceGenerationId
    ? (((await db
        .select({ reviewJson: generations.reviewJson })
        .from(generations)
        .where(eq(generations.id, input.sourceGenerationId)))[0])?.reviewJson ?? null)
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
    ? (await insert.onConflictDoNothing().returning())[0]
    : (await insert.returning())[0];
  if (!inserted) return null;
  await logDecision(db, row, actor, "submit", "draft", toState);
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

export async function submitAutomaticDraft(
  db: Db,
  input: SubmitDraftInput & {
    automationKey: string;
    autoApprove: boolean;
  },
  actor: DraftActor,
): Promise<AutomaticDraftCommit> {
  return await db.transaction(async (tx) => {
    const inserted = await insertSubmittedDraft(
      tx,
      input,
      actor,
      input.automationKey,
      true,
    );
    if (!inserted) {
      const existing = (await tx
        .select()
        .from(drafts)
        .where(eq(drafts.automationKey, input.automationKey)))[0];
      if (!existing) throw new Error("automatic_draft_conflict");
      return {
        draft: rowToDraft(existing),
        created: false,
        autoApproved: false,
      };
    }

    let draft = rowToDraft(inserted);
    if (input.autoApprove) {
      draft = await applyDraftActionInTransaction(
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
export async function setDraftMedia(
  db: Db,
  workspaceId: string,
  draftId: string,
  media: LaunchMedia[],
): Promise<Draft | undefined> {
  const row = (await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId))))[0];
  if (!row) return undefined;
  const now = Date.now();
  await db.update(drafts)
    .set({ mediaJson: media.length > 0 ? JSON.stringify(media) : null, updatedAt: now })
    .where(eq(drafts.id, draftId));
  return rowToDraft({ ...row, mediaJson: media.length > 0 ? JSON.stringify(media) : null, updatedAt: now });
}

export async function listDrafts(
  db: Db,
  workspaceId: string,
  state?: ApprovalState,
  campaignId?: string,
): Promise<Draft[]> {
  const conditions = [eq(drafts.workspaceId, workspaceId)];
  if (state) conditions.push(eq(drafts.state, state));
  if (campaignId) conditions.push(eq(drafts.campaignId, campaignId));
  return (await db
    .select()
    .from(drafts)
    .where(and(...conditions))
    .orderBy(desc(drafts.createdAt)))
    .map(rowToDraft);
}

export async function getDraft(db: Db, workspaceId: string, draftId: string): Promise<Draft | undefined> {
  const row = (await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId))))[0];
  return row ? rowToDraft(row) : undefined;
}

export async function listDecisions(db: Db, draftId: string): Promise<ApprovalDecision[]> {
  return (await db
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.draftId, draftId))
    .orderBy(asc(approvalDecisions.createdAt)))
    .map((row) => ({
      ...row,
      action: row.action as ApprovalAction,
      fromState: row.fromState as ApprovalState,
      toState: row.toState as ApprovalState,
    }));
}

/**
 * The human approval that still covers a draft's **current** content, or null
 * when no such approval exists (Sprint 52).
 *
 * Null means one of: the draft is not currently `approved`; it has never been
 * approved; the newest approval was made by the system or a machine
 * credential, which never records a fingerprint (D2a); or the content or media
 * changed since that approval, so the fingerprints no longer match.
 *
 * The identity comes back with the fingerprint because the caller needs to
 * attribute the authorization it collapses to the person who approved — the
 * proposer is frequently the system actor (cadence), and "who authorized this
 * publication?" must still have a human answer.
 *
 * The comparison lives here, not in the caller: it has to be made against the
 * draft's raw `media_json` column, and re-serializing a parsed `media` array
 * instead would typecheck while silently never matching.
 */
export interface CoveringHumanApproval {
  /** sha256 of exactly the content that was approved, and still stands. */
  fingerprint: string;
  /** Display label recorded on the approval decision, e.g. "founder". */
  actor: string;
  /** The approver's user id; null for the email/Telegram one-click links. */
  actorId: string | null;
}

export async function humanApprovalCoveringDraft(
  db: Db,
  workspaceId: string,
  draftId: string,
): Promise<CoveringHumanApproval | null> {
  const draft = (await db
    .select({ state: drafts.state, content: drafts.content, mediaJson: drafts.mediaJson })
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId))))[0];
  if (draft?.state !== "approved") return null;

  const approveAction: ApprovalAction = "approve";
  const latest = (await db
    .select({
      contentFingerprint: approvalDecisions.contentFingerprint,
      actor: approvalDecisions.actor,
      actorId: approvalDecisions.actorId,
    })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.workspaceId, workspaceId),
        eq(approvalDecisions.draftId, draftId),
        eq(approvalDecisions.action, approveAction),
      ),
    )
    // createdAt is millisecond resolution, so two approvals logged in the same
    // millisecond tie. `seq` is monotonic with insertion, so it breaks the tie
    // by true insertion order; the `id` column is a random UUID and would order
    // arbitrarily.
    //
    // Today this tie-break is belt-and-braces: `approved` is terminal in the
    // contracts state machine (no `edit`/`reject` edge out of it), so a draft
    // cannot reach a second approve decision through the API. Sprint 74 kept
    // the term rather than dropping it — `seq` replaced SQLite's rowid, so the
    // invariant survives if an un-approve path is ever added.
    .orderBy(desc(approvalDecisions.createdAt), desc(approvalDecisions.seq)))[0];
  if (!latest?.contentFingerprint) return null;

  const current = draftApprovalFingerprint({
    id: draftId,
    content: draft.content,
    mediaJson: draft.mediaJson,
  });
  if (current !== latest.contentFingerprint) return null;
  return {
    fingerprint: latest.contentFingerprint,
    actor: latest.actor,
    actorId: latest.actorId,
  };
}

/**
 * Apply a state-machine action to a draft. `newContent` is only meaningful
 * for `edit`. Throws InvalidTransitionError if the action is illegal.
 */
export interface ApplyDraftActionOptions {
  /**
   * Sprint 68 — the founder's own words for an `edit`, when the edit came
   * through the conversational editor. The preference-memory capture is keyed
   * off this: both editor turns and hand edits land through this one `edit`
   * transition, so the instruction is what distinguishes the two sources.
   */
  instruction?: string | null;
}

export async function applyDraftAction(
  db: Db,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
  reason?: string,
  options?: ApplyDraftActionOptions,
): Promise<Draft> {
  return await applyDraftActionInTransaction(db, draft, action, actor, newContent, reason, options);
}

/** Apply a draft action through either the root DB or an active transaction. */
export async function applyDraftActionInTransaction(
  db: DraftWriteDb,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
  reason?: string,
  options?: ApplyDraftActionOptions,
): Promise<Draft> {
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
            ((await db
              .select({ mediaJson: drafts.mediaJson })
              .from(drafts)
              .where(and(eq(drafts.workspaceId, draft.workspaceId), eq(drafts.id, draft.id))))[0])?.mediaJson ?? null,
        })
      : null;

  await db.update(drafts)
    .set({ state: toState, content, updatedAt: now })
    .where(eq(drafts.id, draft.id));
  const decisionId = await logDecision(
    db,
    draft,
    actor,
    action,
    draft.state,
    toState,
    action === "edit" ? content : null,
    contentFingerprint,
    reason ?? null,
  );
  // Sprint 68 (D-68.2): capture the correction for preference memory. Human
  // edits only — this same path carries system approvals, the automation tick
  // and the public API, and a machine edit is not a preference. Capture is a
  // plain insert keyed on the decision id, so it is idempotent and adds no
  // latency to the founder's action.
  if (action === "edit" && actor.human && content !== draft.content) {
    await capturePreferenceEdit(db, {
      workspaceId: draft.workspaceId,
      sourceId: decisionId,
      draftId: draft.id,
      taskType: draft.taskType,
      channel: draft.channel,
      beforeContent: draft.content,
      afterContent: content,
      instruction: options?.instruction ?? null,
    });
  }
  return { ...draft, state: toState, content, updatedAt: now };
}
