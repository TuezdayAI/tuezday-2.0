import { describe, expect, it } from "vitest";
import type { AuthorizationBatchDetail, ExternalAction } from "@tuezday/contracts";
import {
  authorizationBatchSummary,
  campaignBatchSelection,
  selectedAuthorizationIds,
} from "./authorization-batch";

function action(id: string, status: ExternalAction["status"] = "authorization_required") {
  return { id, status } as ExternalAction;
}

describe("authorization batch view model", () => {
  it("builds a campaign preview selection with an optional non-empty kind subset", () => {
    expect(
      campaignBatchSelection("5bb87ab1-9d54-4f20-a91d-0dc30f917b31", ["publish", "send"]),
    ).toEqual({
      mode: "campaign",
      campaignId: "5bb87ab1-9d54-4f20-a91d-0dc30f917b31",
      kinds: ["publish", "send"],
    });
    expect(campaignBatchSelection("5bb87ab1-9d54-4f20-a91d-0dc30f917b31", null)).toEqual({
      mode: "campaign",
      campaignId: "5bb87ab1-9d54-4f20-a91d-0dc30f917b31",
      kinds: null,
    });
    expect(() => campaignBatchSelection("campaign", [])).toThrow(/at least one action kind/i);
  });

  it("returns only explicitly selected authorization-required actions in queue order", () => {
    const actions = [action("a"), action("blocked", "blocked"), action("b"), action("c")];
    expect(selectedAuthorizationIds(actions, new Set(["b", "blocked", "a"]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("rejects explicit batches above the 25-action limit", () => {
    const actions = Array.from({ length: 26 }, (_, index) => action(`action-${index}`));
    expect(() => selectedAuthorizationIds(actions, new Set(actions.map((item) => item.id)))).toThrow(
      /25/,
    );
  });

  it("summarizes preview exclusions and partial terminal outcomes honestly", () => {
    const detail = {
      batch: {
        status: "partially_completed",
        includedCount: 3,
        excludedCount: 1,
        continuationCount: 0,
      },
      items: [
        { eligible: true, status: "succeeded" },
        { eligible: true, status: "scheduled" },
        { eligible: true, status: "failed" },
        { eligible: false, status: "skipped" },
      ],
    } as AuthorizationBatchDetail;

    expect(authorizationBatchSummary(detail)).toEqual({
      included: 3,
      excluded: 1,
      pending: 0,
      succeeded: 1,
      scheduled: 1,
      failed: 1,
      blocked: 0,
      stale: 0,
      isPartial: true,
    });
  });
});
