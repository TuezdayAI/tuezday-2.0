import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_JOB_KINDS } from "@tuezday/contracts";
import type { Db } from "../src/db";
import { backgroundJobs, workspaces } from "../src/db/schema";
import { DEFAULT_BACKGROUND_JOB_POLICY } from "../src/runtime/background-job-policy";
import {
  defineBackgroundJobHandlers,
  type BackgroundJobHandler,
  type BackgroundJobHandlers,
} from "../src/services/background-job-handlers";
import { enqueueBackgroundJob } from "../src/services/background-jobs";
import { runBackgroundJobTick } from "../src/services/background-job-runner";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function handlersWith(
  outcome: Awaited<ReturnType<BackgroundJobHandler>> = { status: "complete" },
): BackgroundJobHandlers {
  return defineBackgroundJobHandlers(
    Object.fromEntries(
      BACKGROUND_JOB_KINDS.map((kind) => [
        kind,
        vi.fn(async () => outcome),
      ]),
    ) as unknown as BackgroundJobHandlers,
  );
}

function policy(overrides: Partial<typeof DEFAULT_BACKGROUND_JOB_POLICY> = {}) {
  return {
    ...DEFAULT_BACKGROUND_JOB_POLICY,
    batchSize: 1,
    perWorkspaceConcurrency: 1,
    ...overrides,
  };
}

describe("background job runner", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    db.insert(workspaces)
      .values({
        id: WORKSPACE_ID,
        name: "Runner",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  });

  it("reconciles, admits, fairly claims, and completes a bounded tick", async () => {
    const handlers = handlersWith();
    const result = await runBackgroundJobTick({
      db,
      handlers,
      policy: policy(),
      instanceId: "api-a",
      shutdownSignal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      busy: false,
      reconciled: 13,
      admitted: 13,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      deadLettered: 0,
      lost: 0,
    });
    expect(
      Object.values(handlers).reduce(
        (calls, handler) => calls + vi.mocked(handler).mock.calls.length,
        0,
      ),
    ).toBe(1);
  });

  it("dead-letters malformed persisted payload without invoking a handler", async () => {
    const handlers = handlersWith();
    const job = enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: WORKSPACE_ID },
      idempotencyKey: "malformed",
      priority: 100,
    });
    db.update(backgroundJobs)
      .set({ payloadJson: "{" })
      .where(eq(backgroundJobs.id, job.id))
      .run();

    const result = await runBackgroundJobTick({
      db,
      handlers,
      policy: policy(),
      instanceId: "api-a",
      shutdownSignal: new AbortController().signal,
    });
    expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(
      db.select().from(backgroundJobs).where(eq(backgroundJobs.id, job.id)).get(),
    ).toMatchObject({ status: "dead_letter", activeKey: null });
    expect(
      Object.values(handlers).every(
        (handler) => vi.mocked(handler).mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it("persists explicit retry and dead-letter outcomes", async () => {
    const retryHandlers = handlersWith({ status: "retry", error: "rate_limited" });
    enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: WORKSPACE_ID },
      idempotencyKey: "retry",
      priority: 100,
    });
    const retry = await runBackgroundJobTick({
      db,
      handlers: retryHandlers,
      policy: policy(),
      instanceId: "api-a",
      shutdownSignal: new AbortController().signal,
    });
    expect(retry).toMatchObject({ claimed: 1, retried: 1 });

    const deadHandlers = handlersWith({ status: "dead_letter", error: "invalid_target" });
    enqueueBackgroundJob(db, {
      payload: { kind: "ads", workspaceId: WORKSPACE_ID },
      idempotencyKey: "dead",
      priority: 100,
    });
    const dead = await runBackgroundJobTick({
      db,
      handlers: deadHandlers,
      policy: policy(),
      instanceId: "api-b",
      shutdownSignal: new AbortController().signal,
    });
    expect(dead).toMatchObject({ claimed: 1, deadLettered: 1 });
  });

  it("treats unexpected handler errors as retryable", async () => {
    const handlers = handlersWith();
    handlers.evidence = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: WORKSPACE_ID },
      idempotencyKey: "throws",
      priority: 100,
    });

    const result = await runBackgroundJobTick({
      db,
      handlers,
      policy: policy(),
      instanceId: "api-a",
      shutdownSignal: new AbortController().signal,
    });
    expect(result).toMatchObject({ claimed: 1, retried: 1 });
  });

  it("does not finish a job after its lease fence changes", async () => {
    const handlers = handlersWith();
    handlers.evidence = vi.fn<BackgroundJobHandler>(async (_payload, context) => {
      db.update(backgroundJobs)
        .set({ leaseVersion: context.claim.leaseVersion + 1 })
        .where(eq(backgroundJobs.id, context.claim.id))
        .run();
      return { status: "complete" as const };
    });
    enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: WORKSPACE_ID },
      idempotencyKey: "lose-fence",
      priority: 100,
    });

    const result = await runBackgroundJobTick({
      db,
      handlers,
      policy: policy(),
      instanceId: "api-a",
      shutdownSignal: new AbortController().signal,
    });
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, lost: 1 });
  });
});
