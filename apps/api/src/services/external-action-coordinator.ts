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
  type ExternalActionOrigin,
  type ExternalActionOriginSurface,
  type ExternalActionStatus,
  type ExternalActionSubmission,
  type ExternalActionSubject,
} from "@tuezday/contracts";
import type { AnalyticsSink } from "../analytics/sink";
import { NoopSink } from "../analytics/sink";
import { track } from "../analytics/track";
import type { Db } from "../db";
import { externalActionDecisions, externalActions } from "../db/schema";
import { humanApprovalCoveringDraft } from "./drafts";
import { canonicalActionFingerprint } from "./external-action-fingerprint";
import { resolveExternalActionPolicy } from "./external-action-policy";
import { ExternalActionPreparationError } from "./external-action-preparation";
import {
  InvalidExternalActionTransitionError,
  findExternalActionByIdempotencyKey,
  getExternalAction,
  getExternalActionPayload,
  insertExternalAction,
  linkExternalActionSuccessor,
  listRunnableExternalActions,
  transitionExternalAction,
  updateExternalActionExecution,
} from "./external-actions";
import { eq } from "drizzle-orm";

/** Why a publish action was authorized without a second click (Sprint 52). */
export const COLLAPSED_FROM_DRAFT_APPROVAL =
  "Authorized by the draft approval — the approved content is unchanged.";

/** Why an already-authorized action never went out. */
export const WITHDRAWN_BEFORE_DISPATCH = "Withdrawn before it was dispatched.";

/**
 * A withdrawal and a denial both end `cancelled` and both record
 * `decision: "deny"` (the decision vocabulary is fixed), so the persisted reason
 * is the *only* thing that can still tell them apart. The marker is therefore
 * always recorded and a founder-supplied reason is appended to it, never
 * substituted for it — otherwise explaining yourself would erase the
 * distinction exactly when the record is most worth reading.
 *
 * It also names the status the action was withdrawn *from*. `cancel` is legal
 * wherever the state machine allows `cancelled`, which includes `failed` and
 * `blocked` — claiming "before it was dispatched" against an action that did
 * dispatch would put a falsehood in the governance record.
 */
export function withdrawalReason(
  from: ExternalActionStatus,
  reason: string | null,
): string {
  const marker =
    from === "authorized" || from === "scheduled"
      ? WITHDRAWN_BEFORE_DISPATCH
      : `Withdrawn while ${from.replaceAll("_", " ")}.`;
  return reason ? `${marker} ${reason}` : marker;
}

/**
 * Who is driving a runtime entry point, with humanity stated rather than
 * guessed (Sprint 52 follow-up, mirroring `DraftActor.human`).
 *
 * It cannot be derived from `userId`: the signed email/Telegram approve links
 * are people with no user id, and the worker is a machine with none either.
 * The persisted decision row keeps the flag, because "did a person refuse
 * this?" is a governance question that outlives the request — a cadence uses
 * exactly that to tell a founder's withdrawal from the automation kill switch
 * cancelling in bulk. Non-human is the safe default for any new caller: it
 * never collapses a gate and never makes a stop permanent.
 */
export interface ExternalActionRuntimeActor extends ExternalActionActor {
  human: boolean;
  /**
   * Sprint 69: who *originated* the proposal, which the actor alone cannot
   * say. A cadence and an agent propose tool both arrive as the system actor
   * with no user id, and the authorization queue has to tell them apart.
   * Omitted means the honest default — a person if there is a user id, the
   * platform otherwise. Never part of the fingerprint (D-69.3).
   */
  origin?: ExternalActionOrigin;
  originRunId?: string | null;
  /** Sprint 78: which agent surface asked — chat or the pipeline engine. */
  originSurface?: ExternalActionOriginSurface | null;
}

