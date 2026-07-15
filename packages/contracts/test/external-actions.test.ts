import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_BATCH_ITEM_STATUSES,
  AUTHORIZATION_BATCH_MODES,
  AUTHORIZATION_BATCH_STATUSES,
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
  budgetChangeIntentSchema,
  authorizationBatchDetailSchema,
  authorizationBatchItemSchema,
  authorizationBatchSchema,
  authorizationBatchSelectionSchema,
  createAuthorizationBatchInputSchema,
  externalActionDetailSchema,
  externalActionPolicyViewSchema,
  externalActionPolicyRuleSchema,
  externalActionSubmissionSchema,
  priorityQueueSchema,
  proposeBudgetChangeInputSchema,
  proposeTargetingChangeInputSchema,
  targetingChangeIntentSchema,
  upsertExternalActionPoliciesInputSchema,
} from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const campaignId = "44444444-4444-4444-8444-444444444444";
const batchId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";

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
  it("owns the bounded authorization batch vocabulary", () => {
    expect(AUTHORIZATION_BATCH_MODES).toEqual(["selected", "campaign"]);
    expect(AUTHORIZATION_BATCH_STATUSES).toEqual([
      "preview",
      "running",
      "completed",
      "partially_completed",
      "failed",
    ]);
    expect(AUTHORIZATION_BATCH_ITEM_STATUSES).toEqual([
      "pending",
      "succeeded",
      "scheduled",
      "failed",
      "blocked",
      "stale",
      "skipped",
    ]);
  });

  it("accepts selected and campaign batch inputs with normalized filters", () => {
    expect(
      createAuthorizationBatchInputSchema.parse({
        requestId,
        selection: { mode: "selected", actionIds: [actionId] },
      }).selection,
    ).toEqual({ mode: "selected", actionIds: [actionId] });
    expect(
      authorizationBatchSelectionSchema.parse({
        mode: "campaign",
        campaignId,
      }),
    ).toEqual({ mode: "campaign", campaignId, kinds: null });
    const campaignSelection = authorizationBatchSelectionSchema.parse({
      mode: "campaign",
      campaignId,
      kinds: ["send", "publish"],
    });
    if (campaignSelection.mode !== "campaign") throw new Error("Expected campaign selection");
    expect(campaignSelection.kinds).toEqual(["send", "publish"]);
  });

  it("rejects empty, oversized, or duplicate batch selections", () => {
    const uniqueActionIds = Array.from({ length: 26 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return `77777777-7777-4777-8777-${suffix}`;
    });
    expect(
      createAuthorizationBatchInputSchema.safeParse({
        requestId,
        selection: { mode: "selected", actionIds: [] },
      }).success,
    ).toBe(false);
    expect(
      createAuthorizationBatchInputSchema.safeParse({
        requestId,
        selection: { mode: "selected", actionIds: uniqueActionIds },
      }).success,
    ).toBe(false);
    expect(
      createAuthorizationBatchInputSchema.safeParse({
        requestId,
        selection: { mode: "selected", actionIds: [actionId, actionId] },
      }).success,
    ).toBe(false);
    expect(
      authorizationBatchSelectionSchema.safeParse({
        mode: "campaign",
        campaignId,
        kinds: ["publish", "publish"],
      }).success,
    ).toBe(false);
  });

  it("parses immutable batch item snapshots and bounded batch metadata", () => {
    const selection = { mode: "selected" as const, actionIds: [actionId] };
    const batch = authorizationBatchSchema.parse({
      id: batchId,
      workspaceId,
      requestId,
      selection,
      status: "preview",
      continuationCount: 0,
      includedCount: 1,
      excludedCount: 0,
      createdBy: { userId: null, label: "Founder" },
      createdAt: 100,
      confirmedAt: null,
      completedAt: null,
    });
    expect(batch.includedCount).toBe(1);
    expect(
      authorizationBatchSchema.safeParse({ ...batch, includedCount: 101 }).success,
    ).toBe(false);

    const item = authorizationBatchItemSchema.parse({
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId,
      batchId,
      actionId,
      actionFingerprint: "a".repeat(64),
      actionUpdatedAt: 90,
      kind: "publish",
      campaignId,
      impact: "Publish the approved launch post to the founder account.",
      eligible: true,
      exclusionReason: null,
      status: "pending",
      error: null,
      submission: null,
      processedAt: null,
    });
    expect(item.actionFingerprint).toHaveLength(64);
    expect(authorizationBatchDetailSchema.parse({ batch, items: [item] }).items).toHaveLength(1);

    const receipt = {
      kind: "publication" as const,
      id: "99999999-9999-4999-8999-999999999999",
      status: "published",
      url: "https://example.com/post",
      error: null,
    };
    const submission = {
      action: {
        ...actionFixture("succeeded"),
        execution: receipt,
        updatedAt: 119,
        completedAt: 119,
      },
      execution: receipt,
    };
    expect(
      authorizationBatchItemSchema.parse({
        ...item,
        status: "succeeded",
        submission,
        processedAt: 120,
      }).status,
    ).toBe("succeeded");
    expect(
      authorizationBatchItemSchema.safeParse({
        ...item,
        status: "failed",
        processedAt: 120,
      }).success,
    ).toBe(false);
    expect(
      authorizationBatchItemSchema.safeParse({
        ...item,
        status: "succeeded",
        submission: {
          ...submission,
          action: { ...submission.action, id: draftId },
        },
        processedAt: 120,
      }).success,
    ).toBe(false);
    expect(
      authorizationBatchItemSchema.safeParse({
        ...item,
        eligible: false,
        exclusionReason: "not_authorization_required",
        status: "skipped",
        error: "Excluded previews do not execute.",
      }).success,
    ).toBe(false);
  });

  it("requires exact detail counts and terminal included items after completion", () => {
    const batch = {
      id: batchId,
      workspaceId,
      requestId,
      selection: { mode: "selected" as const, actionIds: [actionId] },
      status: "completed" as const,
      continuationCount: 0,
      includedCount: 1,
      excludedCount: 0,
      createdBy: { userId: null, label: "Founder" },
      createdAt: 100,
      confirmedAt: 110,
      completedAt: 120,
    };
    const pending = {
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId,
      batchId,
      actionId,
      actionFingerprint: "a".repeat(64),
      actionUpdatedAt: 90,
      kind: "publish" as const,
      campaignId,
      impact: "Publish the approved launch post to the founder account.",
      eligible: true,
      exclusionReason: null,
      status: "pending" as const,
      error: null,
      submission: null,
      processedAt: null,
    };
    expect(authorizationBatchDetailSchema.safeParse({ batch, items: [pending] }).success).toBe(
      false,
    );
    expect(
      authorizationBatchDetailSchema.safeParse({
        batch: { ...batch, status: "preview", confirmedAt: null, completedAt: null },
        items: [{ ...pending, eligible: false, exclusionReason: "duplicate_action", status: "skipped" }],
      }).success,
    ).toBe(false);
  });

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
      "ad_mutation",
      "email_delivery",
    ]);
    expect(PRIORITY_ITEM_KINDS).toEqual([
      "execution_failure",
      "stale_action",
      "policy_block",
      "authorization",
      "content_review",
      "signal_triage",
      "learning_review",
      "connection_health",
    ]);
  });

  it("owns normalized Meta budget and targeting mutation intents", () => {
    expect(
      proposeBudgetChangeInputSchema.parse({
        dailyBudgetCents: 12_500,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }).dailyBudgetCents,
    ).toBe(12_500);
    expect(
      proposeTargetingChangeInputSchema.safeParse({
        countries: ["US", "US"],
        ageMin: 45,
        ageMax: 21,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }).success,
    ).toBe(false);

    const common = {
      launchId: "66666666-6666-4666-8666-666666666666",
      adAccountId: "77777777-7777-4777-8777-777777777777",
      externalAccountId: "act_1",
      externalAdSetId: "set_1",
      providerUpdatedAt: null,
    };
    expect(
      targetingChangeIntentSchema.parse({
        ...common,
        before: { countries: ["US"], ageMin: 18, ageMax: 65 },
        after: { countries: ["us", "DE", "US"], ageMin: 25, ageMax: 54 },
      }).after.countries,
    ).toEqual(["DE", "US"]);
    expect(
      budgetChangeIntentSchema.safeParse({
        ...common,
        currency: "USD",
        beforeDailyBudgetCents: 5_000,
        afterDailyBudgetCents: 5_000,
      }).success,
    ).toBe(false);
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
