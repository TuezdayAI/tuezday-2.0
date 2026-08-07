import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const SPRINT_75_MIGRATION = "0080_sprint_75_operational_hardening.sql";

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

describe("sprint 75 operational-hardening migration (0080)", () => {
  it("is registered once at the next clean migration index", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((candidate) => candidate.idx === 80);
    expect(entry?.tag).toBe("0080_sprint_75_operational_hardening");
    expect(journal.entries.filter((candidate) => candidate.idx === 80)).toHaveLength(1);
    expect(readdirSync(migrationsDir)).toContain(SPRINT_75_MIGRATION);
  });

  it("backfills safe defaults for rows written before Sprint 75", () => {
    const sqlite = databaseThrough("0079");
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
    sqlite
      .prepare(
        `INSERT INTO drafts (
          id, workspace_id, task_type, channel, original_content, content, state, created_at, updated_at
        ) VALUES ('draft-1', 'ws-1', 'instagram_post', 'instagram', 'Video', 'Video', 'approved', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO publications (
          id, workspace_id, draft_id, connection_id, provider_key, target, title,
          status, scheduled_for, created_at, updated_at
        ) VALUES ('publication-1', 'ws-1', 'draft-1', 'conn-1', 'instagram', 'feed', 'Video',
          'scheduled', 1, 1, 1)`,
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
    expect(
      sqlite
        .prepare(
          `SELECT provider_operation_id AS operationId, next_attempt_at AS nextAttemptAt,
            processing_started_at AS startedAt, processing_attempts AS attempts
          FROM publications WHERE id = 'publication-1'`,
        )
        .get(),
    ).toEqual({ operationId: null, nextAttemptAt: null, startedAt: null, attempts: 0 });
    sqlite.close();
  });

  it("adds only the six additive Sprint 75 columns", () => {
    const sql = readFileSync(path.join(migrationsDir, SPRINT_75_MIGRATION), "utf8");
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(6);
    expect(sql).toContain("`connections` ADD `timezone` text DEFAULT 'UTC' NOT NULL");
    expect(sql).toContain(
      "`social_automation_settings` ADD `per_connection_reply_daily_cap` integer DEFAULT 10 NOT NULL",
    );
    expect(sql).toContain("`publications` ADD `provider_operation_id` text");
    expect(sql).toContain("`publications` ADD `next_attempt_at` integer");
    expect(sql).toContain("`publications` ADD `processing_started_at` integer");
    expect(sql).toContain("`publications` ADD `processing_attempts` integer DEFAULT 0 NOT NULL");
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE/i);
  });
});