export interface ExternalActionIntent {
  subject: ExternalActionSubject;
  context: ExternalActionContext;
  payload: unknown;
  requestedFor: number | null;
  links?: { draftId?: string | null };
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
  /**
   * Optional pre-authorization guard (Sprint 54, D4b).
   *
   * `guard` runs inside `dispatch`, which is reached only *after* the action is
   * `authorized` and *after* the `externalActionDecisions` row is written — so
   * a guardrail that was always going to refuse still left "X authorized this
   * spend" on the governance record first. `authorization_required → blocked`
   * is not a legal edge, so the refusal cannot be moved to the gate; it belongs
   * at proposal, where `proposed → blocked` already is legal.
   *
   * Implement it for the conditions knowable before anyone is asked to
   * authorize — a workspace kill switch, a committed-budget cap. Conditions
   * that can only be read at send time stay in `guard`, which keeps running as
   * the backstop for anything that changes while the action sits in the queue.
   */
  guardAtProposal?(
    action: ExternalAction,
    payload: unknown,
  ): Promise<ExternalActionBlocker | null>;
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
  propose(
    command: ExternalActionCommand,
    actor: ExternalActionRuntimeActor,
  ): Promise<ExternalActionSubmission>;
  /**
   * Like `propose`, but always parks the action at `authorization_required` for
   * a human to authorize — it never auto-dispatches, even under an autonomous
   * policy. Used by the copilot (Sprint 42 P2) so a proposed action can never
   * send itself; the normal authorize gate still applies.
   */
  proposeForReview(
    command: ExternalActionCommand,
    actor: ExternalActionRuntimeActor,
  ): Promise<ExternalActionSubmission>;
  authorize(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionRuntimeActor,
  ): Promise<ExternalActionSubmission>;
  deny(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionRuntimeActor,
    reason: string | null,
  ): Promise<ExternalActionSubmission>;
  /**
   * Withdraw an action that was already authorized, before it leaves the
   * building. `deny` answers a request sitting in the authorization queue; a
   * collapsed publish (Sprint 52) never sits there, so this is the only way to
   * stop one. Legal for anything the contracts state machine still lets reach
   * `cancelled` — never for `succeeded`, which has no such edge.
   */
  cancel(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionRuntimeActor,
    reason: string | null,
  ): Promise<ExternalActionSubmission>;
  repropose(
    actionId: string,
    workspaceId: string,
    idempotencyKey: string,
    actor: ExternalActionRuntimeActor,
  ): Promise<ExternalActionSubmission>;
  run(workspaceId: string): Promise<ExternalActionSubmission[]>;
}

async function policyFor(
  db: Db,
  workspaceId: string,
  kind: ExternalActionKind,
  context: ExternalActionContext,
): Promise<EffectiveExternalActionPolicy> {
  return await resolveExternalActionPolicy(db, {
    workspaceId,
    actionKind: kind,
    campaignId: context.campaignId,
    personaId: context.personaId,
    connectionId: context.connectionId,
    laneRevisionId: context.laneRevisionId,
  });
}

