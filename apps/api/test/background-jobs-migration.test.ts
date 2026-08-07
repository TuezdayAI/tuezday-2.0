import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers";

interface MasterRow {
  name: string;
  type: string;
  sql: string | null;
}

describe("Sprint 73 background queue migration", () => {
  it("creates the job, schedule, and workspace-dispatch tables", async () => {
    const db = createTestDb();
    const rows = await db.all<MasterRow>(sql`
      SELECT name, type, sql
      FROM sqlite_master
      WHERE name IN (
        'background_jobs',
        'background_schedules',
        'background_workspace_dispatch'
      )
      ORDER BY name
    `);

    expect(rows.map((row) => row.name)).toEqual([
      "background_jobs",
      "background_schedules",
      "background_workspace_dispatch",
    ]);
    for (const row of rows) {
      expect(row.type).toBe("table");
      expect(row.sql).toContain("workspace_id");
      expect(row.sql).toContain("ON DELETE cascade");
    }
  });

  it("enforces active job and per-workspace schedule uniqueness", async () => {
    const db = createTestDb();
    const indexes = await db.all<{ name: string; sql: string | null }>(sql`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name IN ('background_jobs', 'background_schedules')
      ORDER BY name
    `);

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "background_jobs_active_key_unique",
          sql: expect.stringContaining("UNIQUE"),
        }),
        expect.objectContaining({
          name: "background_schedules_workspace_kind_unique",
          sql: expect.stringContaining("UNIQUE"),
        }),
      ]),
    );
  });
});
