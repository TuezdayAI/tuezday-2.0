import { describe, expect, it } from "vitest";
import type { ChatProposal } from "@tuezday/contracts";
import {
  isActionable,
  mergeProposal,
  pendingSummary,
  producedHref,
  proposalOutcome,
  proposalTone,
  proposalsForMessage,
  quarantineWarning,
  unattachedProposals,
} from "./chat-proposal-view";

// ---------------------------------------------------------------------------
// The confirmation card's copy (Sprint 78). This is the part that decides
// whether a founder understands what they just authorized, so it is tested as
// carefully as the gate behind it.
// ---------------------------------------------------------------------------

function proposal(overrides: Partial<ChatProposal> = {}): ChatProposal {
  return {
    id: "p-1",
    workspaceId: "ws-1",
    sessionId: "s-1",
    messageId: "m-1",
    agentRunId: "r-1",
    tool: "propose_draft",
    intent: {
      title: "Submit a linkedin draft for review",
      detail: [{ label: "Channel", value: "linkedin" }],
      effect: "It goes into your approval queue.",
      rationale: "You asked for a funding post.",
    },
    status: "pending",
    quarantined: false,
    quarantineReason: null,
    producedRef: null,
    producedStatus: null,
    error: null,
    errorMessage: null,
    confirmedByUserId: null,
    resolvedAt: null,
    createdAt: 1,
    ...overrides,
  } as ChatProposal;
}

describe("tone", () => {
  it("separates a quarantined pending card from an ordinary one", () => {
    expect(proposalTone(proposal())).toBe("pending");
    expect(proposalTone(proposal({ quarantined: true }))).toBe("quarantined");
  });

  it("follows the status once resolved, quarantine or not", () => {
    expect(proposalTone(proposal({ status: "confirmed", quarantined: true }))).toBe("confirmed");
    expect(proposalTone(proposal({ status: "declined" }))).toBe("declined");
    expect(proposalTone(proposal({ status: "failed" }))).toBe("failed");
  });

  it("keeps buttons only while it is pending", () => {
    expect(isActionable(proposal())).toBe(true);
    expect(isActionable(proposal({ status: "confirmed" }))).toBe(false);
  });
});

describe("outcome copy", () => {
  it("says where a confirmed thing WENT, not just that it was confirmed", () => {
    // The distinction the whole sprint rests on: confirming a publication
    // under `human_required` publishes nothing.
    expect(
      proposalOutcome(
        proposal({ status: "confirmed", producedStatus: "authorization_required", producedRef: "external_action:a-1" }),
      ),
    ).toBe("Confirmed — it's waiting for your authorization.");
    expect(
      proposalOutcome(
        proposal({ status: "confirmed", producedStatus: "pending_review", producedRef: "draft:d-1" }),
      ),
    ).toBe("Confirmed — it's in your approval queue.");
    expect(
      proposalOutcome(
        proposal({ status: "confirmed", producedStatus: "succeeded", producedRef: "external_action:a-1" }),
      ),
    ).toBe("Confirmed — it went out.");
  });

  it("passes a governed refusal through in the platform's own words", () => {
    expect(
      proposalOutcome(
        proposal({
          status: "failed",
          error: "reply_not_approved",
          errorMessage: "The reply draft has not cleared the approval queue.",
        }),
      ),
    ).toContain("has not cleared the approval queue");
  });

  it("says nothing under a pending card", () => {
    expect(proposalOutcome(proposal())).toBeNull();
  });

  it("names the founder's own decision when they declined", () => {
    expect(proposalOutcome(proposal({ status: "declined" }))).toBe("You declined this.");
  });
});

describe("the produced link", () => {
  it("sends the founder where the thing is actually governed", () => {
    expect(producedHref(proposal({ producedRef: "draft:d-1" }), "ws-1")).toBe(
      "/workspaces/ws-1/review?draft=d-1",
    );
    expect(producedHref(proposal({ producedRef: "external_action:a-1" }), "ws-1")).toBe(
      "/workspaces/ws-1/review?tab=authorizations&action=a-1",
    );
  });

  it("returns null rather than a link that lands somewhere wrong", () => {
    expect(producedHref(proposal(), "ws-1")).toBeNull();
    expect(producedHref(proposal({ producedRef: "nonsense" }), "ws-1")).toBeNull();
    expect(producedHref(proposal({ producedRef: "draft:" }), "ws-1")).toBeNull();
    expect(producedHref(proposal({ producedRef: "signal:s-1" }), "ws-1")).toBeNull();
  });
});

describe("the quarantine warning", () => {
  it("states the reason rather than a generic scare", () => {
    const warning = quarantineWarning(
      proposal({
        quarantined: true,
        quarantineReason: "This repeats wording taken verbatim from an outside page.",
      }),
    );
    expect(warning).toContain("Check this one carefully");
    expect(warning).toContain("verbatim from an outside page");
  });

  it("falls back to a plain sentence when the reason is missing", () => {
    expect(quarantineWarning(proposal({ quarantined: true }))).toContain("outside your workspace");
  });

  it("says nothing on a clean card", () => {
    expect(quarantineWarning(proposal())).toBeNull();
  });
});

describe("grouping", () => {
  it("hangs cards under the message that produced them", () => {
    const list = [proposal(), proposal({ id: "p-2", messageId: "m-2" })];
    expect(proposalsForMessage(list, { id: "m-1" })).toHaveLength(1);
    expect(proposalsForMessage(list, { id: "m-2" })[0]!.id).toBe("p-2");
  });

  it("finds the ones streamed before their message existed", () => {
    const list = [proposal(), proposal({ id: "p-2", messageId: null })];
    expect(unattachedProposals(list).map((p) => p.id)).toEqual(["p-2"]);
  });

  it("counts only what is still waiting on the founder", () => {
    expect(pendingSummary([])).toBeNull();
    expect(pendingSummary([proposal({ status: "confirmed" })])).toBeNull();
    expect(pendingSummary([proposal()])).toBe("1 thing is waiting for you to confirm.");
    expect(pendingSummary([proposal(), proposal({ id: "p-2" })])).toBe(
      "2 things are waiting for you to confirm.",
    );
  });
});

describe("merging a stream update", () => {
  it("replaces in place, so a confirmed card does not jump down the thread", () => {
    const list = [proposal(), proposal({ id: "p-2" })];
    const merged = mergeProposal(list, proposal({ status: "confirmed" }));
    expect(merged.map((p) => p.id)).toEqual(["p-1", "p-2"]);
    expect(merged[0]!.status).toBe("confirmed");
  });

  it("appends one it has not seen", () => {
    expect(mergeProposal([], proposal())).toHaveLength(1);
  });
});
