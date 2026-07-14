import type {
  ExternalAction,
  ExternalActionKind,
  ExternalActionStatus,
  WorkflowStatus,
} from "@tuezday/contracts";
import { reviewHref } from "./review-workspace";

/** In-flight wording depends on what is being dispatched. */
const DISPATCHING_STATUS: Record<ExternalActionKind, WorkflowStatus> = {
  publish: "publishing",
  send: "sending",
  reply: "sending",
  paid_launch: "launching",
  budget_change: "launching",
  targeting_change: "launching",
};

/** Map action lifecycle states onto the canonical workflow badge vocabulary. */
export function externalActionWorkflowStatus(action: ExternalAction): WorkflowStatus {
  switch (action.status) {
    case "proposed":
      return "scheduling";
    case "authorization_required":
      return "authorization_required";
    case "authorized":
      return "authorized";
    case "scheduled":
      return "scheduled";
    case "dispatching":
      return DISPATCHING_STATUS[action.kind];
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "policy_blocked";
    case "stale":
      return "stale";
    case "cancelled":
      return "rejected";
  }
}

const KIND_LABELS: Record<ExternalActionKind, string> = {
  publish: "Publish",
  send: "Send",
  reply: "Reply",
  paid_launch: "Paid launch",
  budget_change: "Budget change",
  targeting_change: "Targeting change",
};

export function actionKindLabel(kind: ExternalActionKind): string {
  return KIND_LABELS[kind];
}

const SCOPE_LABELS: Record<string, string> = {
  workspace: "Workspace default",
  campaign: "Campaign override",
  persona: "Persona constraint",
  connection: "Connection constraint",
  lane: "Lane constraint",
};

/** Why this action needs (or skipped) a human decision — every non-inherit
 * contributing rule is named so the founder can see where the policy came from. */
export function policyExplanation(action: ExternalAction): string {
  const effective =
    action.policy.effective === "human_required"
      ? "This action requires a human decision before it goes out."
      : "This action runs autonomously under the current policy.";
  const contributions = action.policy.contributingRules
    .filter((rule) => rule.rule !== "inherit")
    .map(
      (rule) =>
        `${SCOPE_LABELS[rule.scope] ?? rule.scope} (${rule.scopeLabel}): ${
          rule.rule === "human_required" ? "human required" : "autonomous"
        }`,
    );
  return [effective, ...contributions].join(" ");
}

export function actionTimingLabel(action: ExternalAction): string {
  return action.requestedFor === null
    ? "Immediately once authorized"
    : new Date(action.requestedFor).toLocaleString();
}

/** One sentence naming exactly what leaves the workspace, where, and when. */
export function impactSummary(action: ExternalAction): string {
  const destination = action.subject.destination ?? "its destination";
  const timing =
    action.requestedFor === null
      ? "immediately once authorized"
      : `at ${new Date(action.requestedFor).toLocaleString()}`;
  return `${actionKindLabel(action.kind)} “${action.subject.title}” to ${destination}, ${timing}.`;
}

/** Where to fix a blocked/stale action: the surface that owns its subject. */
export function actionRecoveryHref(action: ExternalAction): string {
  switch (action.subject.kind) {
    case "draft":
      return reviewHref(action.workspaceId, { tab: "approvals", draft: action.subject.id });
    case "inbox_item":
      return reviewHref(action.workspaceId, { tab: "inbox" });
    case "launch_message":
      return `/workspaces/${action.workspaceId}/launches`;
    case "ad_launch":
      return `/workspaces/${action.workspaceId}/ad-launches`;
    case "campaign":
      return `/workspaces/${action.workspaceId}/campaigns/${action.subject.id}`;
  }
}

export interface ActionFilters {
  status: ExternalActionStatus | "all";
  kind: ExternalActionKind | "all";
  campaignId: string | "all";
}

export function filterActions(actions: ExternalAction[], filters: ActionFilters): ExternalAction[] {
  return actions.filter(
    (action) =>
      (filters.status === "all" || action.status === filters.status) &&
      (filters.kind === "all" || action.kind === filters.kind) &&
      (filters.campaignId === "all" || action.context.campaignId === filters.campaignId),
  );
}
