import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "@tuezday/contracts";
import {
  EXECUTION_KIND_LABELS,
  destinationSummary,
  emailDeliveryCopy,
  emailDeliveryWorkflowStatus,
  executionAuthorizationLink,
  executionTargetHref,
  executionWorkflowStatus,
} from "./execution-results";
import { CAMPAIGN_TABS, campaignTab } from "./campaign-control-plane";

function result(over: Partial<ExecutionResult>): ExecutionResult {
  return {
    kind: "publication",
    id: "11111111-1111-4111-8111-111111111111",
    title: "Post",
    channel: "linkedin",
    campaignId: null,
    campaignName: null,
    status: "completed",
    at: 0,
    url: null,
    error: null,
    platformStatus: null,
    destinations: { total: 1, succeeded: 1, failed: 0, skipped: 0, pending: 0 },
    draftId: null,
    ...over,
  };
}

describe("execution results view model", () => {
  it("maps result statuses onto the canonical workflow vocabulary per kind", () => {
    expect(executionWorkflowStatus(result({ status: "completed" }))).toBe("completed");
    expect(executionWorkflowStatus(result({ status: "partially_failed" }))).toBe(
      "partially_failed",
    );
    expect(executionWorkflowStatus(result({ status: "failed" }))).toBe("failed");
    expect(executionWorkflowStatus(result({ kind: "publication", status: "running" }))).toBe(
      "publishing",
    );
    expect(executionWorkflowStatus(result({ kind: "launch", status: "running" }))).toBe("sending");
    expect(executionWorkflowStatus(result({ kind: "ad_launch", status: "running" }))).toBe(
      "launching",
    );
    expect(executionWorkflowStatus(result({ kind: "ad_mutation", status: "running" }))).toBe(
      "launching",
    );
    expect(executionWorkflowStatus(result({ kind: "email_delivery", status: "running" }))).toBe(
      "sending",
    );
  });

  it("keeps provider acceptance separate from terminal email delivery", () => {
    expect(emailDeliveryWorkflowStatus("accepted")).toBe("sending");
    expect(emailDeliveryWorkflowStatus("delivered")).toBe("completed");
    expect(emailDeliveryWorkflowStatus("complained")).toBe("failed");
    expect(emailDeliveryCopy("accepted")).toContain("accepted by Resend");
    expect(emailDeliveryCopy("accepted")).not.toContain("delivered");
  });

  it("summarizes destinations listing successes and failures separately", () => {
    expect(
      destinationSummary(result({ destinations: { total: 1, succeeded: 1, failed: 0, skipped: 0, pending: 0 } })),
    ).toBe("1 sent");
    expect(
      destinationSummary(result({ destinations: { total: 6, succeeded: 3, failed: 2, skipped: 1, pending: 0 } })),
    ).toBe("3 sent · 2 failed · 1 skipped");
    expect(
      destinationSummary(result({ destinations: { total: 2, succeeded: 1, failed: 0, skipped: 0, pending: 1 } })),
    ).toBe("1 sent · 1 pending");
  });

  it("links each result to the surface that owns its recovery", () => {
    expect(executionTargetHref("ws1", result({ kind: "publication" }))).toBe(
      "/workspaces/ws1/content",
    );
    expect(
      executionTargetHref("ws1", result({ kind: "launch", id: "22222222-2222-4222-8222-222222222222" })),
    ).toBe("/workspaces/ws1/launches?launch=22222222-2222-4222-8222-222222222222");
    expect(executionTargetHref("ws1", result({ kind: "ad_launch" }))).toBe(
      "/workspaces/ws1/ad-launches",
    );
    expect(
      executionTargetHref(
        "ws1",
        result({ kind: "ad_mutation", actionKind: "budget_change" }),
      ),
    ).toBe("/workspaces/ws1/ad-launches");
    expect(executionTargetHref("ws1", result({ kind: "email_delivery" }))).toBe(
      "/workspaces/ws1/review?tab=authorizations",
    );
  });

  it("links zero, one, or many governing actions without inventing legacy data", () => {
    expect(executionAuthorizationLink("ws1", result({ externalActionIds: [] }))).toBeNull();
    expect(
      executionAuthorizationLink(
        "ws1",
        result({ externalActionIds: ["22222222-2222-4222-8222-222222222222"] }),
      ),
    ).toEqual({
      label: "View authorization",
      href: "/workspaces/ws1/review?tab=authorizations&action=22222222-2222-4222-8222-222222222222",
    });
    expect(
      executionAuthorizationLink(
        "ws1",
        result({
          campaignId: "33333333-3333-4333-8333-333333333333",
          externalActionIds: [
            "22222222-2222-4222-8222-222222222222",
            "44444444-4444-4444-8444-444444444444",
          ],
        }),
      ),
    ).toEqual({
      label: "View 2 actions",
      href: "/workspaces/ws1/review?tab=authorizations&campaign=33333333-3333-4333-8333-333333333333",
    });
  });

  it("labels every result kind", () => {
    expect(EXECUTION_KIND_LABELS.publication).toBe("Post");
    expect(EXECUTION_KIND_LABELS.launch).toBe("Targeted send");
    expect(EXECUTION_KIND_LABELS.ad_launch).toBe("Ad launch");
    expect(EXECUTION_KIND_LABELS.ad_mutation).toBe("Ad change");
    expect(EXECUTION_KIND_LABELS.email_delivery).toBe("Email");
  });

  it("adds the results tab to the campaign workspace", () => {
    expect(CAMPAIGN_TABS).toContain("results");
    expect(campaignTab("results")).toBe("results");
    expect(campaignTab("bogus")).toBe("overview");
  });
});
