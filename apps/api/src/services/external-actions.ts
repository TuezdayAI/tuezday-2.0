import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  canTransitionExternalAction,
  type EffectiveExternalActionPolicy,
  type ExternalAction,
  type ExternalActionActor,
  type ExternalActionBlocker,
  type ExternalActionDecision,
  type ExternalActionDecisionValue,
  type ExternalActionDetail,
  type ExternalActionExecutionRef,
  type ExternalActionKind,
  type ExternalActionListFilters,
  type ExternalActionStatus,
  type ExternalActionSubject,
  type ExternalActionContext,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  externalActionDecisions,
  externalActions,
  type ExternalActionDecisionRow,
  type ExternalActionRow,
} from "../db/schema";

export class InvalidExternalActionTransitionError extends Error {
  constructor(from: ExternalActionStatus, to: ExternalActionStatus) {
    super(`Cannot transition an external action from "${from}" to "${to}".`);
    this.name = "InvalidExternalActionTransitionError";
  }
}

interface StoredSnapshot {
  subject: ExternalActionSubject;
  context: ExternalActionContext;
}

export interface NewExternalActionRecord {
  id: string;
  workspaceId: string;
  kind: ExternalActionKind;
  subject: ExternalActionSubject;
  context: ExternalActionContext;
  payload: unknown;
  requestedFor: number | null;
  idempotencyKey: string;
  fingerprint: string;
  policy: EffectiveExternalActionPolicy;
  actor: ExternalActionActor;
  supersedesActionId: string | null;
  draftId: string | null;
}

function snapshot(row: ExternalActionRow): StoredSnapshot {
  const parsed = JSON.parse(row.subjectSnapshotJson) as StoredSnapshot | ExternalActionSubject;
  if ("subject" in parsed && "context" in parsed) return parsed;
  return {
    subject: parsed,
    context: {
      campaignId: row.campaignId,
      campaignName: null,
      personaId: row.personaId,
      personaName: null,
      connectionId: row.connectionId,
      connectionName: null,
      laneRevisionId: row.laneRevisionId,
      laneName: null,
    },
  };
}

export function rowToExternalAction(row: ExternalActionRow): ExternalAction {
  const stored = snapshot(row);
  const execution = row.executionReceiptJson
    ? (JSON.parse(row.executionReceiptJson) as ExternalActionExecutionRef)
    : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as ExternalActionKind,
    status: row.status as ExternalActionStatus,
    subject: stored.subject,
    context: stored.context,
    requestedFor: row.requestedFor,
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    policy: JSON.parse(row.policySnapshotJson) as EffectiveExternalActionPolicy,
    blocker: row.blockerCode
      ? {
          code: row.blockerCode,
          message: row.blockerDetail ?? row.blockerCode,
          retryable: row.blockerRetryable ?? false,
        }
      : null,
    supersedesActionId: row.supersedesActionId,
    supersededByActionId: row.supersededByActionId,
    execution,
    proposedBy: { userId: row.proposedByUserId, label: row.proposedByLabel },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    authorizedAt: row.authorizedAt,
    dispatchedAt: row.dispatchedAt,
    completedAt: row.completedAt,
  };
}

function rowToDecision(row: ExternalActionDecisionRow): ExternalActionDecision {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actionId: row.actionId,
    decision: row.decision as ExternalActionDecisionValue,
    reason: row.reason,
    actor: { userId: row.actorUserId, label: row.actorLabel },
    subjectFingerprint: row.subjectFingerprint,
    policy: JSON.parse(row.policySnapshotJson) as EffectiveExternalActionPolicy,
    createdAt: row.createdAt,
  };
}

export function insertExternalAction(db: Db, input: NewExternalActionRecord): ExternalAction {
  const now = Date.now();
  const row: ExternalActionRow = {
    id: input.id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    status: "proposed",
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    // Subject identity is always durable; the relational link is populated
    // only after the concrete adapter establishes workspace ownership.
    draftId: input.draftId,
    campaignId: input.context.campaignId,
    personaId: input.context.personaId,
    connectionId: input.context.connectionId,
    laneRevisionId: input.context.laneRevisionId,
    payloadJson: JSON.stringify(input.payload),
    subjectSnapshotJson: JSON.stringify({ subject: input.subject, context: input.context }),
    requestedFor: input.requestedFor,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    policySnapshotJson: JSON.stringify(input.policy),
    blockerCode: null,
    blockerDetail: null,
    blockerRetryable: null,
    supersedesActionId: input.supersedesActionId,
    supersededByActionId: null,
    executionKind: null,
    executionId: null,
    executionReceiptJson: null,
    proposedByUserId: input.actor.userId,
    proposedByLabel: input.actor.label,
    createdAt: now,
    updatedAt: now,
    authorizedAt: null,
    dispatchedAt: null,
    completedAt: null,
  };
  db.insert(externalActions).values(row).run();
  return rowToExternalAction(row);
}

export function getExternalAction(
  db: Db,
  workspaceId: string,
  actionId: string,
): ExternalAction | undefined {
  const row = db
    .select()
    .from(externalActions)
    .where(and(eq(externalActions.workspaceId, workspaceId), eq(externalActions.id, actionId)))
    .get();
  return row ? rowToExternalAction(row) : undefined;
}

