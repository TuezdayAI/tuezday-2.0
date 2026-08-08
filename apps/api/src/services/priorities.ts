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
export async function deriveCampaignRisks(
  db: Db,
  workspaceId: string,
  now: number,
  executionResultsArg?: ExecutionResult[],
): Promise<PriorityItem[]> {
  // Resolved in the body: the default is a query, and `await` is illegal in a
  // parameter default initializer.
  const executionResults =
    executionResultsArg ?? (await listExecutionResults(db, workspaceId, { limit: 200 }));
  const activeCampaigns = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active")));
  const risks: PriorityItem[] = [];

  for (const campaign of activeCampaigns) {
    const lanes = campaign.currentPlanRevisionId
      ? await db
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
    const overduePublications = await db
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
      );
    const overdueActions = await db
      .select({ dueAt: externalActions.requestedFor })
      .from(externalActions)
      .where(
        and(
          eq(externalActions.workspaceId, workspaceId),
          eq(externalActions.campaignId, campaign.id),
          eq(externalActions.status, "scheduled"),
          lt(externalActions.requestedFor, now),
        ),
      );
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
export async function connectionImpact(
  db: Db,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionImpact> {
  const campaignIds = new Set<string>();
  const dependencies = new Set<string>();
  const activeCampaignIds = new Set(
    (await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.status, "active"))))
      .map((row) => row.id),
  );

  const liveLaneRows = await db
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
    );
  if (liveLaneRows.length > 0) dependencies.add("active campaign lane");
  for (const row of liveLaneRows) campaignIds.add(row.campaignId);

  const publicationRows = await db
    .select({ campaignId: drafts.campaignId })
    .from(publications)
    .innerJoin(drafts, eq(publications.draftId, drafts.id))
    .where(
      and(
        eq(publications.workspaceId, workspaceId),
        eq(publications.connectionId, connectionId),
        eq(publications.status, "scheduled"),
      ),
    );
  if (publicationRows.length > 0) dependencies.add("scheduled publication");
  for (const row of publicationRows) {
    if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
  }

  const scheduledActionRows = await db
    .select({ campaignId: externalActions.campaignId })
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        eq(externalActions.connectionId, connectionId),
        eq(externalActions.status, "scheduled"),
      ),
    );
  if (scheduledActionRows.length > 0) dependencies.add("scheduled external action");
  for (const row of scheduledActionRows) {
    if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
  }

  if (
    (await db
      .select({ id: personaSocialAccounts.id })
      .from(personaSocialAccounts)
      .where(
        and(
          eq(personaSocialAccounts.workspaceId, workspaceId),
          eq(personaSocialAccounts.connectionId, connectionId),
        ),
      ))[0]
  ) {
    dependencies.add("persona sender configuration");
  }

  if (
    (await db
      .select({ id: discoverySources.id })
      .from(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.connectionId, connectionId),
          eq(discoverySources.enabled, true),
        ),
      ))[0]
  ) {
    dependencies.add("enabled discovery source");
  }

  if (
    (await db
      .select({ connectionId: crmSyncSettings.connectionId })
      .from(crmSyncSettings)
      .where(
        and(
          eq(crmSyncSettings.workspaceId, workspaceId),
          eq(crmSyncSettings.connectionId, connectionId),
        ),
      ))[0]
  ) {
    dependencies.add("CRM sync");
  }

  const accountRows = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(
      and(eq(adAccounts.workspaceId, workspaceId), eq(adAccounts.connectionId, connectionId)),
    );
  if (accountRows.length > 0) dependencies.add("ad account");
  if (accountRows.length > 0) {
    const adCampaignRows = await db
      .select({ campaignId: adLaunches.campaignId })
      .from(adLaunches)
      .innerJoin(adAccounts, eq(adLaunches.adAccountId, adAccounts.id))
      .where(
        and(
          eq(adLaunches.workspaceId, workspaceId),
          eq(adAccounts.connectionId, connectionId),
        ),
      );
    for (const row of adCampaignRows) {
      if (row.campaignId && activeCampaignIds.has(row.campaignId)) campaignIds.add(row.campaignId);
    }
  }

  return {
    campaignIds: [...campaignIds].sort(),
    dependencies: [...dependencies],
  };
}

/**
 * Every durable state a human has to resolve — failed executions, blocked and
 * stale actions, authorizations, pending reviews, unrouted signals, proposed
 * learning, lost connections, at-risk campaigns.
 *
 * Sprint 70 (D-70.8) took the *ranking* out of this file. This collects; the
 * agent inbox ranks. There is now exactly one comparator in the codebase that
 * decides what a founder looks at first, and it lives beside the lanes.
 */
export async function collectPriorityItems(
  db: Db,
  workspaceId: string,
  now: number = Date.now(),
): Promise<PriorityItem[]> {
  const items: PriorityItem[] = [];

  const actions = (await db
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        inArray(externalActions.status, [...ACTION_ATTENTION_STATUSES]),
      ),
    ))
    .map(rowToExternalAction);
  for (const action of actions) items.push(actionItem(action));

  // Failed executions — unless a durable failed action already tells the story.
  const failedActionIds = new Set(
    actions.filter((action) => action.status === "failed").map((action) => action.id),
  );
  const executionResults = await listExecutionResults(db, workspaceId, { limit: 200 });
  for (const result of executionResults) {
    if (result.status !== "failed" && result.status !== "partially_failed") continue;
    if ((result.externalActionIds ?? []).some((id) => failedActionIds.has(id))) continue;
    items.push(executionItem(workspaceId, result));
  }

  const campaignRows = await db
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId));
  const campaignNames = new Map(campaignRows.map((row) => [row.id, row.name] as const));
  const activeCampaignIds = new Set(
    campaignRows.filter((row) => row.status === "active").map((row) => row.id),
  );
  const pending = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.state, "pending_review")));
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

  for (const signal of await listSignals(db, workspaceId)) {
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

  for (const synthesis of await listSyntheses(db, workspaceId)) {
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
  for (const connection of await listConnections(db, workspaceId)) {
    if (connection.status === "connected" || actionConnectionIds.has(connection.id)) continue;
    const impact = await connectionImpact(db, workspaceId, connection.id);
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

  items.push(...await deriveCampaignRisks(db, workspaceId, now, executionResults));

  return items;
}
