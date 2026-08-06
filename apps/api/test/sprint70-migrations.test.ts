import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_70_MIGRATION = "0076_sprint_70_agent_inbox.sql";

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
      ) VALUES ('def-1', 'ws-1', 'signal_social_post', 'Reference', '{}', 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_runs (
        id, workspace_id, definition_id, definition_version, task_key,
        channel, created_by, created_at
      ) VALUES ('run-1', 'ws-1', 'def-1', 1, 'signal_social_post', 'linkedin', 'automation', 1)`,
    )
    .run();
}

function insertQuestion(
  sqlite: Database.Database,
  id: string,
  pipelineRunId: string | null = "run-1",
): void {
  sqlite
    .prepare(
      `INSERT INTO agent_questions (
        id, workspace_id, agent_run_id, pipeline_run_id, step_key, type,
        question, why, fingerprint, created_at
      ) VALUES (?, 'ws-1', 'agent-run-1', ?, 'draft', 'missing_permission',
        'May we name the investors?', 'The plan does not say.', ?, 1)`,
    )
    .run(id, pipelineRunId, `fp-${id}`);
}

describe("sprint 70 migration (0076)", () => {
  it("is the checked-in migration after sprint 69", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((candidate) => candidate.idx === 76);
    expect(entry?.tag).toBe("0076_sprint_70_agent_inbox");
    expect(readdirSync(migrationsDir)).toContain(SPRINT_70_MIGRATION);
  });

  it("opens a question as open, with no answer", () => {
    const sqlite = databaseThrough("0076");
    seed(sqlite);
    insertQuestion(sqlite, "q-1");
    const row = sqlite
      .prepare("SELECT status, answer, answered_at FROM agent_questions WHERE id = 'q-1'")
      .get() as { status: string; answer: string | null; answered_at: number | null };
    expect(row).toEqual({ status: "open", answer: null, answered_at: null });
    sqlite.close();
  });

  it("keeps the question when the run it blocked is deleted", () => {
    const sqlite = databaseThrough("0076");
    seed(sqlite);
    insertQuestion(sqlite, "q-1");
    sqlite.prepare("DELETE FROM pipeline_runs WHERE id = 'run-1'").run();
    // "The agent asked this and the run is gone" is a different, and more
    // honest, statement than "the agent never asked".
    const row = sqlite
      .prepare("SELECT pipeline_run_id FROM agent_questions WHERE id = 'q-1'")
      .get() as { pipeline_run_id: string | null };
    expect(row.pipeline_run_id).toBeNull();
    sqlite.close();
  });

  it("cascades questions with the workspace", () => {
    const sqlite = databaseThrough("0076");
    seed(sqlite);
    insertQuestion(sqlite, "q-1");
    insertQuestion(sqlite, "q-2", null);
    sqlite.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_questions").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it("indexes the two lookups the ask lane actually makes", () => {
    const sqlite = databaseThrough("0076");
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_questions'")
      .all()
      .map((row) => (row as { name: string }).name);
    // The inbox reads open questions per workspace; resume reads them per run.
    expect(indexes).toContain("agent_questions_workspace_status");
    expect(indexes).toContain("agent_questions_pipeline_run");
    sqlite.close();
  });
});
