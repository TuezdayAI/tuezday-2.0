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
import type { Db } from "../db";
import { postingCadences, publications, type PostingCadenceRow } from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { getConnection } from "./connections";
import { listDrafts } from "./drafts";
import { createPublication, listCadencePublications } from "./publications";

type Fetcher = typeof fetch;

/** How far ahead a fill looks for open slots. */
export const CADENCE_HORIZON_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Timezone-correct slot math — no date library (the stack ships none). Uses
// Intl to read/derive zone offsets so DST is handled.
// ---------------------------------------------------------------------------

interface LocalDate {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, matching JS Date.getUTCDay(). */
  weekday: number;
}

function localDate(timeZone: string, ms: number): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  let year = 1970;
  let month = 1;
  let day = 1;
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday };
}

/** Offset (zone − UTC, ms) in effect at the given instant for the zone. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  const asUtc = Date.UTC(map.year!, map.month! - 1, map.day!, map.hour!, map.minute!, map.second!);
  return asUtc - utcMs;
}

/** The UTC instant of a wall-clock time in a given zone (DST-aware). */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMs(timeZone, guess);
  let utc = guess - offset;
  // Refine once: near a DST boundary the offset at the guess differs from the
  // offset at the corrected instant.
  const refined = zoneOffsetMs(timeZone, utc);
  if (refined !== offset) utc = guess - refined;
  return utc;
}

/**
 * Every cadence slot instant in (fromMs, toMs]. Walks the window in 12h steps
 * (well under any DST day length) and considers each distinct local date once.
 */
export function slotsBetween(cadence: PostingCadence, fromMs: number, toMs: number): number[] {
  if (toMs <= fromMs || cadence.daysOfWeek.length === 0) return [];
  const days = new Set(cadence.daysOfWeek);
  const [hh, mm] = cadence.timeOfDay.split(":").map(Number);
  const result: number[] = [];
  const seen = new Set<string>();
  const STEP = 12 * 60 * 60 * 1000;
  for (let cursor = fromMs; cursor <= toMs + DAY_MS; cursor += STEP) {
    const lp = localDate(cadence.timezone, cursor);
    const key = `${lp.year}-${lp.month}-${lp.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!days.has(lp.weekday)) continue;
    const at = zonedWallClockToUtc(lp.year, lp.month, lp.day, hh!, mm!, cadence.timezone);
    if (at > fromMs && at <= toMs) result.push(at);
  }
  return [...new Set(result)].sort((a, b) => a - b);
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
  input: CreatePostingCadenceInput,
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
  db.delete(postingCadences)
    .where(and(eq(postingCadences.workspaceId, workspaceId), eq(postingCadences.id, cadenceId)))
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Matching + fill
// ---------------------------------------------------------------------------

/** Draft ids already attached to a publication for this cadence (any status). */
function slottedDraftIds(db: Db, workspaceId: string, cadenceId: string): Set<string> {
  return new Set(
    db
      .select({ draftId: publications.draftId })
      .from(publications)
      .where(and(eq(publications.workspaceId, workspaceId), eq(publications.cadenceId, cadenceId)))
      .all()
      .map((r) => r.draftId),
  );
}

/** Slot times already occupied by a publication for this cadence (any status). */
function takenSlots(db: Db, workspaceId: string, cadenceId: string): Set<number> {
  return new Set(
    db
      .select({ at: publications.scheduledFor })
      .from(publications)
      .where(and(eq(publications.workspaceId, workspaceId), eq(publications.cadenceId, cadenceId)))
      .all()
      .map((r) => r.at),
  );
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
}

/** Pair this cadence's open upcoming slots with queued approved drafts. */
export async function fillCadence(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  cadence: PostingCadence,
  nowMs: number,
): Promise<FillResult> {
  if (cadence.status !== "active" || !cadence.campaignId) return { filled: 0 };
  const connection = getConnection(db, workspaceId, cadence.connectionId);
  if (!connection || connection.status !== "connected") return { filled: 0 };

  const taken = takenSlots(db, workspaceId, cadence.id);
  const openSlots = slotsBetween(cadence, nowMs, nowMs + CADENCE_HORIZON_DAYS * DAY_MS).filter(
    (s) => !taken.has(s),
  );
  if (openSlots.length === 0) return { filled: 0 };

  const queue = eligibleDrafts(db, workspaceId, cadence);
  const count = Math.min(openSlots.length, queue.length);
  for (let i = 0; i < count; i++) {
    const draft = queue[i]!;
    await createPublication(
      db,
      fabric,
      fetcher,
      workspaceId,
      draft.id,
      connection,
      {
        connectionId: connection.id,
        target: cadence.target,
        title: deriveTitle(draft.content),
        scheduledFor: openSlots[i]!,
      },
      cadence.id,
    );
  }
  return { filled: count };
}

export interface CadenceFillRun {
  cadenceId: string;
  filled: number;
}

/** Fill every active cadence (worker entry point). */
export async function fillActiveCadences(
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  nowMs: number,
): Promise<CadenceFillRun[]> {
  const results: CadenceFillRun[] = [];
  for (const cadence of listCadenceRows(db, workspaceId)) {
    if (cadence.status !== "active") continue;
    const { filled } = await fillCadence(db, fabric, fetcher, workspaceId, cadence, nowMs);
    results.push({ cadenceId: cadence.id, filled });
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
