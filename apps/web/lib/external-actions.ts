import {
  EXTERNAL_ACTION_KINDS,
  type ExternalAction,
  type ExternalActionEffectivePolicy,
  type ExternalActionKind,
  type ExternalActionStatus,
  type ExternalActionSubmission,
  type ExternalActionPolicyView,
  type ExternalActionPolicyRule,
  type WorkflowStatus,
} from "@tuezday/contracts";
import { reviewHref } from "./review-workspace";

export type TighteningPolicyRule = Extract<
  ExternalActionPolicyRule,
  "inherit" | "human_required"
>;
export type TighteningPolicyDraft = Record<ExternalActionKind, TighteningPolicyRule>;

export function tighteningPolicyDraft(view: ExternalActionPolicyView): TighteningPolicyDraft {
  const draft = {} as TighteningPolicyDraft;
  for (const actionKind of EXTERNAL_ACTION_KINDS) {
    const stored = view.rules.find((rule) => rule.actionKind === actionKind)?.rule;
    draft[actionKind] = stored === "human_required" ? "human_required" : "inherit";
  }
  return draft;
}

export function tighteningPolicyDirty(
  view: ExternalActionPolicyView,
  draft: TighteningPolicyDraft,
): boolean {
  const stored = tighteningPolicyDraft(view);
  return (Object.keys(stored) as ExternalActionKind[]).some(
    (actionKind) => stored[actionKind] !== draft[actionKind],
  );
}

export function policyConflictCopy(): string {
  return "This action policy changed in another editor. Compare your attempted settings with the current saved policy, then reload before saving again.";
}

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

/** Badge vocabulary for a resolved policy: whether actions of a kind wait for
 * a human decision or go out autonomously. */
export function effectivePolicyWorkflowStatus(
  effective: ExternalActionEffectivePolicy,
): WorkflowStatus {
  return effective === "human_required" ? "authorization_required" : "active";
}

const SCOPE_LABELS: Record<string, string> = {
  workspace: "Workspace default",
  campaign: "Campaign override",
  persona: "Persona constraint",
  connection: "Connection constraint",
  lane: "Lane constraint",
};

export function policyScopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

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

/** Where to decide on this action: the Review authorization queue. */
export function actionAuthorizationHref(action: ExternalAction): string {
  return reviewHref(action.workspaceId, { tab: "authorizations", action: action.id });
}

const MUTATION_RECOVERY_STATUSES: ReadonlySet<ExternalActionStatus> = new Set([
  "blocked",
  "stale",
  "failed",
]);

/** Mutation actions recover on their owning launched-row form; every other
 * state opens the durable action detail in Review. */
export function externalActionHref(action: ExternalAction): string {
  if (
    MUTATION_RECOVERY_STATUSES.has(action.status) &&
    action.subject.kind === "ad_launch" &&
    (action.kind === "budget_change" || action.kind === "targeting_change")
  ) {
    const mutation = action.kind === "budget_change" ? "budget" : "targeting";
    return `/workspaces/${action.workspaceId}/ad-launches?launch=${action.subject.id}&mutation=${mutation}`;
  }
  return actionAuthorizationHref(action);
}

export interface BudgetChangeDiff {
  deltaCents: number;
  absoluteDeltaCents: number;
  percentDelta: number | null;
}

export function budgetChangeDiff(beforeCents: number, afterCents: number): BudgetChangeDiff {
  const deltaCents = afterCents - beforeCents;
  return {
    deltaCents,
    absoluteDeltaCents: Math.abs(deltaCents),
    percentDelta: beforeCents === 0 ? null : (deltaCents / beforeCents) * 100,
  };
}

interface TargetingSnapshot {
  countries: string[];
  ageMin: number;
  ageMax: number;
}

export function targetingChangeDiff(before: TargetingSnapshot, after: TargetingSnapshot) {
  const beforeCountries = new Set(before.countries);
  const afterCountries = new Set(after.countries);
  return {
    countriesAdded: after.countries.filter((country) => !beforeCountries.has(country)).sort(),
    countriesRemoved: before.countries.filter((country) => !afterCountries.has(country)).sort(),
    beforeAge: { min: before.ageMin, max: before.ageMax },
    afterAge: { min: after.ageMin, max: after.ageMax },
  };
}

/** One plain sentence an owning surface can show after proposing an action. */
export function submissionNote(submission: ExternalActionSubmission): string {
  const { action, execution } = submission;
  const kind = actionKindLabel(action.kind);
  switch (action.status) {
    case "authorization_required":
      return `${kind} needs your authorization before it goes out.`;
    case "proposed":
    case "authorized":
    case "scheduled":
      return `${kind} queued — ${actionTimingLabel(action)}.`;
    case "dispatching":
      return `${kind} is going out now.`;
    case "succeeded":
      return `${kind} completed.`;
    case "blocked":
    case "stale":
      return action.blocker?.message ?? `${kind} is ${action.status}.`;
    case "failed":
      return execution?.error ?? action.execution?.error ?? `${kind} failed.`;
    case "cancelled":
      return `${kind} was denied.`;
  }
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
