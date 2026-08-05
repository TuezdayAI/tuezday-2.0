import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_65_MIGRATION = "0071_sprint_65_shadow_ab.sql";

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

function seed(sqlite: Database.Database): void {
  sqlite
    .prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("ws-1", "Workspace", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO pipeline_definitions (
        id, workspace_id, task_key, name, spec_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("def-1", "ws-1", "signal_social_post", "Reference", "{}", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO pipeline_runs (
        id, workspace_id, definition_id, definition_version, task_key,
        channel, created_by, created_at
      ) VALUES ('run-1', 'ws-1', 'def-1', 1, 'signal_social_post', 'linkedin', 'automation', 1)`,
    )
    .run();
}

function insertPair(sqlite: Database.Database, id: string, pairKey: string): void {
  sqlite
    .prepare(
      `INSERT INTO pipeline_shadow_pairs (
        id, workspace_id, pair_key, channel, run_id, created_at
      ) VALUES (?, 'ws-1', ?, 'linkedin', 'run-1', 1)`,
    )
    .run(id, pairKey);
}

describe("sprint 65 migration (0071)", () => {
  it("is the checked-in migration after sprint 64", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 71);
    expect(entry?.tag).toBe("0071_sprint_65_shadow_ab");
    expect(readdirSync(migrationsDir)).toContain(SPRINT_65_MIGRATION);
  });

  it("defaults generation_path to legacy so merging changes nothing", () => {
    const sqlite = databaseThrough("0071");
    seed(sqlite);
    sqlite
      .prepare(
        "INSERT INTO social_automation_settings (workspace_id, updated_at) VALUES ('ws-1', 1)",
      )
      .run();
    const row = sqlite
      .prepare("SELECT generation_path FROM social_automation_settings WHERE workspace_id = 'ws-1'")
      .get() as { generation_path: string };
    expect(row.generation_path).toBe("legacy");
    sqlite.close();
  });

  it("enforces one shadow pair per pair_key", () => {
    const sqlite = databaseThrough("0071");
    seed(sqlite);
    insertPair(sqlite, "pair-1", "shadow:v1:ws:sig:camp:linkedin");
    expect(() => insertPair(sqlite, "pair-2", "shadow:v1:ws:sig:camp:linkedin")).toThrow(
      /UNIQUE/,
    );
    insertPair(sqlite, "pair-3", "shadow:v1:ws:sig:camp:x");
    sqlite.close();
  });

  it("cascades pair deletion from the run and survives draft deletion", () => {
    const sqlite = databaseThrough("0071");
    seed(sqlite);
    sqlite
      .prepare(
        `INSERT INTO drafts (
          id, workspace_id, task_type, channel, original_content, content,
          state, created_at, updated_at
        ) VALUES ('draft-1', 'ws-1', 'signal_response', 'linkedin', 'a', 'a',
          'pending_review', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO pipeline_shadow_pairs (
          id, workspace_id, pair_key, channel, draft_id, run_id, created_at
        ) VALUES ('pair-1', 'ws-1', 'k1', 'linkedin', 'draft-1', 'run-1', 1)`,
      )
      .run();

    sqlite.prepare("DELETE FROM drafts WHERE id = 'draft-1'").run();
    const afterDraft = sqlite
      .prepare("SELECT draft_id FROM pipeline_shadow_pairs WHERE id = 'pair-1'")
      .get() as { draft_id: string | null };
    expect(afterDraft.draft_id).toBeNull();

    sqlite.prepare("DELETE FROM pipeline_runs WHERE id = 'run-1'").run();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM pipeline_shadow_pairs").get(),
    ).toEqual({ n: 0 });
    sqlite.close();
  });

  it("stores rollout decisions and cascades them with the workspace", () => {
    const sqlite = databaseThrough("0071");
    seed(sqlite);
    sqlite
      .prepare(
        `INSERT INTO pipeline_rollout_decisions (
          id, workspace_id, task_key, decision, rationale, metrics_json, created_at
        ) VALUES ('dec-1', 'ws-1', 'signal_social_post', 'adopt_engine', 'It wins.', '{}', 1)`,
      )
      .run();
    sqlite.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM pipeline_rollout_decisions").get(),
    ).toEqual({ n: 0 });
    sqlite.close();
  });
});
