import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_69_MIGRATION = "0075_sprint_69_propose_tools.sql";

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function migratedDatabase(upTo?: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of migrationFiles()) {
    if (upTo && file > upTo) break;
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return sqlite;
}

function seedWorkspace(sqlite: Database.Database): void {
  sqlite
    .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("ws-1", "Workspace", 1, 1);
}

function seedDraft(sqlite: Database.Database, id = "draft-1"): void {
  sqlite
    .prepare(
      `INSERT INTO drafts (
        id, workspace_id, task_type, channel, original_content, content, state, created_at, updated_at
      ) VALUES (?, 'ws-1', 'signal_response', 'linkedin', 'gen', 'final', 'pending_review', 1, 1)`,
    )
    .run(id);
}

function seedAction(
  sqlite: Database.Database,
  id: string,
  proposedByUserId: string | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO external_actions (
        id, workspace_id, kind, status, subject_kind, subject_id, payload_json,
        subject_snapshot_json, idempotency_key, fingerprint, policy_snapshot_json,
        proposed_by_user_id, proposed_by_label, created_at, updated_at
      ) VALUES (?, 'ws-1', 'publish', 'proposed', 'draft', 'draft-1', '{}',
        '{}', ?, ?, '{}', ?, 'label', 1, 1)`,
    )
    .run(id, `key-${id}`, "f".repeat(64), proposedByUserId);
}

describe("sprint 69 migration (0075)", () => {
  it("is the checked-in migration after sprint 68", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 75);
    expect(entry?.tag).toBe(SPRINT_69_MIGRATION.replace(/\.sql$/, ""));
    expect(migrationFiles()).toContain(SPRINT_69_MIGRATION);
  });

  it("backfills origin from who was attributed at proposal time (D-69.4)", () => {
    // Seed on the pre-0075 schema so the backfill sees rows that predate it —
    // the only way to test that the default is not just papering over them.
    const sqlite = migratedDatabase("0074_sprint_68_preference_memory.sql");
    seedWorkspace(sqlite);
    seedDraft(sqlite);
    sqlite
      .prepare("INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("user-1", "founder@test.dev", "hash", "Founder", 1, 1);
    seedAction(sqlite, "action-human", "user-1");
    seedAction(sqlite, "action-system", null);

    sqlite.exec(readFileSync(path.join(migrationsDir, SPRINT_69_MIGRATION), "utf8"));

    const rows = sqlite
      .prepare("SELECT id, origin, origin_run_id FROM external_actions ORDER BY id")
      .all() as { id: string; origin: string; origin_run_id: string | null }[];
    expect(rows).toEqual([
      { id: "action-human", origin: "human", origin_run_id: null },
      { id: "action-system", origin: "system", origin_run_id: null },
    ]);
    sqlite.close();
  });

  it("keeps the proposal after the thing it proposed is deleted", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedDraft(sqlite);
    sqlite
      .prepare(
        `INSERT INTO agent_proposals (
          id, workspace_id, agent_run_id, tool, target_kind, draft_id,
          external_action_id, summary, rationale, created_at
        ) VALUES ('p-1', 'ws-1', 'run-1', 'propose_draft', 'draft', 'draft-1',
          NULL, 'Submitted a draft.', 'Because pricing moved.', 1)`,
      )
      .run();

    sqlite.prepare("DELETE FROM drafts WHERE id = 'draft-1'").run();

    const row = sqlite
      .prepare("SELECT draft_id, summary FROM agent_proposals WHERE id = 'p-1'")
      .get() as { draft_id: string | null; summary: string };
    // The ledger is a record of what the agent did, not a derivative of what
    // survives — nulling the link is right, deleting the row would not be.
    expect(row.draft_id).toBeNull();
    expect(row.summary).toBe("Submitted a draft.");
    sqlite.close();
  });

  it("takes proposals with the workspace", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    sqlite
      .prepare(
        `INSERT INTO agent_proposals (
          id, workspace_id, agent_run_id, tool, target_kind, draft_id,
          external_action_id, summary, rationale, created_at
        ) VALUES ('p-1', 'ws-1', 'run-1', 'propose_draft', 'draft', NULL,
          NULL, 'Submitted a draft.', 'Because pricing moved.', 1)`,
      )
      .run();
    sqlite.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
    const row = sqlite.prepare("SELECT count(*) as n FROM agent_proposals").get() as { n: number };
    expect(row.n).toBe(0);
    sqlite.close();
  });
});
