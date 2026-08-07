import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskLeases } from "../src/db/schema";
import {
  claimTaskLease,
  databaseNowMs,
  heartbeatTaskLease,
  releaseTaskLease,
  withTaskLease,
} from "../src/services/task-leases";
import { createTestDb } from "./helpers";

async function expireLease(db: ReturnType<typeof createTestDb>, key: string): Promise<void> {
  await db.update(taskLeases)
    .set({
      expiresAt: sql`
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 1
      `,
    })
    .where(sql`${taskLeases.key} = ${key}`)
    .run();
}

describe("database-clock task leases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims, renews, releases, and reclaims with monotonic fencing versions", async () => {
    const db = createTestDb();
    const before = Date.now();
    expect(await databaseNowMs(db)).toBeGreaterThanOrEqual(before - 1_000);

    const first = (await claimTaskLease(db, "discovery:scheduler", "owner-a", 45_000))!;
    expect(first.version).toBe(1);
    expect(first.expiresAt).toBeGreaterThan(await databaseNowMs(db));
    expect(
      await claimTaskLease(db, first.key, "owner-b", 45_000),
    ).toBeNull();

    const renewed = (await heartbeatTaskLease(db, first, 45_000))!;
    expect(renewed).toMatchObject({
      key: first.key,
      owner: first.owner,
      version: first.version,
    });
    expect(await releaseTaskLease(db, { ...renewed, owner: "stale" })).toBe(false);
    expect(await releaseTaskLease(db, renewed)).toBe(true);

    const second = (await claimTaskLease(db, first.key, "owner-b", 45_000))!;
    expect(second.version).toBe(2);
    await expireLease(db, first.key);
    expect(await heartbeatTaskLease(db, second, 45_000)).toBeNull();

    const third = (await claimTaskLease(db, first.key, "owner-c", 45_000))!;
    expect(third.version).toBe(3);
    expect(await releaseTaskLease(db, second)).toBe(false);
  });

  it("returns busy without invoking work when another owner is live", async () => {
    const db = createTestDb();
    await claimTaskLease(db, "automation:scheduler", "owner-a", 45_000);
    const work = vi.fn(async () => "unexpected");

    await expect(
      await withTaskLease(
        db,
        {
          key: "automation:scheduler",
          owner: "owner-b",
          leaseMs: 45_000,
          heartbeatMs: 10_000,
        },
        work,
      ),
    ).resolves.toEqual({ busy: true });
    expect(work).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when a heartbeat loses its owner fence", async () => {
    vi.useFakeTimers();
    const db = createTestDb();
    let signalSeen: AbortSignal | undefined;

    const resultPromise = await withTaskLease(
      db,
      {
        key: "automation:workspace-1",
        owner: "owner-a",
        leaseMs: 100,
        heartbeatMs: 10,
      },
      ({ signal }) =>
        new Promise<boolean>((resolve) => {
          signalSeen = signal;
          signal.addEventListener("abort", () => resolve(signal.aborted), {
            once: true,
          });
        }),
    );

    await vi.waitFor(() => expect(signalSeen).toBeDefined());
    await db.update(taskLeases)
      .set({ owner: "owner-b" })
      .where(sql`${taskLeases.key} = ${"automation:workspace-1"}`)
      .run();

    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toEqual({ busy: false, value: true });
    expect(signalSeen?.aborted).toBe(true);
    expect(signalSeen?.reason).toMatchObject({ code: "lease_lost" });
  });
});
