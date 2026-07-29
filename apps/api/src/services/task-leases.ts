import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "../db";
import { taskLeases, type TaskLeaseRow } from "../db/schema";

export interface LeaseToken {
  key: string;
  owner: string;
  version: number;
  expiresAt: number;
}

export const DATABASE_NOW_MS = sql<number>`
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
`;

function toToken(row: TaskLeaseRow): LeaseToken {
  return {
    key: row.key,
    owner: row.owner,
    version: row.version,
    expiresAt: row.expiresAt,
  };
}

export function databaseNowMs(db: DbExecutor): number {
  const row = db.get<{ now: number }>(
    sql`SELECT ${DATABASE_NOW_MS} AS now`,
  );
  if (!row) throw new Error("database_clock_unavailable");
  return row.now;
}

export function claimTaskLease(
  db: Db,
  key: string,
  owner: string,
  leaseMs: number,
): LeaseToken | null {
  return db.transaction((tx) => {
    const inserted = tx
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
      .returning()
      .get();
    if (inserted) return toToken(inserted);

    const reclaimed = tx
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
      .returning()
      .get();
    return reclaimed ? toToken(reclaimed) : null;
  });
}

export function heartbeatTaskLease(
  db: Db,
  token: LeaseToken,
  leaseMs: number,
): LeaseToken | null {
  const renewed = db
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
    .returning()
    .get();
  return renewed ? toToken(renewed) : null;
}

export function releaseTaskLease(db: Db, token: LeaseToken): boolean {
  const result = db
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
    )
    .run();
  return result.changes === 1;
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
  const initialToken = claimTaskLease(
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
    heartbeatTimer = setTimeout(() => {
      if (stopped) return;
      const renewed = heartbeatTaskLease(db, latestToken, input.leaseMs);
      if (!renewed) {
        controller.abort(new Error("lease_lost"));
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
    releaseTaskLease(db, latestToken);
  }
}
