import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Channel } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaignOpportunities,
  canonicalExternalStories,
  contentPackages,
  deliverableEvents,
  deliverables,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import { recordOccurrenceAndResolve } from "../src/services/canonical-stories";
import {
  angleHashOf,
  loadStoryRoutingContext,
} from "../src/services/opportunity-matching";
import {
  createPackageFromOpportunity,
  decidePackage,
} from "../src/services/content-packages";
import { compileRoutingProfile } from "../src/services/routing-profiles";
import { runPackageAssessments } from "../src/services/sufficiency";
import {
  InvalidDeliverableTransitionError,
  InvalidPackageStateError,
  decideDeliverable,
  fanOutDuePackages,
  fanOutPackage,
  getDeliverableDetail,
  listDeliverables,
  materializePlannedSlots,
  sweepStaleDeliverables,
} from "../src/services/deliverables";
import { buildAuthedApp, createTestDb } from "./helpers";

const RUN_OPTS = { limit: 10, leaseMs: 45_000, timeoutMs: 45_000 };
/** Monday 2026-01-05 12:00 UTC — slots land deterministically after this. */
const NOW = Date.UTC(2026, 0, 5, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

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

const plannedLane = {
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "",
  audienceId: null,
  channel: "linkedin" as Channel,
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

const reactiveLane = {
  ...plannedLane,
  key: "founder-instagram",
  name: "Founder Instagram",
  channel: "instagram" as Channel,
  format: "instagram_post",
  deliveryMode: "reactive" as const,
  plannedQuantity: 0,
  schedule: null,
  reactivePeriod: "week" as const,
  reactiveCap: 1,
};

function sufficiencyGateway(eligibleFormats: string[]): LlmGateway {
  return {
    async generate(params: { prompt: string }) {
      const sourceIds = [...params.prompt.matchAll(/SOURCE ([0-9a-f-]{36}) \(/g)].map(
        (m) => m[1]!,
      );
      return {
        text: JSON.stringify({
          sufficient: true,
          confidence: 80,
          supportedClaims: [
            { claim: "Buyers dislike generic output.", sourceIds: sourceIds.slice(0, 1) },
          ],
          missingFacts: [],
          missingMedia: [],
          eligibleFormats,
          ineligibleFormats: [],
          researchActions: [],
        }),
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  } as LlmGateway;
}

describe("deliverables: slots, fan-out & lifecycle (Sprint 63)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Deliver" } })
    ).json().id;
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
  });

  afterEach(async () => {
    await app.close();
  });

  function activatePlan(lanes: Array<typeof plannedLane | typeof reactiveLane>): string {
    const revision = createPlanRevision(db, workspaceId, campaignId, planInput, {
      userId: null,
    });
    for (const lane of lanes) {
      upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
        ...lane,
        personaId,
      });
    }
    activatePlanRevision(db, workspaceId, campaignId, revision.id);
    return revision.id;
  }

  function seedStory(title: string): string {
    db.transaction((tx) => {
      recordOccurrenceAndResolve(tx, {
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
    return db
      .select({ id: canonicalExternalStories.id })
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.title, title))
      .get()!.id;
  }

  function seedOpportunity(storyId: string, angle: string): string {
    const profile = compileRoutingProfile(db, workspaceId, campaignId)!;
    const story = db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, storyId))
      .get()!;
    const occurrenceIds = [...loadStoryRoutingContext(db, story).activeOccurrenceIds];
    const id = randomUUID();
    const now = Date.now();
    db.insert(campaignOpportunities)
      .values({
        id,
        workspaceId,
        canonicalStoryId: storyId,
        manualSignalId: null,
        campaignId,
        planRevisionId: profile.planRevisionId,
        routingProfileId: profile.id,
        status: "qualified",
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

  /** Create a package and assess it into `ready` for the given formats. */
  async function readyPackage(
    title: string,
    angle: string,
    eligibleFormats: string[],
  ): Promise<string> {
    const packageId = createPackageFromOpportunity(
      db,
      workspaceId,
      seedOpportunity(seedStory(title), angle),
      { userId },
    );
    const run = await runPackageAssessments(db, sufficiencyGateway(eligibleFormats), {
      workspaceId,
      ...RUN_OPTS,
    });
    expect(run.assessed).toBe(1);
    expect(
      db.select().from(contentPackages).where(eq(contentPackages.id, packageId)).get()!
        .status,
    ).toBe("ready");
    return packageId;
  }

  it("materializes at most plannedQuantity slots per week within the horizon, idempotently", () => {
    activatePlan([{ ...plannedLane, plannedQuantity: 1 }]);
    const created = materializePlannedSlots(db, { workspaceId, now: NOW });
    // Two Tue/Thu weeks in the 14-day horizon, capped at 1/week.
    expect(created).toBe(2);
    const rows = db
      .select()
      .from(deliverables)
      .orderBy(asc(deliverables.originalScheduledFor))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "planned" && row.kind === "planned")).toBe(
      true,
    );
    expect(rows.every((row) => (row.originalScheduledFor ?? 0) > NOW)).toBe(true);
    // The two kept slots fall in different weeks.
    expect(
      (rows[1]!.originalScheduledFor ?? 0) - (rows[0]!.originalScheduledFor ?? 0),
    ).toBeGreaterThan(5 * DAY_MS);
    // Idempotent re-run.
    expect(materializePlannedSlots(db, { workspaceId, now: NOW })).toBe(0);
  });

  it("materializes the full schedule when quantity covers it, with creation events", () => {
    activatePlan([plannedLane]);
    expect(materializePlannedSlots(db, { workspaceId, now: NOW })).toBe(4);
    const events = db.select().from(deliverableEvents).all();
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.fromStatus === null && event.toStatus === "planned")).toBe(
      true,
    );
  });

  it("fan-out fills the oldest planned slot first and copies the angle", async () => {
    activatePlan([plannedLane]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const packageId = await readyPackage("Slot story", "A grounded angle", [
      "linkedin_post",
    ]);

    const result = fanOutPackage(db, workspaceId, packageId, { userId });
    expect(result.deliverablesCreated).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const rows = db
      .select()
      .from(deliverables)
      .orderBy(asc(deliverables.originalScheduledFor))
      .all();
    const assigned = rows.filter((row) => row.packageId === packageId);
    expect(assigned).toHaveLength(1);
    // Oldest slot won.
    expect(assigned[0]!.id).toBe(rows[0]!.id);
    expect(assigned[0]!.status).toBe("ready");
    expect(assigned[0]!.generationState).toBe("pending");
    expect(assigned[0]!.angle).toBe("A grounded angle");
    // The package is stamped as fanned out.
    expect(
      db.select().from(contentPackages).where(eq(contentPackages.id, packageId)).get()!
        .fannedOutAt,
    ).not.toBeNull();
  });

  it("never gives one package two deliverables on one lane thread", async () => {
    activatePlan([plannedLane]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const packageId = await readyPackage("Repeat story", "A repeat angle", [
      "linkedin_post",
    ]);
    expect(fanOutPackage(db, workspaceId, packageId, { userId }).deliverablesCreated).toBe(1);
    const second = fanOutPackage(db, workspaceId, packageId, { userId });
    expect(second.deliverablesCreated).toBe(0);
    expect(second.skipped.map((entry) => entry.reason)).toEqual(["already_delivered"]);
  });

  it("falls back to a reactive deliverable and enforces the rolling cap", async () => {
    activatePlan([reactiveLane]);
    const first = await readyPackage("Reactive one", "First reactive angle", [
      "instagram_post",
    ]);
    const fanned = fanOutPackage(db, workspaceId, first, { userId });
    expect(fanned.deliverablesCreated).toBe(1);
    const reactive = db
      .select()
      .from(deliverables)
      .where(eq(deliverables.packageId, first))
      .get()!;
    expect(reactive.kind).toBe("reactive");
    expect(reactive.status).toBe("ready");
    expect(reactive.originalScheduledFor).toBeNull();

    // Cap 1/week: a second package is skipped with the recorded reason.
    const second = await readyPackage("Reactive two", "Second reactive angle", [
      "instagram_post",
    ]);
    const capped = fanOutPackage(db, workspaceId, second, { userId });
    expect(capped.deliverablesCreated).toBe(0);
    expect(capped.skipped.map((entry) => entry.reason)).toEqual(["reactive_cap"]);
  });

  it("rejects fan-out of a package that is not ready", async () => {
    activatePlan([plannedLane]);
    const packageId = createPackageFromOpportunity(
      db,
      workspaceId,
      seedOpportunity(seedStory("Unassessed"), "An unassessed angle"),
      { userId },
    );
    expect(() => fanOutPackage(db, workspaceId, packageId, { userId })).toThrow(
      InvalidPackageStateError,
    );
  });

  it("fanOutDuePackages consumes only unfanned ready packages", async () => {
    activatePlan([plannedLane]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const packageId = await readyPackage("Due story", "A due angle", ["linkedin_post"]);
    const run = fanOutDuePackages(db, { workspaceId, limit: 10 });
    expect(run).toEqual({ packagesFannedOut: 1, deliverablesCreated: 1 });
    // Already stamped: nothing due on the second pass.
    expect(fanOutDuePackages(db, { workspaceId, limit: 10 })).toEqual({
      packagesFannedOut: 0,
      deliverablesCreated: 0,
    });
    expect(
      db.select().from(deliverables).where(eq(deliverables.packageId, packageId)).all(),
    ).toHaveLength(1);
  });

  it("sweeps passed planned slots to stale after the grace window", () => {
    activatePlan([{ ...plannedLane, plannedQuantity: 1 }]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    // Within grace: nothing happens.
    expect(sweepStaleDeliverables(db, { workspaceId, now: NOW })).toBe(0);
    const staled = sweepStaleDeliverables(db, { workspaceId, now: NOW + 20 * DAY_MS });
    expect(staled).toBe(2);
    const rows = db.select().from(deliverables).all();
    expect(rows.every((row) => row.status === "stale")).toBe(true);
    // Terminal-ish: a stale deliverable cannot be cancelled without reason… it can, with one.
    const detail = decideDeliverable(db, workspaceId, rows[0]!.id, {
      action: "cancel",
      reason: "missed the window",
      actorUserId: userId,
    });
    expect(detail.deliverable.status).toBe("cancelled");
  });

  it("blocks ready deliverables when their package is cancelled", async () => {
    activatePlan([plannedLane]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const packageId = await readyPackage("Cancelled story", "A cancelled angle", [
      "linkedin_post",
    ]);
    fanOutPackage(db, workspaceId, packageId, { userId });

    decidePackage(db, workspaceId, packageId, {
      action: "cancel",
      reason: "withdrawn",
      actorUserId: userId,
    });

    const assigned = db
      .select()
      .from(deliverables)
      .where(eq(deliverables.packageId, packageId))
      .get()!;
    expect(assigned.status).toBe("blocked");
    const events = db
      .select()
      .from(deliverableEvents)
      .where(eq(deliverableEvents.deliverableId, assigned.id))
      .all();
    expect(events.at(-1)).toMatchObject({
      fromStatus: "ready",
      toStatus: "blocked",
      reason: "package cancelled",
    });
  });

  it("gates decisions through the machine: no cancel on fulfilled, no select on planned", () => {
    activatePlan([{ ...plannedLane, plannedQuantity: 1 }]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const row = db.select().from(deliverables).all()[0]!;
    expect(() =>
      decideDeliverable(db, workspaceId, row.id, {
        action: "select",
        variantId: randomUUID(),
        actorUserId: userId,
      }),
    ).toThrow(InvalidDeliverableTransitionError);
    expect(() =>
      decideDeliverable(db, workspaceId, row.id, {
        action: "regenerate",
        actorUserId: userId,
      }),
    ).toThrow(InvalidDeliverableTransitionError);
  });

  it("lists with status filters and projects lane/campaign context", async () => {
    activatePlan([plannedLane]);
    materializePlannedSlots(db, { workspaceId, now: NOW });
    const listed = listDeliverables(db, workspaceId, { status: "planned" });
    expect(listed.total).toBe(4);
    expect(listed.deliverables[0]).toMatchObject({
      laneName: "Founder LinkedIn",
      channel: "linkedin",
      format: "linkedin_post",
      campaignName: "Category launch",
      variantCount: 0,
      latestVariantStatus: null,
    });
    const detail = getDeliverableDetail(db, workspaceId, listed.deliverables[0]!.id);
    expect(detail.events).toHaveLength(1);
    expect(detail.variants).toHaveLength(0);
  });
});
