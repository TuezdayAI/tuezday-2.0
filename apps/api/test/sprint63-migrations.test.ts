import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_63_MIGRATION = "0069_sprint_63_deliverables.sql";

function databaseThrough(prefix: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter(
      (name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= prefix,
    )
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return sqlite;
}

function seedGraph(sqlite: Database.Database): void {
  sqlite
    .prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("ws-1", "Workspace", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO campaigns (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("camp-1", "ws-1", "Launch", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO campaign_plan_revisions (
        id, workspace_id, campaign_id, revision, status, objective, kpi,
        timeframe, start_at, end_at, audience_ids_json, pillars_json,
        offers_json, ctas_json, guidance, created_by, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "rev-1", "ws-1", "camp-1", 1, "active", "Grow", "Signups", "Q3",
      null, null, "[]", "[]", "[]", "[]", "", null, 1, 1,
    );
  sqlite
    .prepare(
      `INSERT INTO campaign_lanes (id, workspace_id, campaign_id, key, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("lane-1", "ws-1", "camp-1", "li", "LinkedIn", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO personas (id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("persona-1", "ws-1", "CTO", 1, 1);
  sqlite
    .prepare(
      `INSERT INTO campaign_lane_revisions (
        id, workspace_id, lane_id, plan_revision_id, persona_id, channel,
        format, delivery_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("lanerev-1", "ws-1", "lane-1", "rev-1", "persona-1", "linkedin", "linkedin_post", "planned_and_reactive", 1);
  sqlite
    .prepare(
      `INSERT INTO content_packages (
        id, workspace_id, campaign_id, plan_revision_id, opportunity_id,
        canonical_story_id, angle, angle_hash, novelty, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("pkg-1", "ws-1", "camp-1", "rev-1", null, null, "An angle", "angle-1", 100, 1, 1);
}

function insertDeliverable(
  sqlite: Database.Database,
  id: string,
  overrides: {
    kind?: string;
    originalScheduledFor?: number | null;
    packageId?: string | null;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO deliverables (
        id, workspace_id, campaign_id, plan_revision_id, lane_id,
        lane_revision_id, kind, original_scheduled_for, package_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, "ws-1", "camp-1", "rev-1", "lane-1", "lanerev-1",
      overrides.kind ?? "planned",
      overrides.originalScheduledFor === undefined
        ? 1_000
        : overrides.originalScheduledFor,
      overrides.packageId ?? null,
      1, 1,
    );
}

describe("Sprint 63 migrations", () => {
  it("creates deliverables with the planned/pending defaults", () => {
    const sqlite = databaseThrough("0069");
    seedGraph(sqlite);
    insertDeliverable(sqlite, "del-1");

    expect(
      sqlite
        .prepare(
          `SELECT status, generation_state, generation_attempts, generated_at, angle
           FROM deliverables WHERE id = ?`,
        )
        .get("del-1"),
    ).toEqual({
      status: "planned",
      generation_state: "pending",
      generation_attempts: 0,
      generated_at: null,
      angle: "",
    });
    // Sprint 63 also adds the fan-out stamp to packages, defaulting null.
    expect(
      sqlite
        .prepare("SELECT fanned_out_at FROM content_packages WHERE id = ?")
        .get("pkg-1"),
    ).toEqual({ fanned_out_at: null });
  });

  it("enforces the §8.10 planned-slot uniqueness per lane revision", () => {
    const sqlite = databaseThrough("0069");
    seedGraph(sqlite);
    insertDeliverable(sqlite, "del-1", { originalScheduledFor: 1_000 });
    expect(() =>
      insertDeliverable(sqlite, "del-dup", { originalScheduledFor: 1_000 }),
    ).toThrow(/UNIQUE/);
    insertDeliverable(sqlite, "del-2", { originalScheduledFor: 2_000 });
    // Reactive deliverables (no slot) never collide on the planned key.
    insertDeliverable(sqlite, "del-r1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: "pkg-1",
    });
  });

  it("enforces the §8.10 reactive uniqueness per package and lane revision", () => {
    const sqlite = databaseThrough("0069");
    seedGraph(sqlite);
    insertDeliverable(sqlite, "del-r1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: "pkg-1",
    });
    expect(() =>
      insertDeliverable(sqlite, "del-r-dup", {
        kind: "reactive",
        originalScheduledFor: null,
        packageId: "pkg-1",
      }),
    ).toThrow(/UNIQUE/);
    // A planned slot assigned the same package does not hit the reactive key.
    insertDeliverable(sqlite, "del-p1", {
      originalScheduledFor: 3_000,
      packageId: "pkg-1",
    });
  });

  it("keeps deliverables, variants, and snapshots when the package is deleted", () => {
    const sqlite = databaseThrough("0069");
    seedGraph(sqlite);
    insertDeliverable(sqlite, "del-1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: "pkg-1",
    });
    sqlite
      .prepare(
        `INSERT INTO context_snapshots (
          id, workspace_id, deliverable_id, package_id, resolved_context_json,
          inputs_json, model, provider, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("snap-1", "ws-1", "del-1", "pkg-1", "{}", "{}", "m", "p", 1);
    sqlite
      .prepare(
        `INSERT INTO variants (
          id, workspace_id, deliverable_id, variant_version,
          context_snapshot_id, content, model, provider, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("var-1", "ws-1", "del-1", 1, "snap-1", "Post body", "m", "p", 5, 1);

    sqlite.prepare("DELETE FROM content_packages WHERE id = ?").run("pkg-1");

    const deliverable = sqlite
      .prepare("SELECT package_id, kind FROM deliverables WHERE id = ?")
      .get("del-1") as Record<string, unknown>;
    expect(deliverable["package_id"]).toBeNull();
    const snapshot = sqlite
      .prepare(
        "SELECT package_id, resolved_context_json FROM context_snapshots WHERE id = ?",
      )
      .get("snap-1") as Record<string, unknown>;
    expect(snapshot["package_id"]).toBeNull();
    expect(snapshot["resolved_context_json"]).toBe("{}");
    expect(
      sqlite.prepare("SELECT content FROM variants WHERE id = ?").get("var-1"),
    ).toEqual({ content: "Post body" });
  });

  it("keeps variant versions unique per deliverable", () => {
    const sqlite = databaseThrough("0069");
    seedGraph(sqlite);
    insertDeliverable(sqlite, "del-1");
    sqlite
      .prepare(
        `INSERT INTO context_snapshots (
          id, workspace_id, deliverable_id, package_id, resolved_context_json,
          inputs_json, model, provider, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("snap-1", "ws-1", "del-1", null, "{}", "{}", "m", "p", 1);
    const insertVariant = (id: string, version: number) =>
      sqlite
        .prepare(
          `INSERT INTO variants (
            id, workspace_id, deliverable_id, variant_version,
            context_snapshot_id, content, model, provider, duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "ws-1", "del-1", version, "snap-1", "Body", "m", "p", 5, 1);
    insertVariant("var-1", 1);
    expect(() => insertVariant("var-dup", 1)).toThrow(/UNIQUE/);
    insertVariant("var-2", 2);
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }> };
    const entry = journal.entries.find(
      (e) => e.tag === SPRINT_63_MIGRATION.replace(/\.sql$/, ""),
    )!;
    expect(entry).toBeDefined();
    expect(entry.version).toBe("6");
    expect(entry.breakpoints).toBe(true);
    expect(entry.idx).toBe(69);
    expect(entry.tag.startsWith(String(entry.idx).padStart(4, "0"))).toBe(true);
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(
      journal.entries.length,
    );
  });
});
