import { describe, expect, it } from "vitest";
import type { Draft } from "@tuezday/contracts";
import {
  draftChannels,
  draftWorkflowStatus,
  filterDrafts,
  inboxWorkflowStatus,
  queueNeighbors,
  reviewHref,
  reviewTab,
} from "./review-workspace";

function draft(overrides: Partial<Draft>): Draft {
  return {
    id: "d1",
    workspaceId: "w1",
    sourceGenerationId: null,
    sourceSignalId: null,
    campaignId: null,
    leadId: null,
    mediaContactId: null,
    taskType: "linkedin_post",
    channel: "linkedin",
    personaId: null,
    originalContent: "x",
    content: "x",
    state: "pending_review",
    media: null,
    createdAt: 1,
    updatedAt: 1,
    review: null,
    ...overrides,
  } as Draft;
}

describe("review workspace view model", () => {
  it("parses the tab param with a safe default", () => {
    expect(reviewTab("inbox")).toBe("inbox");
    expect(reviewTab("approvals")).toBe("approvals");
    expect(reviewTab("authorizations")).toBe("authorizations");
    expect(reviewTab("nonsense")).toBe("approvals");
    expect(reviewTab(null)).toBe("approvals");
  });

  it("builds canonical review links", () => {
    expect(reviewHref("w1")).toBe("/workspaces/w1/review");
    expect(reviewHref("w1", { tab: "inbox" })).toBe("/workspaces/w1/review?tab=inbox");
    expect(reviewHref("w1", { tab: "approvals", campaign: "c9" })).toBe(
      "/workspaces/w1/review?tab=approvals&campaign=c9",
    );
    expect(reviewHref("w1", {
      tab: "approvals",
      campaign: "c1",
      state: "pending_review",
      channel: "linkedin",
      draft: "d1",
    })).toBe(
      "/workspaces/w1/review?tab=approvals&campaign=c1&state=pending_review&channel=linkedin&draft=d1",
    );
  });

  it("builds authorization queue links preserving filters and selection", () => {
    expect(reviewHref("ws", { tab: "authorizations", campaign: "c", action: "a" })).toBe(
      "/workspaces/ws/review?tab=authorizations&campaign=c&action=a",
    );
    expect(
      reviewHref("w1", {
        tab: "authorizations",
        campaign: "c1",
        kind: "publish",
        status: "authorization_required",
        action: "a1",
      }),
    ).toBe(
      "/workspaces/w1/review?tab=authorizations&campaign=c1&kind=publish&status=authorization_required&action=a1",
    );
  });

  it("maps approval states onto the canonical workflow vocabulary", () => {
    expect(draftWorkflowStatus("draft")).toBe("draft");
    expect(draftWorkflowStatus("pending_review")).toBe("review_required");
    expect(draftWorkflowStatus("edited")).toBe("changes_requested");
    expect(draftWorkflowStatus("approved")).toBe("approved");
    expect(draftWorkflowStatus("rejected")).toBe("rejected");
  });

  it("maps inbox statuses onto the canonical workflow vocabulary", () => {
    expect(inboxWorkflowStatus("unread")).toBe("review_required");
    expect(inboxWorkflowStatus("read")).toBe("review_required");
    expect(inboxWorkflowStatus("replied")).toBe("completed");
    expect(inboxWorkflowStatus("dismissed")).toBe("archived");
  });

  it("filters drafts by state, campaign, and channel together", () => {
    const drafts = [
      draft({ id: "a", campaignId: "c1", channel: "linkedin" }),
      draft({ id: "b", campaignId: "c1", channel: "email", state: "approved" }),
      draft({ id: "c", campaignId: null, channel: "linkedin" }),
    ];
    expect(
      filterDrafts(drafts, { state: "pending_review", campaignId: "c1", channel: "all" }).map(
        (d) => d.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterDrafts(drafts, { state: "all", campaignId: "all", channel: "linkedin" }).map(
        (d) => d.id,
      ),
    ).toEqual(["a", "c"]);
    expect(filterDrafts(drafts, { state: "all", campaignId: "all", channel: "all" })).toHaveLength(
      3,
    );
  });

  it("lists distinct channels in first-seen order", () => {
    const drafts = [
      draft({ id: "a", channel: "linkedin" }),
      draft({ id: "b", channel: "email" }),
      draft({ id: "c", channel: "linkedin" }),
    ];
    expect(draftChannels(drafts)).toEqual(["linkedin", "email"]);
  });

  it("finds queue neighbors and handles the edges", () => {
    expect(queueNeighbors(["a", "b", "c"], "b")).toEqual({ prev: "a", next: "c" });
    expect(queueNeighbors(["a", "b", "c"], "a")).toEqual({ prev: null, next: "b" });
    expect(queueNeighbors(["a", "b", "c"], "c")).toEqual({ prev: "b", next: null });
    expect(queueNeighbors(["a"], "missing")).toEqual({ prev: null, next: null });
  });
});
