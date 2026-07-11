import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_ORIGINS,
  CAMPAIGN_PURPOSES,
  CAMPAIGN_STATUSES,
  DELIVERY_MODES,
  DELIVERABLE_PRODUCTION_STATUSES,
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_STATUSES,
  PACKAGE_SOURCE_ROLES,
  PLAN_REVISION_STATUSES,
  canTransitionDeliverable,
  canTransitionExternalAction,
  campaignLaneRevisionSchema,
  campaignLaneSchema,
  campaignPlanRevisionSchema,
} from "../src/index";

const IDS = {
  workspace: "11111111-1111-4111-8111-111111111111",
  campaign: "22222222-2222-4222-8222-222222222222",
  plan: "33333333-3333-4333-8333-333333333333",
  lane: "44444444-4444-4444-8444-444444444444",
  laneRevision: "55555555-5555-4555-8555-555555555555",
  persona: "66666666-6666-4666-8666-666666666666",
  audience: "77777777-7777-4777-8777-777777777777",
  connection: "88888888-8888-4888-8888-888888888888",
} as const;

const validPlan = {
  id: IDS.plan,
  workspaceId: IDS.workspace,
  campaignId: IDS.campaign,
  revision: 1,
  status: "draft" as const,
  objective: "Create qualified demand",
  kpi: "20 demo requests",
  startAt: 1_700_000_000_000,
  endAt: 1_700_604_800_000,
  audienceIds: [IDS.audience],
  pillars: ["GTM memory"],
  offers: ["Product demo"],
  ctas: ["Book a demo"],
  guidance: "Use customer evidence.",
  createdBy: null,
  createdAt: 1_700_000_000_000,
  activatedAt: null,
};

const validLane = {
  id: IDS.lane,
  workspaceId: IDS.workspace,
  campaignId: IDS.campaign,
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  status: "active" as const,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const validLaneRevision = {
  id: IDS.laneRevision,
  workspaceId: IDS.workspace,
  laneId: IDS.lane,
  planRevisionId: IDS.plan,
  personaId: IDS.persona,
  audienceId: IDS.audience,
  channel: "linkedin" as const,
  format: "linkedin_post",
  publishingConnectionId: IDS.connection,
  providerTarget: "feed",
  deliveryMode: "planned_and_reactive" as const,
  plannedQuantity: 2,
  schedule: {
    daysOfWeek: [2, 4],
    timeOfDay: "10:00",
    timezone: "Asia/Kolkata",
  },
  reactivePeriod: "week" as const,
  reactiveCap: 2,
  status: "active" as const,
  createdAt: 1_700_000_000_000,
};

describe("orchestration vocabularies", () => {
  it("defines campaign identity and the expanded lifecycle", () => {
    expect(CAMPAIGN_ORIGINS).toEqual(["user", "system"]);
    expect(CAMPAIGN_PURPOSES).toEqual(["initiative", "evergreen"]);
    expect(CAMPAIGN_STATUSES).toEqual(["draft", "active", "paused", "completed", "archived"]);
  });

  it("defines plan, delivery, source, and action vocabularies", () => {
    expect(PLAN_REVISION_STATUSES).toEqual(["draft", "active", "superseded"]);
    expect(DELIVERY_MODES).toEqual(["planned", "reactive", "planned_and_reactive"]);
    expect(PACKAGE_SOURCE_ROLES).toEqual([
      "trigger",
      "evidence",
      "inspiration",
      "instruction",
      "repurposed_from",
    ]);
    expect(DELIVERABLE_PRODUCTION_STATUSES).toContain("research_needed");
    expect(EXTERNAL_ACTION_KINDS).toEqual([
      "publish",
      "send",
      "reply",
      "paid_launch",
      "budget_change",
      "targeting_change",
    ]);
    expect(EXTERNAL_ACTION_STATUSES).toContain("authorization_required");
  });
});

describe("campaign plan and lane contracts", () => {
  it("parses an immutable campaign plan revision", () => {
    expect(campaignPlanRevisionSchema.parse(validPlan)).toEqual(validPlan);
  });

  it("keeps a stable lane identity separate from its revision", () => {
    expect(campaignLaneSchema.parse(validLane).id).toBe(IDS.lane);
    const parsed = campaignLaneRevisionSchema.parse(validLaneRevision);
    expect(parsed.laneId).toBe(IDS.lane);
    expect(parsed.id).not.toBe(parsed.laneId);
  });

  it("keeps the speaking persona separate from the target audience", () => {
    const parsed = campaignLaneRevisionSchema.parse(validLaneRevision);
    expect(parsed.personaId).toBe(IDS.persona);
    expect(parsed.audienceId).toBe(IDS.audience);
    expect(parsed.personaId).not.toBe(parsed.audienceId);
  });

  it("requires a schedule and quantity for planned delivery", () => {
    expect(
      campaignLaneRevisionSchema.safeParse({
        ...validLaneRevision,
        deliveryMode: "planned",
        schedule: null,
      }).success,
    ).toBe(false);
    expect(
      campaignLaneRevisionSchema.safeParse({
        ...validLaneRevision,
        deliveryMode: "planned",
        plannedQuantity: 0,
      }).success,
    ).toBe(false);
  });

  it("requires a positive cap for reactive delivery", () => {
    expect(
      campaignLaneRevisionSchema.safeParse({
        ...validLaneRevision,
        deliveryMode: "reactive",
        schedule: null,
        plannedQuantity: 0,
        reactiveCap: null,
      }).success,
    ).toBe(false);
  });
});

describe("orchestration state transitions", () => {
  it("allows a ready deliverable to begin generation", () => {
    expect(canTransitionDeliverable("ready", "generating")).toBe(true);
  });

  it("does not allow fulfilled work to become generating again", () => {
    expect(canTransitionDeliverable("fulfilled", "generating")).toBe(false);
  });

  it("allows authorized actions to be scheduled or dispatched", () => {
    expect(canTransitionExternalAction("authorized", "scheduled")).toBe(true);
    expect(canTransitionExternalAction("authorized", "dispatching")).toBe(true);
  });

  it("does not allow succeeded actions to return to scheduled", () => {
    expect(canTransitionExternalAction("succeeded", "scheduled")).toBe(false);
  });
});
