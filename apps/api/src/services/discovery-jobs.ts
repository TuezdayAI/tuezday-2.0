import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { DiscoverySource } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  discoveryJobs,
  discoverySources,
  type DiscoveryJobRow,
} from "../db/schema";
import { DATABASE_NOW_MS } from "./task-leases";

/** Temporary Sprint 46 route compatibility; Task 4 replaces this with policy. */
export const DISCOVERY_JOB_BATCH_SIZE = 5;
export const DISCOVERY_JOB_LEASE_MS = 45_000;

export interface DiscoveryJobClaim extends DiscoveryJobRow {
  status: "running";
  leaseOwner: string;
  leaseExpiresAt: number;
  heartbeatAt: number;
}

function toClaim(row: DiscoveryJobRow | undefined): DiscoveryJobClaim | null {
  if (
    !row ||
    row.status !== "running" ||
    row.leaseOwner === null ||
    row.leaseExpiresAt === null ||
    row.heartbeatAt === null
  ) {
    return null;
  }
  return row as DiscoveryJobClaim;
}

/**
 * Queue each due source with its current execution version. The partial unique
 * index is the concurrency boundary; conflict-ignore replaces read-before-write
 * busy checks that race across API processes.
 */
export async function enqueueDueDiscoveryJobs(
  db: Db,
  workspaceId: string,
  sources: DiscoverySource[],
  now: number,
): Promise<number> {
  let queued = 0;
  for (const source of sources) {
    if (!source.enabled || source.status === "reserved") continue;
    if (source.backoffUntil !== null && source.backoffUntil > now) continue;
    const inserted = await db.run(sql`
      INSERT INTO discovery_jobs (
        id,
        workspace_id,
        source_id,
        status,
        attempt,
        locked_at,
        source_execution_version,
        lease_owner,
        lease_version,
        lease_expires_at,
        heartbeat_at,
        started_at,
        finished_at,
        fetched_count,
        new_count,
        error,
        created_at
      )
      SELECT
        ${randomUUID()},
        ${workspaceId},
        ${discoverySources.id},
        'queued',
        0,
        NULL,
        ${discoverySources.executionVersion},
        NULL,
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        0,
        NULL,
        ${now}
      FROM ${discoverySources}
      WHERE
        ${discoverySources.workspaceId} = ${workspaceId}
        AND ${discoverySources.id} = ${source.id}
      ON CONFLICT DO NOTHING
    `);
    queued += inserted.changes;
  }
  return queued;
}

/**
 * Claim exactly one oldest queued job, or reclaim one expired running job.
 * Selection and compare-and-swap share one SQLite transaction and database
 * clock so caller time can never steal a live lease.
 */
export async function claimNextDiscoveryJob(
  db: Db,
  input: {
    workspaceId?: string;
    owner: string;
    leaseMs: number;
  },
): Promise<DiscoveryJobClaim | null> {
  return await db.transaction(async (tx) => {
    const candidate = await tx
      .select()
      .from(discoveryJobs)
      .where(
        and(
          input.workspaceId
            ? eq(discoveryJobs.workspaceId, input.workspaceId)
            : undefined,
          or(
            eq(discoveryJobs.status, "queued"),
            and(
              eq(discoveryJobs.status, "running"),
              lte(discoveryJobs.leaseExpiresAt, DATABASE_NOW_MS),
            ),
          ),
        ),
      )
      .orderBy(asc(discoveryJobs.createdAt), asc(discoveryJobs.id))
      .limit(1)
      .get();
    if (!candidate) return null;

    const claimed = await tx
      .update(discoveryJobs)
      .set({
        status: "running",
        attempt: sql`${discoveryJobs.attempt} + 1`,
        lockedAt: DATABASE_NOW_MS,
        startedAt: DATABASE_NOW_MS,
        leaseOwner: input.owner,
        leaseVersion: sql`${discoveryJobs.leaseVersion} + 1`,
        leaseExpiresAt: sql`${DATABASE_NOW_MS} + ${input.leaseMs}`,
        heartbeatAt: DATABASE_NOW_MS,
        finishedAt: null,
        error: null,
      })
      .where(
        and(
          eq(discoveryJobs.id, candidate.id),
          eq(discoveryJobs.leaseVersion, candidate.leaseVersion),
          or(
            eq(discoveryJobs.status, "queued"),
            and(
              eq(discoveryJobs.status, "running"),
              lte(discoveryJobs.leaseExpiresAt, DATABASE_NOW_MS),
            ),
          ),
        ),
      )
      .returning()
      .get();
    return toClaim(claimed);
  });
}

export async function heartbeatDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  leaseMs: number,
): Promise<DiscoveryJobClaim | null> {
  const renewed = await db
    .update(discoveryJobs)
    .set({
      leaseExpiresAt: sql`${DATABASE_NOW_MS} + ${leaseMs}`,
      heartbeatAt: DATABASE_NOW_MS,
    })
    .where(liveClaimWhere(claim))
    .returning()
    .get();
  return toClaim(renewed);
}

function liveClaimWhere(claim: DiscoveryJobClaim) {
  return and(
    eq(discoveryJobs.id, claim.id),
    eq(discoveryJobs.status, "running"),
    eq(discoveryJobs.leaseOwner, claim.leaseOwner),
    eq(discoveryJobs.leaseVersion, claim.leaseVersion),
    gt(discoveryJobs.leaseExpiresAt, DATABASE_NOW_MS),
  );
}

export async function completeDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  counts: { fetchedCount: number; newCount: number },
): Promise<boolean> {
  const result = await db
    .update(discoveryJobs)
    .set({
      status: "succeeded",
      finishedAt: DATABASE_NOW_MS,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      ...counts,
    })
    .where(liveClaimWhere(claim))
    .run();
  return result.changes === 1;
}

export async function failDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  error: string,
): Promise<boolean> {
  const result = await db
    .update(discoveryJobs)
    .set({
      status: "failed",
      finishedAt: DATABASE_NOW_MS,
      error: error.slice(0, 500),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    })
    .where(liveClaimWhere(claim))
    .run();
  return result.changes === 1;
}
