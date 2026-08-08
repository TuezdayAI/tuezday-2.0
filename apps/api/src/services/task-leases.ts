import { and, eq, gt, lte, sql } from "drizzle-orm";
import { type Db, type DbExecutor, rowsAffected } from "../db";
import { taskLeases, type TaskLeaseRow } from "../db/schema";

export interface LeaseToken {
  key: string;
  owner: string;
  version: number;
  expiresAt: number;
}

/**
 * Wall clock in epoch milliseconds, read from the database rather than the
 * caller. Leases must be timed by the one clock every worker agrees on — a
 * worker's local `Date.now()` can be skewed and would expire another's lease.
 */
export const DATABASE_NOW_MS = sql<number>`
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
`;

function toToken(row: TaskLeaseRow): LeaseToken {
  return {
    key: row.key,
    owner: row.owner,
    version: row.version,
    expiresAt: row.expiresAt,
  };
}

export async function databaseNowMs(db: DbExecutor): Promise<number> {
  const { rows } = await db.execute<{ now: number }>(
    sql`SELECT ${DATABASE_NOW_MS} AS now`,
  );
  const row = rows[0];
  if (!row) throw new Error("database_clock_unavailable");
  return Number(row.now);
}

export async function claimTaskLease(
  db: Db,
  key: string,
  owner: string,
  leaseMs: number,
): Promise<LeaseToken | null> {
  return await db.transaction(async (tx) => {
    const inserted = (await tx
      .insert(taskLeases)
      .values({
        key,
        owner,
        version: 1,
        expiresAt: sql`${DATABASE_NOW_MS} + ${leaseMs}`,
        heartbeatAt: DATABASE_NOW_MS,
        createdAt: DATABASE_NOW_MS,
        updatedAt: DATABASE_NOW_MS,
      })
      .onConflictDoNothing({ target: taskLeases.key })
      .returning())[0];
    if (inserted) return toToken(inserted);

    const reclaimed = (await tx
      .update(taskLeases)
      .set({
        owner,
        version: sql`${taskLeases.version} + 1`,
        expiresAt: sql`${DATABASE_NOW_MS} + ${leaseMs}`,
        heartbeatAt: DATABASE_NOW_MS,
        updatedAt: DATABASE_NOW_MS,
      })
      .where(
        and(
          eq(taskLeases.key, key),
          lte(taskLeases.expiresAt, DATABASE_NOW_MS),
        ),
      )
      .returning())[0];
    return reclaimed ? toToken(reclaimed) : null;
  });
}

export async function heartbeatTaskLease(
  db: Db,
  token: LeaseToken,
  leaseMs: number,
): Promise<LeaseToken | null> {
  const renewed = (await db
    .update(taskLeases)
    .set({
      expiresAt: sql`${DATABASE_NOW_MS} + ${leaseMs}`,
      heartbeatAt: DATABASE_NOW_MS,
      updatedAt: DATABASE_NOW_MS,
    })
    .where(
      and(
        eq(taskLeases.key, token.key),
        eq(taskLeases.owner, token.owner),
        eq(taskLeases.version, token.version),
        gt(taskLeases.expiresAt, DATABASE_NOW_MS),
      ),
    )
    .returning())[0];
  return renewed ? toToken(renewed) : null;
}

export async function releaseTaskLease(db: Db, token: LeaseToken): Promise<boolean> {
  const result = await db
    .update(taskLeases)
    .set({
      expiresAt: DATABASE_NOW_MS,
      updatedAt: DATABASE_NOW_MS,
    })
    .where(
      and(
        eq(taskLeases.key, token.key),
        eq(taskLeases.owner, token.owner),
        eq(taskLeases.version, token.version),
      ),
    );
  return rowsAffected(result) === 1;
}

export async function withTaskLease<T>(
  db: Db,
  input: {
    key: string;
    owner: string;
    leaseMs: number;
    heartbeatMs: number;
  },
  work: (context: {
    signal: AbortSignal;
    token: LeaseToken;
  }) => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }> {
  const initialToken = await claimTaskLease(
    db,
    input.key,
    input.owner,
    input.leaseMs,
  );
  if (!initialToken) return { busy: true };

  let latestToken = initialToken;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const controller = new AbortController();

  const scheduleHeartbeat = () => {
    heartbeatTimer = setTimeout(async () => {
      if (stopped) return;
      const renewed = await heartbeatTaskLease(db, latestToken, input.leaseMs);
      if (!renewed) {
        controller.abort(
          Object.assign(new Error("lease_lost"), { code: "lease_lost" }),
        );
        return;
      }
      latestToken = renewed;
      scheduleHeartbeat();
    }, input.heartbeatMs);
  };

  scheduleHeartbeat();
  try {
    const value = await work({
      signal: controller.signal,
      token: initialToken,
    });
    return { busy: false, value };
  } finally {
    stopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    await releaseTaskLease(db, latestToken);
  }
}
