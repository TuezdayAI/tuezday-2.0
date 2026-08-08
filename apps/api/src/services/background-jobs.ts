import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  BACKGROUND_JOB_KINDS,
  backgroundJobLaneFor,
  backgroundJobPayloadSchema,
  backgroundJobStatusSchema,
  type BackgroundJobKind,
  type BackgroundJobLane,
  type BackgroundJobPayload,
  type BackgroundJobStatus,
} from "@tuezday/contracts";
import { type Db, type DbExecutor, rowsAffected } from "../db";
import {
  backgroundJobs,
  backgroundWorkspaceDispatch,
  type BackgroundJobRow,
} from "../db/schema";
import { databaseNowMs } from "./task-leases";
const MAX_IDEMPOTENCY_KEY_CHARS = 300;
const MAX_PAYLOAD_CHARS = 16_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_ERROR_CHARS = 1_000;
const MAX_CANDIDATE_SCAN = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface EnqueueBackgroundJobInput {
  payload: BackgroundJobPayload;
  idempotencyKey: string;
  priority?: number;
  availableAt?: number;
  maxAttempts?: number;
}

export interface BackgroundJobClaim extends BackgroundJobRow {
  kind: BackgroundJobKind;
  status: "running";
  leaseOwner: string;
  leaseExpiresAt: number;
  heartbeatAt: number;
}

export interface ClaimBackgroundJobsInput {
  owner: string;
  leaseMs: number;
  limit: number;
  /** Concurrent maintenance jobs one workspace may hold. */
  perWorkspaceLimit: number;
  /**
   * Sprint 79 (D-79.2): the same budget for the `agent` lane, counted
   * separately. A fifteen-minute agent task must not hold the workspace's only
   * dispatch slot while its publish and discovery ticks queue behind it.
   * Omitted, agent jobs share the maintenance budget — the pre-Sprint-79
   * behaviour.
   */
  perWorkspaceAgentLimit?: number;
}

export interface BackgroundJobListInput {
  status?: BackgroundJobStatus;
  workspaceId?: string;
  kind?: BackgroundJobKind;
  limit?: number;
}

export interface BackgroundQueueStats {
  total: number;
  queued: number;
  runnable: number;
  retrying: number;
  running: number;
  succeeded: number;
  deadLetter: number;
  cancelled: number;
  oldestRunnableAgeMs: number | null;
  averageDurationMs: number | null;
  saturatedWorkspaces: number;
  byKind: Record<BackgroundJobKind, number>;
}

function integerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function activeKey(workspaceId: string, idempotencyKey: string): string {
  return `${workspaceId}:${idempotencyKey}`;
}

function boundedJson(value: unknown, maximum: number): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= maximum) return serialized;
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, maximum - 40),
  }).slice(0, maximum);
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*\S+/gi,
      "$1: [REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, MAX_ERROR_CHARS);
}

function toClaim(row: BackgroundJobRow | undefined): BackgroundJobClaim | null {
  if (
    !row ||
    row.status !== "running" ||
    row.leaseOwner === null ||
    row.leaseExpiresAt === null ||
    row.heartbeatAt === null ||
    !BACKGROUND_JOB_KINDS.includes(row.kind as BackgroundJobKind)
  ) {
    return null;
  }
  return row as BackgroundJobClaim;
}

