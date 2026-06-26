import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS, setAnalyticsOptOutInputSchema } from "../src/index";

describe("analytics contracts", () => {
  it("enumerates the five funnel events", () => {
    expect(ANALYTICS_EVENTS).toEqual([
      "user.registered",
      "generation.created",
      "draft.approved",
      "draft.published",
      "connection.connected",
    ]);
  });
  it("validates the opt-out toggle", () => {
    expect(setAnalyticsOptOutInputSchema.parse({ optOut: true })).toEqual({ optOut: true });
    expect(setAnalyticsOptOutInputSchema.safeParse({ optOut: "yes" }).success).toBe(false);
  });
});
