import { describe, expect, it } from "vitest";
import type { ExternalAction } from "@tuezday/contracts";
import {
  actionKindLabel,
  actionRecoveryHref,
  actionTimingLabel,
  externalActionWorkflowStatus,
  filterActions,
  impactSummary,
  policyExplanation,
} from "./external-actions";

function action(overrides: Partial<ExternalAction> = {}): ExternalAction {
  return {
    id: "a1",
    workspaceId: "w1",
    kind: "publish",
    status: "authorization_required",
    subject: {
      kind: "draft",
      id: "d1",
      title: "Launch post",
      summary: "Body.",
      channel: "linkedin",
      destination: "Founder LinkedIn · feed",
    },
    context: {
      campaignId: "c1",
      campaignName: "Summer push",
      personaId: null,
      personaName: null,
      connectionId: "conn1",
      connectionName: "Founder LinkedIn",
      laneRevisionId: null,
      laneName: null,
    },
    requestedFor: null,
    idempotencyKey: "k1",
    fingerprint: "f".repeat(64),
    policy: {
      effective: "human_required",
      contributingRules: [
        { scope: "workspace", scopeId: "w1", scopeLabel: "Acme", rule: "human_required" },
        { scope: "campaign", scopeId: "c1", scopeLabel: "Summer push", rule: "human_required" },
        { scope: "connection", scopeId: "conn1", scopeLabel: "Founder LinkedIn", rule: "inherit" },
      ],
    },
    blocker: null,
    supersedesActionId: null,
    supersededByActionId: null,
    execution: null,
    proposedBy: { userId: null, label: "system" },
    createdAt: 100,
    updatedAt: 100,
    authorizedAt: null,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  } as ExternalAction;
}

describe("external action view model", () => {
  it("maps every lifecycle state onto the canonical workflow vocabulary", () => {
    expect(externalActionWorkflowStatus(action({ status: "proposed" }))).toBe("scheduling");
    expect(externalActionWorkflowStatus(action({ status: "authorization_required" }))).toBe(
      "authorization_required",
    );
    expect(externalActionWorkflowStatus(action({ status: "authorized" }))).toBe("authorized");
    expect(externalActionWorkflowStatus(action({ status: "scheduled" }))).toBe("scheduled");
    expect(externalActionWorkflowStatus(action({ status: "dispatching" }))).toBe("publishing");
    expect(
      externalActionWorkflowStatus(action({ status: "dispatching", kind: "send" })),
    ).toBe("sending");
    expect(
      externalActionWorkflowStatus(action({ status: "dispatching", kind: "reply" })),
    ).toBe("sending");
    expect(
      externalActionWorkflowStatus(action({ status: "dispatching", kind: "paid_launch" })),
    ).toBe("launching");
    expect(externalActionWorkflowStatus(action({ status: "succeeded" }))).toBe("completed");
    expect(externalActionWorkflowStatus(action({ status: "failed" }))).toBe("failed");
    expect(externalActionWorkflowStatus(action({ status: "blocked" }))).toBe("policy_blocked");
    expect(externalActionWorkflowStatus(action({ status: "stale" }))).toBe("stale");
    expect(externalActionWorkflowStatus(action({ status: "cancelled" }))).toBe("rejected");
  });

  it("labels every action kind for humans", () => {
    expect(actionKindLabel("publish")).toBe("Publish");
    expect(actionKindLabel("send")).toBe("Send");
    expect(actionKindLabel("reply")).toBe("Reply");
    expect(actionKindLabel("paid_launch")).toBe("Paid launch");
    expect(actionKindLabel("budget_change")).toBe("Budget change");
    expect(actionKindLabel("targeting_change")).toBe("Targeting change");
  });

  it("explains the effective policy including campaign overrides", () => {
    const explanation = policyExplanation(action());
    expect(explanation).toContain("human decision");
    expect(explanation).toContain("Campaign override");
    expect(explanation).toContain("Summer push");
    expect(explanation).not.toContain("inherit"); // inherit rules add nothing

    const autonomous = policyExplanation(
      action({
        policy: {
          effective: "autonomous",
          contributingRules: [
            { scope: "workspace", scopeId: "w1", scopeLabel: "Acme", rule: "autonomous" },
          ],
        },
      }),
    );
    expect(autonomous).toContain("autonomous");
    expect(autonomous).toContain("Workspace default");
  });

  it("summarizes exactly what goes out where and when", () => {
    expect(impactSummary(action())).toBe(
      "Publish “Launch post” to Founder LinkedIn · feed, immediately once authorized.",
    );
    const timed = action({ requestedFor: Date.UTC(2026, 6, 20, 9, 0) });
    expect(impactSummary(timed)).toBe(
      `Publish “Launch post” to Founder LinkedIn · feed, at ${new Date(
        Date.UTC(2026, 6, 20, 9, 0),
      ).toLocaleString()}.`,
    );
    expect(actionTimingLabel(action())).toBe("Immediately once authorized");
    expect(actionTimingLabel(timed)).toBe(
      new Date(Date.UTC(2026, 6, 20, 9, 0)).toLocaleString(),
    );
  });

  it("routes recovery to the owning surface per subject kind", () => {
    expect(actionRecoveryHref(action({ status: "stale" }))).toBe(
      "/workspaces/w1/review?tab=approvals&draft=d1",
    );
    expect(
      actionRecoveryHref(
        action({
          kind: "reply",
          status: "stale",
          subject: { ...action().subject, kind: "inbox_item", id: "i1" },
        }),
      ),
    ).toBe("/workspaces/w1/review?tab=inbox");
    expect(
      actionRecoveryHref(
        action({
          kind: "send",
          status: "blocked",
          subject: { ...action().subject, kind: "launch_message", id: "m1" },
        }),
      ),
    ).toBe("/workspaces/w1/launches");
    expect(
      actionRecoveryHref(
        action({
          kind: "paid_launch",
          status: "blocked",
          subject: { ...action().subject, kind: "ad_launch", id: "l1" },
        }),
      ),
    ).toBe("/workspaces/w1/ad-launches");
  });

  it("filters by status, kind, and campaign together", () => {
    const actions = [
      action({ id: "a" }),
      action({ id: "b", status: "blocked", blocker: { code: "x", message: "m", retryable: true } }),
      action({ id: "c", kind: "send", context: { ...action().context, campaignId: null } }),
    ];
    expect(
      filterActions(actions, { status: "authorization_required", kind: "all", campaignId: "all" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "c"]);
    expect(
      filterActions(actions, { status: "all", kind: "publish", campaignId: "c1" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b"]);
    expect(filterActions(actions, { status: "all", kind: "all", campaignId: "all" })).toHaveLength(3);
  });
});
