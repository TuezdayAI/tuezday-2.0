import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  METRIC_KEYS,
  METRIC_SOURCES,
  METRIC_SUBJECT_TYPES,
  METRIC_WINDOWS,
  type MetricKey,
  type MetricSource,
  type MetricSubjectType,
  type MetricWindow,
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
export function recordMetric(db: Db, workspaceId: string, input: MetricInput): boolean {
  if (input.value === null || input.value === undefined) return false;
  assertVocabulary(input);
  if (!Number.isInteger(input.value)) {
    throw new Error(`Metric values are integers (cents for money); got ${input.value}`);
  }
  const now = Date.now();
  db.insert(metrics)
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
export function recordMetrics(db: Db, workspaceId: string, inputs: MetricInput[]): number {
  let written = 0;
  for (const input of inputs) {
    if (recordMetric(db, workspaceId, input)) written += 1;
  }
  return written;
}

/**
 * Insert-if-absent variant for the backfill: never clobbers an existing grain,
 * because the dual-write may already have recorded a fresher value (the ads
 * sync restates a rolling window every few hours). Returns true when inserted.
 */
export function recordMetricIfAbsent(db: Db, workspaceId: string, input: MetricInput): boolean {
  if (input.value === null || input.value === undefined) return false;
  assertVocabulary(input);
  if (!Number.isInteger(input.value)) {
    throw new Error(`Metric values are integers (cents for money); got ${input.value}`);
  }
  const now = Date.now();
  const result = db
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

export function listMetricsForSubject(
  db: Db,
  workspaceId: string,
  subjectType: MetricSubjectType,
  subjectId: string,
): MetricRow[] {
  return db
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
