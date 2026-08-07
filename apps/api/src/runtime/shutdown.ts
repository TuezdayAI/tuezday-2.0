/**
 * Graceful-shutdown state machine for the API process. Extracted from
 * server.ts (a top-level-await script Vitest cannot import) so the only
 * stateful piece of DEP-1's runtime code gets the same test coverage as its
 * pure resolvers.
 *
 * Idempotent — a second signal while shutdown is already in flight is a
 * no-op here (the amended spec keeps this as an intentional escape hatch:
 * Node's default handler still force-exits a wedged shutdown on a repeat
 * signal).
 *
 * Never calls process.exit() directly. Docker collects container logs from
 * piped stdout/stderr, and process.exit() can truncate output that hasn't
 * flushed yet — including the "shutdown complete" line this exists to
 * produce, and any in-flight fire-and-forget work started at boot. Callers
 * should set `process.exitCode` and let the event loop drain naturally.
 */
export interface ShutdownHandlerDeps {
  /** Closes the app (Fastify's app.close(), which runs preClose/onClose hooks). */
  close: () => Promise<void>;
  log: (message: string) => void;
  logError: (message: string, error: unknown) => void;
  /** Sets the process exit code; must not itself terminate the process. */
  exit: (code: number) => void;
}

export function createShutdownHandler(
  deps: ShutdownHandlerDeps,
): (signal: NodeJS.Signals) => Promise<void> {
  const { close, log, logError, exit } = deps;
  let shuttingDown = false;

  return async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Tuezday API: received ${signal}, shutting down...`);
    try {
      await close();
      log("Tuezday API: shutdown complete.");
      exit(0);
    } catch (error) {
      logError("Tuezday API: error during shutdown —", error);
      exit(1);
    }
  };
}
