import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const SPRINT_75_MIGRATION = "0079_sprint_75_operational_hardening.sql";

function databaseThrough(prefix: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= prefix)
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return sqlite;
}

describe("sprint 75 operational-hardening migration (0079)", () => {
  it("is registered once at the next clean migration index", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((candidate) => candidate.idx === 79);
    expect(entry?.tag).toBe("0079_sprint_75_operational_hardening");
    expect(journal.entries.filter((candidate) => candidate.idx === 79)).toHaveLength(1);
    expect(readdirSync(migrationsDir)).toContain(SPRINT_75_MIGRATION);
  });

  it("backfills safe defaults for rows written before Sprint 75", () => {
    const sqlite = databaseThrough("0078");
    sqlite
      .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("ws-1", "Workspace", 1, 1);
    sqlite
      .prepare(
        `INSERT INTO connections (
          id, workspace_id, provider_key, nango_connection_id, created_at, updated_at
        ) VALUES ('conn-1', 'ws-1', 'reddit', 'nango-1', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO social_automation_settings (workspace_id, updated_at) VALUES ('ws-1', 1)",
      )
      .run();

    sqlite.exec(readFileSync(path.join(migrationsDir, SPRINT_75_MIGRATION), "utf8"));

    expect(sqlite.prepare("SELECT timezone FROM connections WHERE id = 'conn-1'").get()).toEqual({
      timezone: "UTC",
    });
    expect(
      sqlite
        .prepare(
          "SELECT per_connection_reply_daily_cap AS cap FROM social_automation_settings WHERE workspace_id = 'ws-1'",
        )
        .get(),
    ).toEqual({ cap: 10 });
    sqlite.close();
  });

  it("adds only the two additive non-null columns with defaults", () => {
    const sql = readFileSync(path.join(migrationsDir, SPRINT_75_MIGRATION), "utf8");
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(2);
    expect(sql).toContain("`connections` ADD `timezone` text DEFAULT 'UTC' NOT NULL");
    expect(sql).toContain(
      "`social_automation_settings` ADD `per_connection_reply_daily_cap` integer DEFAULT 10 NOT NULL",
    );
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE/i);
  });
});
