import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type AuthorizationBatch,
  type AuthorizationBatchDetail,
  type AuthorizationBatchItem,
  type AuthorizationBatchItemStatus,
  type AuthorizationBatchStatus,
  type CreateAuthorizationBatchInput,
  type ExternalAction,
  type ExternalActionActor,
  type ExternalActionKind,
  type ExternalActionSubmission,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  externalActionBatchItems,
  externalActionBatches,
  externalActions,
  type ExternalActionBatchItemRow,
  type ExternalActionBatchRow,
} from "../db/schema";
import {
  StaleExternalActionError,
  type ExternalActionRuntime,
} from "./external-action-coordinator";
import { rowToExternalAction } from "./external-actions";

const CAMPAIGN_BATCH_LIMIT = 100;

interface StoredItemSnapshot {
  position: number;
  actionFingerprint: string;
  actionUpdatedAt: number;
  kind: ExternalActionKind;
  campaignId: string | null;
  impact: string;
  eligible: boolean;
  exclusionReason: string | null;
}

interface ResolvedActionEntry {
  action: ExternalAction;
  eligible: boolean;
  exclusionReason: string | null;
}

export class AuthorizationBatchNotFoundError extends Error {
  constructor() {
    super("Authorization batch not found");
    this.name = "AuthorizationBatchNotFoundError";
  }
}

function storedSnapshot(row: ExternalActionBatchItemRow): StoredItemSnapshot {
  return JSON.parse(row.snapshotJson) as StoredItemSnapshot;
}

function impactOf(action: ExternalAction): string {
  return (action.subject.summary.trim() || action.subject.title.trim() || "External action").slice(
    0,
    1_000,
  );
}

function rowToItem(row: ExternalActionBatchItemRow): AuthorizationBatchItem {
  const snapshot = storedSnapshot(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    batchId: row.batchId,
    actionId: row.actionId,
    actionFingerprint: snapshot.actionFingerprint,
    actionUpdatedAt: snapshot.actionUpdatedAt,
    kind: snapshot.kind,
    campaignId: snapshot.campaignId,
    impact: snapshot.impact,
    eligible: snapshot.eligible,
    exclusionReason: snapshot.exclusionReason,
    status: row.status as AuthorizationBatchItemStatus,
    error: row.error,
    submission: row.submissionJson
      ? (JSON.parse(row.submissionJson) as ExternalActionSubmission)
      : null,
    processedAt: row.processedAt,
  };
}

function rowToBatch(
  row: ExternalActionBatchRow,
  includedCount: number,
  excludedCount: number,
): AuthorizationBatch {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestId: row.requestId,
    selection: JSON.parse(row.selectionJson) as AuthorizationBatch["selection"],
    status: row.status as AuthorizationBatchStatus,
    continuationCount: row.continuationCount,
    includedCount,
    excludedCount,
    createdBy: { userId: row.createdByUserId, label: row.createdByLabel },
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
  };
}

export function getAuthorizationBatchDetail(
  db: Db,
  workspaceId: string,
  batchId: string,
): AuthorizationBatchDetail | undefined {
  const batchRow = db
    .select()
    .from(externalActionBatches)
    .where(
      and(
        eq(externalActionBatches.workspaceId, workspaceId),
        eq(externalActionBatches.id, batchId),
      ),
    )
    .get();
  if (!batchRow) return undefined;
  const rows = db
    .select()
    .from(externalActionBatchItems)
    .where(
      and(
        eq(externalActionBatchItems.workspaceId, workspaceId),
        eq(externalActionBatchItems.batchId, batchId),
      ),
    )
    .all()
    .sort((left, right) => storedSnapshot(left).position - storedSnapshot(right).position);
  const items = rows.map(rowToItem);
  return {
    batch: rowToBatch(
      batchRow,
      items.filter((item) => item.eligible).length,
      items.filter((item) => !item.eligible).length,
    ),
    items,
  };
}

function actionById(db: Db, actionId: string): ExternalAction | undefined {
  const row = db
    .select()
    .from(externalActions)
    .where(eq(externalActions.id, actionId))
    .get();
  return row ? rowToExternalAction(row) : undefined;
}

function selectedActions(
  db: Db,
  workspaceId: string,
  actionIds: string[],
): ResolvedActionEntry[] {
  const seen = new Set<string>();
  return actionIds.flatMap<ResolvedActionEntry>((actionId) => {
    if (seen.has(actionId)) return [];
    seen.add(actionId);
    const action = actionById(db, actionId);
    if (!action) return [];
    if (action.workspaceId !== workspaceId) {
      return [{ action, eligible: false, exclusionReason: "workspace_mismatch" }];
    }
    if (action.status !== "authorization_required") {
      return [{ action, eligible: false, exclusionReason: "not_authorization_required" }];
    }
    return [{ action, eligible: true, exclusionReason: null }];
  });
}

function compareCampaignActions(left: ExternalAction, right: ExternalAction): number {
  const leftRequested = left.requestedFor ?? left.createdAt;
  const rightRequested = right.requestedFor ?? right.createdAt;
  return (
    leftRequested - rightRequested ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function campaignActions(
  db: Db,
  workspaceId: string,
  campaignId: string,
  kinds: ExternalActionKind[] | null,
): { actions: ExternalAction[]; continuationCount: number } {
  const allowedKinds = kinds ? new Set(kinds) : null;
  const matches = db
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        eq(externalActions.campaignId, campaignId),
        eq(externalActions.status, "authorization_required"),
      ),
    )
    .all()
    .map(rowToExternalAction)
    .filter((action) => !allowedKinds || allowedKinds.has(action.kind))
    .sort(compareCampaignActions);
  return {
    actions: matches.slice(0, CAMPAIGN_BATCH_LIMIT),
    continuationCount: Math.max(0, matches.length - CAMPAIGN_BATCH_LIMIT),
  };
}