export async function enqueueBackgroundJob(
  db: DbExecutor,
  input: EnqueueBackgroundJobInput,
): Promise<BackgroundJobRow> {
  const payload = backgroundJobPayloadSchema.parse(input.payload);
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS
  ) {
    throw new Error(
      `idempotencyKey must contain 1 through ${MAX_IDEMPOTENCY_KEY_CHARS} characters.`,
    );
  }
  const priority = integerInRange(input.priority ?? 0, "priority", -100, 100);
  const maxAttempts = integerInRange(
    input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
    1,
    25,
  );
  const now = await databaseNowMs(db);
  const availableAt = integerInRange(
    input.availableAt ?? now,
    "availableAt",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > MAX_PAYLOAD_CHARS) {
    throw new Error(`background job payload exceeds ${MAX_PAYLOAD_CHARS} characters.`);
  }
  const scopedActiveKey = activeKey(payload.workspaceId, idempotencyKey);

  const inserted = (await db
    .insert(backgroundJobs)
    .values({
      id: randomUUID(),
      workspaceId: payload.workspaceId,
      kind: payload.kind,
      payloadJson,
      idempotencyKey,
      activeKey: scopedActiveKey,
      priority,
      status: "queued",
      availableAt,
      attempt: 0,
      maxAttempts,
      leaseOwner: null,
      leaseVersion: 0,
      leaseExpiresAt: null,
      heartbeatAt: null,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: backgroundJobs.activeKey })
    .returning())[0];
  if (inserted) return inserted;

  const existing = (await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.activeKey, scopedActiveKey)))[0];
  if (!existing) throw new Error("background_job_enqueue_conflict_without_active_row");
  return existing;
}

function validateClaimInput(input: ClaimBackgroundJobsInput): void {
  if (!input.owner.trim() || input.owner.length > 300) {
    throw new Error("owner must contain 1 through 300 characters.");
  }
  integerInRange(input.leaseMs, "leaseMs", 1, 86_400_000);
  integerInRange(input.limit, "limit", 1, 100);
  integerInRange(input.perWorkspaceLimit, "perWorkspaceLimit", 1, 100);
}

/**
 * Claim a fair batch. A SQLite transaction plus per-row lease-version CAS is
 * the concurrency boundary; a brief outer dispatcher lease further reduces
 * contention when multiple API processes receive ticks simultaneously.
 */
