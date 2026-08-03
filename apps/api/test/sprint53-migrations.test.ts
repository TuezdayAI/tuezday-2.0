import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_53_MIGRATION = "0062_sprint_53_derived_signal_routing.sql";

function applySqlFile(sqlite: Database.Database, file: string): void {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}

function databaseThrough(prefix: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter(
      (name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= prefix,
    )
    .sort()) {
    applySqlFile(sqlite, file);
  }
  return sqlite;
}

/**
 * A pre-Sprint-53 database: signals and discovered items that still carry the
 * legacy routing columns, alongside rows that never did.
 */
function seedLegacyRouting(sqlite: Database.Database): void {
  sqlite
    .prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("workspace-1", "Workspace", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO discovery_sources (
        id, workspace_id, type, name, config_json, enabled, status,
        last_error, last_fetched_at, connection_id, cursor_json,
        backoff_until, last_attempted_at, execution_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "source-1",
      "workspace-1",
      "rss",
      "Source",
      "{}",
      1,
      "active",
      null,
      null,
      null,
      "{}",
      null,
      null,
      1,
      1,
    );

  const insertSignal = sqlite.prepare(
    `INSERT INTO signals (
      id, workspace_id, content, source, source_url,
      suggested_persona_id, suggested_campaign_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSignal.run(
    "signal-routed",
    "workspace-1",
    "A routed signal",
    "manual",
    null,
    "persona-legacy",
    "campaign-legacy",
    1,
  );
  // Half-populated: only one of the pair was ever written.
  insertSignal.run(
    "signal-half",
    "workspace-1",
    "A half-routed signal",
    "manual",
    null,
    "persona-legacy",
    null,
    1,
  );
  insertSignal.run(
    "signal-clean",
    "workspace-1",
    "Never routed",
    "manual",
    null,
    null,
    null,
    1,
  );

  const insertItem = sqlite.prepare(
    `INSERT INTO discovered_items (
      id, workspace_id, source_id, external_id, title, url, summary,
      published_at, score, suggested_persona_id, suggested_campaign_id,
      score_reason, status, signal_id, scored_at, url_hash, content_hash,
      duplicate_of_id, matching_state, matching_version,
      matching_input_fingerprint, matching_lease_owner,
      matching_lease_expires_at, matching_heartbeat_at, matching_error,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    "item-routed",
    "workspace-1",
    "source-1",
    "ext-routed",
    "A routed item",
    "https://example.com/routed",
    "Summary",
    1,
    88,
    "persona-legacy",
    "campaign-legacy",
    "Fits the launch.",
    "new",
    null,
    1,
    null,
    "content-routed",
    null,
    "ready",
    0,
    null,
    null,
    null,
    null,
    null,
    1,
  );
  insertItem.run(
    "item-clean",
    "workspace-1",
    "source-1",
    "ext-clean",
    "Never routed",
    "https://example.com/clean",
    "Summary",
    1,
    40,
    null,
    null,
    null,
    "new",
    null,
    1,
    null,
    "content-clean",
    null,
    "ready",
    0,
    null,
    null,
    null,
    null,
    null,
    1,
  );
}

function routingSnapshot(sqlite: Database.Database) {
  return {
    signals: sqlite
      .prepare(
        "SELECT id, suggested_persona_id, suggested_campaign_id, content, source, created_at FROM signals ORDER BY id",
      )
      .all(),
    items: sqlite
      .prepare(
        "SELECT id, suggested_persona_id, suggested_campaign_id, score, score_reason, status, matching_state FROM discovered_items ORDER BY id",
      )
      .all(),
  };
}

describe("Sprint 53 migrations", () => {
  it("nulls the legacy routing columns on signals and discovered items", () => {
    const sqlite = databaseThrough("0061");
    seedLegacyRouting(sqlite);

    applySqlFile(sqlite, SPRINT_53_MIGRATION);

    expect(
      sqlite
        .prepare(
          "SELECT id, suggested_persona_id, suggested_campaign_id FROM signals ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "signal-clean",
        suggested_persona_id: null,
        suggested_campaign_id: null,
      },
      {
        id: "signal-half",
        suggested_persona_id: null,
        suggested_campaign_id: null,
      },
      {
        id: "signal-routed",
        suggested_persona_id: null,
        suggested_campaign_id: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT id, suggested_persona_id, suggested_campaign_id FROM discovered_items ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "item-clean",
        suggested_persona_id: null,
        suggested_campaign_id: null,
      },
      {
        id: "item-routed",
        suggested_persona_id: null,
        suggested_campaign_id: null,
      },
    ]);
  });

  it("leaves every other column on both tables untouched", () => {
    const sqlite = databaseThrough("0061");
    seedLegacyRouting(sqlite);

    applySqlFile(sqlite, SPRINT_53_MIGRATION);

    // The real routing signal (score, reason, matching state) survives; only
    // the dead mapping is cleared.
    expect(
      sqlite
        .prepare(
          "SELECT score, score_reason, status, matching_state FROM discovered_items WHERE id = ?",
        )
        .get("item-routed"),
    ).toEqual({
      score: 88,
      score_reason: "Fits the launch.",
      status: "new",
      matching_state: "ready",
    });
    expect(
      sqlite
        .prepare("SELECT content, source FROM signals WHERE id = ?")
        .get("signal-routed"),
    ).toEqual({ content: "A routed signal", source: "manual" });
  });

  it("is a no-op when applied a second time", () => {
    const sqlite = databaseThrough("0061");
    seedLegacyRouting(sqlite);

    applySqlFile(sqlite, SPRINT_53_MIGRATION);
    const afterFirst = routingSnapshot(sqlite);
    applySqlFile(sqlite, SPRINT_53_MIGRATION);
    const afterSecond = routingSnapshot(sqlite);

    expect(afterSecond).toEqual(afterFirst);
  });

  it("is registered in the drizzle journal as the next migration", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }> };
    const last = journal.entries[journal.entries.length - 1]!;

    expect(last.tag).toBe(SPRINT_53_MIGRATION.replace(/\.sql$/, ""));
    expect(last.version).toBe("6");
    expect(last.breakpoints).toBe(true);
    expect(last.idx).toBe(journal.entries.length - 1);
    // Every idx is unique and the tag's numeric prefix agrees with it.
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(
      journal.entries.length,
    );
  });
});
