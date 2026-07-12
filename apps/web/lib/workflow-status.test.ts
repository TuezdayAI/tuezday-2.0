import { describe, expect, it } from "vitest";
import { workflowStatusView } from "./workflow-status";

describe("workflowStatusView", () => {
  it("combines contract metadata with a family icon", () => {
    expect(workflowStatusView("review_required")).toEqual({
      label: "Review required",
      family: "attention",
      icon: "warning",
    });
    expect(workflowStatusView("publishing")).toEqual({
      label: "Publishing",
      family: "progress",
      icon: "status-generating",
    });
    expect(workflowStatusView("approved")).toEqual({
      label: "Approved",
      family: "ready",
      icon: "status-approved",
    });
    expect(workflowStatusView("failed")).toEqual({
      label: "Failed",
      family: "blocked",
      icon: "status-rejected",
    });
    expect(workflowStatusView("paused")).toEqual({
      label: "Paused",
      family: "informational",
      icon: "info",
    });
  });
});
