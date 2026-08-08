import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    environment: "node",
    // Postgres round-trips are slower than better-sqlite3's in-process calls,
    // and fixtures now clone a database rather than a memory buffer.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Postgres is a co-tenant on this machine, not a library, and under load it
    // wants several cores of its own. Vitest's default (cores - 1) leaves it
    // none, and the run thrashes: on 8 cores the same 30-file subset takes 35s
    // at 4 workers, 48s at 7 (the default), and 62s at 10. Half the cores for
    // the workers and half for the server beats oversubscribing either.
    maxWorkers: "50%",
    minWorkers: 1,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
