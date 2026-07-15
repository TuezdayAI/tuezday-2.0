import { and, eq, inArray, lt } from "drizzle-orm";
import type {
  ExecutionResult,
  ExternalAction,
  PriorityItem,
  PriorityQueue,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  adAccounts,
  adLaunches,
  campaignLaneRevisions,
  campaignLanes,
  campaigns,
  connections,
  crmSyncSettings,
  discoverySources,
  drafts,
  externalActions,
  personaSocialAccounts,
  publications,
} from "../db/schema";
import { deriveTitle } from "./cadences";
import { listConnections } from "./connections";
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

export interface ConnectionImpact {
  campaignIds: string[];
  dependencies: string[];
}

const CAMPAIGN_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Derive one strongest operational risk for every active campaign. */
export function deriveCampaignRisks(
  db: Db,
  workspaceId: string,
  now: number,
  executionResults: ExecutionResult[] = listExecutionResults(db, workspaceId, { limit: 200 }),
): PriorityItem[] {
  const activeCampaigns = db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")))
    .all();
  const risks: PriorityItem[] = [];

  for (const campaign of activeCampaigns) {
    const lanes = campaign.currentPlanRevisionId
      ? db
          .select({
            name: campaignLaneRevisions.name,
            status: campaignLaneRevisions.status,
            connectionId: campaignLaneRevisions.publishingConnectionId,
            connectionStatus: connections.status,
          })
          .from(campaignLaneRevisions)
          .leftJoin(connections, eq(campaignLaneRevisions.publishingConnectionId, connections.id))
          .where(
            and(
              eq(campaignLaneRevisions.workspaceId, workspaceId),
              eq(campaignLaneRevisions.planRevisionId, campaign.currentPlanRevisionId),
            ),
          )
          .all()
      : [];
    const activeLanes = lanes.filter((lane) => lane.status === "active");
    const blockedLane = activeLanes.find(
      (lane) => lane.connectionId !== null && lane.connectionStatus !== "connected",
    );
    const recentFailures = executionResults.filter(
      (result) =>
        result.campaignId === campaign.id &&
        (result.status === "failed" || result.status === "partially_failed") &&
        result.at >= now - CAMPAIGN_FAILURE_WINDOW_MS &&
        result.at <= now,
    );
    const overduePublications = db
      .select({ dueAt: publications.scheduledFor })
      .from(publications)
      .innerJoin(drafts, eq(publications.draftId, drafts.id))
      .where(
        and(
          eq(publications.workspaceId, workspaceId),
          eq(publications.status, "scheduled"),
          eq(drafts.campaignId, campaign.id),
          lt(publications.scheduledFor, now),
        ),
      )
      .all();
    const overdueActions = db
      .select({ dueAt: externalActions.requestedFor })
      .from(externalActions)
      .where(
        and(
          eq(externalActions.workspaceId, workspaceId),
          eq(externalActions.campaignId, campaign.id),
          eq(externalActions.status, "scheduled"),
          lt(externalActions.requestedFor, now),
        ),
      )
      .all();
    const overdueDueAt = [...overduePublications, ...overdueActions]
      .map((row) => row.dueAt)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0];

    let detail:
      | Pick<PriorityItem, "status" | "reason" | "consequence" | "dueAt">
      | undefined;
    if (blockedLane) {
      detail = {
        status: "connection_lost",
        reason: `Active lane “${blockedLane.name}” cannot deliver because its publishing connection is unavailable.`,
        consequence: "The campaign cannot complete all planned delivery until the lane is repaired.",
        dueAt: null,
      };
    } else if (recentFailures.length >= 3) {
      detail = {
        status: "failed",
        reason: `${recentFailures.length} failed deliveries in 7 days need investigation.`,
        consequence: "Repeated delivery failures are interrupting this campaign's execution.",
        dueAt: null,
      };
    } else if (overdueDueAt !== undefined) {
      const overdueHours = Math.max(1, Math.floor((now - overdueDueAt) / (60 * 60 * 1000)));
      detail = {
        status: "stale",
        reason: `Scheduled campaign work is ${overdueHours} hour${overdueHours === 1 ? "" : "s"} overdue.`,
        consequence: "The scheduled work has not reached its destination and needs recovery.",
        dueAt: overdueDueAt,
      };
    } else if (activeLanes.length === 0) {
      detail = {
        status: "setup_required",
        reason: "No active campaign lane is capable of delivery.",
        consequence: "This campaign cannot produce or deliver work until an active lane is configured.",
        dueAt: null,
      };
    }
    if (!detail) continue;

    risks.push({
      id: campaign.id,
      kind: "campaign_risk",
      title: `${campaign.name} is at risk`,
      href: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
      campaignId: campaign.id,
      campaignName: campaign.name,
      createdAt: campaign.updatedAt,
      ...detail,
    });
  }

  return risks;
}