export function fingerprintExternalActionIntent(
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
    links: { draftId: intent.links?.draftId ?? null },
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

function unavailableAdapterBlocker(kind: ExternalActionKind): ExternalActionBlocker {
  return {
    code: "adapter_unavailable",
    message: `The ${kind.replaceAll("_", " ")} adapter is not available in the current stage.`,
    retryable: false,
  };
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
  /**
   * Revalidation has two failure modes and they mean the same thing.
   *
   * The adapter can return a *different* intent (the fingerprint no longer
   * matches), or it can refuse to build one at all — `publishIntent` throws
   * `ExternalActionPreparationError` when the draft left `approved`, the
   * connection was deleted, or the persona lost its routing. Both say "what was
   * proposed no longer holds", so both must resolve to `stale`. Letting the
   * preparation error escape instead reported a bare conflict to the founder
   * and left the action sitting in the queue, re-failing on every click
   * (Sprint 52 §3.3). A `revalidated: false` result is that refusal; anything
   * else still throws, because an unknown fault must not be laundered into
   * staleness.
   */
  type Revalidation =
    | {
        revalidated: true;
        intent: ExternalActionIntent;
        policy: EffectiveExternalActionPolicy;
        value: string;
      }
    | { revalidated: false };

  async function currentFingerprint(
    action: ExternalAction,
    adapter: ExternalActionAdapter,
  ): Promise<Revalidation> {
    let intent: ExternalActionIntent;
    try {
      intent = await adapter.revalidate(action, await getExternalActionPayload(db, action.id));
    } catch (error) {
      if (error instanceof ExternalActionPreparationError) return { revalidated: false };
      throw error;
    }
    const policy = await policyFor(db, action.workspaceId, action.kind, intent.context);
    return {
      revalidated: true,
      intent,
      policy,
      value: fingerprintExternalActionIntent(action.workspaceId, action.kind, intent, policy),
    };
  }

  /** True when the action is no longer what was proposed — either revalidation
   * refused it, or it revalidated to a different fingerprint. */
  function diverged(action: ExternalAction, current: Revalidation): boolean {
    return !current.revalidated || current.value !== action.fingerprint;
  }

  async function stale(action: ExternalAction): Promise<ExternalAction> {
    return await transitionExternalAction(db, action.workspaceId, action.id, "stale", {
      blocker: {
        code: "subject_changed",
        message: "The subject, destination, timing, context, or effective policy changed.",
        retryable: false,
      },
      completedAt: Date.now(),
    });
  }

  async function dispatch(actionId: string, workspaceId: string): Promise<ExternalActionSubmission> {
    let action = await getExternalAction(db, workspaceId, actionId);
    if (!action) throw new ExternalActionNotFoundError();
    const adapter = adapters[action.kind];
    if (!adapter) {
      action = await transitionExternalAction(db, workspaceId, action.id, "blocked", {
        blocker: unavailableAdapterBlocker(action.kind),
        completedAt: Date.now(),
      });
      return submission(action);
    }

    const current = await currentFingerprint(action, adapter);
    if (diverged(action, current)) {
      // `dispatching` has no edge to `stale` — an in-flight attempt with an
      // unknown outcome must not be rewritten underneath itself. Leave it for
      // the durable adapter to resolve rather than throwing an illegal
      // transition out of the runner.
      return submission(
        canTransitionExternalAction(action.status, "stale") ? await stale(action) : action,
      );
    }

    const payload = await getExternalActionPayload(db, action.id);
    const blocker = await adapter.guard(action, payload);
    if (blocker) {
      // An in-flight provider operation cannot truthfully move backward to
      // blocked. Keep it dispatching and retry after the reversible condition
      // (for example the kill switch) clears.
      if (action.status === "dispatching") return submission(action);
      action = await transitionExternalAction(db, workspaceId, action.id, "blocked", {
        blocker,
        completedAt: Date.now(),
      });
      return submission(action);
    }
    if (action.requestedFor !== null && action.requestedFor > Date.now()) {
      if (action.status !== "scheduled") {
        action = await transitionExternalAction(db, workspaceId, action.id, "scheduled");
      }
      return submission(action);
    }

    if (action.status !== "dispatching") {
      action = await transitionExternalAction(db, workspaceId, action.id, "dispatching", {
        dispatchedAt: Date.now(),
      });
    }
    try {
      const receipt = await adapter.execute(action, payload);
      const inFlightPublication =
        receipt.kind === "publication" &&
        !receipt.error &&
        (receipt.status === "processing" || receipt.status === "scheduled");
      action = inFlightPublication
        ? await updateExternalActionExecution(db, workspaceId, action.id, receipt)
        : await transitionExternalAction(
            db,
            workspaceId,
            action.id,
            receipt.error ? "failed" : "succeeded",
            { execution: receipt, completedAt: Date.now() },
          );
    } catch {
      // A thrown adapter error has an unknown outcome. Keep the action dispatching
      // so the durable adapter can recover or retry with the same idempotency key.
      action = (await getExternalAction(db, workspaceId, action.id))!;
    }
    return submission(action);
  }

  /**
   * The one way an action reaches `cancelled`: a decision on the record and the
   * status change committed together, so the audit trail can never claim a
   * refusal that did not take effect. Shared by `deny` (answering a queued
   * request) and `cancel` (withdrawing an authorization already granted) —
   * different questions, identical durable consequence.
   */
  async function recordCancellation(
    actionId: string,
    workspaceId: string,
    actor: ExternalActionRuntimeActor,
    // Built from the action, because the reason a withdrawal records depends on
    // the status it is withdrawing from — which only this function has read.
    reasonFor: (action: ExternalAction) => string | null,
  ): Promise<ExternalActionSubmission> {
    const action = await getExternalAction(db, workspaceId, actionId);
    if (!action) throw new ExternalActionNotFoundError();
    if (!canTransitionExternalAction(action.status, "cancelled")) {
      throw new InvalidExternalActionTransitionError(action.status, "cancelled");
    }
    const reason = reasonFor(action);
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.insert(externalActionDecisions)
        .values({
          id: randomUUID(),
          workspaceId,
          actionId,
          decision: "deny",
          reason,
          actorUserId: actor.userId,
          actorLabel: actor.label,
          actorHuman: actor.human,
          subjectFingerprint: action.fingerprint,
          policySnapshotJson: JSON.stringify(action.policy),
          createdAt: now,
        });
      await tx.update(externalActions)
        .set({ status: "cancelled", completedAt: now, updatedAt: now })
        .where(eq(externalActions.id, actionId));
    });
    return submission((await getExternalAction(db, workspaceId, actionId))!);
  }

  async function proposeWithLineage(
    command: ExternalActionCommand,
    actor: ExternalActionRuntimeActor,
    supersedesActionId: string | null,
    // When true, always park the action at `authorization_required` for a human
    // to clear — never auto-authorize/dispatch, regardless of effective policy.
    // Copilot-initiated proposals (Sprint 42 P2) use this: the in-chat confirm
    // is a request to *propose*, never to send. The normal authorize gate still
    // applies on top.
    forceReview = false,
  ): Promise<ExternalActionSubmission> {
    const intent: ExternalActionIntent = {
      subject: command.subject,
      context: command.context,
      payload: command.payload ?? null,
      requestedFor: command.requestedFor ?? null,
      links: { draftId: command.links?.draftId ?? null },
    };
    const policy = await policyFor(db, command.workspaceId, command.kind, intent.context);
    const fingerprint = fingerprintExternalActionIntent(
      command.workspaceId,
      command.kind,
      intent,
      policy,
    );
    const existing = await findExternalActionByIdempotencyKey(
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

    let action = await insertExternalAction(db, {
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
      ...(actor.origin ? { origin: actor.origin } : {}),
      originRunId: actor.originRunId ?? null,
      originSurface: actor.originSurface ?? null,
      supersedesActionId,
      draftId: intent.links?.draftId ?? null,
    });
    if (supersedesActionId) await linkExternalActionSuccessor(db, supersedesActionId, action.id);

    const adapter = adapters[action.kind];
    if (!adapter) {
      action = await transitionExternalAction(db, action.workspaceId, action.id, "blocked", {
        blocker: unavailableAdapterBlocker(action.kind),
        completedAt: Date.now(),
      });
      return submission(action);
    }

    // Sprint 54 (D4b) — refuse before anyone is asked to authorize. This sits
    // ahead of both the human_required branch and the autonomous dispatch, so a
    // blocker here means no decision row is ever written and no adapter is ever
    // dispatched. `guard` still runs in `dispatch` as the backstop.
    const proposalBlocker = adapter.guardAtProposal
      ? await adapter.guardAtProposal(action, intent.payload)
      : null;
    if (proposalBlocker) {
      action = await transitionExternalAction(db, action.workspaceId, action.id, "blocked", {
        blocker: proposalBlocker,
        completedAt: Date.now(),
      });
      return submission(action);
    }

    if (forceReview || policy.effective === "human_required") {
      // Sprint 52 (D2) — the collapsed publish gate. Approving a draft is the
      // decision "this may go out"; for `publish` it also authorizes the
      // publication, so a founder clicks once instead of twice. It applies
      // only when a human approved (D2a/D2c: a system or public-API approval
      // records no fingerprint) and the approved content still stands, so
      // editing after approval re-arms this gate. The five other kinds keep
      // their second gate unconditionally, and a copilot proposal
      // (`forceReview`) is never allowed to send itself.
      //
      // A repropose (`supersedesActionId`) never collapses. Its predecessor
      // went stale because the subject, destination, timing, context or
      // effective policy changed — precisely what the approval fingerprint,
      // which covers content and media only, cannot see. Putting a corrected
      // action back in the queue must ask a human about the change.
      const draftId = intent.links?.draftId ?? null;
      const collapsible =
        !forceReview &&
        supersedesActionId === null &&
        action.kind === "publish" &&
        draftId !== null &&
        canTransitionExternalAction(action.status, "authorized");
      const approval = collapsible
        ? await humanApprovalCoveringDraft(db, action.workspaceId, draftId!)
        : null;
      if (!approval) {
        action = await transitionExternalAction(
          db,
          action.workspaceId,
          action.id,
          "authorization_required",
        );
        return submission(action);
      }

      // Both gates stay on the record, and the authorization is attributed to
      // the human who approved the draft — not to the proposer, which for the
      // cadence path is the system actor. Decision and status move together,
      // as in `authorize()`: a decision row asserting "authorized by <human>"
      // against an action still sitting at `proposed` would be a false
      // governance record. `dispatch()` stays outside the transaction.
      const collapsedAt = Date.now();
      const collapsedActionId = action.id;
      await db.transaction(async (tx) => {
        await tx.insert(externalActionDecisions)
          .values({
            id: randomUUID(),
            workspaceId: action.workspaceId,
            actionId: collapsedActionId,
            decision: "authorize",
            reason: COLLAPSED_FROM_DRAFT_APPROVAL,
            actorUserId: approval.actorId,
            // `humanApprovalCoveringDraft` returns only human approvals.
            actorHuman: true,
            actorLabel: approval.actor,
            subjectFingerprint: action.fingerprint,
            policySnapshotJson: JSON.stringify(action.policy),
            createdAt: collapsedAt,
          });
        await tx.update(externalActions)
          .set({ status: "authorized", authorizedAt: collapsedAt, updatedAt: collapsedAt })
          .where(eq(externalActions.id, collapsedActionId));
      });
      // There is no click to attribute here, but there *is* an authorization,
      // and it belongs to the human who approved the draft. Without this the
      // funnel would read the collapse as authorizations disappearing. It is a
      // distinct event so `review.action_authorized` keeps meaning "someone
      // pressed Authorize"; total authorizations is the sum of the two.
      if (approval.actorId) {
        await track(db, analytics, {
          event: "review.action_authorized_collapsed",
          distinctId: approval.actorId,
          workspaceId: action.workspaceId,
          properties: { action_id: collapsedActionId, action_kind: action.kind },
        });
      }
      return await dispatch(collapsedActionId, action.workspaceId);
    }
    action = await transitionExternalAction(db, action.workspaceId, action.id, "authorized", {
      authorizedAt: Date.now(),
    });
    return await dispatch(action.id, action.workspaceId);
  }

  return {
    async propose(command, actor) {
      return await proposeWithLineage(command, actor, null);
    },

    async proposeForReview(command, actor) {
      return await proposeWithLineage(command, actor, null, true);
    },

    async authorize(actionId, workspaceId, actor) {
      const action = await getExternalAction(db, workspaceId, actionId);
      if (!action) throw new ExternalActionNotFoundError();
      if (!canTransitionExternalAction(action.status, "authorized")) {
        throw new InvalidExternalActionTransitionError(action.status, "authorized");
      }
      const adapter = adapters[action.kind];
      if (!adapter) throw new InvalidExternalActionTransitionError(action.status, "blocked");
      const current = await currentFingerprint(action, adapter);
      if (diverged(action, current)) throw new StaleExternalActionError(await stale(action));

      const now = Date.now();
      await db.transaction(async (tx) => {
        await tx.insert(externalActionDecisions)
          .values({
            id: randomUUID(),
            workspaceId,
            actionId,
            decision: "authorize",
            reason: null,
            actorUserId: actor.userId,
            actorLabel: actor.label,
            actorHuman: actor.human,
            subjectFingerprint: action.fingerprint,
            policySnapshotJson: JSON.stringify(action.policy),
            createdAt: now,
          });
        await tx.update(externalActions)
          .set({ status: "authorized", authorizedAt: now, updatedAt: now })
          .where(eq(externalActions.id, actionId));
      });
      if (actor.userId) {
        await track(db, analytics, {
          event: "review.action_authorized",
          distinctId: actor.userId,
          workspaceId,
          properties: { action_id: actionId, action_kind: action.kind },
        });
      }
      return await dispatch(actionId, workspaceId);
    },

    async deny(actionId, workspaceId, actor, reason) {
      return await recordCancellation(actionId, workspaceId, actor, () => reason);
    },

    async cancel(actionId, workspaceId, actor, reason) {
      return await recordCancellation(actionId, workspaceId, actor, (action) =>
        withdrawalReason(action.status, reason),
      );
    },

    async repropose(actionId, workspaceId, idempotencyKey, actor) {
      const action = await getExternalAction(db, workspaceId, actionId);
      if (!action) throw new ExternalActionNotFoundError();
      if (action.status !== "stale" && action.status !== "blocked") {
        throw new InvalidExternalActionTransitionError(action.status, "proposed");
      }
      const adapter = adapters[action.kind];
      let intent: ExternalActionIntent;
      if (adapter) {
        try {
          intent = await adapter.revalidate(action, await getExternalActionPayload(db, action.id));
        } catch (error) {
          // "Re-propose with the current content" cannot rebuild an intent the
          // world no longer supports. Nothing is re-marked: a `stale` action is
          // already stale, and a `blocked` one keeps its `blocked → proposed`
          // edge open for when the guardrail behind it is cleared.
          //
          // Only the stale case reports staleness. Telling a founder looking at
          // a blocked action that "the content changed since it was proposed"
          // would name the wrong cause; the preparation error already carries
          // the true one, and the route maps it at its own status.
          if (error instanceof ExternalActionPreparationError) {
            if (action.status === "stale") throw new StaleExternalActionError(action);
          }
          throw error;
        }
      } else {
        intent = {
          subject: action.subject,
          context: action.context,
          payload: await getExternalActionPayload(db, action.id),
          requestedFor: action.requestedFor,
          links: { draftId: action.subject.kind === "draft" ? action.subject.id : null },
        };
      }
      return await proposeWithLineage(
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
      for (const action of await listRunnableExternalActions(db, workspaceId)) {
        try {
          results.push(await dispatch(action.id, workspaceId));
        } catch {
          const durable = await getExternalAction(db, workspaceId, action.id);
          if (durable) results.push(submission(durable));
        }
      }
      return results;
    },
  };
}
