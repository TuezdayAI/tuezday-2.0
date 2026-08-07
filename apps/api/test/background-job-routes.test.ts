import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_JOB_KINDS } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { DEFAULT_BACKGROUND_JOB_POLICY } from "../src/runtime/background-job-policy";
import {
  defineBackgroundJobHandlers,
  type BackgroundJobHandlers,
} from "../src/services/background-job-handlers";
import {
  claimBackgroundJobs,
  deadLetterBackgroundJob,
  enqueueBackgroundJob,
} from "../src/services/background-jobs";
import { createTestDb, registerUser } from "./helpers";

const WORKER_TOKEN = "sprint-73-worker-token";

describe("internal background job routes", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let userToken: string;

  beforeEach(async () => {
    db = createTestDb();
    const handlers = defineBackgroundJobHandlers(
      Object.fromEntries(
        BACKGROUND_JOB_KINDS.map((kind) => [
          kind,
          async () => ({ status: "complete" as const }),
        ]),
      ) as unknown as BackgroundJobHandlers,
    );
    app = await buildApp({
      db,
      workerToken: WORKER_TOKEN,
      backgroundJobHandlers: handlers,
      backgroundJobPolicy: {
        ...DEFAULT_BACKGROUND_JOB_POLICY,
        batchSize: 1,
        perWorkspaceConcurrency: 1,
      },
    });
    const user = await registerUser(app, "queue-operator@test.dev");
    userToken = user.token;
    const workspace = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: "Queue routes" },
    });
    workspaceId = workspace.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  const workerHeaders = () => ({ authorization: `Bearer ${WORKER_TOKEN}` });

  it.each([
    ["POST", "/internal/background-jobs/tick"],
    ["GET", "/internal/background-jobs"],
    ["GET", "/internal/background-jobs/stats"],
  ] as const)("requires the worker credential for %s %s", async (method, url) => {
    const absent = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
    const user = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${userToken}` },
      payload: method === "POST" ? {} : undefined,
    });
    expect(absent.statusCode).toBe(401);
    expect(user.statusCode).toBe(401);
  });

  it("runs one strict queue tick and exposes bounded inspection", async () => {
    const tick = await app.inject({
      method: "POST",
      url: "/internal/background-jobs/tick",
      headers: workerHeaders(),
      payload: {},
    });
    expect(tick.statusCode, tick.body).toBe(200);
    expect(tick.json()).toMatchObject({ busy: false, admitted: 13, claimed: 1 });

    const injected = await app.inject({
      method: "POST",
      url: "/internal/background-jobs/tick",
      headers: workerHeaders(),
      payload: { workspaceId },
    });
    expect(injected.statusCode).toBe(400);

    const list = await app.inject({
      method: "GET",
      url: `/internal/background-jobs?workspaceId=${workspaceId}&limit=5`,
      headers: workerHeaders(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.length).toBeLessThanOrEqual(5);

    const invalid = await app.inject({
      method: "GET",
      url: "/internal/background-jobs?limit=0",
      headers: workerHeaders(),
    });
    expect(invalid.statusCode).toBe(400);

    const stats = await app.inject({
      method: "GET",
      url: "/internal/background-jobs/stats",
      headers: workerHeaders(),
    });
    expect(stats.statusCode, stats.body).toBe(200);
    expect(stats.json().total).toBe(13);
    expect(stats.json()).toMatchObject({
      averageDurationMs: expect.anything(),
      saturatedWorkspaces: expect.any(Number),
    });
  });

  it("requeues only dead-letter work and preserves its history", async () => {
    const queued = await enqueueBackgroundJob(db, {
      payload: { kind: "evidence", workspaceId },
      idempotencyKey: "operator-requeue",
      priority: 100,
    });
    const [claim] = await claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    const dead = (await deadLetterBackgroundJob(db, claim!, "provider rejected"))!;

    const response = await app.inject({
      method: "POST",
      url: `/internal/background-jobs/${dead.id}/requeue`,
      headers: workerHeaders(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      sourceJobId: queued.id,
      job: { status: "queued", idempotencyKey: "operator-requeue" },
    });

    const repeat = await app.inject({
      method: "POST",
      url: `/internal/background-jobs/${response.json().job.id}/requeue`,
      headers: workerHeaders(),
      payload: {},
    });
    expect(repeat.statusCode).toBe(409);
  });
});
