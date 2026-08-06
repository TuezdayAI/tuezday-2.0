import { describe, expect, it, vi } from "vitest";
import {
  createWorkerClient,
  summarizeCadenceRun,
  summarizePublishRun,
} from "../src/client";
import type { WorkerConfig } from "../src/config";

const config: WorkerConfig = {
  internalApiUrl: "http://localhost:3001",
  token: "worker-client-test-token",
  intervals: {
    discoveryMs: 60_000,
    automationMs: 60_000,
    learningMs: 86_400_000,
    adsMs: 3_600_000,
    publishMs: 60_000,
    cadenceMs: 60_000,
    inboxMs: 60_000,
    sequenceMs: 60_000,
    evidenceMs: 60_000,
  },
};

describe("worker HTTP client", () => {
  it("runs governed actions before legacy publication receipts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          actions: [
            {
              action: { id: "action-1", kind: "publish", status: "dispatching" },
              execution: { id: "publication-1", status: "processing", error: null },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [
            { id: "publication-2", ok: true, state: "published" },
            { id: "publication-3", ok: false, state: "blocked", error: "kill_switch_on" },
          ],
        }),
      );
    const client = createWorkerClient(config, { fetcher, maxAttempts: 1 });

    const result = await client.runPublishing("workspace-1");

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3001/workspaces/workspace-1/external-actions/run",
      "http://localhost:3001/workspaces/workspace-1/publish/run",
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
    expect(summarizePublishRun(result)).toEqual({
      published: 1,
      processing: 1,
      blocked: 1,
      failed: 0,
      outcomes: [
        { id: "publication-1", state: "processing" },
        { id: "publication-2", state: "published" },
        { id: "publication-3", state: "blocked", error: "kill_switch_on" },
      ],
    });
  });

  it("preserves cadence issues even when no draft was filled", () => {
    expect(
      summarizeCadenceRun([
        {
          cadenceId: "cadence-1",
          filled: 0,
          issues: [
            {
              code: "nonexistent_local_time",
              cadenceId: "cadence-1",
              draftId: null,
              slot: null,
              message: "02:30 does not exist on 2026-03-08 in America/New_York.",
            },
          ],
        },
      ]),
    ).toEqual({
      filled: 0,
      issues: [
        expect.objectContaining({ code: "nonexistent_local_time", cadenceId: "cadence-1" }),
      ],
    });
  });

  it("retries bounded network failures during concurrent startup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = createWorkerClient(config, {
      fetcher,
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    await expect(client.listWorkspaces()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe(
      "http://localhost:3001/workspaces",
    );
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${config.token}`);
  });

  it("does not retry an HTTP response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const client = createWorkerClient(config, {
      fetcher,
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    await expect(client.listWorkspaces()).rejects.toThrow(
      "GET /workspaces returned 503",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
