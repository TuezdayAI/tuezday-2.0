import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import {
  METRIC_KEYS,
  METRIC_SOURCES,
  METRIC_SUBJECT_TYPES,
  METRIC_WINDOWS,
  metricWindowKind,
  type MetricKey,
  type MetricSource,
  type MetricSubjectType,
  type MetricWindow,
  type MetricWindowKindValue,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { metrics, type MetricRow } from "../db/schema";

// Sprint 55: the single write path into the unified metric fact table.
// Every writer — manual entry, platform capture, ads sync, the backfill —
// goes through here, so the vocabulary check and the upsert-on-grain
// semantics live in exactly one place.

export interface MetricInput {
  subjectType: MetricSubjectType;
  subjectId: string;
  metricKey: MetricKey;
  /**
   * The observed number (integer; money in cents). `null`/`undefined` means
   * the source did not observe this metric at all — absence is not zero, and
   * no row is written. Callers pass it through so that skipping is this
   * module's documented behaviour, not each caller's private convention.
   */
  value: number | null | undefined;
  window: MetricWindow;
  periodStart: number;
  source: MetricSource;
  capturedAt: number;
}

function assertVocabulary(input: MetricInput): void {
  if (!(METRIC_SUBJECT_TYPES as readonly string[]).includes(input.subjectType)) {
    throw new Error(`Unknown metric subject type: ${String(input.subjectType)}`);
  }
  if (!(METRIC_KEYS as readonly string[]).includes(input.metricKey)) {
    throw new Error(`Unknown metric key: ${String(input.metricKey)}`);
  }
  if (!(METRIC_WINDOWS as readonly string[]).includes(input.window)) {
    throw new Error(`Unknown metric window: ${String(input.window)}`);
  }
  if (!(METRIC_SOURCES as readonly string[]).includes(input.source)) {
    throw new Error(`Unknown metric source: ${String(input.source)}`);
  }
}

/**
 * Record one observation. Upserts on the grain
 * (workspace, subjectType, subjectId, metricKey, window, periodStart), so a
 * re-sync updates in place rather than duplicating. Returns true when a row
 * was written, false when the value was absent.
 */
export async function recordMetric(db: Db, workspaceId: string, input: MetricInput): Promise<boolean> {
  if (input.value === null || input.value === undefined) return false;
  assertVocabulary(input);
  if (!Number.isInteger(input.value)) {
    throw new Error(`Metric values are integers (cents for money); got ${input.value}`);
  }
  const now = Date.now();
  await db.insert(metrics)
    .values({
      id: randomUUID(),
      workspaceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      metricKey: input.metricKey,
      value: input.value,
      window: input.window,
      periodStart: input.periodStart,
      source: input.source,
      capturedAt: input.capturedAt,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        metrics.workspaceId,
        metrics.subjectType,
        metrics.subjectId,
        metrics.metricKey,
        metrics.window,
        metrics.periodStart,
      ],
      set: {
        value: input.value,
        source: input.source,
        capturedAt: input.capturedAt,
      },
    })
    .run();
  return true;
}

/** Record a batch; absent values are skipped. Returns how many rows were written. */
export async function recordMetrics(db: Db, workspaceId: string, inputs: MetricInput[]): Promise<number> {
  let written = 0;
  for (const input of inputs) {
    if (await recordMetric(db, workspaceId, input)) written += 1;
  }
  return written;
}

/**
 * Insert-if-absent variant for the backfill: never clobbers an existing grain,
 * because the dual-write may already have recorded a fresher value (the ads
 * sync restates a rolling window every few hours). Returns true when inserted.
 */
