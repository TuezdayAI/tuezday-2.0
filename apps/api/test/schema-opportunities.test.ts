/**
 * Campaign-opportunity schema invariants (Sprint 61, design §8.5/§9.3).
 *
 * Ported from sprint61-migrations.test.ts. The two that matter are the
 * story/signal XOR — a check constraint, which SQLite and Postgres express
 * differently enough to be worth proving rather than assuming — and the
 * per-angle identity indexes, which are what stop the matcher re-proposing
 * the same decision on every pass.
 */
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { PG_ERROR, expectPgError } from "./schema-introspection";
import { CAMPAIGN, PLAN_REVISION, ROUTING_PROFILE, STORY, WS, seedCampaignGraph } from "./schema-seed";
import type { Db } from "../src/db";
import { campaignOpportunities, signals } from "../src/db/schema";


function insertOpportunity(
  db: Db,
  id: string,
  overrides: { storyId?: string | null; signalId?: string | null; angleHash?: string } = {},
) {
  return db.insert(campaignOpportunities).values({
    id,
    workspaceId: WS,
    canonicalStoryId: overrides.storyId === undefined ? STORY : overrides.storyId,
    manualSignalId: overrides.signalId === undefined ? null : overrides.signalId,
    campaignId: CAMPAIGN,
    planRevisionId: PLAN_REVISION,
    routingProfileId: ROUTING_PROFILE,
    status: "needs_review",
    angle: "An angle",
    angleHash: overrides.angleHash ?? "angle-1",
    workspaceRelevance: 80,
    campaignFit: 75,
    confidence: 65,
    actionability: 70,
    sourceTrust: 60,
    reason: "Fits the plan.",
    matcherVersion: 1,
    policyJson: "{}",
    createdAt: 1,
    updatedAt: 1,
  });
}

/** The seed graph already carries one opportunity; these tests want a bare one. */
async function seeded(): Promise<Db> {
  const db = await createTestDb();
  await seedCampaignGraph(db);
  await db.delete(campaignOpportunities);
  return db;
}

describe("campaign opportunity schema", () => {
  it("enforces the story/signal XOR", async () => {
    const db = await seeded();

    await insertOpportunity(db, "opp-ok");
    await expectPgError(
      insertOpportunity(db, "opp-neither", { storyId: null, signalId: null }),
      PG_ERROR.checkViolation,
      "campaign_opportunities_trigger_xor",
    );

    await db
      .insert(signals)
      .values({ id: "sig-1", workspaceId: WS, content: "Manual signal", source: "manual", createdAt: 1 });
    await expectPgError(insertOpportunity(db, "opp-both", { signalId: "sig-1" }), PG_ERROR.checkViolation, "campaign_opportunities_trigger_xor");

    await insertOpportunity(db, "opp-signal", { storyId: null, signalId: "sig-1" });
  });

  it("keeps story×campaign×revision×angle×matcher decisions unique per angle", async () => {
    const db = await seeded();

    await insertOpportunity(db, "opp-1");
    await expect(insertOpportunity(db, "opp-dup"), PG_ERROR.uniqueViolation);
    // A different angle for the same story×campaign is an independent decision.
    await insertOpportunity(db, "opp-2", { angleHash: "angle-2" });
  });

  it("scopes the signal identity index the same way", async () => {
    const db = await seeded();
    await db
      .insert(signals)
      .values({ id: "sig-1", workspaceId: WS, content: "Manual signal", source: "manual", createdAt: 1 });

    await insertOpportunity(db, "opp-1", { storyId: null, signalId: "sig-1" });
    await expectPgError(
      insertOpportunity(db, "opp-dup", { storyId: null, signalId: "sig-1" }), PG_ERROR.uniqueViolation);
    await insertOpportunity(db, "opp-2", {
      storyId: null,
      signalId: "sig-1",
      angleHash: "angle-2",
    });
  });
});
