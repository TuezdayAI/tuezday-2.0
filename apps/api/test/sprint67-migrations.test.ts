import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_67_MIGRATION = "0073_sprint_67_eval_harness.sql";

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

function seedSuite(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO eval_suites (
        id, workspace_id, name, task_key, channel, cta_expectation, case_count, created_at
      ) VALUES ('suite-1', 'ws-1', 'baseline', 'signal_social_post', 'linkedin', 'any', 0, 1)`,
    )
    .run();
}

describe("sprint 67 migration (0073)", () => {
  it("is the checked-in migration after sprint 66", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // Pinned by index rather than by being last, so Sprint 68's migration does
    // not break this test the way Sprint 67's broke the Sprint 66 one.
    const entry = journal.entries.find((candidate) => candidate.idx === 73);
    expect(entry?.tag).toBe(SPRINT_67_MIGRATION.replace(/\.sql$/, ""));
    expect(readdirSync(migrationsDir)).toContain(SPRINT_67_MIGRATION);
  });

  it("keeps a banned claim unique per workspace", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    const insert = sqlite.prepare(
      "INSERT INTO workspace_banned_claims (id, workspace_id, phrase, note, created_at) VALUES (?, 'ws-1', ?, '', 1)",
    );
    insert.run("claim-1", "guaranteed results");
    expect(() => insert.run("claim-2", "guaranteed results")).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it("points a baseline label at exactly one run, but allows many unlabelled ones", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedSuite(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO eval_runs (
        id, workspace_id, suite_id, status, judge_enabled, metrics_json, baseline_label, created_at
      ) VALUES (?, 'ws-1', 'suite-1', 'succeeded', 0, '{}', ?, 1)`,
    );
    insert.run("run-1", "pre-66");
    expect(() => insert.run("run-2", "pre-66")).toThrow(/UNIQUE/);
    // The partial index must not collapse the unlabelled runs into one.
    insert.run("run-3", null);
    insert.run("run-4", null);
    sqlite.close();
  });

  it("keeps an eval case after its source draft is deleted (D-67.2)", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedSuite(sqlite);
    sqlite
      .prepare(
        `INSERT INTO drafts (
          id, workspace_id, task_type, channel, original_content, content, state, created_at, updated_at
        ) VALUES ('draft-1', 'ws-1', 'signal_response', 'linkedin', 'gen', 'final', 'approved', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO eval_cases (
          id, suite_id, workspace_id, signal_content, signal_source, channel,
          source_draft_id, generated_content, final_content, outcome, decided_at, created_at
        ) VALUES ('case-1', 'suite-1', 'ws-1', 'signal', 'other', 'linkedin',
          'draft-1', 'gen', 'final', 'approved', 1, 1)`,
      )
      .run();

    sqlite.prepare("DELETE FROM drafts WHERE id = 'draft-1'").run();

    const row = sqlite
      .prepare("SELECT source_draft_id, generated_content FROM eval_cases WHERE id = 'case-1'")
      .get() as { source_draft_id: string | null; generated_content: string };
    expect(row.source_draft_id).toBeNull();
    expect(row.generated_content).toBe("gen");
    sqlite.close();
  });

  it("cascades case results away with their run", () => {
    const sqlite = migratedDatabase();
    seedWorkspace(sqlite);
    seedSuite(sqlite);
    sqlite
      .prepare(
        `INSERT INTO eval_cases (
          id, suite_id, workspace_id, signal_content, signal_source, channel,
          generated_content, final_content, outcome, decided_at, created_at
        ) VALUES ('case-1', 'suite-1', 'ws-1', 's', 'other', 'linkedin', 'g', 'f', 'approved', 1, 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO eval_runs (
          id, workspace_id, suite_id, status, judge_enabled, metrics_json, created_at
        ) VALUES ('run-1', 'ws-1', 'suite-1', 'succeeded', 0, '{}', 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO eval_case_results (
          id, run_id, case_id, checks_json, cost_cents, duration_ms, created_at
        ) VALUES ('res-1', 'run-1', 'case-1', '[]', 0, 0, 1)`,
      )
      .run();

    sqlite.prepare("DELETE FROM eval_runs WHERE id = 'run-1'").run();
    const remaining = sqlite
      .prepare("SELECT count(*) as n FROM eval_case_results")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    sqlite.close();
  });
});