export async function recordMetricIfAbsent(db: Db, workspaceId: string, input: MetricInput): Promise<boolean> {
  if (input.value === null || input.value === undefined) return false;
  assertVocabulary(input);
  if (!Number.isInteger(input.value)) {
    throw new Error(`Metric values are integers (cents for money); got ${input.value}`);
  }
  const now = Date.now();
  const result = await db
    .insert(metrics)
    .values({
      id: randomUUID(),
      workspaceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      metricKey: input.metricKey,
      value: input.value,
      window: input.window,
      periodStart: input.periodStart,
      source: input.source,
      capturedAt: input.capturedAt,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

export async function listMetricsForSubject(
  db: Db,
  workspaceId: string,
  subjectType: MetricSubjectType,
  subjectId: string,
): Promise<MetricRow[]> {
  return await db
    .select()
    .from(metrics)
    .where(
      and(
        eq(metrics.workspaceId, workspaceId),
        eq(metrics.subjectType, subjectType),
        eq(metrics.subjectId, subjectId),
      ),
    )
    .all();
}

// ---------------------------------------------------------------------------
// Rollups (Sprint 76) — the read side of the fact table, for the
// `get_metric_summary` agent tool and anything else that needs a number rather
// than rows.
// ---------------------------------------------------------------------------

export interface MetricSummaryQuery {
  subjectType: MetricSubjectType;
  /** Omitted rolls up across every subject of that type in the workspace. */
  subjectId?: string;
  metricKeys?: MetricKey[];
  /** Required: it decides the time semantics, so it is never defaulted. */
  window: MetricWindow;
  /** Only observations captured within this many days back. */
  sinceDays?: number;
}

export interface MetricSummaryEntry {
  metricKey: MetricKey;
  total: number;
  /** How many distinct subjects contributed to `total`. */
  subjectCount: number;
  observations: number;
}

export interface MetricSummary {
  subjectType: MetricSubjectType;
  subjectId: string | null;
  window: MetricWindow;
  windowKind: MetricWindowKindValue;
  /** Inclusive capture-time floor applied, or null when unbounded. */
  since: number | null;
  entries: MetricSummaryEntry[];
  /** Plain-language statement of what `total` means, so a model cannot misread it. */
  interpretation: string;
}

const WINDOW_INTERPRETATION: Record<MetricWindowKindValue, string> = {
  cumulative:
    "Cumulative windows are running totals per subject since it went live. Each subject contributes its single latest reading, summed across subjects — readings of the same subject over time are never added together.",
  periodic:
    "Periodic windows are per-period totals, so every observation in range is summed. Comparing two date ranges is meaningful here.",
  point:
    "Point readings cover no defined period. Each subject contributes its latest reading only; treat the total as a snapshot, not a rate.",
};

/**
 * Roll the fact table up to one number per metric key.
 *
 * The Sprint 55 rule this exists to enforce: cumulative and periodic values
 * must never be summed together. A summary is therefore always for exactly one
 * `window`, and the aggregation differs by its kind — a cumulative or point
 * window keeps one (the latest) reading per subject before summing across
 * subjects, while a periodic window sums every observation in range. Mixing
 * them would double-count a subject's lifetime total once per capture.
 */
export async function summarizeMetrics(
  db: Db,
  workspaceId: string,
  query: MetricSummaryQuery,
): Promise<MetricSummary> {
  const windowKind = metricWindowKind(query.window);
  const since =
    query.sinceDays === undefined ? null : Date.now() - query.sinceDays * 24 * 60 * 60 * 1000;

  const conditions = [
    eq(metrics.workspaceId, workspaceId),
    eq(metrics.subjectType, query.subjectType),
    eq(metrics.window, query.window),
  ];
  if (query.subjectId) conditions.push(eq(metrics.subjectId, query.subjectId));
  if (since !== null) conditions.push(gte(metrics.capturedAt, since));

  const rows = await db
    .select()
    .from(metrics)
    .where(and(...conditions))
    .all();

  const wanted = new Set<MetricKey>(query.metricKeys ?? METRIC_KEYS);
  // key -> subjectId -> the rows that count toward its contribution.
  const bySubject = new Map<MetricKey, Map<string, MetricRow[]>>();
  for (const row of rows) {
    const key = row.metricKey as MetricKey;
    if (!wanted.has(key)) continue;
    let subjects = bySubject.get(key);
    if (!subjects) {
      subjects = new Map();
      bySubject.set(key, subjects);
    }
    const existing = subjects.get(row.subjectId);
    if (existing) existing.push(row);
    else subjects.set(row.subjectId, [row]);
  }

  const entries: MetricSummaryEntry[] = [];
  for (const key of METRIC_KEYS) {
    const subjects = bySubject.get(key);
    if (!subjects) continue;
    let total = 0;
    let observations = 0;
    for (const subjectRows of subjects.values()) {
      observations += subjectRows.length;
      if (windowKind === "periodic") {
        for (const row of subjectRows) total += row.value;
      } else {
        // One reading per subject: the most recently captured, tie-broken on
        // periodStart so a same-millisecond re-sync is still deterministic.
        const latest = subjectRows.reduce((best, row) =>
          row.capturedAt > best.capturedAt ||
          (row.capturedAt === best.capturedAt && row.periodStart > best.periodStart)
            ? row
            : best,
        );
        total += latest.value;
      }
    }
    entries.push({ metricKey: key, total, subjectCount: subjects.size, observations });
  }

  return {
    subjectType: query.subjectType,
    subjectId: query.subjectId ?? null,
    window: query.window,
    windowKind,
    since,
    entries,
    interpretation: WINDOW_INTERPRETATION[windowKind],
  };
}
