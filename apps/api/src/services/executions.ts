import { and, eq, inArray, ne } from "drizzle-orm";
import type { ExecutionResult, ExecutionResultStatus } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  adLaunches,
  campaigns,
  drafts,
  emailDeliveries,
  externalActions,
  launchMessages,
  launches,
  publications,
} from "../db/schema";

export interface ExecutionListOptions {
  campaignId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The unified execution-results projection (UI revamp golden loop): what
 * Tuezday actually executed — social publications, targeted-launch dispatches,
 * and ad launches — rolled up into the canonical result states. Read-only;
 * scheduled/draft work is Calendar and Review territory, not a result.
 */
export function listExecutionResults(
  db: Db,
  workspaceId: string,
  options: ExecutionListOptions = {},
): ExecutionResult[] {
  const campaignNames = new Map<string, string>();
  for (const row of db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .all()) {
    campaignNames.set(row.id, row.name);
  }
  const campaignOf = (campaignId: string | null | undefined) => {
    const id = campaignId ?? null;
    return { campaignId: id, campaignName: id ? (campaignNames.get(id) ?? null) : null };
  };

  const results: ExecutionResult[] = [
    ...publicationResults(db, workspaceId, campaignOf),
    ...launchResults(db, workspaceId, campaignOf),
    ...adLaunchResults(db, workspaceId, campaignOf),
    ...adMutationResults(db, workspaceId, campaignOf),
    ...emailDeliveryResults(db, workspaceId, campaignOf),
  ];

  const scoped = options.campaignId
    ? results.filter((result) => result.campaignId === options.campaignId)
    : results;
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return scoped.sort((left, right) => right.at - left.at).slice(0, limit);
}

function emailDeliveryResults(
  db: Db,
  workspaceId: string,
  campaignOf: CampaignOf,
): ExecutionResult[] {
  const rows = db
    .select({ delivery: emailDeliveries, action: externalActions })
    .from(emailDeliveries)
    .innerJoin(externalActions, eq(emailDeliveries.externalActionId, externalActions.id))
    .where(eq(emailDeliveries.workspaceId, workspaceId))
    .all();
  return rows.map(({ delivery, action }) => {
    const running = delivery.status === "queued" || delivery.status === "accepted";
    const completed = delivery.status === "delivered";
    return {
      kind: "email_delivery" as const,
      id: delivery.id,
      title: delivery.subject,
      channel: "email",
      ...campaignOf(action.campaignId),
      status: running ? ("running" as const) : completed ? ("completed" as const) : ("failed" as const),
      at: delivery.completedAt ?? delivery.acceptedAt ?? delivery.createdAt,
      url: null,
      error: running || completed ? null : (delivery.lastError ?? delivery.status),
      platformStatus: delivery.status,
      destinations: {
        total: 1,
        succeeded: completed ? 1 : 0,
        failed: running || completed ? 0 : 1,
        skipped: 0,
        pending: running ? 1 : 0,
      },
      draftId: action.draftId,
      externalActionIds: [action.id],
    };
  });
}

function adMutationResults(
  db: Db,
  workspaceId: string,
  campaignOf: CampaignOf,
): ExecutionResult[] {
  const rows = db
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        inArray(externalActions.kind, ["budget_change", "targeting_change"]),
        inArray(externalActions.status, ["succeeded", "failed"]),
        eq(externalActions.executionKind, "ad_mutation"),
      ),
    )
    .all();
  const results: ExecutionResult[] = [];
  for (const row of rows) {
    if (
      !row.executionReceiptJson ||
      (row.kind !== "budget_change" && row.kind !== "targeting_change")
    ) {
      continue;
    }
    const snapshot = JSON.parse(row.subjectSnapshotJson) as {
      subject?: { title?: string };
    };
    const receipt = JSON.parse(row.executionReceiptJson) as {
      error?: string | null;
    };
    const succeeded = row.status === "succeeded";
    results.push({
      kind: "ad_mutation",
      id: row.id,
      title: snapshot.subject?.title ?? (row.kind === "budget_change" ? "Budget change" : "Targeting change"),
      channel: "ads",
      ...campaignOf(row.campaignId),
      status: succeeded ? "completed" : "failed",
      at: row.completedAt ?? row.updatedAt,
      url: null,
      error: succeeded ? null : (receipt.error ?? row.blockerDetail),
      platformStatus: null,
      destinations: {
        total: 1,
        succeeded: succeeded ? 1 : 0,
        failed: succeeded ? 0 : 1,
        skipped: 0,
        pending: 0,
      },
      draftId: null,
      actionKind: row.kind,
      externalActionIds: [row.id],
    });
  }
  return results;
}

type CampaignOf = (campaignId: string | null | undefined) => {
  campaignId: string | null;
  campaignName: string | null;
};

