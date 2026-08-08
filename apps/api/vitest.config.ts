import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    environment: "node",
    // Postgres round-trips are slower than better-sqlite3's in-process calls,
    // and fixtures now clone a database rather than a memory buffer.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
