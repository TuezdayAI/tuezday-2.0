import { describe, expect, it } from "vitest";
import {
  campaignLaneRevisionViewSchema,
  campaignPlanWorkspaceSchema,
} from "../src/index.js";

const plan = {
  id: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  campaignId: "10000000-0000-4000-8000-000000000003",
  revision: 2,
  status: "draft",
  objective: "Create qualified demand",
  kpi: "20 demos",
  timeframe: "Q3 2026",
  startAt: null,
  endAt: null,
  audienceIds: [],
  pillars: ["GTM memory"],
  offers: ["Demo"],
  ctas: ["Book a demo"],
  guidance: "Use evidence.",
  createdBy: null,
  createdAt: 1,
  activatedAt: null,
} as const;

const lane = {
  id: "20000000-0000-4000-8000-000000000001",
  workspaceId: plan.workspaceId,
  laneId: "20000000-0000-4000-8000-000000000002",
  planRevisionId: plan.id,
  key: "founder-linkedin",
  name: "Founder LinkedIn",
  personaId: "20000000-0000-4000-8000-000000000003",
  audienceId: null,
  channel: "linkedin",
  format: "linkedin_post",
  publishingConnectionId: null,
  providerTarget: "",
  deliveryMode: "planned",
  plannedQuantity: 3,
  schedule: { daysOfWeek: [1, 3, 5], timeOfDay: "09:30", timezone: "Asia/Kolkata" },
  reactivePeriod: null,
  reactiveCap: null,
  status: "active",
  createdAt: 1,
} as const;

describe("campaign workspace contracts", () => {
  it("adds stable lane identity to a lane revision", () => {
    expect(campaignLaneRevisionViewSchema.parse(lane)).toMatchObject({
      key: "founder-linkedin",
      name: "Founder LinkedIn",
    });
  });

  it("validates revision history and configuration issues", () => {
    const result = campaignPlanWorkspaceSchema.parse({
      currentPlanRevisionId: null,
      revisions: [{ plan, lanes: [lane] }],
      issues: [{
        path: "channels.email",
        code: "execution_mapping_missing",
        message: "Choose an execution mapping for email.",
      }],
    });
    expect(result.revisions[0]?.lanes[0]?.name).toBe("Founder LinkedIn");
    expect(result.issues[0]?.code).toBe("execution_mapping_missing");
  });
});
