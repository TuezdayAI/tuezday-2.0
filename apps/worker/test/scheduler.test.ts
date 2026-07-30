import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSettledLoop } from "../src/scheduler";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("settled worker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps a still-running invocation", async () => {
    const first = deferred<void>();
    const run = vi.fn(() => first.promise);
    const loop = startSettledLoop({
      name: "discovery",
      intervalMs: 1_000,
      run,
      onError: vi.fn(),
    });

    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("reports a rejected run and schedules the next wake", async () => {
    const onError = vi.fn();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValue(undefined);

    const loop = startSettledLoop({
      name: "ads",
      intervalMs: 500,
      run,
      onError,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("does not schedule after stop during an unresolved run", async () => {
    const active = deferred<void>();
    const run = vi.fn(() => active.promise);
    const loop = startSettledLoop({
      name: "inbox",
      intervalMs: 100,
      run,
      onError: vi.fn(),
    });

    loop.stop();
    active.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
