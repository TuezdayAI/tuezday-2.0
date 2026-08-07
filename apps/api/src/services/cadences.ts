import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type {
  CadenceStatus,
  Channel,
  CreatePostingCadenceInput,
  Publication,
  PostingCadence,
  UpdatePostingCadenceInput,
} from "@tuezday/contracts";
import { canTransitionExternalAction } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  externalActions,
  postingCadences,
  publications,
  type PostingCadenceRow,
} from "../db/schema";
import {
  checkPostGuardrails,
  getSocialAutomationSettings,
} from "./automation";
import { getCampaign } from "./campaigns";
import { localDateAt, resolveWallClock, zonedDateBounds } from "./civil-time";
import { getConnection } from "./connections";
import { listDrafts } from "./drafts";
import {
  ExternalActionPreparationError,
  preparePublicationAction,
} from "./external-action-adapters";
import type {
  ExternalActionRuntime,
  ExternalActionRuntimeActor,
} from "./external-action-coordinator";
import {
  humanRefusedActionIds,
  insertExternalActionDecision,
  rowToExternalAction,
  transitionExternalAction,
} from "./external-actions";
import { listCadencePublications } from "./publications";

/** Cadence fills and the cadence's own bulk cancellations are the system's. */
const SYSTEM_ACTOR: ExternalActionRuntimeActor = { userId: null, label: "system", human: false };

/** Why a pending cadence post was cancelled without anyone deciding about it. */
export const KILL_SWITCH_STOP_REASON =
  "Stopped by the social automation kill switch. Not a decision about this post — turning the kill switch off returns the draft to the queue.";
export const CADENCE_DELETED_REASON = "The posting cadence was deleted.";

/** How far ahead a fill looks for open slots. */
export const CADENCE_HORIZON_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Timezone-correct slot math. Temporal is owned by the civil-time leaf so DST
// gaps and overlaps have one explicit policy across scheduling and guardrails.
// ---------------------------------------------------------------------------

interface LocalDate {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, matching JS Date.getUTCDay(). */
  weekday: number;
}

export function localDate(timeZone: string, ms: number): LocalDate {
  return localDateAt(ms, timeZone);
}

/** The UTC instant of a wall-clock time in a given zone (DST-aware). */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const resolved = resolveWallClock({ year, month, day, hour, minute, timeZone });
  if (!resolved.ok) {
    const localDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const timeOfDay = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    throw new RangeError(
      `${timeOfDay} does not exist on ${localDate} in ${timeZone}.`,
    );
  }
  return resolved.instantMs;
}

export interface CadenceSlotIssue {
  code: "nonexistent_local_time";
  localDate: string;
  timeOfDay: string;
  timezone: string;
  message: string;
}

export interface DetailedSlots {
  slots: number[];
  issues: CadenceSlotIssue[];
}

/**
 * Every cadence slot instant in (fromMs, toMs]. Walks the window in 12h steps
 * (well under any DST day length) and considers each distinct local date once.
 */