export function listExternalActions(
  db: Db,
  workspaceId: string,
  filters: ExternalActionListFilters,
): ExternalAction[] {
  return db
    .select()
    .from(externalActions)
    .where(eq(externalActions.workspaceId, workspaceId))
    .orderBy(desc(externalActions.createdAt))
    .all()
    .map(rowToExternalAction)
    .filter((action) => !filters.status || action.status === filters.status)
    .filter((action) => !filters.kind || action.kind === filters.kind)
    .filter((action) => !filters.campaign || action.context.campaignId === filters.campaign)
    .filter((action) => !filters.channel || action.subject.channel === filters.channel)
    .slice(0, filters.limit);
}

export function getExternalActionPayload(db: Db, actionId: string): unknown {
  const row = db
    .select({ payloadJson: externalActions.payloadJson })
    .from(externalActions)
    .where(eq(externalActions.id, actionId))
    .get();
  return row ? JSON.parse(row.payloadJson) : undefined;
}

export function findExternalActionByIdempotencyKey(
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
): ExternalAction | undefined {
  const row = db
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        eq(externalActions.idempotencyKey, idempotencyKey),
      ),
    )
    .get();
  return row ? rowToExternalAction(row) : undefined;
}

export function getExternalActionDetail(
  db: Db,
  workspaceId: string,
  actionId: string,
): ExternalActionDetail | undefined {
  const action = getExternalAction(db, workspaceId, actionId);
  if (!action) return undefined;
  const decisions = db
    .select()
    .from(externalActionDecisions)
    .where(
      and(
        eq(externalActionDecisions.workspaceId, workspaceId),
        eq(externalActionDecisions.actionId, actionId),
      ),
    )
    .orderBy(desc(externalActionDecisions.createdAt))
    .all()
    .map(rowToDecision);
  return { action, decisions };
}

export function transitionExternalAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  to: ExternalActionStatus,
  options: {
    blocker?: ExternalActionBlocker | null;
    execution?: ExternalActionExecutionRef | null;
    authorizedAt?: number | null;
    dispatchedAt?: number | null;
    completedAt?: number | null;
  } = {},
): ExternalAction {
  const action = getExternalAction(db, workspaceId, actionId);
  if (!action) throw new Error("External action not found");
  if (!canTransitionExternalAction(action.status, to)) {
    throw new InvalidExternalActionTransitionError(action.status, to);
  }
  const now = Date.now();
  const execution = options.execution;
  db.update(externalActions)
    .set({
      status: to,
      blockerCode: options.blocker?.code ?? null,
      blockerDetail: options.blocker?.message ?? null,
      blockerRetryable: options.blocker?.retryable ?? null,
      executionKind: execution?.kind ?? action.execution?.kind ?? null,
      executionId: execution?.id ?? action.execution?.id ?? null,
      executionReceiptJson:
        execution === null
          ? null
          : execution
            ? JSON.stringify(execution)
            : action.execution
              ? JSON.stringify(action.execution)
              : null,
      authorizedAt: options.authorizedAt === undefined ? action.authorizedAt : options.authorizedAt,
      dispatchedAt: options.dispatchedAt === undefined ? action.dispatchedAt : options.dispatchedAt,
      completedAt: options.completedAt === undefined ? action.completedAt : options.completedAt,
      updatedAt: now,
    })
    .where(eq(externalActions.id, actionId))
    .run();
  return getExternalAction(db, workspaceId, actionId)!;
}

export function insertExternalActionDecision(
  db: Db,
  action: ExternalAction,
  decision: ExternalActionDecisionValue,
  actor: ExternalActionActor,
  reason: string | null,
): void {
  db.insert(externalActionDecisions)
    .values({
      id: randomUUID(),
      workspaceId: action.workspaceId,
      actionId: action.id,
      decision,
      reason,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      subjectFingerprint: action.fingerprint,
      policySnapshotJson: JSON.stringify(action.policy),
      createdAt: Date.now(),
    })
    .run();
}

export function linkExternalActionSuccessor(
  db: Db,
  actionId: string,
  successorId: string,
): void {
  db.update(externalActions)
    .set({ supersededByActionId: successorId, updatedAt: Date.now() })
    .where(eq(externalActions.id, actionId))
    .run();
}

const TERMINAL_EXTERNAL_ACTION_STATUSES: ReadonlySet<ExternalActionStatus> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "stale",
  "cancelled",
]);

/** Completed attempts against one subject — used to derive fresh idempotency
 * keys so a founder can retry a failed/blocked/denied attempt from the owning
 * surface without colliding with the prior durable action. */
export function countTerminalExternalActionsForSubject(
  db: Db,
  workspaceId: string,
  kind: ExternalActionKind,
  subjectId: string,
): number {
  return db
    .select({ status: externalActions.status })
    .from(externalActions)
    .where(
      and(
        eq(externalActions.workspaceId, workspaceId),
        eq(externalActions.kind, kind),
        eq(externalActions.subjectId, subjectId),
      ),
    )
    .all()
    .filter((row) => TERMINAL_EXTERNAL_ACTION_STATUSES.has(row.status as ExternalActionStatus))
    .length;
}

export function listRunnableExternalActions(db: Db, workspaceId: string): ExternalAction[] {
  return db
    .select()
    .from(externalActions)
    .where(eq(externalActions.workspaceId, workspaceId))
    .orderBy(externalActions.createdAt)
    .all()
    .map(rowToExternalAction)
    .filter(
      (action) =>
        action.status === "authorized" ||
        (action.status === "scheduled" && (action.requestedFor ?? 0) <= Date.now()),
    );
}
