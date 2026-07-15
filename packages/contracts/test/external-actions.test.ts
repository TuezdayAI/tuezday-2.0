import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTION_DECISIONS,
  EXTERNAL_ACTION_EXECUTION_KINDS,
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_POLICY_RULES,
  EXTERNAL_ACTION_POLICY_SCOPES,
  EXTERNAL_ACTION_STATUSES,
  EXTERNAL_ACTION_SUBJECT_KINDS,
  PRIORITY_ITEM_KINDS,
  canTransitionExternalAction,
  calendarEntrySchema,
  externalActionDetailSchema,
  externalActionPolicyViewSchema,
  externalActionPolicyRuleSchema,
  externalActionSubmissionSchema,
  priorityQueueSchema,
  upsertExternalActionPoliciesInputSchema,
} from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const campaignId = "44444444-4444-4444-8444-444444444444";

function actionFixture(status = "authorization_required") {
  return {
    id: actionId,
    workspaceId,
    kind: "publish",
    status,
    subject: {
      kind: "draft",
      id: draftId,
      title: "Launch week teaser",
      summary: "The exact approved LinkedIn post.",
      channel: "linkedin",
      destination: "Founder account",
    },
    context: {
      campaignId,
      campaignName: "Launch week",
      personaId: null,
      personaName: null,
      connectionId: null,
      connectionName: null,
      laneRevisionId: null,
      laneName: null,
    },
    requestedFor: 1_800_000_000_000,
    idempotencyKey: "publish:draft:request-1",
    fingerprint: "a".repeat(64),
    policy: {
      effective: "human_required",
      contributingRules: [
        {
          scope: "workspace",
          scopeId: workspaceId,
          scopeLabel: "Workspace default",
          rule: "human_required",
        },
      ],
    },
    blocker: null,
    supersedesActionId: null,
    supersededByActionId: null,
    execution: null,
    proposedBy: { userId: null, label: "Founder" },
    createdAt: 100,
    updatedAt: 100,
    authorizedAt: null,
    dispatchedAt: null,
    completedAt: null,
  };
}

