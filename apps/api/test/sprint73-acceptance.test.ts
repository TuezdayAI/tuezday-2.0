import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_RECURRING_JOB_KINDS } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  backgroundJobs,
  backgroundSchedules,
  workspaces,
} from "../src/db/schema";
import { DEFAULT_BACKGROUND_JOB_POLICY } from "../src/runtime/background-job-policy";
import {
  createBackgroundJobHandlersFromOperations,
  type BackgroundJobOperations,
} from "../src/services/background-job-handlers";
import {
  claimBackgroundJobs,
  enqueueBackgroundJob,
} from "../src/services/background-jobs";
import { reconcileBackgroundSchedules } from "../src/services/background-schedules";
import { createTestDb } from "./helpers";

const TOKEN = "sprint-73-acceptance-worker";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("Sprint 73 durable queue acceptance", () => {
  let app: TuezdayApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("survives retries, dead letters, requeue, reclaim, and app restart fairly", async () => {
    const db = await createTestDb();
    await seedWorkspace(db, FIRST, "First");
    await seedWorkspace(db, SECOND, "Second");
    const attempts = new Map<string, number>();
    let secondRecovers = false;
    const evidence = vi.fn(async (workspaceId: string) => {
      const attempt = (attempts.get(workspaceId) ?? 0) + 1;
      attempts.set(workspaceId, attempt);
      if (workspaceId === FIRST && attempt === 1) throw new Error("transient");
      if (workspaceId === SECOND && !secondRecovers) throw new Error("persistent");
      return { workspaceId, attempt };
    });
    const operations = Object.fromEntries(
      BACKGROUND_RECURRING_JOB_KINDS.map((kind) => [
        kind,
        kind === "evidence" ? evidence : vi.fn(async () => ({ kind })),
      ]),
    ) as unknown as BackgroundJobOperations;
    const handlers = createBackgroundJobHandlersFromOperations(operations);
    const policy = {
      ...DEFAULT_BACKGROUND_JOB_POLICY,
      batchSize: 2,
      perWorkspaceConcurrency: 1,
      baseBackoffMs: 100,
      maxBackoffMs: 100,
    };
    await reconcileBackgroundSchedules(db, policy);
    await db.update(backgroundSchedules)
      .set({ nextRunAt: Date.now() + 86_400_000 });
    await enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: FIRST },
      idempotencyKey: "acceptance:first",
      priority: 100,
      maxAttempts: 3,
    });
    await enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: SECOND },
      idempotencyKey: "acceptance:second",
      priority: 100,
      maxAttempts: 2,
    });

    app = await buildApp({
      db,
      workerToken: TOKEN,
      backgroundJobHandlers: handlers,
      backgroundJobPolicy: policy,
    });
    expect(await tick(app)).toMatchObject({ claimed: 2, retried: 2 });
    expect(evidence.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual([
      FIRST,
      SECOND,
    ]);

    await db.update(backgroundJobs)
      .set({ availableAt: 0 })
      .where(eq(backgroundJobs.status, "queued"));
    expect(await tick(app)).toMatchObject({
      claimed: 2,
      succeeded: 1,
      deadLettered: 1,
    });
    const dead = ((await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, "dead_letter")))[0])!;

    secondRecovers = true;
    const requeued = await app.inject({
      method: "POST",
      url: `/internal/background-jobs/${dead.id}/requeue`,
      headers: workerHeaders(),
      payload: {},
    });
    expect(requeued.statusCode, requeued.body).toBe(201);
    expect(await tick(app)).toMatchObject({ claimed: 1, succeeded: 1 });

    const reclaim = await enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId: FIRST },
      idempotencyKey: "acceptance:reclaim",
      priority: 100,
    });
    const [staleClaim] = await claimBackgroundJobs(db, {
      owner: "dead-process",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(staleClaim?.id).toBe(reclaim.id);
    await db.update(backgroundJobs)
      .set({ leaseExpiresAt: 0 })
      .where(eq(backgroundJobs.id, reclaim.id));
    expect(await tick(app)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(
      (await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, reclaim.id)))[0],
    ).toMatchObject({ status: "succeeded", attempt: 2 });

    await app.close();
    app = undefined;
    const scheduleCount = (await db.select().from(backgroundSchedules)).length;
    app = await buildApp({
      db,
      workerToken: TOKEN,
      backgroundJobHandlers: handlers,
      backgroundJobPolicy: policy,
    });
    expect(await tick(app)).toMatchObject({ reconciled: 0, admitted: 0 });
    expect(await db.select().from(backgroundSchedules)).toHaveLength(scheduleCount);

    const stats = await app.inject({
      method: "GET",
      url: "/internal/background-jobs/stats",
      headers: workerHeaders(),
    });
    expect(stats.statusCode, stats.body).toBe(200);
    expect(stats.json()).toMatchObject({ deadLetter: 1, running: 0 });
  });
});

async function seedWorkspace(db: Db, id: string, name: string): Promise<void> {
  await db.insert(workspaces)
    .values({ id, name, createdAt: Date.now(), updatedAt: Date.now() });
}

function workerHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function tick(app: TuezdayApp) {
  const response = await app.inject({
    method: "POST",
    url: "/internal/background-jobs/tick",
    headers: workerHeaders(),
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
