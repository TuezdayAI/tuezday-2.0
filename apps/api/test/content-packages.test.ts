import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  campaignOpportunityEvents,
  canonicalExternalStories,
  contentPackageEvents,
  contentPackages,
  packageSources,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { recordOccurrenceAndResolve } from "../src/services/canonical-stories";
import {
  InvalidOpportunityTransitionError,
} from "../src/services/opportunities";
import {
  angleHashOf,
  loadStoryRoutingContext,
} from "../src/services/opportunity-matching";
import {
  InvalidPackageTransitionError,
  createPackageFromOpportunity,
  decidePackage,
  getPackageDetail,
  listPackages,
  noveltyFor,
} from "../src/services/content-packages";
import { compileRoutingProfile } from "../src/services/routing-profiles";
import { buildAuthedApp, createTestDb } from "./helpers";

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "{}", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const planInput = {
  objective: "Build category awareness for GTM memory",
  kpi: "Qualified conversations",
  timeframe: "Q3",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory"],
  offers: ["Product demo"],
  ctas: ["Book a demo"],
  guidance: "Use customer evidence.",
};

const laneInput = {
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "",
  audienceId: null,
  channel: "linkedin" as const,
  format: "linkedin_post",
  publishingConnectionId: null,
  providerTarget: "feed",
  deliveryMode: "planned" as const,
  plannedQuantity: 2,
  schedule: { daysOfWeek: [2, 4], timeOfDay: "10:00", timezone: "Asia/Kolkata" },
  reactivePeriod: null,
  reactiveCap: null,
  status: "active" as const,
};