describe("external action governance contracts", () => {
  it("owns the complete policy, decision, subject, execution, and priority vocabulary", () => {
    expect(EXTERNAL_ACTION_POLICY_SCOPES).toEqual([
      "workspace",
      "campaign",
      "persona",
      "connection",
      "lane",
    ]);
    expect(EXTERNAL_ACTION_POLICY_RULES).toEqual([
      "inherit",
      "autonomous",
      "human_required",
    ]);
    expect(EXTERNAL_ACTION_DECISIONS).toEqual(["authorize", "deny"]);
    expect(EXTERNAL_ACTION_SUBJECT_KINDS).toEqual([
      "draft",
      "inbox_item",
      "launch_message",
      "ad_launch",
      "campaign",
    ]);
    expect(EXTERNAL_ACTION_EXECUTION_KINDS).toEqual([
      "publication",
      "inbox_reply",
      "launch_message",
      "ad_launch",
    ]);
    expect(PRIORITY_ITEM_KINDS).toEqual([
      "execution_failure",
      "stale_action",
      "policy_block",
      "authorization",
      "content_review",
    ]);
  });

  it("adds stale without weakening terminal action transitions", () => {
    expect(EXTERNAL_ACTION_STATUSES).toEqual([
      "proposed",
      "authorization_required",
      "authorized",
      "scheduled",
      "dispatching",
      "succeeded",
      "failed",
      "blocked",
      "stale",
      "cancelled",
    ]);
    expect(canTransitionExternalAction("authorization_required", "stale")).toBe(true);
    expect(canTransitionExternalAction("authorized", "stale")).toBe(true);
    expect(canTransitionExternalAction("scheduled", "stale")).toBe(true);
    expect(canTransitionExternalAction("stale", "cancelled")).toBe(true);
    expect(canTransitionExternalAction("succeeded", "dispatching")).toBe(false);
  });

  it("parses an authorization-required submission and immutable decision detail", () => {
    const submission = externalActionSubmissionSchema.parse({
      action: actionFixture(),
      execution: null,
    });
    expect(submission.action.status).toBe("authorization_required");

    const detail = externalActionDetailSchema.parse({
      action: actionFixture("cancelled"),
      decisions: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          workspaceId,
          actionId,
          decision: "deny",
          reason: "Wrong destination",
          actor: { userId: null, label: "Founder" },
          subjectFingerprint: "a".repeat(64),
          policy: actionFixture().policy,
          createdAt: 110,
        },
      ],
    });
    expect(detail.decisions[0]?.decision).toBe("deny");
  });

  it("requires a durable blocker for blocked and stale actions", () => {
    expect(
      externalActionSubmissionSchema.safeParse({
        action: { ...actionFixture("blocked"), blocker: null },
        execution: null,
      }).success,
    ).toBe(false);
    expect(
      externalActionSubmissionSchema.safeParse({
        action: {
          ...actionFixture("stale"),
          blocker: {
            code: "subject_changed",
            message: "The approved content changed.",
            retryable: false,
          },
        },
        execution: null,
      }).success,
    ).toBe(true);
  });

  it("validates scoped policy writes and rejects workspace inheritance", () => {
    expect(
      externalActionPolicyRuleSchema.safeParse({
        id: "66666666-6666-4666-8666-666666666666",
        workspaceId,
        scope: "workspace",
        scopeId: campaignId,
        actionKind: "publish",
        rule: "human_required",
        createdBy: null,
        createdAt: 100,
        updatedAt: 100,
      }).success,
    ).toBe(false);
    expect(
      upsertExternalActionPoliciesInputSchema.safeParse({
        scope: "workspace",
        scopeId: workspaceId,
        expectedUpdatedAt: null,
        rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({
          actionKind,
          rule: actionKind === "publish" ? "inherit" : "human_required",
        })),
      }).success,
    ).toBe(false);
  });

  it("requires a complete optimistic scope snapshot for policy writes", () => {
    const rules = EXTERNAL_ACTION_KINDS.map((actionKind) => ({
      actionKind,
      rule: "inherit" as const,
    }));
    expect(
      upsertExternalActionPoliciesInputSchema.safeParse({
        scope: "campaign",
        scopeId: campaignId,
        expectedUpdatedAt: null,
        rules,
      }).success,
    ).toBe(true);
    expect(
      upsertExternalActionPoliciesInputSchema.safeParse({
        scope: "campaign",
        scopeId: campaignId,
        rules,
      }).success,
    ).toBe(false);
    expect(
      upsertExternalActionPoliciesInputSchema.safeParse({
        scope: "campaign",
        scopeId: campaignId,
        expectedUpdatedAt: null,
        rules: rules.slice(0, -1),
      }).success,
    ).toBe(false);
    expect(
      externalActionPolicyViewSchema.parse({
        scope: "campaign",
        scopeId: campaignId,
        scopeLabel: "Launch week",
        rules: [],
        effective: [],
        updatedAt: null,
      }).updatedAt,
    ).toBeNull();
  });

  it("parses the unified priority queue", () => {
    const parsed = priorityQueueSchema.parse({
      generatedAt: 200,
      items: [
        {
          id: actionId,
          kind: "authorization",
          status: "authorization_required",
          title: "Authorize LinkedIn publication",
          reason: "Workspace policy requires a decision.",
          consequence: "The scheduled post will not publish until authorized.",
          href: `/workspaces/${workspaceId}/review?tab=authorizations&action=${actionId}`,
          campaignId,
          campaignName: "Launch week",
          dueAt: 1_800_000_000_000,
          createdAt: 100,
        },
      ],
    });
    expect(parsed.items[0]?.kind).toBe("authorization");
  });

  it("allows external actions to occupy Calendar before an execution receipt exists", () => {
    expect(
      calendarEntrySchema.parse({
        kind: "external_action",
        at: 1_800_000_000_000,
        cadenceId: null,
        cadenceName: null,
        campaignId,
        campaignName: "Launch week",
        channel: "linkedin",
        providerKey: "linkedin",
        status: "authorization_required",
        title: "Launch week teaser",
        draftId,
        publicationId: null,
        externalActionId: actionId,
        url: null,
        error: null,
      }).externalActionId,
    ).toBe(actionId);
  });
});
