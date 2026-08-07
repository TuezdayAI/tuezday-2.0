import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { campaignRoutingProfiles, campaigns } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  activatePlanRevision,
  createPlanRevision,
} from "../src/services/campaign-plans";
import { upsertLaneRevision } from "../src/services/campaign-lanes";
import {
  compileRoutingProfile,
  currentRoutingProfiles,
  updateRoutingPolicy,
} from "../src/services/routing-profiles";
import { buildAuthedApp, createTestDb } from "./helpers";

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const planInput = {
  objective: "Build category awareness",
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

describe("campaign routing profiles (Sprint 61)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: stubLlm });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Routing" } })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Category launch" },
      })
    ).json().id;
    personaId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Founder" },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function activatePlan(overrides: Partial<typeof planInput> = {}) {
    const revision = await createPlanRevision(
      db,
      workspaceId,
      campaignId,
      { ...planInput, ...overrides },
      { userId: null },
    );
    await upsertLaneRevision(db, workspaceId, campaignId, revision.id, {
      ...laneInput,
      personaId,
    });
    await activatePlanRevision(db, workspaceId, campaignId, revision.id);
    return revision;
  }

  it("returns undefined before a plan revision is active", async () => {
    expect(await compileRoutingProfile(db, workspaceId, campaignId)).toBeUndefined();
    expect(await currentRoutingProfiles(db, workspaceId)).toEqual([]);
  });

  it("compiles deterministically: unchanged inputs produce no new row", async () => {
    await activatePlan();
    const first = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const second = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    expect(first.profileVersion).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.profileFingerprint).toBe(first.profileFingerprint);
    expect(
      await db.select().from(campaignRoutingProfiles).where(eq(campaignRoutingProfiles.campaignId, campaignId)).all(),
    ).toHaveLength(1);
    // The compiled projection reflects plan + active lanes + policy defaults.
    expect(first.payload.pillars).toEqual(["GTM memory"]);
    expect(first.payload.personaIds).toEqual([personaId]);
    expect(first.payload.channels).toEqual(["linkedin"]);
    expect(first.payload.formats).toEqual(["linkedin_post"]);
    expect(first.routingBand).toBe("review");
    expect(first.minFit).toBe(70);
  });

  it("versions on plan-revision change with the fingerprint tracking inputs", async () => {
    await activatePlan();
    const first = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    await activatePlan({ pillars: ["GTM memory", "Proof"] });
    const second = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    expect(second.profileVersion).toBe(2);
    expect(second.profileFingerprint).not.toBe(first.profileFingerprint);
    expect(second.planRevisionId).not.toBe(first.planRevisionId);
    // Both rows survive — profiles are append-only derived data.
    expect(
      await db.select().from(campaignRoutingProfiles).where(eq(campaignRoutingProfiles.campaignId, campaignId)).all(),
    ).toHaveLength(2);
  });

  it("recompiles when routing policy changes and snapshots the new policy", async () => {
    await activatePlan();
    const first = (await compileRoutingProfile(db, workspaceId, campaignId))!;
    const { profile } = await updateRoutingPolicy(db, workspaceId, campaignId, {
      band: "auto_package",
      minFit: 80,
      exclusions: ["crypto"],
    });
    expect(profile!.profileVersion).toBe(first.profileVersion + 1);
    expect(profile!.routingBand).toBe("auto_package");
    expect(profile!.minFit).toBe(80);
    expect(profile!.payload.exclusions).toEqual(["crypto"]);
    const campaign = (await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .get())!;
    expect(campaign.routingBand).toBe("auto_package");
    expect(campaign.routingMinFit).toBe(80);
  });

  it("excludes band-off campaigns from the routing set", async () => {
    await activatePlan();
    expect(await currentRoutingProfiles(db, workspaceId)).toHaveLength(1);
    await updateRoutingPolicy(db, workspaceId, campaignId, { band: "off" });
    expect(await currentRoutingProfiles(db, workspaceId)).toEqual([]);
  });
});
