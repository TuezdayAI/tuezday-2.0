import { describe, expect, it } from "vitest";
import type { PriorityItem, PriorityQueue } from "@tuezday/contracts";
import { priorityQueueState, priorityView } from "./priorities";

function item(over: Partial<PriorityItem>): PriorityItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "authorization",
    status: "authorization_required",
    title: "Publish launch note",
    reason: "Waiting for your authorization.",
    consequence: "Nothing reaches the destination until you decide.",
    href: "/workspaces/ws1/review?tab=authorizations&action=a1",
    campaignId: null,
    campaignName: null,
    dueAt: null,
    createdAt: 1,
    ...over,
  };
}

describe("Home priority view model", () => {
  it("maps every priority kind to a stable label, icon, and CTA", () => {
    expect(priorityView(item({ kind: "execution_failure", status: "failed" }))).toMatchObject({
      label: "Execution failed",
      icon: "status-rejected",
      cta: "Resolve failure",
      status: "failed",
    });
    expect(priorityView(item({ kind: "stale_action", status: "stale" }))).toMatchObject({
      label: "Action is stale",
      icon: "warning",
      cta: "Review stale action",
    });
    expect(priorityView(item({ kind: "policy_block", status: "policy_blocked" }))).toMatchObject({
      label: "Action blocked",
      icon: "warning",
      cta: "Resolve blocker",
    });
    expect(priorityView(item({ kind: "authorization" }))).toMatchObject({
      label: "Authorization required",
      icon: "status-review",
      cta: "Open authorization",
    });
    expect(priorityView(item({ kind: "content_review", status: "review_required" }))).toMatchObject({
      label: "Content review",
      icon: "review",
      cta: "Review content",
    });
    expect(priorityView(item({ kind: "signal_triage", status: "review_required" }))).toMatchObject({
      label: "Signal needs review",
      icon: "signal",
      cta: "Review signal",
    });
    expect(priorityView(item({ kind: "learning_review", status: "review_required" }))).toMatchObject({
      label: "Learning review",
      icon: "status-learning",
      cta: "Review learning",
    });
    expect(priorityView(item({ kind: "connection_health", status: "connection_lost" }))).toMatchObject({
      label: "Connection lost",
      icon: "connection-lost",
      cta: "Reconnect",
    });
    expect(priorityView(item({ kind: "campaign_risk", status: "failed" }))).toMatchObject({
      label: "Campaign risk",
      icon: "campaign-risk",
      cta: "Review campaign",
    });
  });

  it("preserves the server-ranked recovery href and canonical status", () => {
    const priority = item({ href: "/recover-here", status: "partially_failed" });
    expect(priorityView(priority)).toMatchObject({ href: "/recover-here", status: "partially_failed" });
  });

  it("distinguishes attention from the honest all-clear state", () => {
    const empty: PriorityQueue = { items: [], generatedAt: 10 };
    expect(priorityQueueState(empty)).toBe("all_clear");
    expect(priorityQueueState({ ...empty, items: [item({})] })).toBe("attention");
  });
});
