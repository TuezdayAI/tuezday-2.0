import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_66_MIGRATION = "0072_sprint_66_reject_reason.sql";

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

describe("sprint 66 migration (0072)", () => {
  it("is the checked-in migration after sprint 65", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // Pinned by index, not by being last — a later sprint's migration must not
    // break this test (Sprint 67's did, when this asserted "last entry").
    const entry = journal.entries.find((candidate) => candidate.idx === 72);
    expect(entry?.tag).toBe(SPRINT_66_MIGRATION.replace(/\.sql$/, ""));
    expect(readdirSync(migrationsDir)).toContain(SPRINT_66_MIGRATION);
  });

  it("adds a nullable reason column that pre-existing decision rows survive", () => {
    // Rows written before the migration (no reason column) must read back
    // with reason NULL after it — nothing is backfilled.
    const sqlite = databaseThrough("0071");
    sqlite
      .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("ws-1", "Workspace", 1, 1);
    sqlite
      .prepare(
        `INSERT INTO generations (
          id, workspace_id, task_type, channel, prompt, sections_json, output,
          model, provider, duration_ms, created_at
        ) VALUES ('gen-1', 'ws-1', 'signal_response', 'linkedin', 'p', '[]', 'o', 'm', 'p', 0, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO drafts (
          id, workspace_id, source_generation_id, task_type, channel,
          original_content, content, state, created_at, updated_at
        ) VALUES ('draft-1', 'ws-1', 'gen-1', 'signal_response', 'linkedin', 'c', 'c', 'rejected', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO approval_decisions (
          id, draft_id, workspace_id, action, from_state, to_state, actor, created_at
        ) VALUES ('dec-1', 'draft-1', 'ws-1', 'reject', 'pending_review', 'rejected', 'founder', 1)`,
      )
      .run();

    sqlite.exec(readFileSync(path.join(migrationsDir, SPRINT_66_MIGRATION), "utf8"));

    const before = sqlite
      .prepare("SELECT reason FROM approval_decisions WHERE id = 'dec-1'")
      .get() as { reason: string | null };
    expect(before.reason).toBeNull();

    sqlite
      .prepare(
        `INSERT INTO approval_decisions (
          id, draft_id, workspace_id, action, from_state, to_state, actor, reason, created_at
        ) VALUES ('dec-2', 'draft-1', 'ws-1', 'reject', 'pending_review', 'rejected', 'founder', 'Too generic', 2)`,
      )
      .run();
    const after = sqlite
      .prepare("SELECT reason FROM approval_decisions WHERE id = 'dec-2'")
      .get() as { reason: string | null };
    expect(after.reason).toBe("Too generic");
    sqlite.close();
  });
});
