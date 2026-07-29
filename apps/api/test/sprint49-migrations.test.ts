import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function applySqlFile(sqlite: Database.Database, file: string): void {
  sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}

function migrationFile(prefix: string): string {
  const matches = readdirSync(migrationsDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".sql"))
    .sort();
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function migratedEmptyDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    applySqlFile(sqlite, file);
  }
  return sqlite;
}

function columns(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("Sprint 49 migrations", () => {
  it("installs lease persistence after remote migration 0052", () => {
    const sqlite = migratedEmptyDatabase();

    expect(migrationFile("0053_")).toContain("sprint_49_leases");
    expect(columns(sqlite, "task_leases")).toEqual(
      expect.arrayContaining([
        "key",
        "owner",
        "version",
        "expires_at",
        "heartbeat_at",
        "created_at",
        "updated_at",
      ]),
    );
    expect(columns(sqlite, "discovery_sources")).toContain("execution_version");
    expect(columns(sqlite, "discovery_jobs")).toEqual(
      expect.arrayContaining([
        "source_execution_version",
        "lease_owner",
        "lease_version",
        "lease_expires_at",
        "heartbeat_at",
      ]),
    );

    const indexes = sqlite
      .prepare("PRAGMA index_list(discovery_jobs)")
      .all() as Array<{ name: string; unique: number }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: "discovery_jobs_one_active_source",
        unique: 1,
      }),
    );
  });

  it("installs automatic-draft idempotency as migration 0054", () => {
    const sqlite = migratedEmptyDatabase();

    expect(migrationFile("0054_")).toContain(
      "sprint_49_automation_idempotency",
    );
    expect(columns(sqlite, "drafts")).toContain("automation_key");
    const indexes = sqlite
      .prepare("PRAGMA index_list(drafts)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: "drafts_automation_key",
        unique: 1,
        partial: 1,
      }),
    );
  });
});
