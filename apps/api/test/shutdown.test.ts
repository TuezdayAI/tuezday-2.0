import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../src/runtime/shutdown";

function makeDeps(close: () => Promise<void>) {
  const log = vi.fn();
  const logError = vi.fn();
  const exit = vi.fn();
  const shutdown = createShutdownHandler({ close, log, logError, exit });
  return { shutdown, log, logError, exit };
}

describe("createShutdownHandler", () => {
  it("closes the app and exits 0 on success", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { shutdown, exit, log, logError } = makeDeps(close);

    await shutdown("SIGTERM");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("received SIGTERM"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("shutdown complete"),
    );
  });

  it("logs the error and exits 1 when close() rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("boom"));
    const { shutdown, exit, logError } = makeDeps(close);

    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toContain("error during shutdown");
    expect(logError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("never calls exit with both 0 and 1", async () => {
    const close = vi.fn().mockRejectedValue(new Error("boom"));
    const { shutdown, exit } = makeDeps(close);

    await shutdown("SIGINT");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is idempotent — a second signal while shutdown is in flight is a no-op", async () => {
    let resolveClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const { shutdown, exit } = makeDeps(close);

    const first = await shutdown("SIGTERM");
    const second = await shutdown("SIGTERM");
    resolveClose();
    await Promise.all([first, second]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent after completing — a later signal is also a no-op", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { shutdown, exit } = makeDeps(close);

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
