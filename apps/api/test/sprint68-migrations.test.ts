import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_68_MIGRATION = "0074_sprint_68_preference_memory.sql";

function migratedDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return sqlite;
}

function seedWorkspace(sqlite: Database.Database): void {
  sqlite
    .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("ws-1", "Workspace", 1, 1);
}

function seedEdit(sqlite: Database.Database, id = "edit-1", draftId: string | null = null): void {
  sqlite
    .prepare(
      `INSERT INTO preference_edits (
        id, workspace_id, source, source_id, draft_id, task_type, channel,
        before_content, after_content, instruction, edit_distance, digested_at, created_at
      ) VALUES (?, 'ws-1', 'draft_edit', ?, ?, 'signal_response', 'linkedin',
        'before', 'after', NULL, 40, NULL, 1)`,
    )
    .run(id, id, draftId);
}

function seedRule(sqlite: Database.Database, id = "rule-1"): void {
  sqlite
    .prepare(
      `INSERT INTO preference_rules (
        id, workspace_id, rule, polarity, scope_task_type, scope_channel, status, origin,
        confidence, observation_count, applied_count, last_observed_at, last_applied_at,
        promoted_at, retired_at, created_at, updated_at
      ) VALUES (?, 'ws-1', 'Never open with a rhetorical question', 'avoid', NULL, NULL,
        'active', 'extracted', 80, 1, 0, 1, NULL, NULL, NULL, 1, 1)`,
    )
    .run(id);
}

describe("sprint 68 migration (0074)", () => {
  it("is the checked-in migration after sprint 67", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // Pinned by index rather than by being last, so Sprint 69's migration does
    // not break this test the way Sprint 67's broke the Sprint 66 one.
    const entry = journal.entries.find((candidate) => candidate.idx === 74);
    expect(entry?.tag).toBe(SPRINT_68_MIGRATION.replace(/\.sql$/, ""));
    expect(readdirSync(migrationsDir)).toContain(SPRINT_68_MIGRATION);
  });

  it("captures one edit per source row and refuses a duplicate", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedEdit(sqlite, "decision-1");
    // Re-recording the same decision is a no-op, not a second observation.
    expect(() => seedEdit(sqlite, "decision-1")).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it("keeps a captured correction after its draft is deleted", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    sqlite
      .prepare(
        `INSERT INTO drafts (
          id, workspace_id, task_type, channel, original_content, content, state, created_at, updated_at
        ) VALUES ('draft-1', 'ws-1', 'signal_response', 'linkedin', 'gen', 'final', 'edited', 1, 1)`,
      )
      .run();
    seedEdit(sqlite, "edit-1", "draft-1");

    sqlite.prepare("DELETE FROM drafts WHERE id = 'draft-1'").run();

    const row = sqlite
      .prepare("SELECT draft_id, before_content FROM preference_edits WHERE id = 'edit-1'")
      .get() as { draft_id: string | null; before_content: string };
    expect(row.draft_id).toBeNull();
    expect(row.before_content).toBe("before");
    sqlite.close();
  });

  it("links a rule to an edit exactly once and cascades from either side", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedEdit(sqlite);
    seedRule(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO preference_rule_evidence (id, rule_id, edit_id, excerpt, created_at)
       VALUES (?, 'rule-1', 'edit-1', 'why', 1)`,
    );
    insert.run("ev-1");
    expect(() => insert.run("ev-2")).toThrow(/UNIQUE/);

    sqlite.prepare("DELETE FROM preference_rules WHERE id = 'rule-1'").run();
    const remaining = sqlite
      .prepare("SELECT count(*) as n FROM preference_rule_evidence")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    // The edit itself survives its rule — it is evidence, not a derivative.
    const edits = sqlite.prepare("SELECT count(*) as n FROM preference_edits").get() as {
      n: number;
    };
    expect(edits.n).toBe(1);
    sqlite.close();
  });

  it("takes both edits and rules with the workspace", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedEdit(sqlite);
    seedRule(sqlite);
    sqlite.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
    for (const table of ["preference_edits", "preference_rules"]) {
      const row = sqlite.prepare(`SELECT count(*) as n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
    sqlite.close();
  });
});
