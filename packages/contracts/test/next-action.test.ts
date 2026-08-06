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

describe("nextActionFor — the setup answer only (Sprint 70, D-70.9)", () => {
  /**
   * Sprint 70 deleted the four branches that ranked *work*. They were the other
   * half of atlas conflict #7: each re-derived from raw counts something the
   * agent inbox already computes as a ranked item with a reason, and the two
   * could disagree in front of the founder. These assertions are the proof the
   * duplication is gone, not a regression.
   */
  it("no longer answers for work the inbox ranks", () => {
    const busy: NextActionState = {
      ...base,
      draftCount: 3,
      blockedPublishCount: 2,
      liveCampaignsWithoutContent: 1,
      insightsAvailableUnconnected: true,
    };
    // Setup complete and nothing generating: the setup answer is "all clear",
    // and the drafts/blocks/campaigns show up in the inbox instead.
    expect(nextActionFor(busy)).toMatchObject({ kind: "none", module: "" });
    for (const kind of ["review", "connect_blocked", "campaign_content", "connect_insights"]) {
      expect(nextActionFor(busy).kind).not.toBe(kind);
    }
  });
  it("work never outranks an unmet setup step any more", () => {
    const action = nextActionFor({
      ...base,
      draftCount: 5,
      checklist: { ...base.checklist, channel_connected: false },
    });
    expect(action).toMatchObject({ kind: "checklist", checklistItem: "channel_connected" });
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
