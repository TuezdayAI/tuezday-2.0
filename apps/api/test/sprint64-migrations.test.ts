import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_64_MIGRATION = "0070_sprint_64_pipelines.sql";

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
}

function insertRun(
  sqlite: Database.Database,
  id: string,
  idempotencyKey: string | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO pipeline_runs (
        id, workspace_id, definition_id, definition_version, task_key,
        channel, idempotency_key, created_by, created_at
      ) VALUES (?, ?, ?, 1, 'signal_social_post', 'linkedin', ?, 'test', 1)`,
    )
    .run(id, "ws-1", "def-1", idempotencyKey);
}

describe("sprint 64 migration (0070)", () => {
  it("is the checked-in migration after sprint 63", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 70);
    expect(entry?.tag).toBe("0070_sprint_64_pipelines");
    expect(readdirSync(migrationsDir)).toContain(SPRINT_64_MIGRATION);
  });

  it("applies defaults on definitions and runs", () => {
    const sqlite = databaseThrough("0070");
    seed(sqlite);
    const definition = sqlite
      .prepare("SELECT status, current_version, description FROM pipeline_definitions")
      .get() as { status: string; current_version: number; description: string };
    expect(definition).toEqual({ status: "draft", current_version: 1, description: "" });

    insertRun(sqlite, "run-1", null);
    const run = sqlite
      .prepare("SELECT status, mode, checklist_json FROM pipeline_runs")
      .get() as { status: string; mode: string; checklist_json: string };
    expect(run).toEqual({ status: "queued", mode: "live", checklist_json: "[]" });
    sqlite.close();
  });

  it("enforces one version row per (definition, version)", () => {
    const sqlite = databaseThrough("0070");
    seed(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO pipeline_definition_versions (
        id, definition_id, version, spec_json, actor_label, created_at
      ) VALUES (?, ?, ?, '{}', 'system', 1)`,
    );
    insert.run("v-1", "def-1", 1);
    expect(() => insert.run("v-2", "def-1", 1)).toThrow(/UNIQUE/);
    insert.run("v-3", "def-1", 2);
    sqlite.close();
  });

  it("dedupes runs only when an idempotency key is present", () => {
    const sqlite = databaseThrough("0070");
    seed(sqlite);
    insertRun(sqlite, "run-1", null);
    insertRun(sqlite, "run-2", null); // null keys never collide
    insertRun(sqlite, "run-3", "signal:abc");
    expect(() => insertRun(sqlite, "run-4", "signal:abc")).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it("enforces unique step attempts and cascades them with the run", () => {
    const sqlite = databaseThrough("0070");
    seed(sqlite);
    insertRun(sqlite, "run-1", null);
    const insert = sqlite.prepare(
      `INSERT INTO pipeline_run_steps (
        id, run_id, step_key, iteration, attempt, created_at
      ) VALUES (?, 'run-1', ?, ?, ?, 1)`,
    );
    insert.run("s-1", "draft", 1, 1);
    expect(() => insert.run("s-2", "draft", 1, 1)).toThrow(/UNIQUE/);
    insert.run("s-3", "draft", 1, 2);
    insert.run("s-4", "draft", 2, 1);

    sqlite.prepare("DELETE FROM pipeline_runs WHERE id = 'run-1'").run();
    const remaining = sqlite
      .prepare("SELECT count(*) AS count FROM pipeline_run_steps")
      .get() as { count: number };
    expect(remaining.count).toBe(0);
    sqlite.close();
  });

  it("keeps runs when the signal or draft they reference is deleted", () => {
    const sqlite = databaseThrough("0070");
    seed(sqlite);
    sqlite
      .prepare(
        `INSERT INTO signals (id, workspace_id, content, source, created_at)
         VALUES ('sig-1', 'ws-1', 'A signal', 'manual', 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO pipeline_runs (
          id, workspace_id, definition_id, definition_version, task_key,
          signal_id, channel, created_by, created_at
        ) VALUES ('run-1', 'ws-1', 'def-1', 1, 'signal_social_post', 'sig-1',
          'linkedin', 'test', 1)`,
      )
      .run();
    sqlite.prepare("DELETE FROM signals WHERE id = 'sig-1'").run();
    const run = sqlite
      .prepare("SELECT signal_id FROM pipeline_runs WHERE id = 'run-1'")
      .get() as { signal_id: string | null };
    expect(run.signal_id).toBeNull();
    sqlite.close();
  });
});
