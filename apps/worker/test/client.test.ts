import { describe, expect, it, vi } from "vitest";
import { createWorkerClient, summarizeCadenceRun } from "../src/client";
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