export function slotsBetweenDetailed(
  cadence: Pick<PostingCadence, "daysOfWeek" | "timeOfDay" | "timezone">,
  fromMs: number,
  toMs: number,
): DetailedSlots {
  if (toMs <= fromMs || cadence.daysOfWeek.length === 0) return { slots: [], issues: [] };
  const days = new Set(cadence.daysOfWeek);
  const [hh, mm] = cadence.timeOfDay.split(":").map(Number);
  const result: number[] = [];
  const issues: CadenceSlotIssue[] = [];
  const seen = new Set<string>();
  const STEP = 12 * 60 * 60 * 1000;
  for (let cursor = fromMs; cursor <= toMs + DAY_MS; cursor += STEP) {
    const lp = localDate(cadence.timezone, cursor);
    const key = `${lp.year}-${lp.month}-${lp.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!days.has(lp.weekday)) continue;
    const resolved = resolveWallClock({
      year: lp.year,
      month: lp.month,
      day: lp.day,
      hour: hh!,
      minute: mm!,
      timeZone: cadence.timezone,
    });
    if (!resolved.ok) {
      const bounds = zonedDateBounds(lp, cadence.timezone);
      if (bounds.end > fromMs && bounds.start <= toMs) {
        const localDate = `${lp.year}-${String(lp.month).padStart(2, "0")}-${String(lp.day).padStart(2, "0")}`;
        issues.push({
          code: "nonexistent_local_time",
          localDate,
          timeOfDay: cadence.timeOfDay,
          timezone: cadence.timezone,
          message: `${cadence.timeOfDay} does not exist on ${localDate} in ${cadence.timezone}.`,
        });
      }
      continue;
    }
    if (resolved.instantMs > fromMs && resolved.instantMs <= toMs) {
      result.push(resolved.instantMs);
    }
  }
  return {
    slots: [...new Set(result)].sort((a, b) => a - b),
    issues,
  };
}

export function slotsBetween(
  cadence: Pick<PostingCadence, "daysOfWeek" | "timeOfDay" | "timezone">,
  fromMs: number,
  toMs: number,
): number[] {
  return slotsBetweenDetailed(cadence, fromMs, toMs).slots;
}

/** First line of the draft, the post title for platforms that need one (Reddit). */
export function deriveTitle(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "Untitled post").slice(0, 300);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function rowToCadence(row: PostingCadenceRow): PostingCadence {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    campaignId: row.campaignId,
    personaId: row.personaId,
    channel: row.channel as Channel,
    connectionId: row.connectionId,
    target: row.target,
    daysOfWeek: JSON.parse(row.daysOfWeekJson) as number[],
    timeOfDay: row.timeOfDay,
    timezone: row.timezone,
    status: row.status as CadenceStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCadenceRows(db: Db, workspaceId: string): PostingCadence[] {
  return db
    .select()
    .from(postingCadences)
    .where(eq(postingCadences.workspaceId, workspaceId))
    .orderBy(asc(postingCadences.createdAt))
    .all()
    .map(rowToCadence);
}

export function getCadence(
  db: Db,
  workspaceId: string,
  cadenceId: string,
): PostingCadence | undefined {
  const row = db
    .select()
    .from(postingCadences)
    .where(and(eq(postingCadences.workspaceId, workspaceId), eq(postingCadences.id, cadenceId)))
    .get();
  return row ? rowToCadence(row) : undefined;
}

export function createCadence(
  db: Db,
  workspaceId: string,
  input: CreatePostingCadenceInput & { connectionId: string },
): PostingCadence {
  const now = Date.now();
  const row: PostingCadenceRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    campaignId: input.campaignId,
    personaId: input.personaId ?? null,
    channel: input.channel,
    connectionId: input.connectionId,
    target: input.target,
    daysOfWeekJson: JSON.stringify(input.daysOfWeek),
    timeOfDay: input.timeOfDay,
    timezone: input.timezone,
    status: input.status,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(postingCadences).values(row).run();
  return rowToCadence(row);
}

export function updateCadence(
  db: Db,
  workspaceId: string,
  cadenceId: string,
  input: UpdatePostingCadenceInput,
): PostingCadence | undefined {
  const existing = getCadence(db, workspaceId, cadenceId);
  if (!existing) return undefined;
  const patch: Partial<PostingCadenceRow> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.campaignId !== undefined) patch.campaignId = input.campaignId;
  if (input.personaId !== undefined) patch.personaId = input.personaId;
  if (input.channel !== undefined) patch.channel = input.channel;
  if (input.connectionId !== undefined) patch.connectionId = input.connectionId;
  if (input.target !== undefined) patch.target = input.target;
  if (input.daysOfWeek !== undefined) patch.daysOfWeekJson = JSON.stringify(input.daysOfWeek);
  if (input.timeOfDay !== undefined) patch.timeOfDay = input.timeOfDay;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.status !== undefined) patch.status = input.status;
  db.update(postingCadences).set(patch).where(eq(postingCadences.id, cadenceId)).run();
  return getCadence(db, workspaceId, cadenceId);
}

/**
 * Delete a cadence. Its still-`scheduled` publications are removed first so a
 * deleted cadence never fires a surprise post; published history is kept (its
 * cadence link is nulled).
 */
export function deleteCadence(db: Db, workspaceId: string, cadenceId: string): boolean {
  const existing = getCadence(db, workspaceId, cadenceId);
  if (!existing) return false;
  db.delete(publications)
    .where(and(eq(publications.cadenceId, cadenceId), eq(publications.status, "scheduled")))
    .run();
  db.update(publications)
    .set({ cadenceId: null })
    .where(eq(publications.cadenceId, cadenceId))
    .run();
  cancelPendingActionsForCadence(db, workspaceId, cadenceId, CADENCE_DELETED_REASON);
  db.delete(postingCadences)
    .where(and(eq(postingCadences.workspaceId, workspaceId), eq(postingCadences.id, cadenceId)))
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Matching + fill
// ---------------------------------------------------------------------------

/** Every publish action this cadence has created, in any status. */
function cadenceActions(db: Db, workspaceId: string, cadenceId: string) {
  return db
    .select()
    .from(externalActions)
    .where(and(eq(externalActions.workspaceId, workspaceId), eq(externalActions.kind, "publish")))
    .all()
    .map((row) => ({
      action: rowToExternalAction(row),
      payload: JSON.parse(row.payloadJson) as { cadenceId?: string | null; draftId?: string },
    }))
    .filter(({ payload }) => payload.cadenceId === cadenceId);
}

/** This cadence's actions that are still on their way out of the building. */
function pendingCadenceActions(db: Db, workspaceId: string, cadenceId: string) {
  return cadenceActions(db, workspaceId, cadenceId).filter(
    ({ action }) => action.status !== "cancelled" && action.status !== "stale",
  );
}

/**
 * Draft ids this cadence must not pick up again.
 *
 * A `cancelled` action counts only when a *person* refused it (Sprint 52
 * review, narrowed by its follow-up). A collapsed publish is authorized without
 * a second click, so withdrawing it is the only human "no" available — and if
 * the next fill re-slotted the same draft it would collapse again and publish,
 * making the withdrawal meaningless. Consequence, and it is intended: a
 * withdrawn draft does not return to this cadence unless it is re-queued.
 *
 * A cancellation the *system* made is a different statement. The automation
 * kill switch cancels this cadence's pending posts in bulk to stop the queue
 * now; it says nothing about any particular draft, and it is meant to be
 * reversible. Counting those here would let one flip of an emergency stop
 * permanently orphan every draft it touched, so they are excluded and become
 * eligible again once the stop is lifted. `stale` actions are excluded for
 * their own reason — superseded by a `repropose`, not refused.
 */
function slottedDraftIds(db: Db, workspaceId: string, cadenceId: string): Set<string> {
  const ids = new Set(
    db
      .select({ draftId: publications.draftId })
      .from(publications)
      .where(and(eq(publications.workspaceId, workspaceId), eq(publications.cadenceId, cadenceId)))
      .all()
      .map((r) => r.draftId),
  );
  const actions = cadenceActions(db, workspaceId, cadenceId);
  const humanRefused = humanRefusedActionIds(
    db,
    workspaceId,
    actions.filter(({ action }) => action.status === "cancelled").map(({ action }) => action.id),
  );
  for (const { action, payload } of actions) {
    if (action.status === "stale") continue;
    if (action.status === "cancelled" && !humanRefused.has(action.id)) continue;
    if (payload.draftId) ids.add(payload.draftId);
  }
  return ids;
}

/**
 * Slot times already occupied by a publication for this cadence.
 *
 * A withdrawn (`cancelled`) action *frees* its slot, unlike `slottedDraftIds`
 * above: the founder refused that post, not that airtime, so a different
 * approved draft may take the slot. The withdrawn draft cannot come back for
 * it, because it stays in `slottedDraftIds`.
 */
function takenSlots(db: Db, workspaceId: string, cadenceId: string): Set<number> {
  const slots = new Set(
    db
      .select({ at: publications.scheduledFor })
      .from(publications)
      .where(and(eq(publications.workspaceId, workspaceId), eq(publications.cadenceId, cadenceId)))
      .all()
      .map((r) => r.at),
  );
  for (const { action } of pendingCadenceActions(db, workspaceId, cadenceId)) {
    if (action.requestedFor !== null) slots.add(action.requestedFor);
  }
  return slots;
}

/** Approved drafts matching the cadence and not yet slotted, oldest-approved first. */
export function eligibleDrafts(db: Db, workspaceId: string, cadence: PostingCadence) {
  if (!cadence.campaignId) return [];
  const slotted = slottedDraftIds(db, workspaceId, cadence.id);
  return listDrafts(db, workspaceId, "approved", cadence.campaignId)
    .filter((d) => d.channel === cadence.channel)
    .filter((d) => !cadence.personaId || d.personaId === cadence.personaId)
    .filter((d) => !slotted.has(d.id))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export interface FillResult {
  filled: number;
  issues: Array<{
    code: "nonexistent_local_time" | "publish_validation";
    cadenceId: string;
    draftId: string | null;
    slot: number | null;
    message: string;
  }>;
}

/** Pair this cadence's open upcoming slots with queued approved drafts. */
export async function fillCadence(
  db: Db,
  runtime: ExternalActionRuntime,
  workspaceId: string,
  cadence: PostingCadence,
  nowMs: number,
): Promise<FillResult> {
  if (cadence.status !== "active" || !cadence.campaignId) return { filled: 0, issues: [] };
  const connection = getConnection(db, workspaceId, cadence.connectionId);
  if (!connection || connection.status !== "connected") return { filled: 0, issues: [] };

  // scheduled_auto cadences post without a human gate, so they run under the
  // social-automation guardrails. manual/human_in_the_loop cadences only ever
  // hold human-approved drafts, so they fill exactly as before (no guardrail).
  const campaign = getCampaign(db, workspaceId, cadence.campaignId);
  const isAuto = campaign?.automationMode === "scheduled_auto";
  const settings = isAuto ? getSocialAutomationSettings(db, workspaceId) : null;
  if (isAuto && settings!.killSwitch) {
    // The kill switch is a hard stop: slot nothing and clear this cadence's
    // pending auto-posts so flipping it stops the queue.
    cancelScheduledPublicationsForCadence(
      db,
      workspaceId,
      cadence.id,
      KILL_SWITCH_STOP_REASON,
    );
    return { filled: 0, issues: [] };
  }

  const taken = takenSlots(db, workspaceId, cadence.id);
  const detailed = slotsBetweenDetailed(
    cadence,
    nowMs,
    nowMs + CADENCE_HORIZON_DAYS * DAY_MS,
  );
  const issues: FillResult["issues"] = detailed.issues.map((issue) => ({
    code: issue.code,
    cadenceId: cadence.id,
    draftId: null,
    slot: null,
    message: issue.message.slice(0, 500),
  }));
  const openSlots = detailed.slots.filter((slot) => !taken.has(slot));
  if (openSlots.length === 0) return { filled: 0, issues };

  const queue = eligibleDrafts(db, workspaceId, cadence);
  let qi = 0;
  let filled = 0;
  for (const slot of openSlots) {
    if (qi >= queue.length) break;
    // Re-check per slot so caps account for posts created earlier in this run;
    // a capped day is skipped while a later, less-busy day can still fill.
    if (isAuto) {
      const check = checkPostGuardrails(db, settings!, {
        campaign: campaign!,
        connectionId: connection.id,
        slotMs: slot,
      });
      if (!check.ok) continue;
    }
    while (qi < queue.length) {
      const draft = queue[qi++]!;
      try {
        const command = preparePublicationAction(
          db,
          workspaceId,
          draft.id,
          {
            connectionId: connection.id,
            target: cadence.target,
            title: deriveTitle(draft.content),
            scheduledFor: slot,
          },
          {
            idempotencyKey: `cadence:${cadence.id}:${slot}:${draft.id}`,
            cadenceId: cadence.id,
            automated: isAuto,
          },
        );
        await runtime.propose(command, SYSTEM_ACTOR);
        filled += 1;
        break;
      } catch (error) {
        if (
          !(error instanceof ExternalActionPreparationError) ||
          error.code !== "publish_validation"
        ) {
          throw error;
        }
        issues.push({
          code: "publish_validation",
          cadenceId: cadence.id,
          draftId: draft.id,
          slot,
          message: error.message.slice(0, 500),
        });
      }
    }
  }
  return { filled, issues };
}

/** Delete a cadence's not-yet-published (`scheduled`) publications — used to
 * clear pending auto-posts when the kill switch goes on. Published history stays. */
function cancelScheduledPublicationsForCadence(
  db: Db,
  workspaceId: string,
  cadenceId: string,
  reason: string,
): void {
  db.delete(publications)
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.cadenceId, cadenceId),
        eq(publications.status, "scheduled"),
      ),
    )
    .run();
  cancelPendingActionsForCadence(db, workspaceId, cadenceId, reason);
}

/**
 * Cancel this cadence's still-pending publish actions on the system's behalf.
 *
 * Each cancellation is recorded as a decision, in the same transaction as the
 * status change, for the reason `recordCancellation` gives: an action that ends
 * `cancelled` with no decision behind it is a refusal nobody made. It is
 * attributed to the system with `human: false`, which is also what tells a
 * later fill that this stop was not a founder's "no" — the kill switch is
 * reversible and a withdrawal is not.
 */
function cancelPendingActionsForCadence(
  db: Db,
  workspaceId: string,
  cadenceId: string,
  reason: string,
): void {
  for (const { action } of pendingCadenceActions(db, workspaceId, cadenceId)) {
    if (!canTransitionExternalAction(action.status, "cancelled")) continue;
    // These two helpers take `Db`, so they run on the connection rather than on
    // the `tx` handle — same connection, so they are inside this transaction and
    // roll back together (verified).
    db.transaction(() => {
      insertExternalActionDecision(db, action, "deny", SYSTEM_ACTOR, reason);
      transitionExternalAction(db, workspaceId, action.id, "cancelled", {
        completedAt: Date.now(),
      });
    });
  }
}

export interface CadenceFillRun {
  cadenceId: string;
  filled: number;
  issues: FillResult["issues"];
}

/** Fill every active cadence (worker entry point). */
export async function fillActiveCadences(
  db: Db,
  runtime: ExternalActionRuntime,
  workspaceId: string,
  nowMs: number,
): Promise<CadenceFillRun[]> {
  const results: CadenceFillRun[] = [];
  for (const cadence of listCadenceRows(db, workspaceId)) {
    if (cadence.status !== "active") continue;
    const result = await fillCadence(db, runtime, workspaceId, cadence, nowMs);
    results.push({ cadenceId: cadence.id, ...result });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CadenceSummary extends PostingCadence {
  queuedCount: number;
  nextSlotAt: number | null;
}

export function listCadences(db: Db, workspaceId: string, nowMs: number): CadenceSummary[] {
  return listCadenceRows(db, workspaceId).map((cadence) => {
    const upcoming =
      cadence.status === "active"
        ? slotsBetween(cadence, nowMs, nowMs + CADENCE_HORIZON_DAYS * DAY_MS)
        : [];
    return {
      ...cadence,
      queuedCount: eligibleDrafts(db, workspaceId, cadence).length,
      nextSlotAt: upcoming[0] ?? null,
    };
  });
}

export interface CadenceDetail extends PostingCadence {
  queuedCount: number;
  upcomingSlots: number[];
  publications: Publication[];
}

export function getCadenceDetail(
  db: Db,
  workspaceId: string,
  cadence: PostingCadence,
  nowMs: number,
): CadenceDetail {
  const upcomingSlots = slotsBetween(
    cadence,
    nowMs,
    nowMs + CADENCE_HORIZON_DAYS * DAY_MS,
  ).slice(0, 20);
  return {
    ...cadence,
    queuedCount: eligibleDrafts(db, workspaceId, cadence).length,
    upcomingSlots,
    publications: listCadencePublications(db, workspaceId, cadence.id),
  };
}
