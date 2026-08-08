// Sprint 68 (PRD Move 5): capture — a human correction becomes a durable,
// digestible row. Deterministic and synchronous by design (D-68.3): the row is
// the queue, the extraction tick is the consumer, and no LLM call ever sits in
// the founder's approval path.
//
// Leaf module (D-68.10): drizzle + contracts + edit-distance only. `drafts.ts`
// calls it from inside a transaction and the extraction service reads it, so
// it must not reach back into either.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  PREFERENCE_MIN_EDIT_DISTANCE,
  preferenceEditSchema,
  type Channel,
  type PreferenceEdit,
  type PreferenceEditSource,
  type TaskType,
} from "@tuezday/contracts";
import { type Db, type DbExecutor, rowsAffected } from "../db";
import { preferenceEdits, type PreferenceEditRow } from "../db/schema";
import { normalizedEditDistance } from "./edit-distance";
type PreferenceWriteDb = Pick<DbExecutor, "insert" | "select">;

export function rowToPreferenceEdit(row: PreferenceEditRow): PreferenceEdit {
  return preferenceEditSchema.parse({
    ...row,
    source: row.source as PreferenceEditSource,
    taskType: row.taskType as TaskType,
    channel: row.channel as Channel,
  });
}

export interface CapturePreferenceEditInput {
  workspaceId: string;
  /** Decision id — stable, unique per edit, and what makes capture idempotent. */
  sourceId: string;
  draftId: string;
  taskType: TaskType;
  channel: Channel;
  beforeContent: string;
  afterContent: string;
  /**
   * The founder's own words for the correction. Present only when the edit came
   * through the conversational editor — which is also what distinguishes the
   * two sources, since both land through the same `edit` transition.
   */
  instruction?: string | null;
}

/**
 * Record one human correction. Returns null when there is nothing to learn:
 * a below-threshold diff is whitespace, not taste (`PREFERENCE_MIN_EDIT_DISTANCE`).
 * Re-recording the same `sourceId` is a no-op, so a retried transaction cannot
 * double-count an edit into a rule's observation count.
 */
export async function capturePreferenceEdit(
  db: PreferenceWriteDb,
  input: CapturePreferenceEditInput,
  now = Date.now(),
): Promise<PreferenceEdit | null> {
  const before = input.beforeContent;
  const after = input.afterContent;
  const distance = normalizedEditDistance(before, after);
  if (distance < PREFERENCE_MIN_EDIT_DISTANCE) return null;

  const instruction = input.instruction?.trim() ? input.instruction.trim() : null;
  const row: PreferenceEditRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    source: instruction ? "editor_turn" : "draft_edit",
    sourceId: input.sourceId,
    draftId: input.draftId,
    taskType: input.taskType,
    channel: input.channel,
    beforeContent: before,
    afterContent: after,
    instruction,
    editDistance: distance,
    digestedAt: null,
    createdAt: now,
  };
  const inserted = await db
    .insert(preferenceEdits)
    .values(row)
    .onConflictDoNothing({
      target: [preferenceEdits.workspaceId, preferenceEdits.source, preferenceEdits.sourceId],
    });
  if (rowsAffected(inserted) === 0) return null;
  return rowToPreferenceEdit(row);
}

export interface ListPreferenceEditsOptions {
  digested?: boolean;
  limit?: number;
}

export async function listPreferenceEdits(
  db: Db,
  workspaceId: string,
  options: ListPreferenceEditsOptions = {},
): Promise<PreferenceEdit[]> {
  const digestedFilter =
    options.digested === undefined
      ? undefined
      : options.digested
        ? isNotNull(preferenceEdits.digestedAt)
        : isNull(preferenceEdits.digestedAt);
  return (await db
    .select()
    .from(preferenceEdits)
    .where(and(eq(preferenceEdits.workspaceId, workspaceId), digestedFilter))
    .orderBy(desc(preferenceEdits.createdAt))
    .limit(options.limit ?? 50))
    .map(rowToPreferenceEdit);
}

/** Oldest-first, so a backlog is digested in the order the founder made it. */
export async function listUndigestedEdits(db: Db, workspaceId: string, limit: number): Promise<PreferenceEdit[]> {
  return (await db
    .select()
    .from(preferenceEdits)
    .where(and(eq(preferenceEdits.workspaceId, workspaceId), isNull(preferenceEdits.digestedAt)))
    .orderBy(asc(preferenceEdits.createdAt))
    .limit(limit))
    .map(rowToPreferenceEdit);
}

export async function getPreferenceEdit(
  db: Db,
  workspaceId: string,
  editId: string,
): Promise<PreferenceEdit | undefined> {
  const row = (await db
    .select()
    .from(preferenceEdits)
    .where(and(eq(preferenceEdits.workspaceId, workspaceId), eq(preferenceEdits.id, editId))))[0];
  return row ? rowToPreferenceEdit(row) : undefined;
}

/**
 * Stamp edits as read. Called for every edit a pass touched — including ones
 * that taught nothing and ones whose extraction call failed — so a single
 * poisonous diff can never wedge the loop behind it.
 */
export async function markEditsDigested(db: Db, editIds: string[], now = Date.now()): Promise<void> {
  for (const editId of editIds) {
    await db.update(preferenceEdits)
      .set({ digestedAt: now })
      .where(eq(preferenceEdits.id, editId));
  }
}