/** Identify only durable, currently-live work that depends on a connection. */
export function connectionImpact(
  db: Db,
  workspaceId: string,
  connectionId: string,
): ConnectionImpact {
  const campaignIds = new Set<string>();
  const dependencies = new Set<string>();
  const activeCampaignIds = new Set(
    db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")))
      .all()
      .map((row) => row.id),
  );

  const liveLaneRows = db
    .select({ campaignId: campaignLanes.campaignId })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLaneRevisions.laneId, campaignLanes.id))
    .innerJoin(campaigns, eq(campaignLanes.campaignId, campaigns.id))
    .where(
      and(
        eq(campaignLaneRevisions.workspaceId, workspaceId),
        eq(campaignLaneRevisions.publishingConnectionId, connectionId),
        eq(campaignLaneRevisions.status, "active"),
        eq(campaignLanes.status, "active"),
        eq(campaigns.status, "active"),
        eq(campaigns.currentPlanRevisionId, campaignLaneRevisions.planRevisionId),
      ),
    )
    .all();
  if (liveLaneRows.length > 0) dependencies.add("active campaign lane");
  for (const row of liveLaneRows) campaignIds.add(row.campaignId);

  const publicationRows = db
    .select({ campaignId: drafts.campaignId })
    .from(publications)
    .innerJoin(drafts, eq(publications.draftId, drafts.id))
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.connectionId, connectionId),
        eq(publications.status, "scheduled"),
      ),
    )
    .all();
  if (publicationRows.length > 0) dependencies.add("scheduled publication");
  for (const row of publicationRows) {
    if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
  }

  const scheduledActionRows = db
    .select({ campaignId: externalActions.campaignId })
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        eq(externalActions.connectionId, connectionId),
        eq(externalActions.status, "scheduled"),
      ),
    )
    .all();
  if (scheduledActionRows.length > 0) dependencies.add("scheduled external action");
  for (const row of scheduledActionRows) {
    if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
  }

  if (
    db
      .select({ id: personaSocialAccounts.id })
      .from(personaSocialAccounts)
      .where(
        and(
          eq(personaSocialAccounts.workspaceId, workspaceId),
          eq(personaSocialAccounts.connectionId, connectionId),
        ),
      )
      .get()
  ) {
    dependencies.add("persona sender configuration");
  }

  if (
    db
      .select({ id: discoverySources.id })
      .from(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.connectionId, connectionId),
          eq(discoverySources.enabled, true),
        ),
      )
      .get()
  ) {
    dependencies.add("enabled discovery source");
  }

  if (
    db
      .select({ connectionId: crmSyncSettings.connectionId })
      .from(crmSyncSettings)
      .where(
        and(
          eq(crmSyncSettings.workspaceId, workspaceId),
          eq(crmSyncSettings.connectionId, connectionId),
        ),
      )
      .get()
  ) {
    dependencies.add("CRM sync");
  }

  const accountRows = db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(
      and(eq(adAccounts.workspaceId, workspaceId), eq(adAccounts.connectionId, connectionId)),
    )
    .all();
  if (accountRows.length > 0) dependencies.add("ad account");
  if (accountRows.length > 0) {
    const adCampaignRows = db
      .select({ campaignId: adLaunches.campaignId })
      .from(adLaunches)
      .innerJoin(adAccounts, eq(adLaunches.adAccountId, adAccounts.id))
      .where(
        and(
          eq(adLaunches.workspaceId, workspaceId),
          eq(adAccounts.connectionId, connectionId),
        ),
      )
      .all();
    for (const row of adCampaignRows) {
      if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
    }
  }

  return {
    campaignIds: [...campaignIds].sort(),
    dependencies: [...dependencies],
  };
}

/** Ranking tiers: exact execution/action recovery first, then stopping risks,
 * ordinary content review, and finally unmatched signal triage. */
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
  if (
    item.kind === "connection_health" ||
    item.kind === "campaign_risk" ||
    item.kind === "learning_review" ||
    (item.kind === "signal_triage" && item.campaignId !== null)
  ) {
    return 4;
  }
  if (item.kind === "content_review") return 5;
  return 6;
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
  const executionResults = listExecutionResults(db, workspaceId, { limit: 200 });
  for (const result of executionResults) {
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

  const actionConnectionIds = new Set(
    actions
      .map((action) => action.context.connectionId)
      .filter((id): id is string => id !== null),
  );
  for (const connection of listConnections(db, workspaceId)) {
    if (connection.status === "connected" || actionConnectionIds.has(connection.id)) continue;
    const impact = connectionImpact(db, workspaceId, connection.id);
    if (impact.dependencies.length === 0) continue;
    const campaignId = impact.campaignIds[0] ?? null;
    items.push({
      id: connection.id,
      kind: "connection_health",
      status: "connection_lost",
      title: `${connection.displayName} needs reconnection`,
      reason: `${connection.displayName} is ${connection.status} and blocks: ${impact.dependencies.join(", ")}.`,
      consequence: "Dependent campaign work and syncs cannot continue until you reconnect it.",
      href: `/workspaces/${workspaceId}/connectors?connection=${connection.id}`,
      campaignId,
      campaignName: campaignId ? (campaignNames.get(campaignId) ?? null) : null,
      dueAt: null,
      createdAt: connection.updatedAt,
    });
  }

  items.push(...deriveCampaignRisks(db, workspaceId, now, executionResults));

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
