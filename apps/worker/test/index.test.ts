import { describe, expect, it, vi } from "vitest";
import type { WorkerClient } from "../src/client";
import type { WorkerConfig } from "../src/config";
import { startWorker } from "../src/index";
import type { SettledLoop, startSettledLoop } from "../src/scheduler";

describe("thin worker startup", () => {
  it("starts exactly one settled background-jobs loop", async () => {
    const config: WorkerConfig = {
      internalApiUrl: "https://internal.example.test",
      token: "worker-token",
      queuePollMs: 750,
    };
    const client: WorkerClient = {
      runBackgroundJobsTick: vi.fn(async () => ({
        busy: false,
        reconciled: 0,
        admitted: 2,
        claimed: 2,
        succeeded: 1,
        retried: 1,
        deadLettered: 0,
        lost: 0,
      })),
    };
    const loop: SettledLoop = { stop: vi.fn() };
    const startLoop = vi.fn<typeof startSettledLoop>(() => loop);
    const info = vi.fn();
    const error = vi.fn();

    const worker = startWorker({
      config,
      client,
      startLoop,
      logger: { info, error },
    });

    expect(startLoop).toHaveBeenCalledTimes(1);
    const spec = startLoop.mock.calls[0]![0];
    expect(spec).toMatchObject({
      name: "background-jobs",
      intervalMs: 750,
    });
    await spec.run();
    expect(client.runBackgroundJobsTick).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('"claimed":2'),
    );
    spec.onError(new Error("api down"));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"background_jobs_tick_failed"'),
    );

    worker.stop();
    expect(loop.stop).toHaveBeenCalledTimes(1);
  });
});
