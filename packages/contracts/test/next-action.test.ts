import { describe, expect, it } from "vitest";
import {
  nextActionFor,
  checklistProgress,
  nextActionStateSchema,
  type NextActionState,
} from "../src/index.js";

const base: NextActionState = {
  draftCount: 0,
  blockedPublishCount: 0,
  liveCampaignsWithoutContent: 0,
  insightsAvailableUnconnected: false,
  generatingCount: 0,
  checklist: {
    brain_reviewed: true,
    channel_connected: true,
    first_campaign: true,
    first_approval: true,
    insights_live: true,
    team_invited: true,
  },
};

describe("nextActionFor — spec §5.1 priority order", () => {
  it("1: drafts waiting for review win over everything", () => {
    const action = nextActionFor({ ...base, draftCount: 3, blockedPublishCount: 2 });
    expect(action).toMatchObject({ kind: "review", module: "/approvals" });
    expect(action.reason).toBe("3 drafts waiting for review");
  });
  it("uses singular copy for one draft", () => {
    expect(nextActionFor({ ...base, draftCount: 1 }).reason).toBe("1 draft waiting for review");
  });
  it("2: blocked publish points at Integrations", () => {
    const action = nextActionFor({ ...base, blockedPublishCount: 1, liveCampaignsWithoutContent: 2 });
    expect(action).toMatchObject({ kind: "connect_blocked", module: "/connectors" });
  });
  it("3: live campaign without content points at Campaigns", () => {
    const action = nextActionFor({ ...base, liveCampaignsWithoutContent: 1, insightsAvailableUnconnected: true });
    expect(action).toMatchObject({ kind: "campaign_content", module: "/campaigns" });
  });
  it("4: unconnected insights points at Integrations", () => {
    const action = nextActionFor({ ...base, insightsAvailableUnconnected: true });
    expect(action).toMatchObject({ kind: "connect_insights", module: "/connectors" });
  });
  it("5: first incomplete checklist item, in fixed order", () => {
    const action = nextActionFor({
      ...base,
      checklist: { ...base.checklist, channel_connected: false, team_invited: false },
    });
    expect(action).toMatchObject({ kind: "checklist", checklistItem: "channel_connected", module: "/connectors" });
  });
  it("system-working: nothing user-actionable but generating", () => {
    const action = nextActionFor({ ...base, generatingCount: 3 });
    expect(action).toMatchObject({ kind: "system_working", module: "" });
    expect(action.reason).toContain("3");
  });
  it("none: all clear", () => {
    expect(nextActionFor(base)).toMatchObject({ kind: "none", module: "" });
  });
  it("exactly one action always — never throws, never undefined", () => {
    const parsed = nextActionStateSchema.parse(base);
    expect(nextActionFor(parsed).kind).toBeDefined();
  });
});

describe("checklistProgress", () => {
  it("counts done items", () => {
    expect(checklistProgress({ ...base, checklist: { ...base.checklist, team_invited: false } }))
      .toEqual({ done: 5, total: 6, complete: false });
    expect(checklistProgress(base)).toEqual({ done: 6, total: 6, complete: true });
  });
});