function publicationResults(db: Db, workspaceId: string, campaignOf: CampaignOf): ExecutionResult[] {
  const rows = db
    .select({ publication: publications, draft: drafts })
    .from(publications)
    .leftJoin(drafts, eq(publications.draftId, drafts.id))
    .where(and(eq(publications.workspaceId, workspaceId), ne(publications.status, "scheduled")))
    .all();
  return rows.map(({ publication, draft }) => {
    const failed = publication.status === "failed";
    return {
      kind: "publication" as const,
      id: publication.id,
      title: publication.title,
      channel: publication.providerKey,
      ...campaignOf(draft?.campaignId),
      status: failed ? ("failed" as const) : ("completed" as const),
      at: publication.publishedAt ?? publication.scheduledFor,
      url: publication.externalUrl,
      error: failed ? publication.lastError : null,
      platformStatus: null,
      destinations: {
        total: 1,
        succeeded: failed ? 0 : 1,
        failed: failed ? 1 : 0,
        skipped: 0,
        pending: 0,
      },
      draftId: publication.draftId,
      externalActionIds: publication.externalActionId ? [publication.externalActionId] : [],
    };
  });
}

function launchResults(db: Db, workspaceId: string, campaignOf: CampaignOf): ExecutionResult[] {
  const launchRows = db
    .select()
    .from(launches)
    .where(eq(launches.workspaceId, workspaceId))
    .all();
  if (launchRows.length === 0) return [];
  const messageRows = db
    .select({
      launchId: launchMessages.launchId,
      status: launchMessages.status,
      sentAt: launchMessages.sentAt,
      lastError: launchMessages.lastError,
      externalActionId: launchMessages.externalActionId,
    })
    .from(launchMessages)
    .where(
      inArray(
        launchMessages.launchId,
        launchRows.map((row) => row.id),
      ),
    )
    .all();

  const byLaunch = new Map<
    string,
    {
      sent: number;
      failed: number;
      skipped: number;
      pending: number;
      lastSentAt: number | null;
      error: string | null;
      actionIds: Set<string>;
    }
  >();
  for (const message of messageRows) {
    const rollup = byLaunch.get(message.launchId) ?? {
      sent: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      lastSentAt: null,
      error: null,
      actionIds: new Set<string>(),
    };
    if (message.externalActionId) rollup.actionIds.add(message.externalActionId);
    if (message.status === "sent") rollup.sent += 1;
    else if (message.status === "failed") rollup.failed += 1;
    else if (message.status === "skipped") rollup.skipped += 1;
    else rollup.pending += 1;
    if (message.sentAt !== null) {
      rollup.lastSentAt = Math.max(rollup.lastSentAt ?? 0, message.sentAt);
    }
    if (message.status === "failed" && rollup.error === null && message.lastError) {
      rollup.error = message.lastError;
    }
    byLaunch.set(message.launchId, rollup);
  }

  const results: ExecutionResult[] = [];
  for (const launch of launchRows) {
    const rollup = byLaunch.get(launch.id);
    // Results, not intentions: a launch enters the list once dispatch started.
    if (!rollup || rollup.sent + rollup.failed + rollup.skipped === 0) continue;
    let status: ExecutionResultStatus;
    if (rollup.pending > 0) status = "running";
    else if (rollup.failed > 0 && rollup.sent > 0) status = "partially_failed";
    else if (rollup.failed > 0) status = "failed";
    else status = "completed";
    results.push({
      kind: "launch",
      id: launch.id,
      title: launch.name,
      channel: (JSON.parse(launch.channelsJson) as string[]).join(", ") || null,
      ...campaignOf(launch.campaignId),
      status,
      at: rollup.lastSentAt ?? launch.updatedAt,
      url: null,
      error: rollup.error,
      platformStatus: null,
      destinations: {
        total: rollup.sent + rollup.failed + rollup.skipped + rollup.pending,
        succeeded: rollup.sent,
        failed: rollup.failed,
        skipped: rollup.skipped,
        pending: rollup.pending,
      },
      draftId: null,
      externalActionIds: [...rollup.actionIds].sort(),
    });
  }
  return results;
}

function adLaunchResults(db: Db, workspaceId: string, campaignOf: CampaignOf): ExecutionResult[] {
  const rows = db
    .select()
    .from(adLaunches)
    .where(eq(adLaunches.workspaceId, workspaceId))
    .all();
  const results: ExecutionResult[] = [];
  for (const launch of rows) {
    const launched = launch.status === "launched";
    // Gate states without a failed attempt are Review territory, not results.
    if (!launched && launch.lastError === null) continue;
    results.push({
      kind: "ad_launch",
      id: launch.id,
      title: launch.name,
      channel: null,
      ...campaignOf(launch.campaignId),
      status: launched ? "completed" : "failed",
      at: launch.launchedAt ?? launch.updatedAt,
      url: null,
      error: launched ? null : launch.lastError,
      platformStatus: launch.platformStatus,
      destinations: {
        total: 1,
        succeeded: launched ? 1 : 0,
        failed: launched ? 0 : 1,
        skipped: 0,
        pending: 0,
      },
      draftId: launch.creativeDraftId,
      externalActionIds: launch.externalActionId ? [launch.externalActionId] : [],
    });
  }
  return results;
}
