// Pure view helpers for the Sprint 68 preference-memory page — kept in lib so
// they are unit-tested (node env). Nothing here decides anything; the API owns
// every status transition and every count.

import type {
  PreferenceEdit,
  PreferenceRule,
  PreferenceRuleStatus,
} from "@tuezday/contracts";

/** The order the founder should read statuses in: what's live, then what's waiting. */
export const RULE_STATUS_ORDER: PreferenceRuleStatus[] = [
  "active",
  "candidate",
  "disabled",
  "promoted",
  "retired",
];

const STATUS_LABELS: Record<PreferenceRuleStatus, string> = {
  active: "Active",
  candidate: "Needs your call",
  disabled: "Switched off",
  promoted: "In your brain docs",
  retired: "Retired",
};

const STATUS_HELP: Record<PreferenceRuleStatus, string> = {
  active: "Injected into every matching draft.",
  candidate: "Learned, but not confident enough to apply on its own yet.",
  disabled: "You switched this off. Nothing will re-enable it.",
  promoted: "Folded into your brain docs by a synthesis you accepted — the resolver reads it there now.",
  retired: "Stopped being observed and stopped being applied, so it was stood down.",
};

export function statusLabel(status: PreferenceRuleStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusHelp(status: PreferenceRuleStatus): string {
  return STATUS_HELP[status] ?? "";
}

export function statusTone(status: PreferenceRuleStatus): "approved" | "rejected" | "neutral" {
  if (status === "active" || status === "promoted") return "approved";
  if (status === "disabled" || status === "retired") return "rejected";
  return "neutral";
}

/** Human scope, matching what the resolver trace says. */
export function scopeLabel(rule: Pick<PreferenceRule, "scopeTaskType" | "scopeChannel">): string {
  if (rule.scopeTaskType && rule.scopeChannel) {
    return `${rule.scopeTaskType} on ${rule.scopeChannel}`;
  }
  return rule.scopeChannel ?? rule.scopeTaskType ?? "all tasks";
}

/**
 * The one line that tells a founder whether to trust a rule: how many of their
 * own edits produced it, and how many drafts it has actually shaped.
 */
export function provenanceLine(
  rule: Pick<PreferenceRule, "observationCount" | "appliedCount" | "origin">,
): string {
  if (rule.origin === "manual") {
    return rule.appliedCount === 1
      ? "Written by you · applied to 1 draft"
      : `Written by you · applied to ${rule.appliedCount} drafts`;
  }
  const observed =
    rule.observationCount === 1 ? "1 of your edits" : `${rule.observationCount} of your edits`;
  const applied = rule.appliedCount === 1 ? "1 draft" : `${rule.appliedCount} drafts`;
  return `Learned from ${observed} · applied to ${applied}`;
}

/**
 * Which buttons a rule gets. The founder's levers, and only the ones that mean
 * something: a promoted rule lives in a brain doc now, so switching it off here
 * would be a lie — the doc is where they'd edit it.
 */
export function availableActions(status: PreferenceRuleStatus): PreferenceRuleStatus[] {
  switch (status) {
    case "candidate":
      return ["active", "disabled"];
    case "active":
      return ["disabled"];
    case "disabled":
      return ["active"];
    case "retired":
      return ["active"];
    case "promoted":
      return [];
    default:
      return [];
  }
}

export function actionLabel(status: PreferenceRuleStatus): string {
  switch (status) {
    case "active":
      return "Turn on";
    case "disabled":
      return "Switch off";
    case "retired":
      return "Retire";
    default:
      return statusLabel(status);
  }
}

/** Group rules for display, dropping empty buckets so the page stays quiet. */
export function groupByStatus(
  rules: PreferenceRule[],
): { status: PreferenceRuleStatus; rules: PreferenceRule[] }[] {
  return RULE_STATUS_ORDER.map((status) => ({
    status,
    rules: rules.filter((rule) => rule.status === status),
  })).filter((group) => group.rules.length > 0);
}

/** What the founder actually changed, in one line, for the captured-edits list. */
export function editSummary(edit: PreferenceEdit): string {
  const scope = `${edit.taskType} on ${edit.channel}`;
  const rewrite = `${Math.round(edit.editDistance)}% rewritten`;
  return edit.instruction ? `${scope} · "${edit.instruction}"` : `${scope} · ${rewrite}`;
}

/**
 * The page's headline. Distinguishes "nothing captured" from "captured but not
 * digested yet" — they need different actions from the founder.
 */
export function memoryState(
  rules: PreferenceRule[],
  edits: PreferenceEdit[],
): "learning" | "pending" | "empty" {
  if (rules.some((rule) => rule.status === "active" || rule.status === "candidate")) {
    return "learning";
  }
  return edits.length > 0 ? "pending" : "empty";
}
