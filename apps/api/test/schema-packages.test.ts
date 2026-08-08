/**
 * Content-package and deliverable schema invariants (design §8.7–§8.11).
 *
 * These assertions were spread across sprint62/63-migrations.test.ts, where
 * they ran against a database built by replaying migrations up to a numbered
 * file. Sprint 74 squashed the history into one baseline, so they run against
 * the baseline instead — the constraints are the same, and they are exactly
 * the kind a dialect swap breaks quietly: partial-unique indexes, defaults,
 * and ON DELETE SET NULL where CASCADE would destroy provenance.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { PG_ERROR, expectPgError } from "./schema-introspection";
import {
  CAMPAIGN,
  LANE,
  LANE_REVISION,
  OPPORTUNITY,
  PACKAGE_FIRST,
  STORY,
  WS,
  insertAssessment,
  insertDeliverable,
  insertPackage,
  insertSnapshot,
  insertVariant,
  seedCampaignGraph,
} from "./schema-seed";
import {
  campaignLaneRevisions,
  campaignLanes,
  canonicalExternalStories,
  contentPackages,
  contextSnapshots,
  deliverables,
  laneEligibilityDecisions,
  packageSources,
  variants,
} from "../src/db/schema";

async function seeded() {
  const db = await createTestDb();
  await seedCampaignGraph(db);
  return db;
}

describe("content package schema", () => {
  it("creates packages with the assessing/pending defaults", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);

    const [pkg] = await db
      .select({
        status: contentPackages.status,
        assessmentState: contentPackages.assessmentState,
        assessmentAttempts: contentPackages.assessmentAttempts,
        assessedAt: contentPackages.assessedAt,
        fannedOutAt: contentPackages.fannedOutAt,
      })
      .from(contentPackages)
      .where(eq(contentPackages.id, PACKAGE_FIRST));

    expect(pkg).toEqual({
      status: "assessing",
      assessmentState: "pending",
      assessmentAttempts: 0,
      assessedAt: null,
      fannedOutAt: null,
    });
  });

  it("keeps the opportunity→package pairing 1:1 (partial unique)", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);
    await expectPgError(insertPackage(db, "pkg-dup"), PG_ERROR.uniqueViolation);
    // Orphaned packages (opportunity deleted) never collide with each other:
    // the index is partial on `opportunity_id IS NOT NULL`.
    await insertPackage(db, "pkg-orphan-1", { opportunityId: null });
    await insertPackage(db, "pkg-orphan-2", { opportunityId: null });
  });

  it("lets packages and source snapshots survive story/opportunity deletion", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);
    await db.insert(packageSources).values({
      id: "src-1",
      workspaceId: WS,
      packageId: PACKAGE_FIRST,
      role: "trigger",
      canonicalStoryId: STORY,
      title: "A",
      url: "https://ex.com/a",
      excerpt: "Excerpt",
      createdAt: 1,
    });

    await db.delete(canonicalExternalStories).where(eq(canonicalExternalStories.id, STORY));

    // Deleting the story cascades into the opportunity, so both refs go null —
    // but the package row and its snapshot survive (design §1.3 provenance).
    const [pkg] = await db
      .select()
      .from(contentPackages)
      .where(eq(contentPackages.id, PACKAGE_FIRST));
    expect(pkg?.canonicalStoryId).toBeNull();
    expect(pkg?.opportunityId).toBeNull();
    expect(pkg?.angle).toBe("An angle");

    const [source] = await db
      .select()
      .from(packageSources)
      .where(eq(packageSources.id, "src-1"));
    expect(source?.canonicalStoryId).toBeNull();
    expect(source?.title).toBe("A");
    expect(source?.excerpt).toBe("Excerpt");
  });

  it("keeps assessment versions and eligibility decisions unique", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);

    await insertAssessment(db, "assess-1", 1);
    await expectPgError(insertAssessment(db, "assess-dup", 1), PG_ERROR.uniqueViolation);
    await insertAssessment(db, "assess-2", 2);

    const decision = (id: string, assessmentId: string) =>
      db.insert(laneEligibilityDecisions).values({
        id,
        workspaceId: WS,
        packageId: PACKAGE_FIRST,
        assessmentId,
        laneId: LANE,
        laneRevisionId: LANE_REVISION,
        eligible: true,
        checksJson: "[]",
        evaluatorVersion: 1,
        createdAt: 1,
      });

    await decision("dec-1", "assess-1");
    await expectPgError(decision("dec-dup", "assess-1"), PG_ERROR.uniqueViolation);
    // A new assessment re-evaluates the same lane revision independently.
    await decision("dec-2", "assess-2");
  });
});

describe("deliverable schema", () => {
  it("creates deliverables with the planned/pending defaults", async () => {
    const db = await seeded();
    await insertDeliverable(db, "del-1");

    const [row] = await db
      .select({
        status: deliverables.status,
        generationState: deliverables.generationState,
        generationAttempts: deliverables.generationAttempts,
        generatedAt: deliverables.generatedAt,
        angle: deliverables.angle,
      })
      .from(deliverables)
      .where(eq(deliverables.id, "del-1"));

    expect(row).toEqual({
      status: "planned",
      generationState: "pending",
      generationAttempts: 0,
      generatedAt: null,
      angle: "",
    });
  });

  it("enforces the §8.10 planned-slot uniqueness per lane revision", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);
    await insertDeliverable(db, "del-1", { originalScheduledFor: 1_000 });
    await expectPgError(
      insertDeliverable(db, "del-dup", { originalScheduledFor: 1_000 }), PG_ERROR.uniqueViolation);
    await insertDeliverable(db, "del-2", { originalScheduledFor: 2_000 });
    // Reactive deliverables (no slot) never collide on the planned key.
    await insertDeliverable(db, "del-r1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: PACKAGE_FIRST,
    });
  });

  it("enforces the §8.10 reactive uniqueness per package and lane revision", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);
    await insertDeliverable(db, "del-r1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: PACKAGE_FIRST,
    });
    await expectPgError(
      insertDeliverable(db, "del-r-dup", {
        kind: "reactive",
        originalScheduledFor: null,
        packageId: PACKAGE_FIRST,
      }), PG_ERROR.uniqueViolation);
    // A planned slot assigned the same package does not hit the reactive key.
    await insertDeliverable(db, "del-p1", {
      originalScheduledFor: 3_000,
      packageId: PACKAGE_FIRST,
    });
  });

  it("keeps deliverables, variants, and snapshots when the package is deleted", async () => {
    const db = await seeded();
    await insertPackage(db, PACKAGE_FIRST);
    await insertDeliverable(db, "del-1", {
      kind: "reactive",
      originalScheduledFor: null,
      packageId: PACKAGE_FIRST,
    });
    await insertSnapshot(db, "snap-1", "del-1", PACKAGE_FIRST);
    await insertVariant(db, "var-1", "del-1", 1, "snap-1");

    await db.delete(contentPackages).where(eq(contentPackages.id, PACKAGE_FIRST));

    const [deliverable] = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, "del-1"));
    expect(deliverable?.packageId).toBeNull();

    const [snapshot] = await db
      .select()
      .from(contextSnapshots)
      .where(eq(contextSnapshots.id, "snap-1"));
    expect(snapshot?.packageId).toBeNull();
    expect(snapshot?.resolvedContextJson).toBe("{}");

    const [variant] = await db.select().from(variants).where(eq(variants.id, "var-1"));
    expect(variant?.content).toBe("Post body");
  });

  it("keeps variant versions unique per deliverable", async () => {
    const db = await seeded();
    await insertDeliverable(db, "del-1");
    await insertSnapshot(db, "snap-1", "del-1", null);

    await insertVariant(db, "var-1", "del-1", 1, "snap-1");
    await expectPgError(insertVariant(db, "var-dup", "del-1", 1, "snap-1"), PG_ERROR.uniqueViolation);
    await insertVariant(db, "var-2", "del-1", 2, "snap-1");
  });

  it("keeps a lane revision unique per lane and plan revision", async () => {
    const db = await seeded();
    // The identity index that lets a deliverable name one lane configuration.
    await expectPgError(
      db.insert(campaignLaneRevisions).values({
        id: "lanerev-dup",
        workspaceId: WS,
        laneId: LANE,
        planRevisionId: "rev-1",
        personaId: "persona-1",
        channel: "linkedin",
        format: "linkedin_post",
        deliveryMode: "reactive",
        createdAt: 1,
      }), PG_ERROR.uniqueViolation);

    await expectPgError(
      db.insert(campaignLanes).values({
        id: "lane-dup",
        workspaceId: WS,
        campaignId: CAMPAIGN,
        key: "li",
        name: "LinkedIn again",
        createdAt: 1,
        updatedAt: 1,
      }), PG_ERROR.uniqueViolation);
  });
});
