import { describe, expect, it } from "vitest";
import type { AgentProposal, ExternalAction } from "@tuezday/contracts";
import {
  actionOriginHref,
  actionOriginLabel,
  isAgentOriginated,
} from "./external-actions";
import {
  proposalHref,
  proposalLine,
  proposalResolved,
  proposalTone,
  proposalsSummary,
} from "./agent-proposals-view";

const RUN_ID = "99999999-9999-4999-8999-999999999999";

function action(overrides: Partial<ExternalAction> = {}): ExternalAction {
  return {
    id: "action-1",
    workspaceId: "ws-1",
    kind: "publish",
    status: "authorization_required",
    subject: {
      kind: "draft",
      id: "draft-1",
      title: "Pricing post",
      summary: "The approved post.",
      channel: "linkedin",
      destination: "Founder account",
    },
    context: {
      campaignId: null,
      campaignName: null,
      personaId: null,
      personaName: null,
      connectionId: null,
      connectionName: null,
      laneRevisionId: null,
      laneName: null,
    },
    requestedFor: null,
    idempotencyKey: "k",
    fingerprint: "a".repeat(64),
    policy: { effective: "human_required", contributingRules: [] },
    blocker: null,
    supersedesActionId: null,
    supersededByActionId: null,
    execution: null,
    proposedBy: { userId: null, label: "system" },
    origin: "system",
    originRunId: null,
    createdAt: 1,
    updatedAt: 1,
    authorizedAt: null,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  } as ExternalAction;
}

function proposal(overrides: Partial<AgentProposal> = {}): AgentProposal {
  return {
    id: "p-1",
    workspaceId: "ws-1",
    agentRunId: RUN_ID,
    tool: "propose_draft",
    targetKind: "draft",
    draftId: "draft-1",
    externalActionId: null,
    summary: "Submitted a linkedin draft for review.",
    rationale: "The competitor moved to usage-based pricing.",
    createdAt: 1,
    ...overrides,
  } as AgentProposal;
}

describe("action origin (Sprint 69)", () => {
  it("tells the three origins apart, which the actor label cannot", () => {
    // A cadence and an agent both arrive with no user id and a "system"-ish
    // label; only the typed origin separates them.
    expect(actionOriginLabel(action())).toBe("Proposed automatically");
    expect(actionOriginLabel(action({ origin: "agent", originRunId: RUN_ID }))).toBe(
      "Proposed by an agent",
    );
    expect(
      actionOriginLabel(action({ origin: "human", proposedBy: { userId: "u-1", label: "Founder" } })),
    ).toBe("Proposed by you");
  });

  it("badges only agent-originated actions", () => {
    expect(isAgentOriginated(action())).toBe(false);
    expect(isAgentOriginated(action({ origin: "agent", originRunId: RUN_ID }))).toBe(true);
  });

  it("links straight to the run that asked for it", () => {
    expect(actionOriginHref("ws-1", action())).toBeNull();
    expect(actionOriginHref("ws-1", action({ origin: "agent", originRunId: RUN_ID }))).toBe(
      `/workspaces/ws-1/inspector?run=${RUN_ID}`,
    );
  });
});

describe("proposal trace (Sprint 69)", () => {
  it("shows both what it did and why, because either alone is useless", () => {
    expect(proposalLine(proposal())).toBe(
      "Submitted a linkedin draft for review. — “The competitor moved to usage-based pricing.”",
    );
  });

  it("marks a proposal whose target is gone rather than hiding it", () => {
    expect(proposalResolved(proposal())).toBe(true);
    expect(proposalTone(proposal())).toBe("neutral");
    const orphaned = proposal({ draftId: null });
    expect(proposalResolved(orphaned)).toBe(false);
    expect(proposalTone(orphaned)).toBe("draft");
    expect(proposalHref("ws-1", orphaned)).toBeNull();
  });

  it("sends the founder to wherever the thing is actually governed", () => {
    expect(proposalHref("ws-1", proposal())).toBe("/workspaces/ws-1/review?draft=draft-1");
    expect(
      proposalHref(
        "ws-1",
        proposal({ targetKind: "external_action", draftId: null, externalActionId: "a-1" }),
      ),
    ).toBe("/workspaces/ws-1/review?tab=authorizations&action=a-1");
  });

  it("summarises a run's proposals honestly, including none", () => {
    expect(proposalsSummary([])).toBe("Proposed nothing.");
    expect(proposalsSummary([proposal()])).toBe("1 proposal · 1 still available to act on");
    expect(proposalsSummary([proposal(), proposal({ id: "p-2", draftId: null })])).toBe(
      "2 proposals · 1 still available to act on",
    );
  });
});
