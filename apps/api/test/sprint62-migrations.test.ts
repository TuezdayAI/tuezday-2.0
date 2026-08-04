import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const SPRINT_62_MIGRATION = "0068_sprint_62_content_packages.sql";

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
      "opp-1", "ws-1", "story-1", null, "camp-1", "rev-1", "prof-1",
      "qualified", "An angle", "angle-1",
      80, 75, 65, 70, 60, null, "[]", "Fits the plan.", 1, "{}", null, 1, 1,
    );
}

function insertPackage(
  sqlite: Database.Database,
  id: string,
  overrides: { opportunityId?: string | null } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO content_packages (
        id, workspace_id, campaign_id, plan_revision_id, opportunity_id,
        canonical_story_id, angle, angle_hash, novelty, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, "ws-1", "camp-1", "rev-1",
      overrides.opportunityId === undefined ? "opp-1" : overrides.opportunityId,
      "story-1", "An angle", "angle-1", 100, 1, 1,
    );
}

describe("Sprint 62 migrations", () => {
  it("creates packages with the assessing/pending defaults", () => {
    const sqlite = databaseThrough("0068");
    seedGraph(sqlite);
    insertPackage(sqlite, "pkg-1");

    expect(
      sqlite
        .prepare(
          `SELECT status, assessment_state, assessment_attempts, assessed_at
           FROM content_packages WHERE id = ?`,
        )
        .get("pkg-1"),
    ).toEqual({
      status: "assessing",
      assessment_state: "pending",
      assessment_attempts: 0,
      assessed_at: null,
    });
  });

  it("keeps the opportunity→package pairing 1:1 (partial unique)", () => {
    const sqlite = databaseThrough("0068");
    seedGraph(sqlite);
    insertPackage(sqlite, "pkg-1");
    expect(() => insertPackage(sqlite, "pkg-dup")).toThrow(/UNIQUE/);
    // Orphaned packages (opportunity deleted) never collide with each other.
    insertPackage(sqlite, "pkg-orphan-1", { opportunityId: null });
    insertPackage(sqlite, "pkg-orphan-2", { opportunityId: null });
  });

  it("lets packages and source snapshots survive story/opportunity deletion", () => {
    const sqlite = databaseThrough("0068");
    seedGraph(sqlite);
    insertPackage(sqlite, "pkg-1");
    sqlite
      .prepare(
        `INSERT INTO package_sources (
          id, workspace_id, package_id, role, canonical_story_id,
          occurrence_id, signal_id, title, url, excerpt, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "src-1", "ws-1", "pkg-1", "trigger", "story-1", null, null,
        "A", "https://ex.com/a", "Excerpt", "{}", 1,
      );

    sqlite.prepare("DELETE FROM canonical_external_stories WHERE id = ?").run("story-1");

    const pkg = sqlite
      .prepare(
        "SELECT opportunity_id, canonical_story_id, angle FROM content_packages WHERE id = ?",
      )
      .get("pkg-1") as Record<string, unknown>;
    // Deleting the story cascades into the opportunity, so both refs go null —
    // but the package row and its snapshot survive (design §1.3 provenance).
    expect(pkg["canonical_story_id"]).toBeNull();
    expect(pkg["opportunity_id"]).toBeNull();
    expect(pkg["angle"]).toBe("An angle");

    const source = sqlite
      .prepare(
        "SELECT canonical_story_id, title, excerpt FROM package_sources WHERE id = ?",
      )
      .get("src-1") as Record<string, unknown>;
    expect(source["canonical_story_id"]).toBeNull();
    expect(source["title"]).toBe("A");
    expect(source["excerpt"]).toBe("Excerpt");
  });

  it("keeps assessment versions and eligibility decisions unique", () => {
    const sqlite = databaseThrough("0068");
    seedGraph(sqlite);
    insertPackage(sqlite, "pkg-1");
    const insertAssessment = (id: string, version: number) =>
      sqlite
        .prepare(
          `INSERT INTO sufficiency_assessments (
            id, workspace_id, package_id, assessment_version, verdict,
            confidence, assessor_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "ws-1", "pkg-1", version, "sufficient", 80, 1, 1);
    insertAssessment("assess-1", 1);
    expect(() => insertAssessment("assess-dup", 1)).toThrow(/UNIQUE/);
    insertAssessment("assess-2", 2);

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
      .run("lanerev-1", "ws-1", "lane-1", "rev-1", "persona-1", "linkedin", "linkedin_post", "reactive", 1);

    const insertDecision = (id: string, assessmentId: string) =>
      sqlite
        .prepare(
          `INSERT INTO lane_eligibility_decisions (
            id, workspace_id, package_id, assessment_id, lane_id,
            lane_revision_id, eligible, checks_json, evaluator_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "ws-1", "pkg-1", assessmentId, "lane-1", "lanerev-1", 1, "[]", 1, 1);
    insertDecision("dec-1", "assess-1");
    expect(() => insertDecision("dec-dup", "assess-1")).toThrow(/UNIQUE/);
    // A new assessment re-evaluates the same lane revision independently.
    insertDecision("dec-2", "assess-2");
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }> };
    const entry = journal.entries.find(
      (e) => e.tag === SPRINT_62_MIGRATION.replace(/\.sql$/, ""),
    )!;
    expect(entry).toBeDefined();
    expect(entry.version).toBe("6");
    expect(entry.breakpoints).toBe(true);
    expect(entry.idx).toBe(68);
    expect(entry.tag.startsWith(String(entry.idx).padStart(4, "0"))).toBe(true);
    expect(new Set(journal.entries.map((e) => e.idx)).size).toBe(
      journal.entries.length,
    );
  });
});
