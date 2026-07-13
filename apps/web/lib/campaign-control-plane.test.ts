import { describe, expect, it } from "vitest";
import {
  campaignStatus,
  campaignMutationResult,
  campaignTab,
  dateOnlyToTimestamp,
  editablePlan,
  formatLaneSchedule,
  laneStatus,
  orderCampaignInventory,
  planStatus,
  timestampToDateOnly,
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

  it("round-trips date-only values in a positive UTC offset", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const dateOnly = "2026-07-13";
      const timestamp = dateOnlyToTimestamp(dateOnly);
      expect(new Date(timestamp!).getTimezoneOffset()).toBe(-330);
      expect(timestampToDateOnly(timestamp)).toBe(dateOnly);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("maps empty date values to the nullable timestamp contract", () => {
    expect(dateOnlyToTimestamp("")).toBeNull();
    expect(timestampToDateOnly(null)).toBe("");
  });

  it("stably orders active campaigns before every other status", () => {
    const campaigns = [
      { id: "archived-1", status: "archived" },
      { id: "active-1", status: "active" },
      { id: "paused-1", status: "paused" },
      { id: "active-2", status: "active" },
      { id: "draft-1", status: "draft" },
      { id: "archived-2", status: "archived" },
    ] as never;

    expect(orderCampaignInventory(campaigns).map((campaign) => campaign.id)).toEqual([
      "active-1",
      "active-2",
      "archived-1",
      "paused-1",
      "draft-1",
      "archived-2",
    ]);
  });

  it("turns rejected campaign mutations into the existing error message contract", async () => {
    await expect(
      campaignMutationResult(
        () => Promise.reject(new Error("network unavailable")),
        "Could not update the campaign status.",
      ),
    ).resolves.toEqual({ ok: false, message: "Could not update the campaign status." });
  });
});
