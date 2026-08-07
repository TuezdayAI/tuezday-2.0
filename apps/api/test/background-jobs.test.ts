import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { BackgroundJobPayload } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { backgroundJobs, workspaces } from "../src/db/schema";
import {
  claimBackgroundJobs,
  completeBackgroundJob,
  deadLetterBackgroundJob,
  enqueueBackgroundJob,
  getBackgroundQueueStats,
  heartbeatBackgroundJob,
  listBackgroundJobs,
  requeueDeadLetter,
  retryBackgroundJob,
} from "../src/services/background-jobs";
import { createTestDb } from "./helpers";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

function payload(
  workspaceId: string,
  kind: Exclude<BackgroundJobPayload["kind"], "launch_generate"> = "evidence",
): BackgroundJobPayload {
  return { kind, workspaceId };
}

describe("durable background job repository", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    const now = Date.now();
    db.insert(workspaces)
      .values([
        { id: WORKSPACE_A, name: "A", createdAt: now, updatedAt: now },
        { id: WORKSPACE_B, name: "B", createdAt: now + 1, updatedAt: now + 1 },
      ])
      .run();
  });

  function enqueue(
    workspaceId: string,
    key: string,
    options: {
      kind?: Exclude<BackgroundJobPayload["kind"], "launch_generate">;
      availableAt?: number;
      maxAttempts?: number;
      priority?: number;
    } = {},
  ) {
    return enqueueBackgroundJob(db, {
      payload: payload(workspaceId, options.kind),
      idempotencyKey: key,
      availableAt: options.availableAt,
      maxAttempts: options.maxAttempts,
      priority: options.priority,
    });
  }

  it("deduplicates only active jobs within a workspace", () => {
    const first = enqueue(WORKSPACE_A, "daily:evidence");
    const duplicate = enqueue(WORKSPACE_A, "daily:evidence");
    const otherWorkspace = enqueue(WORKSPACE_B, "daily:evidence");

    expect(duplicate.id).toBe(first.id);
    expect(otherWorkspace.id).not.toBe(first.id);
    const [claim] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(completeBackgroundJob(db, claim!, { ok: true })).toBe(true);

    const nextOccurrence = enqueue(WORKSPACE_A, "daily:evidence");
    expect(nextOccurrence.id).not.toBe(first.id);
    expect(first.activeKey).toBe(`${WORKSPACE_A}:daily:evidence`);
  });

  it("validates payload tenant identity and admission bounds", () => {
    expect(() =>
      enqueueBackgroundJob(db, {
        payload: { kind: "evidence", workspaceId: "not-a-uuid" } as BackgroundJobPayload,
        idempotencyKey: "invalid",
      }),
    ).toThrow();
    expect(() =>
      enqueueBackgroundJob(db, {
        payload: payload(WORKSPACE_A),
        idempotencyKey: "",
      }),
    ).toThrow("idempotency");
    expect(() =>
      enqueueBackgroundJob(db, {
        payload: payload(WORKSPACE_A),
        idempotencyKey: "attempts",
        maxAttempts: 0,
      }),
    ).toThrow("maxAttempts");
  });

  it("does not claim work before its database availability time", () => {
    enqueue(WORKSPACE_A, "future", { availableAt: Date.now() + 60_000 });
    expect(
      claimBackgroundJobs(db, {
        owner: "worker-a",
        leaseMs: 30_000,
        limit: 1,
        perWorkspaceLimit: 1,
      }),
    ).toEqual([]);
  });

  it("serves one job per workspace before a noisy tenant receives another", () => {
    enqueue(WORKSPACE_A, "a-1", { priority: 10 });
    enqueue(WORKSPACE_A, "a-2", { priority: 10 });
    enqueue(WORKSPACE_B, "b-1");

    const claims = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 2,
      perWorkspaceLimit: 2,
    });

    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.workspaceId))).toEqual(
      new Set([WORKSPACE_A, WORKSPACE_B]),
    );
  });

  it("enforces the per-workspace concurrency cap", () => {
    enqueue(WORKSPACE_A, "a-1");
    enqueue(WORKSPACE_A, "a-2");
    const [running] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(running?.workspaceId).toBe(WORKSPACE_A);

    expect(
      claimBackgroundJobs(db, {
        owner: "worker-b",
        leaseMs: 30_000,
        limit: 1,
        perWorkspaceLimit: 1,
      }),
    ).toEqual([]);
  });

  it("reclaims expired leases with a higher fence and rejects stale writes", () => {
    enqueue(WORKSPACE_A, "reclaim");
    const [first] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(first).toMatchObject({ attempt: 1, leaseVersion: 1 });

    db.update(backgroundJobs)
      .set({
        leaseExpiresAt: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 1`,
      })
      .where(eq(backgroundJobs.id, first!.id))
      .run();

    const [second] = claimBackgroundJobs(db, {
      owner: "worker-b",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(second).toMatchObject({ attempt: 2, leaseVersion: 2, leaseOwner: "worker-b" });
    expect(heartbeatBackgroundJob(db, first!, 30_000)).toBeNull();
    expect(completeBackgroundJob(db, first!, {})).toBe(false);
    expect(heartbeatBackgroundJob(db, second!, 30_000)).toMatchObject({
      id: second!.id,
      leaseVersion: 2,
    });
    expect(completeBackgroundJob(db, second!, {})).toBe(true);
  });

  it("retries with deterministic bounded backoff and dead-letters exhausted work", () => {
    const queued = enqueue(WORKSPACE_A, "retry", { maxAttempts: 2 });
    const [first] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    const retried = retryBackgroundJob(db, first!, "provider down", {
      baseBackoffMs: 1_000,
      maxBackoffMs: 5_000,
    });
    expect(retried).toMatchObject({ id: queued.id, status: "queued", attempt: 1 });
    expect(retried!.availableAt).toBeGreaterThan(Date.now());
    expect(retried!.availableAt - Date.now()).toBeLessThanOrEqual(5_000);

    db.update(backgroundJobs)
      .set({ availableAt: 0 })
      .where(eq(backgroundJobs.id, queued.id))
      .run();
    const [second] = claimBackgroundJobs(db, {
      owner: "worker-b",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    const exhausted = retryBackgroundJob(db, second!, "still down", {
      baseBackoffMs: 1_000,
      maxBackoffMs: 5_000,
    });
    expect(exhausted).toMatchObject({ status: "dead_letter", activeKey: null });
  });

  it("sanitizes diagnostics and requeues a dead letter without deleting history", () => {
    enqueue(WORKSPACE_A, "dead");
    const [claim] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    const dead = deadLetterBackgroundJob(
      db,
      claim!,
      `Authorization: Bearer super-secret-token\n${"x".repeat(2_000)}`,
    );
    expect(dead).toMatchObject({ status: "dead_letter", activeKey: null });
    expect(dead!.lastError).not.toContain("super-secret-token");
    expect(dead!.lastError!.length).toBeLessThanOrEqual(1_000);

    const requeued = requeueDeadLetter(db, dead!.id);
    expect(requeued).toMatchObject({
      status: "queued",
      attempt: 0,
      idempotencyKey: dead!.idempotencyKey,
    });
    expect(requeued!.id).not.toBe(dead!.id);
    expect(
      db.select().from(backgroundJobs).where(eq(backgroundJobs.id, dead!.id)).get()?.status,
    ).toBe("dead_letter");
  });

  it("lists bounded filters and reports queue statistics by kind", () => {
    enqueue(WORKSPACE_A, "queued", { kind: "evidence" });
    enqueue(WORKSPACE_B, "running", { kind: "ads" });
    const [running] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(running).toBeDefined();
    const otherKind = running!.kind === "ads" ? "evidence" : "ads";

    expect(listBackgroundJobs(db, { status: "running", limit: 10 })).toHaveLength(1);
    expect(listBackgroundJobs(db, { kind: otherKind, limit: 10 })).toHaveLength(1);
    expect(() => listBackgroundJobs(db, { limit: 0 })).toThrow("limit");

    const stats = getBackgroundQueueStats(db, { perWorkspaceConcurrency: 1 });
    expect(stats.total).toBe(2);
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.saturatedWorkspaces).toBe(1);
    expect(stats.averageDurationMs).toBeNull();
    expect(stats.byKind.ads + stats.byKind.evidence).toBe(2);
  });

  it("reports terminal execution duration without counting queued time", () => {
    const queued = enqueue(WORKSPACE_A, "duration", { kind: "evidence" });
    const [claim] = claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    db.update(backgroundJobs)
      .set({ startedAt: sql`${backgroundJobs.startedAt} - 25` })
      .where(eq(backgroundJobs.id, queued.id))
      .run();
    expect(completeBackgroundJob(db, claim!, { ok: true })).toBe(true);

    const stats = getBackgroundQueueStats(db, { perWorkspaceConcurrency: 1 });
    expect(stats.averageDurationMs).toBeGreaterThanOrEqual(25);
    expect(stats.saturatedWorkspaces).toBe(0);
  });

  it("cascades queue history when its workspace is deleted", () => {
    enqueue(WORKSPACE_A, randomUUID());
    db.delete(workspaces).where(eq(workspaces.id, WORKSPACE_A)).run();
    expect(
      db
        .select()
        .from(backgroundJobs)
        .where(and(eq(backgroundJobs.workspaceId, WORKSPACE_A)))
        .all(),
    ).toEqual([]);
  });
});
