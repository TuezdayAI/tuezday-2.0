import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { constraintText, indexes, tableNames } from "./schema-introspection";

const QUEUE_TABLES = [
  "background_jobs",
  "background_schedules",
  "background_workspace_dispatch",
];

describe("Sprint 73 background queue schema", () => {
  it("creates the job, schedule, and workspace-dispatch tables", async () => {
    const db = await createTestDb();
    const present = await tableNames(db);
    expect(QUEUE_TABLES.filter((name) => present.includes(name))).toEqual(QUEUE_TABLES);

    for (const table of QUEUE_TABLES) {
      // Every queue table is workspace-scoped and dies with its workspace, so
      // deleting a workspace can never strand queued work.
      const text = await constraintText(db, table);
      expect(text).toContain("workspace_id");
      expect(text).toContain("ON DELETE CASCADE");
    }
  });

  it("enforces active job and per-workspace schedule uniqueness", async () => {
    const db = await createTestDb();
    const jobIndexes = await indexes(db, "background_jobs");
    const scheduleIndexes = await indexes(db, "background_schedules");

    expect(
      jobIndexes.find((i) => i.name === "background_jobs_active_key_unique")?.definition,
    ).toContain("CREATE UNIQUE INDEX");
    expect(
      scheduleIndexes.find((i) => i.name === "background_schedules_workspace_kind_unique")
        ?.definition,
    ).toContain("CREATE UNIQUE INDEX");
  });
});