describe("content packages (Sprint 62)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: stubLlm });
    const workspace = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Packages" },
    });
    workspaceId = workspace.json().id;
    userId = (await app.inject({ method: "GET", url: "/auth/me" })).json().user.id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Category launch" },
      })
    ).json().id;
    const revision = await createPlanRevision(
      db,
      workspaceId,
      campaignId,
      planInput,
      { userId: null },
    );
    await upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
      ...laneInput,
      personaId,
    });
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedStory(title: string): Promise<string> {
    await db.transaction(async (tx) => {
      await recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: randomUUID(), type: "rss", name: "Feed" },
        fetchRunId: null,
        item: {
          externalId: randomUUID(),
          title,
          url: `https://ex.com/${randomUUID()}`,
          summary: "Discussion about generic AI output and GTM memory.",
          publishedAt: null,
        },
        observedAt: Date.now(),
      });
    });
    return (await db
      .select({ id: canonicalExternalStories.id })
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.title, title))
      .get())!.id;
  }

  async function seedOpportunity(
    storyId: string,
    angle: string,
    status: "qualified" | "auto_qualified" | "needs_review" = "qualified",
  ): Promise<string> {
    const profile = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const story = (await db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, storyId))
      .get())!;
    const occurrenceIds = [...(await loadStoryRoutingContext(db, story)).activeOccurrenceIds];
    const id = randomUUID();
    const now = Date.now();
    await db.insert(campaignOpportunities)
      .values({
        id,
        workspaceId,
        canonicalStoryId: storyId,
        manualSignalId: null,
        campaignId,
        planRevisionId: profile.planRevisionId,
        routingProfileId: profile.id,
        status,
        angle,
        angleHash: angleHashOf(angle),
        workspaceRelevance: 85,
        campaignFit: 80,
        confidence: 75,
        actionability: 70,
        sourceTrust: 60,
        suggestedPersonaId: null,
        supportedClaimsJson: JSON.stringify([
          { claim: "Buyers dislike generic output.", occurrenceIds },
        ]),
        reason: "Fits the pillar.",
        matcherVersion: 1,
        policyJson: JSON.stringify({ band: "review", checks: [] }),
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  it("consumes a qualified opportunity: transition, snapshots, novelty, events", async () => {
    const storyId = await seedStory("Buyers hate generic AI output");
    const opportunityId = await seedOpportunity(storyId, "Generic output is a memory problem");

    const packageId = await createPackageFromOpportunity(db, workspaceId, opportunityId, {
      userId,
    });

    const opportunity = (await db
      .select()
      .from(campaignOpportunities)
      .where(eq(campaignOpportunities.id, opportunityId))
      .get())!;
    expect(opportunity.status).toBe("package_created");
    expect(opportunity.decidedByUserId).toBe(userId);
    const oppEvents = await db
      .select()
      .from(campaignOpportunityEvents)
      .where(eq(campaignOpportunityEvents.opportunityId, opportunityId))
      .all();
    expect(oppEvents.map((e) => [e.fromStatus, e.toStatus])).toContainEqual([
      "qualified",
      "package_created",
    ]);

    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.status).toBe("assessing");
    expect(detail.package.assessmentState).toBe("pending");
    expect(detail.package.angle).toBe("Generic output is a memory problem");
    expect(detail.package.novelty).toBe(100);
    expect(detail.package.campaignName).toBe("Category launch");
    expect(detail.package.latestVerdict).toBeNull();

    const roles = detail.sources.map((s) => s.role).sort();
    expect(roles).toEqual(["evidence", "trigger"]);
    const trigger = detail.sources.find((s) => s.role === "trigger")!;
    expect(trigger.canonicalStoryId).toBe(storyId);
    expect(trigger.title).toBe("Buyers hate generic AI output");
    const evidence = detail.sources.find((s) => s.role === "evidence")!;
    expect(evidence.occurrenceId).not.toBeNull();

    expect(detail.events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, "assessing"],
    ]);
  });

  it("keeps the pairing 1:1 and refuses unqualified opportunities", async () => {
    const storyId = await seedStory("Second story");
    const opportunityId = await seedOpportunity(storyId, "An angle");
    await createPackageFromOpportunity(db, workspaceId, opportunityId, { userId });
    expect(async () =>
      await createPackageFromOpportunity(db, workspaceId, opportunityId, { userId }),
    ).toThrow(InvalidOpportunityTransitionError);

    const reviewStory = await seedStory("Review story");
    const reviewOpportunity = await seedOpportunity(reviewStory, "Other angle", "needs_review");
    expect(async () =>
      await createPackageFromOpportunity(db, workspaceId, reviewOpportunity, { userId }),
    ).toThrow(InvalidOpportunityTransitionError);
  });

  it("scores novelty deterministically against recent campaign angles", async () => {
    const storyA = await seedStory("Novelty story A");
    const angle = "Buyers forget every generic AI draft instantly";
    await createPackageFromOpportunity(db, workspaceId, await seedOpportunity(storyA, angle), {
      userId,
    });
    // Identical normalized angle → 0.
    expect(await noveltyFor(db, campaignId, angle, angleHashOf(angle), Date.now())).toBe(0);
    // Heavy token overlap scores low; an unrelated angle stays fully novel.
    const similar = "Buyers forget every generic AI draft";
    expect(
      await noveltyFor(db, campaignId, similar, angleHashOf(similar), Date.now()),
    ).toBeLessThan(50);
    const unrelated = "Pricing pages convert better with proof";
    expect(
      await noveltyFor(db, campaignId, unrelated, angleHashOf(unrelated), Date.now()),
    ).toBe(100);
  });

  it("moves lifecycle only through the contracts machine with audit events", async () => {
    const storyId = await seedStory("Lifecycle story");
    const packageId = await createPackageFromOpportunity(
      db,
      workspaceId,
      await seedOpportunity(storyId, "Lifecycle angle"),
      { userId },
    );
    const cancelled = await decidePackage(db, workspaceId, packageId, {
      action: "cancel",
      reason: "stale",
      actorUserId: userId,
    });
    expect(cancelled.package.status).toBe("cancelled");
    expect(async () =>
      await decidePackage(db, workspaceId, packageId, {
        action: "reassess",
        actorUserId: userId,
      }),
    ).toThrow(InvalidPackageTransitionError);
    const events = await db
      .select()
      .from(contentPackageEvents)
      .where(eq(contentPackageEvents.packageId, packageId))
      .orderBy(asc(contentPackageEvents.createdAt))
      .all();
    expect(events.at(-1)).toMatchObject({
      fromStatus: "assessing",
      toStatus: "cancelled",
      actorUserId: userId,
      reason: "stale",
    });
  });

  it("lists with filters and totals", async () => {
    const storyId = await seedStory("Listing story");
    await createPackageFromOpportunity(
      db,
      workspaceId,
      await seedOpportunity(storyId, "Listing angle"),
      { userId },
    );
    const all = await listPackages(db, workspaceId);
    expect(all.total).toBe(1);
    expect(all.packages[0]!.storyTitle).toBe("Listing story");
    expect((await listPackages(db, workspaceId, { status: "cancelled" })).total).toBe(0);
    expect((await listPackages(db, workspaceId, { campaignId })).total).toBe(1);
    expect((await listPackages(db, workspaceId, { campaignId: randomUUID() })).total).toBe(0);
  });

  it("keeps package rows and snapshots when the story graph is deleted", async () => {
    const storyId = await seedStory("Doomed story");
    const packageId = await createPackageFromOpportunity(
      db,
      workspaceId,
      await seedOpportunity(storyId, "Doomed angle"),
      { userId },
    );
    await db.delete(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, storyId))
      .run();
    const detail = await getPackageDetail(db, workspaceId, packageId);
    expect(detail.package.canonicalStoryId).toBeNull();
    expect(detail.package.opportunityId).toBeNull();
    expect(detail.package.angle).toBe("Doomed angle");
    // Snapshots survive with their captured text.
    const trigger = detail.sources.find((s) => s.role === "trigger")!;
    expect(trigger.canonicalStoryId).toBeNull();
    expect(trigger.title).toBe("Doomed story");
  });
});
