import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { DiscoverySource } from "@tuezday/contracts";
import type { Db } from "../db";
import { discoveryJobs, type DiscoveryJobRow } from "../db/schema";

// Discovery job ledger (Sprint 46): `/discovery/run` enqueues due sources and
// processes a bounded batch synchronously. Local DB back-pressure — retries,
// per-source progress, and no run-long serialization behind one slow source —
// without a queue system. better-sqlite3 is synchronous on one connection, so
// enqueue/claim need no locking beyond the status column itself.

/** How many source jobs one `/discovery/run` call processes. */
export const DISCOVERY_JOB_BATCH_SIZE = 5;
/** A `running` job locked longer than this is presumed dead and released. */
export const DISCOVERY_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Fail `running` jobs whose lock is older than the timeout (a crashed or
 * hung run). Failing them frees their sources for re-enqueueing.
 */
export function releaseStaleDiscoveryJobs(db: Db, now: number): number {
  const result = db
    .update(discoveryJobs)
    .set({ status: "failed", error: "stale_lock", finishedAt: now })
    .where(
      and(
        eq(discoveryJobs.status, "running"),
        lt(discoveryJobs.lockedAt, now - DISCOVERY_JOB_LOCK_TIMEOUT_MS),
      ),
    )
    .run();
  return result.changes;
}

/**
 * Queue a job for each eligible source that is past its rate-limit backoff
 * and has no queued/running job already. Callers pass sources pre-filtered
 * for enabled/provider-configured status. Returns how many were enqueued.
 */
export function enqueueDueDiscoveryJobs(
  db: Db,
  workspaceId: string,
  sources: DiscoverySource[],
  now: number,
): number {
  const busy = new Set(
    db
      .select({ sourceId: discoveryJobs.sourceId })
      .from(discoveryJobs)
      .where(
        and(
          eq(discoveryJobs.workspaceId, workspaceId),
          inArray(discoveryJobs.status, ["queued", "running"]),
        ),
      )
      .all()
      .map((r) => r.sourceId),
  );
  let queued = 0;
  for (const source of sources) {
    if (source.backoffUntil !== null && source.backoffUntil > now) continue;
    if (busy.has(source.id)) continue;
    db.insert(discoveryJobs)
      .values({
        id: randomUUID(),
        workspaceId,
        sourceId: source.id,
        status: "queued",
        attempt: 0,
        lockedAt: null,
        startedAt: null,
        finishedAt: null,
        fetchedCount: 0,
        newCount: 0,
        error: null,
        createdAt: now,
      })
      .run();
    queued += 1;
  }
  return queued;
}

/**
 * Move up to `limit` of the oldest queued jobs to `running` and return them.
 * Leftovers stay queued for the next run — the bounded-batch guarantee.
 */
export function claimDiscoveryJobs(
  db: Db,
  workspaceId: string,
  limit: number,
  now: number,
): DiscoveryJobRow[] {
  const rows = db
    .select()
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.workspaceId, workspaceId), eq(discoveryJobs.status, "queued")))
    .orderBy(asc(discoveryJobs.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => {
    const claimed = {
      status: "running",
      attempt: row.attempt + 1,
      lockedAt: now,
      startedAt: now,
    } as const;
    db.update(discoveryJobs).set(claimed).where(eq(discoveryJobs.id, row.id)).run();
    return { ...row, ...claimed };
  });
}

export function completeDiscoveryJob(
  db: Db,
  jobId: string,
  counts: { fetchedCount: number; newCount: number },
  now: number,
): void {
  db.update(discoveryJobs)
    .set({ status: "succeeded", finishedAt: now, error: null, ...counts })
    .where(eq(discoveryJobs.id, jobId))
    .run();
}

export function failDiscoveryJob(db: Db, jobId: string, error: string, now: number): void {
  db.update(discoveryJobs)
    .set({ status: "failed", finishedAt: now, error: error.slice(0, 500) })
    .where(eq(discoveryJobs.id, jobId))
    .run();
}
