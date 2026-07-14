import { randomUUID } from "node:crypto";
import {
  canTransitionExternalAction,
  type EffectiveExternalActionPolicy,
  type ExternalAction,
  type ExternalActionActor,
  type ExternalActionBlocker,
  type ExternalActionContext,
  type ExternalActionExecutionRef,
  type ExternalActionKind,
  type ExternalActionSubmission,
  type ExternalActionSubject,
} from "@tuezday/contracts";
import type { AnalyticsSink } from "../analytics/sink";
import { NoopSink } from "../analytics/sink";
import { track } from "../analytics/track";
import type { Db } from "../db";
import { externalActionDecisions, externalActions } from "../db/schema";
import { canonicalActionFingerprint } from "./external-action-fingerprint";
import { resolveExternalActionPolicy } from "./external-action-policy";
import {
  InvalidExternalActionTransitionError,
  findExternalActionByIdempotencyKey,
  getExternalAction,
  getExternalActionPayload,
  insertExternalAction,
  linkExternalActionSuccessor,
  listRunnableExternalActions,
  transitionExternalAction,
} from "./external-actions";
import { eq } from "drizzle-orm";

export interface ExternalActionIntent {
  subject: ExternalActionSubject;
  context: ExternalActionContext;
  payload: unknown;
  requestedFor: number | null;
}

export interface ExternalActionCommand extends ExternalActionIntent {
  workspaceId: string;
  kind: ExternalActionKind;
  idempotencyKey: string;
}

export interface ExternalActionAdapter {
  revalidate(action: ExternalAction, payload: unknown): Promise<ExternalActionIntent>;
  guard(action: ExternalAction, payload: unknown): Promise<ExternalActionBlocker | null>;
  execute(action: ExternalAction, payload: unknown): Promise<ExternalActionExecutionRef>;
}

export type ExternalActionAdapterRegistry = Partial<
  Record<ExternalActionKind, ExternalActionAdapter>
>;

export class ExternalActionNotFoundError extends Error {
  constructor() {
    super("External action not found");
    this.name = "ExternalActionNotFoundError";
  }
}

export class ExternalActionIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key already identifies a different external action.");
    this.name = "ExternalActionIdempotencyConflictError";
  }
}

export class StaleExternalActionError extends Error {
  constructor(public readonly action: ExternalAction) {
    super("The external action changed after it was proposed.");
    this.name = "StaleExternalActionError";
  }
}

export interface ExternalActionRuntime {
  propose(command: ExternalActionCommand, actor: ExternalActionActor): Promise<ExternalActionSubmission>;
  authorize(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionActor,
  ): Promise<ExternalActionSubmission>;
  deny(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionActor,
    reason: string | null,
  ): Promise<ExternalActionSubmission>;
  repropose(
    actionId: string,
    workspaceId: string,
    idempotencyKey: string,
    actor: ExternalActionActor,
  ): Promise<ExternalActionSubmission>;
  run(workspaceId: string): Promise<ExternalActionSubmission[]>;
}

function policyFor(
  db: Db,
  workspaceId: string,
  kind: ExternalActionKind,
  context: ExternalActionContext,
): EffectiveExternalActionPolicy {
  return resolveExternalActionPolicy(db, {
    workspaceId,
    actionKind: kind,
    campaignId: context.campaignId,
    personaId: context.personaId,
    connectionId: context.connectionId,
    laneRevisionId: context.laneRevisionId,
  });
}

function fingerprintFor(
  workspaceId: string,
  kind: ExternalActionKind,
  intent: ExternalActionIntent,
  policy: EffectiveExternalActionPolicy,
): string {
  return canonicalActionFingerprint({
    workspaceId,
    kind,
    subject: intent.subject,
    context: intent.context,
    payload: intent.payload ?? null,
    requestedFor: intent.requestedFor ?? null,
    policy: {
      effective: policy.effective,
      contributingRules: policy.contributingRules.map(({ scope, scopeId, rule }) => ({
        scope,
        scopeId,
        rule,
      })),
    },
  });
}

function submission(action: ExternalAction): ExternalActionSubmission {
  return { action, execution: action.execution };
}

