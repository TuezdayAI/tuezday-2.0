import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function applySqlFile(
  sqlite: Database.Database,
  file: string,
): void {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}

function databaseThrough(prefix: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter(
      (name) =>
        /^\d{4}_.+\.sql$/.test(name) &&
        name.slice(0, 4) <= prefix,
    )
    .sort()) {
    applySqlFile(sqlite, file);
  }
  return sqlite;
}

describe("Sprint 50 migrations", () => {
  it("parks existing Google Trends sources and active jobs", () => {
    const sqlite = databaseThrough("0055");
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
        "trends-source",
        "workspace-1",
        "google_trends",
        "Trends",
        '{"geo":"US"}',
        1,
        "active",
        null,
        null,
        null,
        "{}",
        999,
        null,
        1,
        1,
      );
    sqlite
      .prepare(
        `INSERT INTO discovery_jobs (
          id, workspace_id, source_id, status, attempt, locked_at,
          source_execution_version, lease_owner, lease_version,
          lease_expires_at, heartbeat_at, started_at, finished_at,
          fetched_count, new_count, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "trends-job",
        "workspace-1",
        "trends-source",
        "running",
        1,
        1,
        1,
        "worker-1",
        1,
        999,
        1,
        1,
        null,
        0,
        0,
        null,
        1,
      );

    applySqlFile(
      sqlite,
      "0057_sprint_50_google_trends_reserved.sql",
    );

    expect(
      sqlite
        .prepare(
          "SELECT status, enabled, last_error, backoff_until FROM discovery_sources WHERE id = ?",
        )
        .get("trends-source"),
    ).toEqual({
      status: "reserved",
      enabled: 0,
      last_error: "source_reserved",
      backoff_until: null,
    });
    expect(
      sqlite
        .prepare(
          "SELECT status, error, lease_owner, lease_expires_at, heartbeat_at FROM discovery_jobs WHERE id = ?",
        )
        .get("trends-job"),
    ).toEqual({
      status: "skipped",
      error: "source_reserved",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    });
  });

  it("requires legacy Facebook-backed Instagram connections to reconnect", () => {
    const sqlite = databaseThrough("0057");
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("workspace-1", "Workspace", 1, 1);
    sqlite
      .prepare(
        `INSERT INTO connections (
          id, workspace_id, provider_key, nango_connection_id, config_json,
          status, last_checked_at, last_error, created_at, display_name,
          updated_at, content_profile_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-instagram",
        "workspace-1",
        "instagram",
        "nango-legacy-instagram",
        "{}",
        "connected",
        1,
        null,
        1,
        "Instagram",
        1,
        "{}",
      );
    sqlite
      .prepare(
        `INSERT INTO discovery_sources (
          id, workspace_id, type, name, config_json, enabled, status,
          last_error, last_fetched_at, connection_id, cursor_json,
          backoff_until, last_attempted_at, execution_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "instagram-source",
        "workspace-1",
        "instagram",
        "Instagram",
        '{"mode":"account_timeline","handle":"tuezday"}',
        1,
        "active",
        null,
        null,
        "legacy-instagram",
        "{}",
        null,
        null,
        1,
        1,
      );
    sqlite
      .prepare(
        `INSERT INTO discovery_jobs (
          id, workspace_id, source_id, status, attempt, locked_at,
          source_execution_version, lease_owner, lease_version,
          lease_expires_at, heartbeat_at, started_at, finished_at,
          fetched_count, new_count, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "instagram-job",
        "workspace-1",
        "instagram-source",
        "queued",
        0,
        null,
        1,
        null,
        0,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        1,
      );

    applySqlFile(sqlite, "0058_sprint_50_instagram_login.sql");

    expect(
      sqlite
        .prepare(
          "SELECT status, last_error FROM connections WHERE id = ?",
        )
        .get("legacy-instagram"),
    ).toEqual({ status: "error", last_error: "reconnect_required" });
    expect(
      sqlite
        .prepare(
          "SELECT status, last_error FROM discovery_sources WHERE id = ?",
        )
        .get("instagram-source"),
    ).toEqual({ status: "error", last_error: "reconnect_required" });
    expect(
      sqlite
        .prepare("SELECT status, error FROM discovery_jobs WHERE id = ?")
        .get("instagram-job"),
    ).toEqual({ status: "skipped", error: "reconnect_required" });
  });

  it("parks unsupported commercial sources and their active jobs", () => {
    const sqlite = databaseThrough("0058");
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("workspace-1", "Workspace", 1, 1);
    const insertSource = sqlite.prepare(
      `INSERT INTO discovery_sources (
        id, workspace_id, type, name, config_json, enabled, status,
        last_error, last_fetched_at, connection_id, cursor_json,
        backoff_until, last_attempted_at, execution_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertJob = sqlite.prepare(
      `INSERT INTO discovery_jobs (
        id, workspace_id, source_id, status, attempt, locked_at,
        source_execution_version, lease_owner, lease_version,
        lease_expires_at, heartbeat_at, started_at, finished_at,
        fetched_count, new_count, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const type of ["g2", "capterra", "intent"]) {
      const sourceId = `${type}-source`;
      insertSource.run(
        sourceId,
        "workspace-1",
        type,
        type,
        '{"query":"market"}',
        1,
        "active",
        null,
        null,
        null,
        "{}",
        999,
        null,
        1,
        1,
      );
      insertJob.run(
        `${type}-job`,
        "workspace-1",
        sourceId,
        "queued",
        0,
        null,
        1,
        null,
        0,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        1,
      );
    }

    applySqlFile(sqlite, "0059_sprint_50_reserved_vocabulary.sql");

    expect(
      sqlite
        .prepare(
          "SELECT type, status, enabled, last_error, backoff_until FROM discovery_sources ORDER BY type",
        )
        .all(),
    ).toEqual([
      {
        type: "capterra",
        status: "reserved",
        enabled: 0,
        last_error: "source_reserved",
        backoff_until: null,
      },
      {
        type: "g2",
        status: "reserved",
        enabled: 0,
        last_error: "source_reserved",
        backoff_until: null,
      },
      {
        type: "intent",
        status: "reserved",
        enabled: 0,
        last_error: "source_reserved",
        backoff_until: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT status, error FROM discovery_jobs ORDER BY id",
        )
        .all(),
    ).toEqual([
      { status: "skipped", error: "source_reserved" },
      { status: "skipped", error: "source_reserved" },
      { status: "skipped", error: "source_reserved" },
    ]);
  });
});
