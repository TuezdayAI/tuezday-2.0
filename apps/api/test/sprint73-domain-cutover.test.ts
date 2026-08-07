import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_RECURRING_JOB_KINDS,
  type BackgroundRecurringJobKind,
} from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import { workspaces } from "../src/db/schema";
import { DEFAULT_BACKGROUND_JOB_POLICY } from "../src/runtime/background-job-policy";
import {
  createBackgroundJobHandlersFromOperations,
  type BackgroundJobOperations,
} from "../src/services/background-job-handlers";
import { runBackgroundJobTick } from "../src/services/background-job-runner";
import { createTestDb } from "./helpers";

const WORKER_TOKEN = "sprint-73-cutover-worker-token";
const WORKSPACE_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;

describe("Sprint 73 domain cutover", () => {
  let app: TuezdayApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("executes every recurring domain only for the workspace carried by its job", async () => {
    const db = createTestDb();
    for (const [index, id] of WORKSPACE_IDS.entries()) {
      db.insert(workspaces)
        .values({
          id,
          name: `Workspace ${index + 1}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
    }
    const operations = Object.fromEntries(
      BACKGROUND_RECURRING_JOB_KINDS.map((kind) => [
        kind,
        vi.fn(async (workspaceId: string) => ({ kind, workspaceId })),
      ]),
    ) as unknown as BackgroundJobOperations;
    const handlers = createBackgroundJobHandlersFromOperations(operations);
    const policy = {
      ...DEFAULT_BACKGROUND_JOB_POLICY,
      batchSize: 26,
      perWorkspaceConcurrency: 13,
    };

    const tick = await runBackgroundJobTick({
      db,
      handlers,
      policy,
      instanceId: "api-cutover",
      shutdownSignal: new AbortController().signal,
    });

    expect(tick).toMatchObject({
      busy: false,
      reconciled: 26,
      admitted: 26,
      claimed: 26,
      succeeded: 26,
    });
    for (const kind of BACKGROUND_RECURRING_JOB_KINDS) {
      const calls = vi.mocked(operations[kind]).mock.calls;
      expect(
        calls.map(([workspaceId]) => workspaceId).sort(),
        kind,
      ).toEqual([...WORKSPACE_IDS]);
    }

    app = await buildApp({
      db,
      workerToken: WORKER_TOKEN,
      backgroundJobHandlers: handlers,
      backgroundJobPolicy: policy,
    });
    for (const path of [
      "/internal/discovery/tick",
      "/internal/automation/tick",
      "/internal/pipelines/tick",
      "/internal/preferences/tick",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {},
      });
      expect(response.statusCode, path).toBe(404);
    }
  });

  it("keeps launch generation unavailable until its event-job cutover", async () => {
    const operations = Object.fromEntries(
      BACKGROUND_RECURRING_JOB_KINDS.map((kind) => [
        kind,
        vi.fn(async () => ({ kind })),
      ]),
    ) as unknown as Record<
      BackgroundRecurringJobKind,
      BackgroundJobOperations[BackgroundRecurringJobKind]
    >;
    const handlers = createBackgroundJobHandlersFromOperations(operations);
    await expect(
      handlers.launch_generate(
        {
          kind: "launch_generate",
          workspaceId: WORKSPACE_IDS[0],
          launchId: "33333333-3333-4333-8333-333333333333",
          input: {},
          actor: { userId: null, label: "system", human: false },
        },
        {} as never,
      ),
    ).resolves.toEqual({
      status: "retry",
      error: "background_job_handler_unavailable:launch_generate",
    });
  });
});
