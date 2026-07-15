import { and, eq, inArray } from "drizzle-orm";
import type {
  ExecutionResult,
  ExternalAction,
  PriorityItem,
  PriorityQueue,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { campaigns, drafts, externalActions } from "../db/schema";
import { deriveTitle } from "./cadences";
import { listExecutionResults } from "./executions";
import { rowToExternalAction } from "./external-actions";
import { listSyntheses } from "./learning";
import { listSignals, type SignalWithDrafts } from "./signals";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SIGNAL_TRIAGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Action states a human has to resolve, in the priority vocabulary. */
const ACTION_ATTENTION_STATUSES = ["failed", "blocked", "stale", "authorization_required"] as const;

function authorizationHref(workspaceId: string, actionId: string): string {
  return `/workspaces/${workspaceId}/review?tab=authorizations&action=${actionId}`;
}

function actionItem(action: ExternalAction): PriorityItem {
  const base = {
    id: action.id,
    title: action.subject.title,
    href: authorizationHref(action.workspaceId, action.id),
    campaignId: action.context.campaignId,
    campaignName: action.context.campaignName,
    dueAt: action.requestedFor,
    createdAt: action.createdAt,
  };
  switch (action.status) {
    case "failed":
      return {
        ...base,
        kind: "execution_failure",
        status: "failed",
        reason: action.execution?.error ?? action.blocker?.message ?? "The delivery attempt failed.",
        consequence: "The destination never received it — retry from its owning surface.",
      };
    case "blocked":
      return {
        ...base,
        kind: "policy_block",
        status: "policy_blocked",
        reason: action.blocker?.message ?? "A guardrail blocked this action.",
        consequence: "It will not go out until the blocker is cleared.",
      };
    case "stale":
      return {
        ...base,
        kind: "stale_action",
        status: "stale",
        reason:
          action.blocker?.message ??
          "The content, destination, or policy changed after this was proposed.",
        consequence: "Re-propose it from its owning surface with the current content.",
      };
    default:
      return {
        ...base,
        kind: "authorization",
        status: "authorization_required",
        reason: `Waiting for your authorization to ${action.kind.replace("_", " ")}.`,
        consequence: "Nothing reaches the destination until you authorize or deny it.",
      };
  }
}

const EXECUTION_OWNER_PATH: Record<ExecutionResult["kind"], string> = {
  publication: "content",
  launch: "launches",
  ad_launch: "ad-launches",
  ad_mutation: "ad-launches",
  email_delivery: "review?tab=authorizations",
};

function executionItem(workspaceId: string, result: ExecutionResult): PriorityItem {
  return {
    id: result.id,
    kind: "execution_failure",
    status: result.status === "partially_failed" ? "partially_failed" : "failed",
    title: result.title,
    reason: result.error ?? "The delivery attempt failed.",
    consequence: "The destination never received it — retry from its owning surface.",
    href: `/workspaces/${workspaceId}/${EXECUTION_OWNER_PATH[result.kind]}`,
    campaignId: result.campaignId,
    campaignName: result.campaignName,
    dueAt: null,
    createdAt: result.at,
  };
}

/**
 * Produce the Home priority for one signal after its matches have been limited
 * to active campaigns. Keeping this step pure makes the 24-hour threshold and
 * response-draft deduplication deterministic and independently testable.
 */
export function signalPriorityCandidate(
  signal: SignalWithDrafts,
  now: number,
): PriorityItem | null {
  if (signal.drafts.length > 0) return null;

  const campaignMatch = signal.matches.find((match) => match.campaignId !== null);
  const overdueAt = signal.createdAt + SIGNAL_TRIAGE_AFTER_MS;
  if (!campaignMatch && now < overdueAt) return null;

  return {
    id: signal.id,
    kind: "signal_triage",
    status: "review_required",
    title: deriveTitle(signal.content),
    reason: campaignMatch
      ? `${campaignMatch.campaignName ?? "The matched campaign"} needs a response decision for this ${campaignMatch.score}% match${campaignMatch.reason ? `: ${campaignMatch.reason}` : "."}`
      : "No active campaign decision has been made for this signal after 24 hours.",
    consequence: "A response draft will not be created until you review and route this signal.",
    href: `/workspaces/${signal.workspaceId}/discovery?signal=${signal.id}`,
    campaignId: campaignMatch?.campaignId ?? null,
    campaignName: campaignMatch?.campaignName ?? null,
    dueAt: campaignMatch ? null : overdueAt,
    createdAt: signal.createdAt,
  };
}

/** Ranking tiers: overdue failures/blocks/stale, overdue authorizations, other
 * failures/blocks/stale, authorizations, then content review. */
function tier(item: PriorityItem, now: number): number {
  const overdue = item.dueAt !== null && item.dueAt <= now;
  const failureLike =
    item.kind === "execution_failure" ||
    item.kind === "policy_block" ||
    item.kind === "stale_action";
  if (failureLike && overdue) return 0;
  if (item.kind === "authorization" && overdue) return 1;
  if (failureLike) return 2;
  if (item.kind === "authorization") return 3;
  return 4;
}

/**
 * The Home "Needs you now" projection: every durable action state a human has
 * to resolve, plus failed executions and pending content reviews, ranked
 * deterministically most-urgent first.
 */
export function listWorkspacePriorities(
  db: Db,
  workspaceId: string,
  limit: number = DEFAULT_LIMIT,
): PriorityQueue {
  const now = Date.now();
  const items: PriorityItem[] = [];

  const actions = db
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        inArray(externalActions.status, [...ACTION_ATTENTION_STATUSES]),
      ),
    )
    .all()
    .map(rowToExternalAction);
  for (const action of actions) items.push(actionItem(action));

  // Failed executions — unless a durable failed action already tells the story.
  const failedActionIds = new Set(
    actions.filter((action) => action.status === "failed").map((action) => action.id),
  );
  for (const result of listExecutionResults(db, workspaceId, { limit: 200 })) {
    if (result.status !== "failed" && result.status !== "partially_failed") continue;
    if ((result.externalActionIds ?? []).some((id) => failedActionIds.has(id))) continue;
    items.push(executionItem(workspaceId, result));
  }

  const campaignRows = db
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .all();
  const campaignNames = new Map(campaignRows.map((row) => [row.id, row.name] as const));
  const activeCampaignIds = new Set(
    campaignRows.filter((row) => row.status === "active").map((row) => row.id),
  );
  const pending = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.state, "pending_review")))
    .all();
  for (const draft of pending) {
    items.push({
      id: draft.id,
      kind: "content_review",
      status: "review_required",
      title: deriveTitle(draft.content),
      reason: "This draft is waiting for your review.",
      consequence: "It cannot be scheduled or published until you decide.",
      href: `/workspaces/${workspaceId}/review?tab=approvals&draft=${draft.id}`,
      campaignId: draft.campaignId,
      campaignName: draft.campaignId ? (campaignNames.get(draft.campaignId) ?? null) : null,
      dueAt: null,
      createdAt: draft.createdAt,
    });
  }

  for (const signal of listSignals(db, workspaceId)) {
    const candidate = signalPriorityCandidate(
      {
        ...signal,
        matches: signal.matches.filter(
          (match) => match.campaignId !== null && activeCampaignIds.has(match.campaignId),
        ),
      },
      now,
    );
    if (candidate) items.push(candidate);
  }

  for (const synthesis of listSyntheses(db, workspaceId)) {
    if (synthesis.status !== "proposed") continue;
    items.push({
      id: synthesis.id,
      kind: "learning_review",
      status: "review_required",
      title: synthesis.proposal.trim().slice(0, 80) || "Review proposed learning",
      reason:
        synthesis.rationale.trim() ||
        "This proposal was synthesized from recent decisions and performance.",
      consequence: "The Brain will not change until you accept or dismiss this proposal.",
      href: `/workspaces/${workspaceId}/learning?synthesis=${synthesis.id}`,
      campaignId: null,
      campaignName: null,
      dueAt: null,
      createdAt: synthesis.createdAt,
    });
  }

  items.sort((left, right) => {
    const byTier = tier(left, now) - tier(right, now);
    if (byTier !== 0) return byTier;
    const byDue = (left.dueAt ?? left.createdAt) - (right.dueAt ?? right.createdAt);
    if (byDue !== 0) return byDue;
    const byCreated = left.createdAt - right.createdAt;
    if (byCreated !== 0) return byCreated;
    return left.id.localeCompare(right.id);
  });

  const bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
  return { items: items.slice(0, bounded), generatedAt: now };
}