export function createExternalActionRuntime({
  db,
  adapters,
  analytics = new NoopSink(),
}: {
  db: Db;
  adapters: ExternalActionAdapterRegistry;
  analytics?: AnalyticsSink;
}): ExternalActionRuntime {
  async function currentFingerprint(
    action: ExternalAction,
    adapter: ExternalActionAdapter,
  ): Promise<{ intent: ExternalActionIntent; policy: EffectiveExternalActionPolicy; value: string }> {
    const intent = await adapter.revalidate(action, getExternalActionPayload(db, action.id));
    const policy = policyFor(db, action.workspaceId, action.kind, intent.context);
    return {
      intent,
      policy,
      value: fingerprintFor(action.workspaceId, action.kind, intent, policy),
    };
  }

  function stale(action: ExternalAction): ExternalAction {
    return transitionExternalAction(db, action.workspaceId, action.id, "stale", {
      blocker: {
        code: "subject_changed",
        message: "The subject, destination, timing, context, or effective policy changed.",
        retryable: false,
      },
      completedAt: Date.now(),
    });
  }

  async function dispatch(actionId: string, workspaceId: string): Promise<ExternalActionSubmission> {
    let action = getExternalAction(db, workspaceId, actionId);
    if (!action) throw new ExternalActionNotFoundError();
    const adapter = adapters[action.kind];
    if (!adapter) {
      action = transitionExternalAction(db, workspaceId, action.id, "blocked", {
        blocker: {
          code: "unsupported_adapter",
          message: "This external action adapter is not available in the current stage.",
          retryable: false,
        },
        completedAt: Date.now(),
      });
      return submission(action);
    }

    const current = await currentFingerprint(action, adapter);
    if (current.value !== action.fingerprint) {
      return submission(stale(action));
    }

    const payload = getExternalActionPayload(db, action.id);
    const blocker = await adapter.guard(action, payload);
    if (blocker) {
      action = transitionExternalAction(db, workspaceId, action.id, "blocked", {
        blocker,
        completedAt: Date.now(),
      });
      return submission(action);
    }
    if (action.requestedFor !== null && action.requestedFor > Date.now()) {
      if (action.status !== "scheduled") {
        action = transitionExternalAction(db, workspaceId, action.id, "scheduled");
      }
      return submission(action);
    }

    action = transitionExternalAction(db, workspaceId, action.id, "dispatching", {
      dispatchedAt: Date.now(),
    });
    try {
      const receipt = await adapter.execute(action, payload);
      action = transitionExternalAction(
        db,
        workspaceId,
        action.id,
        receipt.error ? "failed" : "succeeded",
        { execution: receipt, completedAt: Date.now() },
      );
    } catch {
      action = transitionExternalAction(db, workspaceId, action.id, "failed", {
        completedAt: Date.now(),
      });
    }
    return submission(action);
  }

  async function proposeWithLineage(
    command: ExternalActionCommand,
    actor: ExternalActionActor,
    supersedesActionId: string | null,
  ): Promise<ExternalActionSubmission> {
    const intent: ExternalActionIntent = {
      subject: command.subject,
      context: command.context,
      payload: command.payload ?? null,
      requestedFor: command.requestedFor ?? null,
    };
    const policy = policyFor(db, command.workspaceId, command.kind, intent.context);
    const fingerprint = fingerprintFor(command.workspaceId, command.kind, intent, policy);
    const existing = findExternalActionByIdempotencyKey(
      db,
      command.workspaceId,
      command.idempotencyKey,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ExternalActionIdempotencyConflictError();
      }
      return submission(existing);
    }

    let action = insertExternalAction(db, {
      id: randomUUID(),
      workspaceId: command.workspaceId,
      kind: command.kind,
      subject: intent.subject,
      context: intent.context,
      payload: intent.payload,
      requestedFor: intent.requestedFor,
      idempotencyKey: command.idempotencyKey,
      fingerprint,
      policy,
      actor,
      supersedesActionId,
    });
    if (supersedesActionId) linkExternalActionSuccessor(db, supersedesActionId, action.id);

    if (!adapters[action.kind]) {
      action = transitionExternalAction(db, action.workspaceId, action.id, "blocked", {
        blocker: {
          code: "unsupported_adapter",
          message: "This external action adapter is not available in the current stage.",
          retryable: false,
        },
        completedAt: Date.now(),
      });
      return submission(action);
    }
    if (policy.effective === "human_required") {
      action = transitionExternalAction(db, action.workspaceId, action.id, "authorization_required");
      return submission(action);
    }
    action = transitionExternalAction(db, action.workspaceId, action.id, "authorized", {
      authorizedAt: Date.now(),
    });
    return dispatch(action.id, action.workspaceId);
  }

  return {
    propose(command, actor) {
      return proposeWithLineage(command, actor, null);
    },

    async authorize(actionId, workspaceId, actor) {
      const action = getExternalAction(db, workspaceId, actionId);
      if (!action) throw new ExternalActionNotFoundError();
      if (!canTransitionExternalAction(action.status, "authorized")) {
        throw new InvalidExternalActionTransitionError(action.status, "authorized");
      }
      const adapter = adapters[action.kind];
      if (!adapter) throw new InvalidExternalActionTransitionError(action.status, "blocked");
      const current = await currentFingerprint(action, adapter);
      if (current.value !== action.fingerprint) throw new StaleExternalActionError(stale(action));

      const now = Date.now();
      db.transaction((tx) => {
        tx.insert(externalActionDecisions)
          .values({
            id: randomUUID(),
            workspaceId,
            actionId,
            decision: "authorize",
            reason: null,
            actorUserId: actor.userId,
            actorLabel: actor.label,
            subjectFingerprint: action.fingerprint,
            policySnapshotJson: JSON.stringify(action.policy),
            createdAt: now,
          })
          .run();
        tx.update(externalActions)
          .set({ status: "authorized", authorizedAt: now, updatedAt: now })
          .where(eq(externalActions.id, actionId))
          .run();
      });
      if (actor.userId) {
        track(db, analytics, {
          event: "review.action_authorized",
          distinctId: actor.userId,
          workspaceId,
          properties: { action_id: actionId, action_kind: action.kind },
        });
      }
      return dispatch(actionId, workspaceId);
    },

    async deny(actionId, workspaceId, actor, reason) {
      const action = getExternalAction(db, workspaceId, actionId);
      if (!action) throw new ExternalActionNotFoundError();
      if (!canTransitionExternalAction(action.status, "cancelled")) {
        throw new InvalidExternalActionTransitionError(action.status, "cancelled");
      }
      const now = Date.now();
      db.transaction((tx) => {
        tx.insert(externalActionDecisions)
          .values({
            id: randomUUID(),
            workspaceId,
            actionId,
            decision: "deny",
            reason,
            actorUserId: actor.userId,
            actorLabel: actor.label,
            subjectFingerprint: action.fingerprint,
            policySnapshotJson: JSON.stringify(action.policy),
            createdAt: now,
          })
          .run();
        tx.update(externalActions)
          .set({ status: "cancelled", completedAt: now, updatedAt: now })
          .where(eq(externalActions.id, actionId))
          .run();
      });
      return submission(getExternalAction(db, workspaceId, actionId)!);
    },

    async repropose(actionId, workspaceId, idempotencyKey, actor) {
      const action = getExternalAction(db, workspaceId, actionId);
      if (!action) throw new ExternalActionNotFoundError();
      if (action.status !== "stale" && action.status !== "blocked") {
        throw new InvalidExternalActionTransitionError(action.status, "proposed");
      }
      const adapter = adapters[action.kind];
      const intent = adapter
        ? await adapter.revalidate(action, getExternalActionPayload(db, action.id))
        : {
            subject: action.subject,
            context: action.context,
            payload: getExternalActionPayload(db, action.id),
            requestedFor: action.requestedFor,
          };
      return proposeWithLineage(
        {
          workspaceId,
          kind: action.kind,
          idempotencyKey,
          ...intent,
        },
        actor,
        action.id,
      );
    },

    async run(workspaceId) {
      const results: ExternalActionSubmission[] = [];
      for (const action of listRunnableExternalActions(db, workspaceId)) {
        try {
          results.push(await dispatch(action.id, workspaceId));
        } catch {
          const durable = getExternalAction(db, workspaceId, action.id);
          if (durable) results.push(submission(durable));
        }
      }
      return results;
    },
  };
}
