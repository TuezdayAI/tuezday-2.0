import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_61_MIGRATION = "0067_sprint_61_campaign_opportunities.sql";

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
      `INSERT INTO canonical_external_stories (
        id, workspace_id, status, canonical_url, title, content_fingerprint,
        first_observed_at, last_observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("story-1", "ws-1", "active", "https://ex.com/a", "A", "fp-a", 1, 1, 1, 1);
  sqlite
    .prepare(
      `INSERT INTO campaign_routing_profiles (
        id, workspace_id, campaign_id, plan_revision_id, profile_version,
        profile_fingerprint, routing_band, min_fit, min_confidence, min_trust,
        compiler_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("prof-1", "ws-1", "camp-1", "rev-1", 1, "pfp-1", "review", 70, 60, 0, 1, "{}", 1);
}

function insertOpportunity(
  sqlite: Database.Database,
  id: string,
  overrides: { storyId?: string | null; signalId?: string | null; angleHash?: string } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO campaign_opportunities (
        id, workspace_id, canonical_story_id, manual_signal_id, campaign_id,
        plan_revision_id, routing_profile_id, status, angle, angle_hash,
        workspace_relevance, campaign_fit, confidence, actionability,
        source_trust, suggested_persona_id, supported_claims_json, reason,
        matcher_version, policy_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, "ws-1",
      overrides.storyId === undefined ? "story-1" : overrides.storyId,
      overrides.signalId === undefined ? null : overrides.signalId,
      "camp-1", "rev-1", "prof-1", "needs_review", "An angle",
      overrides.angleHash ?? "angle-1",
      80, 75, 65, 70, 60, null, "[]", "Fits the plan.", 1, "{}", null, 1, 1,
    );
}

describe("Sprint 61 migrations", () => {
  it("enforces the story/signal XOR on opportunities", () => {
    const sqlite = databaseThrough("0067");
    seedGraph(sqlite);

    insertOpportunity(sqlite, "opp-ok");
    expect(() =>
      insertOpportunity(sqlite, "opp-neither", { storyId: null, signalId: null }),
    ).toThrow(/campaign_opportunities_trigger_xor|CHECK/);
    sqlite
      .prepare(
        `INSERT INTO signals (id, workspace_id, content, source, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("sig-1", "ws-1", "Manual signal", "manual", 1);
    expect(() =>
      insertOpportunity(sqlite, "opp-both", { signalId: "sig-1" }),
    ).toThrow(/campaign_opportunities_trigger_xor|CHECK/);
    insertOpportunity(sqlite, "opp-signal", { storyId: null, signalId: "sig-1" });
  });

  it("keeps story×campaign×revision×angle×matcher decisions unique per angle", () => {
    const sqlite = databaseThrough("0067");
    seedGraph(sqlite);

    insertOpportunity(sqlite, "opp-1");
    expect(() => insertOpportunity(sqlite, "opp-dup")).toThrow(/UNIQUE/);
    // A different angle for the same story×campaign is an independent decision.
    insertOpportunity(sqlite, "opp-2", { angleHash: "angle-2" });
  });

  it("backfills routing defaults onto pre-existing campaigns and stories", () => {
    const sqlite = databaseThrough("0066");
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
      .run("camp-old", "ws-1", "Pre-61", 1, 1);
    sqlite
      .prepare(
        `INSERT INTO canonical_external_stories (
          id, workspace_id, status, canonical_url, title, content_fingerprint,
          first_observed_at, last_observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("story-old", "ws-1", "active", "https://ex.com/o", "O", "fp-o", 1, 1, 1, 1);

    sqlite.exec(
      readFileSync(path.join(migrationsDir, SPRINT_61_MIGRATION), "utf8"),
    );

    expect(
      sqlite
        .prepare(
          `SELECT routing_band, routing_min_fit, routing_min_confidence,
                  routing_min_trust, routing_exclusions_json
           FROM campaigns WHERE id = ?`,
        )
        .get("camp-old"),
    ).toEqual({
      routing_band: "review",
      routing_min_fit: 70,
      routing_min_confidence: 60,
      routing_min_trust: 0,
      routing_exclusions_json: "[]",
    });
    expect(
      sqlite
        .prepare(
          `SELECT routing_state, routing_fingerprint, routing_attempts, routed_at
           FROM canonical_external_stories WHERE id = ?`,
        )
        .get("story-old"),
    ).toEqual({
      routing_state: "pending",
      routing_fingerprint: null,
      routing_attempts: 0,
      routed_at: null,
    });
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }> };
    const entry = journal.entries.find(
      (e) => e.tag === SPRINT_61_MIGRATION.replace(/\.sql$/, ""),
    )!;
    expect(entry).toBeDefined();
    expect(entry.version).toBe("6");
    expect(entry.breakpoints).toBe(true);
    expect(entry.idx).toBe(67);
    expect(entry.tag.startsWith(String(entry.idx).padStart(4, "0"))).toBe(true);
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(
      journal.entries.length,
    );
  });
});
