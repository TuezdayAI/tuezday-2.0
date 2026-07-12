import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS, setAnalyticsOptOutInputSchema } from "../src/index";

describe("analytics contracts", () => {
  it("enumerates the curated product and workflow events", () => {
    expect(ANALYTICS_EVENTS).toEqual([
      "user.registered",
      "generation.created",
      "draft.approved",
      "draft.published",
      "connector.connected",
      "publication.started",
      "home.next_action_opened",
      "campaign.context_opened",
      "review.item_opened",
      "review.revision_requested",
      "review.content_decided",
      "review.action_authorized",
      "calendar.item_scheduled",
      "execution.result_viewed",
    ]);
  });
  it("validates the opt-out toggle", () => {
    expect(setAnalyticsOptOutInputSchema.parse({ optOut: true })).toEqual({ optOut: true });
    expect(setAnalyticsOptOutInputSchema.safeParse({ optOut: "yes" }).success).toBe(false);
  });
});
