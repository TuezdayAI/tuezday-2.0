import { describe, expect, it, vi } from "vitest";
import { createWorkerClient } from "../src/client";
import type { WorkerConfig } from "../src/config";

const config: WorkerConfig = {
  internalApiUrl: "http://localhost:3001",
  token: "worker-client-test-token",
  queuePollMs: 1_000,
};

describe("worker HTTP client", () => {
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

    await expect(client.runBackgroundJobsTick()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe(
      "http://localhost:3001/internal/background-jobs/tick",
    );
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${config.token}`);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: "POST",
      body: "{}",
    });
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

    await expect(client.runBackgroundJobsTick()).rejects.toThrow(
      "POST /internal/background-jobs/tick returned 503",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("exposes no generic or maintenance request surface", () => {
    const client = createWorkerClient(config, { fetcher: vi.fn() });
    expect(Object.keys(client)).toEqual(["runBackgroundJobsTick"]);
  });
});
