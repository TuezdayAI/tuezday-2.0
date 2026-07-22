import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  WORKFLOW_STATUSES,
  WORKFLOW_STATUS_META,
  workflowStatusSchema,
} from "../src/index.js";

describe("workflow status contract", () => {
  it("defines every approved status exactly once", () => {
    expect(WORKFLOW_STATUSES).toEqual([
      "draft",
      "review_required",
      "authorization_required",
      "changes_requested",
      "generating",
      "regenerating",
      "scheduling",
      "publishing",
      "sending",
      "launching",
      "approved",
      "rejected",
      "authorized",
      "scheduled",
      "active",
      "connected",
      "completed",
      "setup_required",
      "connection_lost",
      "policy_blocked",
      "partially_failed",
      "failed",
      "stale",
      "paused",
      "superseded",
      "archived",
      "experimental",
    ]);
    expect(Object.keys(WORKFLOW_STATUS_META)).toEqual([...WORKFLOW_STATUSES]);
  });

  it("gives every status a human label and approved family", () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(workflowStatusSchema.parse(status)).toBe(status);
      expect(WORKFLOW_STATUS_META[status].label.length).toBeGreaterThan(2);
      expect(["attention", "progress", "ready", "blocked", "informational"]).toContain(
        WORKFLOW_STATUS_META[status].family,
      );
    }
  });

  it("keeps partial failure blocked and scheduled ready", () => {
    expect(WORKFLOW_STATUS_META.partially_failed.family).toBe("blocked");
    expect(WORKFLOW_STATUS_META.scheduled.family).toBe("ready");
  });

  it("registers the golden-loop analytics vocabulary", () => {
    expect(ANALYTICS_EVENTS).toEqual(
      expect.arrayContaining([
        "home.next_action_opened",
        "campaign.context_opened",
        "review.item_opened",
        "review.revision_requested",
        "review.content_decided",
        "review.action_authorized",
        "calendar.item_scheduled",
        "execution.result_viewed",
      ]),
    );
  });
});
