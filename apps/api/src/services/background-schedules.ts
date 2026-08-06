import { randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import {
  BACKGROUND_RECURRING_JOB_KINDS,
  type BackgroundRecurringJobKind,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { backgroundSchedules, workspaces } from "../db/schema";
import type { BackgroundJobPolicy } from "../runtime/background-job-policy";
import { enqueueBackgroundJob } from "./background-jobs";
import { databaseNowMs } from "./task-leases";

const MAX_SCHEDULES_PER_ADMISSION = 1_000;

export function reconcileBackgroundSchedules(
  db: Db,
  policy: BackgroundJobPolicy,
  now = databaseNowMs(db),
): number {
  const workspaceRows = db.select({ id: workspaces.id }).from(workspaces).all();
  let created = 0;
  for (const workspace of workspaceRows) {
    for (const kind of BACKGROUND_RECURRING_JOB_KINDS) {
      const inserted = db
        .insert(backgroundSchedules)
        .values({
          id: randomUUID(),
          workspaceId: workspace.id,
          kind,
          intervalMs: policy.intervals[kind],
          nextRunAt: now,
          lastEnqueuedAt: null,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [backgroundSchedules.workspaceId, backgroundSchedules.kind],
        })
        .returning({ id: backgroundSchedules.id })
        .get();
      if (inserted) {
        created += 1;
        continue;
      }
      db.update(backgroundSchedules)
        .set({
          intervalMs: policy.intervals[kind],
          enabled: true,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundSchedules.workspaceId, workspace.id),
            eq(backgroundSchedules.kind, kind),
          ),
        )
        .run();
    }
  }
  return created;
}

function nextBoundary(nextRunAt: number, intervalMs: number, now: number): number {
  const missed = Math.floor((now - nextRunAt) / intervalMs);
  return nextRunAt + (missed + 1) * intervalMs;
}

export function admitDueBackgroundSchedules(
  db: Db,
  now = databaseNowMs(db),
  maxAttempts = 5,
): { scanned: number; admitted: number } {
  const due = db
    .select()
    .from(backgroundSchedules)
    .where(
      and(
        eq(backgroundSchedules.enabled, true),
        lte(backgroundSchedules.nextRunAt, now),
      ),
    )
    .orderBy(asc(backgroundSchedules.nextRunAt), asc(backgroundSchedules.id))
    .limit(MAX_SCHEDULES_PER_ADMISSION)
    .all();
  let admitted = 0;

  for (const candidate of due) {
    if (
      !BACKGROUND_RECURRING_JOB_KINDS.includes(
        candidate.kind as BackgroundRecurringJobKind,
      )
    ) {
      db.update(backgroundSchedules)
        .set({ enabled: false, updatedAt: now })
        .where(eq(backgroundSchedules.id, candidate.id))
        .run();
      continue;
    }
    const kind = candidate.kind as BackgroundRecurringJobKind;
    const didAdmit = db.transaction((tx) => {
      const advanced = tx
        .update(backgroundSchedules)
        .set({
          nextRunAt: nextBoundary(candidate.nextRunAt, candidate.intervalMs, now),
          lastEnqueuedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundSchedules.id, candidate.id),
            eq(backgroundSchedules.enabled, true),
            eq(backgroundSchedules.nextRunAt, candidate.nextRunAt),
          ),
        )
        .returning({ id: backgroundSchedules.id })
        .get();
      if (!advanced) return false;
      enqueueBackgroundJob(tx, {
        payload: { kind, workspaceId: candidate.workspaceId },
        idempotencyKey: `schedule:${candidate.id}:${candidate.nextRunAt}`,
        availableAt: now,
        maxAttempts,
      });
      return true;
    });
    if (didAdmit) admitted += 1;
  }

  return { scanned: due.length, admitted };
}