export async function claimBackgroundJobs(
  db: Db,
  input: ClaimBackgroundJobsInput,
): Promise<BackgroundJobClaim[]> {
  validateClaimInput(input);
  // Sprint 79: the per-workspace budget is per LANE. `laneKey` is what makes
  // that a seven-line change rather than a second claim path — a workspace
  // with no agent tasks counts and claims exactly as it did before.
  const limitForLane = (lane: BackgroundJobLane): number =>
    lane === "agent"
      ? input.perWorkspaceAgentLimit ?? input.perWorkspaceLimit
      : input.perWorkspaceLimit;
  const laneKey = (workspaceId: string, kind: string): string =>
    `${workspaceId}:${backgroundJobLaneFor(kind as BackgroundJobKind)}`;

  return await db.transaction(async (tx) => {
    const now = await databaseNowMs(tx);
    const liveRows = await tx
      .select({ workspaceId: backgroundJobs.workspaceId, kind: backgroundJobs.kind })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.status, "running"),
          gt(backgroundJobs.leaseExpiresAt, now),
        ),
      );
    const liveCounts = new Map<string, number>();
    for (const row of liveRows) {
      const key = laneKey(row.workspaceId, row.kind);
      liveCounts.set(key, (liveCounts.get(key) ?? 0) + 1);
    }

    const candidates = await tx
      .select()
      .from(backgroundJobs)
      .where(
        or(
          and(
            eq(backgroundJobs.status, "queued"),
            lte(backgroundJobs.availableAt, now),
          ),
          and(
            eq(backgroundJobs.status, "running"),
            lte(backgroundJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(
        desc(backgroundJobs.priority),
        asc(backgroundJobs.availableAt),
        asc(backgroundJobs.createdAt),
        asc(backgroundJobs.id),
      )
      .limit(Math.min(MAX_CANDIDATE_SCAN, Math.max(100, input.limit * 25)));
    if (candidates.length === 0) return [];

    const workspaceIds = [...new Set(candidates.map((row) => row.workspaceId))];
    const dispatchRows = await tx
      .select()
      .from(backgroundWorkspaceDispatch)
      .where(inArray(backgroundWorkspaceDispatch.workspaceId, workspaceIds));
    const lastDispatched = new Map(
      dispatchRows.map((row) => [row.workspaceId, row.lastDispatchedAt]),
    );
    // One queue per (workspace, lane). Fairness across workspaces is unchanged
    // — `lastDispatched` is still keyed on the workspace — but a workspace's
    // agent work and its maintenance work now hold separate slots.
    const queues = new Map<string, BackgroundJobRow[]>();
    const laneOwner = new Map<string, { workspaceId: string; lane: BackgroundJobLane }>();
    for (const candidate of candidates) {
      const key = laneKey(candidate.workspaceId, candidate.kind);
      const queue = queues.get(key) ?? [];
      queue.push(candidate);
      queues.set(key, queue);
      laneOwner.set(key, {
        workspaceId: candidate.workspaceId,
        lane: backgroundJobLaneFor(candidate.kind as BackgroundJobKind),
      });
    }

    const claims: BackgroundJobClaim[] = [];
    while (claims.length < input.limit) {
      const eligible = [...queues.keys()]
        .filter(
          (key) =>
            (queues.get(key)?.length ?? 0) > 0 &&
            (liveCounts.get(key) ?? 0) < limitForLane(laneOwner.get(key)!.lane),
        )
        .sort((left, right) => {
          const leftAt = lastDispatched.get(laneOwner.get(left)!.workspaceId) ?? Number.MIN_SAFE_INTEGER;
          const rightAt = lastDispatched.get(laneOwner.get(right)!.workspaceId) ?? Number.MIN_SAFE_INTEGER;
          return leftAt - rightAt || left.localeCompare(right);
        });
      if (eligible.length === 0) break;

      let claimedThisPass = false;
      for (const key of eligible) {
        if (claims.length >= input.limit) break;
        const { workspaceId, lane } = laneOwner.get(key)!;
        if ((liveCounts.get(key) ?? 0) >= limitForLane(lane)) continue;
        const queue = queues.get(key)!;
        let claimed: BackgroundJobClaim | null = null;
        while (queue.length > 0 && !claimed) {
          const candidate = queue.shift()!;
          const availability =
            candidate.status === "queued"
              ? and(
                  eq(backgroundJobs.status, "queued"),
                  lte(backgroundJobs.availableAt, now),
                )
              : and(
                  eq(backgroundJobs.status, "running"),
                  lte(backgroundJobs.leaseExpiresAt, now),
                );
          const row = (await tx
            .update(backgroundJobs)
            .set({
              status: "running",
              attempt: sql`${backgroundJobs.attempt} + 1`,
              leaseOwner: input.owner,
              leaseVersion: sql`${backgroundJobs.leaseVersion} + 1`,
              leaseExpiresAt: now + input.leaseMs,
              heartbeatAt: now,
              startedAt: now,
              finishedAt: null,
              resultJson: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(backgroundJobs.id, candidate.id),
                eq(backgroundJobs.leaseVersion, candidate.leaseVersion),
                availability,
              ),
            )
            .returning())[0];
          claimed = toClaim(row);
        }
        if (!claimed) continue;

        await tx.insert(backgroundWorkspaceDispatch)
          .values({
            workspaceId,
            lastDispatchedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: backgroundWorkspaceDispatch.workspaceId,
            set: { lastDispatchedAt: now, updatedAt: now },
          });
        lastDispatched.set(workspaceId, now);
        liveCounts.set(key, (liveCounts.get(key) ?? 0) + 1);
        claims.push(claimed);
        claimedThisPass = true;
      }
      if (!claimedThisPass) break;
    }
    return claims;
  });
}

function liveClaimWhere(claim: BackgroundJobClaim, now: number) {
  return and(
    eq(backgroundJobs.id, claim.id),
    eq(backgroundJobs.status, "running"),
    eq(backgroundJobs.leaseOwner, claim.leaseOwner),
    eq(backgroundJobs.leaseVersion, claim.leaseVersion),
    gt(backgroundJobs.leaseExpiresAt, now),
  );
}

export async function heartbeatBackgroundJob(
  db: Db,
  claim: BackgroundJobClaim,
  leaseMs: number,
): Promise<BackgroundJobClaim | null> {
  integerInRange(leaseMs, "leaseMs", 1, 86_400_000);
  const now = await databaseNowMs(db);
  return toClaim(
    (await db
      .update(backgroundJobs)
      .set({
        leaseExpiresAt: now + leaseMs,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(liveClaimWhere(claim, now))
      .returning())[0],
  );
}

export async function completeBackgroundJob(
  db: Db,
  claim: BackgroundJobClaim,
  result: unknown,
): Promise<boolean> {
  const now = await databaseNowMs(db);
  const updated = await db
    .update(backgroundJobs)
    .set({
      status: "succeeded",
      activeKey: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: now,
      lastError: null,
      resultJson: boundedJson(result, MAX_RESULT_CHARS),
      updatedAt: now,
    })
    .where(liveClaimWhere(claim, now));
  return rowsAffected(updated) === 1;
}

function deterministicBackoffMs(
  claim: BackgroundJobClaim,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  const core = Math.min(
    maxBackoffMs,
    baseBackoffMs * 2 ** Math.max(0, claim.attempt - 1),
  );
  const jitterRoom = Math.min(Math.floor(core * 0.2), maxBackoffMs - core);
  if (jitterRoom <= 0) return core;
  let hash = claim.attempt;
  for (const char of claim.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return core + (hash % (jitterRoom + 1));
}

export async function deadLetterBackgroundJob(
  db: Db,
  claim: BackgroundJobClaim,
  error: unknown,
): Promise<BackgroundJobRow | null> {
  const now = await databaseNowMs(db);
  return (
    (await db
      .update(backgroundJobs)
      .set({
        status: "dead_letter",
        activeKey: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: now,
        lastError: sanitizeError(error),
        updatedAt: now,
      })
      .where(liveClaimWhere(claim, now))
      .returning())[0] ?? null
  );
}

export async function retryBackgroundJob(
  db: Db,
  claim: BackgroundJobClaim,
  error: unknown,
  options: {
    baseBackoffMs: number;
    maxBackoffMs: number;
    availableAt?: number;
  },
): Promise<BackgroundJobRow | null> {
  const baseBackoffMs = integerInRange(
    options.baseBackoffMs,
    "baseBackoffMs",
    1,
    86_400_000,
  );
  const maxBackoffMs = integerInRange(
    options.maxBackoffMs,
    "maxBackoffMs",
    baseBackoffMs,
    7 * 86_400_000,
  );
  if (claim.attempt >= claim.maxAttempts) {
    return await deadLetterBackgroundJob(db, claim, error);
  }

  const now = await databaseNowMs(db);
  const availableAt = options.availableAt ??
    now + deterministicBackoffMs(claim, baseBackoffMs, maxBackoffMs);
  integerInRange(availableAt, "availableAt", now + 1, Number.MAX_SAFE_INTEGER);
  return (
    (await db
      .update(backgroundJobs)
      .set({
        status: "queued",
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: null,
        lastError: sanitizeError(error),
        updatedAt: now,
      })
      .where(liveClaimWhere(claim, now))
      .returning())[0] ?? null
  );
}

export async function requeueDeadLetter(
  db: Db,
  jobId: string,
  options: { availableAt?: number; maxAttempts?: number } = {},
): Promise<BackgroundJobRow | null> {
  const dead = (await db
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.id, jobId),
        eq(backgroundJobs.status, "dead_letter"),
      ),
    ))[0];
  if (!dead) return null;
  const parsed = backgroundJobPayloadSchema.parse(JSON.parse(dead.payloadJson));
  return await enqueueBackgroundJob(db, {
    payload: parsed,
    idempotencyKey: dead.idempotencyKey,
    priority: dead.priority,
    availableAt: options.availableAt,
    maxAttempts: options.maxAttempts ?? dead.maxAttempts,
  });
}

export async function listBackgroundJobs(
  db: Db,
  input: BackgroundJobListInput = {},
): Promise<BackgroundJobRow[]> {
  const limit = integerInRange(input.limit ?? 50, "limit", 1, 250);
  if (input.status) backgroundJobStatusSchema.parse(input.status);
  if (input.kind && !BACKGROUND_JOB_KINDS.includes(input.kind)) {
    throw new Error(`Unknown background job kind: ${input.kind}`);
  }
  const conditions = [
    input.status ? eq(backgroundJobs.status, input.status) : undefined,
    input.workspaceId
      ? eq(backgroundJobs.workspaceId, input.workspaceId)
      : undefined,
    input.kind ? eq(backgroundJobs.kind, input.kind) : undefined,
  ].filter((condition) => condition !== undefined);
  return await db
    .select()
    .from(backgroundJobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(backgroundJobs.createdAt), desc(backgroundJobs.id))
    .limit(limit);
}

export async function getBackgroundQueueStats(
  db: Db,
  options: { perWorkspaceConcurrency?: number; perWorkspaceAgentConcurrency?: number } = {},
): Promise<BackgroundQueueStats> {
  const now = await databaseNowMs(db);
  const perWorkspaceConcurrency = integerInRange(
    options.perWorkspaceConcurrency ?? 1,
    "perWorkspaceConcurrency",
    1,
    100,
  );
  const perWorkspaceAgentConcurrency = integerInRange(
    options.perWorkspaceAgentConcurrency ?? perWorkspaceConcurrency,
    "perWorkspaceAgentConcurrency",
    1,
    100,
  );
  const { rows: aggregateRows } = await db.execute<{
    total: number;
    queued: number;
    runnable: number;
    retrying: number;
    running: number;
    succeeded: number;
    dead_letter: number;
    cancelled: number;
    oldest_runnable_at: number | null;
    average_duration_ms: number | null;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'queued' AND available_at <= ${now} THEN 1 ELSE 0 END) AS runnable,
      SUM(CASE WHEN status = 'queued' AND attempt > 0 THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      MIN(CASE WHEN status = 'queued' AND available_at <= ${now} THEN created_at END) AS oldest_runnable_at,
      AVG(CASE
        WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
        THEN finished_at - started_at
      END) AS average_duration_ms
    FROM background_jobs
  `);
  const aggregate = aggregateRows[0];
  // Saturation is per (workspace, lane) since Sprint 79 — a workspace running
  // its one allowed agent task is not "saturated" for maintenance work, and an
  // operator gauge that said otherwise would send someone looking for a
  // backlog that is not there. The lane rule is restated in SQL rather than
  // imported; `background_jobs_lane_matches_contract` in the queue suite is
  // what keeps the two honest.
  const { rows: saturationRows } = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM (
      SELECT
        workspace_id,
        (kind = 'agent_task') AS is_agent,
        COUNT(*) AS running
      FROM background_jobs
      WHERE status = 'running'
      GROUP BY workspace_id, (kind = 'agent_task')
    ) AS lanes
    WHERE running >= CASE
      WHEN is_agent THEN ${perWorkspaceAgentConcurrency}::bigint
      ELSE ${perWorkspaceConcurrency}::bigint
    END
  `);
  const saturation = saturationRows[0];
  const byKind = Object.fromEntries(
    BACKGROUND_JOB_KINDS.map((kind) => [kind, 0]),
  ) as Record<BackgroundJobKind, number>;
  for (const row of (await db.execute<{ kind: string; count: number }>(sql`
    SELECT kind, COUNT(*) AS count
    FROM background_jobs
    GROUP BY kind
  `)).rows) {
    if (BACKGROUND_JOB_KINDS.includes(row.kind as BackgroundJobKind)) {
      byKind[row.kind as BackgroundJobKind] = row.count;
    }
  }
  const oldest = aggregate?.oldest_runnable_at ?? null;
  return {
    total: aggregate?.total ?? 0,
    queued: aggregate?.queued ?? 0,
    runnable: aggregate?.runnable ?? 0,
    retrying: aggregate?.retrying ?? 0,
    running: aggregate?.running ?? 0,
    succeeded: aggregate?.succeeded ?? 0,
    deadLetter: aggregate?.dead_letter ?? 0,
    cancelled: aggregate?.cancelled ?? 0,
    oldestRunnableAgeMs: oldest === null ? null : Math.max(0, now - oldest),
    averageDurationMs: aggregate?.average_duration_ms ?? null,
    saturatedWorkspaces: saturation?.count ?? 0,
    byKind,
  };
}