export function createAuthorizationBatchPreview(
  db: Db,
  workspaceId: string,
  input: CreateAuthorizationBatchInput,
  actor: ExternalActionActor,
): AuthorizationBatchDetail {
  const existing = db
    .select({ id: externalActionBatches.id })
    .from(externalActionBatches)
    .where(
      and(
        eq(externalActionBatches.workspaceId, workspaceId),
        eq(externalActionBatches.requestId, input.requestId),
      ),
    )
    .get();
  if (existing) return getAuthorizationBatchDetail(db, workspaceId, existing.id)!;

  const selected =
    input.selection.mode === "selected"
      ? {
          entries: selectedActions(db, workspaceId, input.selection.actionIds),
          continuationCount: 0,
        }
      : (() => {
          const resolved = campaignActions(
            db,
            workspaceId,
            input.selection.campaignId,
            input.selection.kinds,
          );
          return {
            entries: resolved.actions.map((action) => ({
              action,
              eligible: true,
              exclusionReason: null,
            })),
            continuationCount: resolved.continuationCount,
          };
        })();
  const batchId = randomUUID();
  const now = Date.now();

  db.transaction((tx) => {
    tx.insert(externalActionBatches)
      .values({
        id: batchId,
        workspaceId,
        requestId: input.requestId,
        selectionJson: JSON.stringify(input.selection),
        status: "preview",
        continuationCount: selected.continuationCount,
        createdByUserId: actor.userId,
        createdByLabel: actor.label,
        createdAt: now,
        confirmedAt: null,
        completedAt: null,
      })
      .run();
    if (selected.entries.length > 0) {
      tx.insert(externalActionBatchItems)
        .values(
          selected.entries.map(({ action, eligible, exclusionReason }, position) => ({
            id: randomUUID(),
            workspaceId,
            batchId,
            actionId: action.id,
            snapshotJson: JSON.stringify({
              position,
              actionFingerprint: action.fingerprint,
              actionUpdatedAt: action.updatedAt,
              kind: action.kind,
              campaignId: action.context.campaignId,
              impact: impactOf(action),
              eligible,
              exclusionReason,
            } satisfies StoredItemSnapshot),
            status: eligible ? "pending" : "skipped",
            submissionJson: null,
            error: null,
            processedAt: null,
          })),
        )
        .run();
    }
  });
  return getAuthorizationBatchDetail(db, workspaceId, batchId)!;
}

function outcomeOf(submission: ExternalActionSubmission): AuthorizationBatchItemStatus | null {
  switch (submission.action.status) {
    case "succeeded":
    case "scheduled":
    case "failed":
    case "blocked":
    case "stale":
      return submission.action.status;
    default:
      return null;
  }
}

function batchOutcome(items: AuthorizationBatchItem[]): AuthorizationBatchStatus {
  const included = items.filter((item) => item.eligible);
  const successful = included.filter(
    (item) => item.status === "succeeded" || item.status === "scheduled",
  ).length;
  if (included.length > 0 && successful === included.length) return "completed";
  if (successful > 0) return "partially_completed";
  return "failed";
}

export async function runAuthorizationBatch(
  db: Db,
  runtime: ExternalActionRuntime,
  workspaceId: string,
  batchId: string,
  actor: ExternalActionActor,
): Promise<AuthorizationBatchDetail> {
  const initial = getAuthorizationBatchDetail(db, workspaceId, batchId);
  if (!initial) throw new AuthorizationBatchNotFoundError();
  if (["completed", "partially_completed", "failed"].includes(initial.batch.status)) {
    return initial;
  }
  const confirmedAt = initial.batch.confirmedAt ?? Date.now();
  db.update(externalActionBatches)
    .set({ status: "running", confirmedAt, completedAt: null })
    .where(eq(externalActionBatches.id, batchId))
    .run();

  for (const item of initial.items) {
    if (!item.eligible || item.status !== "pending") continue;
    try {
      const submission = await runtime.authorize(item.actionId, workspaceId, actor);
      const status = outcomeOf(submission);
      if (!status) {
        throw new Error(`Authorization returned non-terminal status "${submission.action.status}".`);
      }
      db.update(externalActionBatchItems)
        .set({
          status,
          submissionJson: JSON.stringify(submission),
          error: null,
          processedAt: Date.now(),
        })
        .where(eq(externalActionBatchItems.id, item.id))
        .run();
    } catch (error) {
      if (error instanceof StaleExternalActionError) {
        db.update(externalActionBatchItems)
          .set({
            status: "stale",
            submissionJson: JSON.stringify({
              action: error.action,
              execution: error.action.execution,
            } satisfies ExternalActionSubmission),
            error: error.message,
            processedAt: Date.now(),
          })
          .where(eq(externalActionBatchItems.id, item.id))
          .run();
        continue;
      }
      db.update(externalActionBatchItems)
        .set({
          status: "failed",
          submissionJson: null,
          error: error instanceof Error ? error.message.slice(0, 1_000) : "Authorization failed",
          processedAt: Date.now(),
        })
        .where(eq(externalActionBatchItems.id, item.id))
        .run();
    }
  }

  const processed = getAuthorizationBatchDetail(db, workspaceId, batchId)!;
  db.update(externalActionBatches)
    .set({ status: batchOutcome(processed.items), completedAt: Date.now() })
    .where(eq(externalActionBatches.id, batchId))
    .run();
  return getAuthorizationBatchDetail(db, workspaceId, batchId)!;
}
