import { describe, expect, it } from "vitest";
import {
  campaignStatus,
  campaignTab,
  editablePlan,
  formatLaneSchedule,
  laneStatus,
  planStatus,
} from "./campaign-control-plane";

describe("campaign control plane presentation", () => {
  it("normalizes route tabs", () => {
    expect(campaignTab("plan")).toBe("plan");
    expect(campaignTab("unknown")).toBe("overview");
    expect(campaignTab(null)).toBe("overview");
  });

  it("maps domain states to canonical workflow states", () => {
    expect(campaignStatus("active")).toBe("active");
    expect(campaignStatus("draft")).toBe("draft");
    expect(planStatus("superseded")).toBe("superseded");
    expect(laneStatus("paused")).toBe("paused");
    expect(laneStatus("retired")).toBe("archived");
  });

  it("selects only a draft plan for editing", () => {
    expect(
      editablePlan([{ plan: { status: "active" } }, { plan: { status: "draft" } }] as never)?.plan
        .status,
    ).toBe("draft");
    expect(editablePlan([{ plan: { status: "active" } }] as never)).toBeNull();
  });

  it("formats planned and reactive delivery without backend terminology", () => {
    expect(
      formatLaneSchedule({
        deliveryMode: "planned",
        plannedQuantity: 3,
        schedule: { daysOfWeek: [1, 3, 5], timeOfDay: "09:30", timezone: "Asia/Kolkata" },
        reactivePeriod: null,
        reactiveCap: null,
      }),
    ).toBe("3 planned · Mon, Wed, Fri · 09:30 · Asia/Kolkata");
    expect(
      formatLaneSchedule({
        deliveryMode: "reactive",
        plannedQuantity: 0,
        schedule: null,
        reactivePeriod: "week",
        reactiveCap: 2,
      }),
    ).toBe("Up to 2 reactive / week");
  });
});
