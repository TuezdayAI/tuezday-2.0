import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_ACTION_KINDS,
  type ExternalActionKind,
  ExternalActionBlocker,
  ExternalActionExecutionRef,
} from "@tuezday/contracts";
import type { AnalyticsSink } from "../src/analytics/sink";
import type { Db } from "../src/db";
import { externalActionDecisions, users, workspaces } from "../src/db/schema";
import { canonicalActionFingerprint } from "../src/services/external-action-fingerprint";
import {
  ExternalActionIdempotencyConflictError,
  StaleExternalActionError,
  WITHDRAWN_BEFORE_DISPATCH,
  createExternalActionRuntime,
  type ExternalActionAdapter,
  type ExternalActionCommand,
  type ExternalActionIntent,
} from "../src/services/external-action-coordinator";
import { ExternalActionPreparationError } from "../src/services/external-action-preparation";
import {
  InvalidExternalActionTransitionError,
  getExternalAction,
  getExternalActionDetail,
  transitionExternalAction,
} from "../src/services/external-actions";
import { ensureWorkspaceActionPolicies } from "../src/services/external-action-backfill";
import {
  listExternalActionPolicies,
  upsertExternalActionPolicies,
} from "../src/services/external-action-policy";
import { createTestDb } from "./helpers";

const ACTOR = { userId: null, label: "Founder", human: true };

async function setWorkspacePolicies(
  db: Db,
  workspaceId: string,
  overrides: Partial<Record<ExternalActionKind, "autonomous" | "human_required">>,
) {
  const current = await listExternalActionPolicies(db, workspaceId, "workspace", workspaceId);
  return await upsertExternalActionPolicies(
    db,
    workspaceId,
    {
      scope: "workspace",
      scopeId: workspaceId,
      expectedUpdatedAt: current.updatedAt,
      rules: EXTERNAL_ACTION_KINDS.map((actionKind) => ({
        actionKind,
        rule: overrides[actionKind] ?? "human_required",
      })),
    },
    null,
  );
}

function execution(error: string | null = null): ExternalActionExecutionRef {
  return {
    kind: "publication",
    id: randomUUID(),
    status: error ? "failed" : "published",
    url: error ? null : "https://example.com/post/1",
    error,
  };
}

function command(workspaceId: string, overrides: Partial<ExternalActionCommand> = {}): ExternalActionCommand {
  return {
    workspaceId,
    kind: "publish",
    subject: {
      kind: "draft",
      id: randomUUID(),
      title: "Launch teaser",
      summary: "The approved post",
      channel: "linkedin",
      destination: "Founder account",
    },
    context: {
      campaignId: null,
      campaignName: null,
      personaId: null,
      personaName: null,
      connectionId: null,
      connectionName: null,
      laneRevisionId: null,
      laneName: null,
    },
    payload: { body: "Ship it", target: "feed" },
    requestedFor: null,
    idempotencyKey: `publish:${randomUUID()}`,
    ...overrides,
  };
}

function fakeAdapter(initial: ExternalActionCommand) {
  let current: ExternalActionIntent = {
    subject: initial.subject,
    context: initial.context,
    payload: initial.payload,
    requestedFor: initial.requestedFor,
  };
  let blocker: ExternalActionBlocker | null = null;
  let result = execution();
  let revalidateError: Error | null = null;
  const execute = vi.fn(async () => result);
  const adapter: ExternalActionAdapter = {
    async revalidate() {
      if (revalidateError) throw revalidateError;
      return current;
    },
    async guard() {
      return blocker;
    },
    execute,
  };
  return {
    adapter,
    execute,
    setCurrent(next: ExternalActionIntent) {
      current = next;
    },
    setBlocker(next: ExternalActionBlocker | null) {
      blocker = next;
    },
    /** Revalidation refuses outright — the draft left `approved`, the
     * connection vanished — rather than returning a different intent. */
    setRevalidateError(next: Error | null) {
      revalidateError = next;
    },
    setResult(next: ExternalActionExecutionRef) {
      result = next;
    },
  };
}

describe("external action lifecycle", () => {
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspaceId = randomUUID();
    const now = Date.now();
    await db.insert(workspaces)
      .values({ id: workspaceId, name: "Action Lab", createdAt: now, updatedAt: now });
    await ensureWorkspaceActionPolicies(db, workspaceId);
  });

  it("canonicalizes object keys recursively while preserving array order", () => {
    expect(canonicalActionFingerprint({ b: 2, a: { z: 3, y: [2, 1] } })).toBe(
      canonicalActionFingerprint({ a: { y: [2, 1], z: 3 }, b: 2 }),
    );
    expect(canonicalActionFingerprint({ values: [1, 2] })).not.toBe(
      canonicalActionFingerprint({ values: [2, 1] }),
    );
  });

  it("returns an identical human-required proposal and rejects incompatible key reuse", async () => {
    const input = command(workspaceId, { idempotencyKey: "publish:one" });
    const fake = fakeAdapter(input);
    const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });

    const first = await runtime.propose(input, ACTOR);
    const retry = await runtime.propose(input, ACTOR);
    expect(first.action.status).toBe("authorization_required");
    expect(retry.action.id).toBe(first.action.id);
    expect(fake.execute).not.toHaveBeenCalled();

    await expect(
      await runtime.propose(
        { ...input, payload: { body: "Changed", target: "feed" } },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ExternalActionIdempotencyConflictError);
  });

  it("dispatches autonomous work once and preserves its execution receipt", async () => {
    await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
    const input = command(workspaceId);
    const fake = fakeAdapter(input);
    const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });

    const submitted = await runtime.propose(input, ACTOR);
    expect(submitted.action.status).toBe("succeeded");
    expect(submitted.execution?.status).toBe("published");
    expect(fake.execute).toHaveBeenCalledTimes(1);
    expect((await runtime.propose(input, ACTOR)).action.id).toBe(submitted.action.id);
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });

  it("records authorization and denial separately from content approval", async () => {
    const authorizedInput = command(workspaceId);
    const authorizedFake = fakeAdapter(authorizedInput);
    const runtime = createExternalActionRuntime({
      db,
      adapters: { publish: authorizedFake.adapter },
    });
    const queued = await runtime.propose(authorizedInput, ACTOR);
    const authorized = await runtime.authorize(queued.action.id, workspaceId, ACTOR);
    expect(authorized.action.status).toBe("succeeded");
    expect((await getExternalActionDetail(db, workspaceId, queued.action.id))?.decisions[0]?.decision).toBe(
      "authorize",
    );

    const deniedInput = command(workspaceId);
    const deniedFake = fakeAdapter(deniedInput);
    const deniedRuntime = createExternalActionRuntime({
      db,
      adapters: { publish: deniedFake.adapter },
    });
    const toDeny = await deniedRuntime.propose(deniedInput, ACTOR);
    const denied = await deniedRuntime.deny(
      toDeny.action.id,
      workspaceId,
      ACTOR,
      "Wrong destination",
    );
    expect(denied.action.status).toBe("cancelled");
    expect(deniedFake.execute).not.toHaveBeenCalled();
    expect((await getExternalActionDetail(db, workspaceId, toDeny.action.id))?.decisions[0]?.reason).toBe(
      "Wrong destination",
    );
  });

  it("emits authorization analytics only after the durable decision commits", async () => {
    const now = Date.now();
    const userId = randomUUID();
    await db.insert(users)
      .values({
        id: userId,
        email: "founder@action.test",
        name: "Founder",
        createdAt: now,
        updatedAt: now,
      });
    const input = command(workspaceId);
    const fake = fakeAdapter(input);
    const capture = vi.fn(async () => {
      expect(await db.select().from(externalActionDecisions)).toHaveLength(1);
    });
    const analytics: AnalyticsSink = { capture };
    const runtime = createExternalActionRuntime({
      db,
      adapters: { publish: fake.adapter },
      analytics,
    });
    const queued = await runtime.propose(input, { userId, label: "Founder", human: true });

    await runtime.authorize(queued.action.id, workspaceId, { userId, label: "Founder", human: true });

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review.action_authorized",
        distinctId: userId,
        workspaceId,
      }),
    );
  });

  it("marks a changed subject stale before authorization and never executes it", async () => {
    const input = command(workspaceId);
    const fake = fakeAdapter(input);
    const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
    const queued = await runtime.propose(input, ACTOR);
    fake.setCurrent({
      subject: { ...input.subject, summary: "Edited after review" },
      context: input.context,
      payload: { body: "Edited after review", target: "feed" },
      requestedFor: null,
    });

    await expect(await runtime.authorize(queued.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
      StaleExternalActionError,
    );
    expect((await getExternalAction(db, workspaceId, queued.action.id))?.status).toBe("stale");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("schedules future work and the runner dispatches it when due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-14T10:00:00Z"));
    try {
      await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
      const dueAt = Date.now() + 60_000;
      const input = command(workspaceId, { requestedFor: dueAt });
      const fake = fakeAdapter(input);
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const scheduled = await runtime.propose(input, ACTOR);
      expect(scheduled.action.status).toBe("scheduled");
      expect(fake.execute).not.toHaveBeenCalled();

      vi.setSystemTime(dueAt);
      const run = await runtime.run(workspaceId);
      expect(run[0]?.action.status).toBe("succeeded");
      expect(fake.execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists guardrail blockers and failed adapter receipts", async () => {
    await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
    const blockedInput = command(workspaceId);
    const blockedFake = fakeAdapter(blockedInput);
    blockedFake.setBlocker({ code: "connection_unhealthy", message: "Reconnect it.", retryable: true });
    const blockedRuntime = createExternalActionRuntime({
      db,
      adapters: { publish: blockedFake.adapter },
    });
    expect((await blockedRuntime.propose(blockedInput, ACTOR)).action.status).toBe("blocked");

    const failedInput = command(workspaceId);
    const failedFake = fakeAdapter(failedInput);
    failedFake.setResult(execution("Provider unavailable"));
    const failedRuntime = createExternalActionRuntime({
      db,
      adapters: { publish: failedFake.adapter },
    });
    const failed = await failedRuntime.propose(failedInput, ACTOR);
    expect(failed.action.status).toBe("failed");
    expect(failed.execution?.error).toBe("Provider unavailable");
  });

  it("creates a linked successor and durably blocks unsupported action kinds", async () => {
    const input = command(workspaceId);
    const fake = fakeAdapter(input);
    const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
    const first = await runtime.propose(input, ACTOR);
    fake.setCurrent({
      subject: { ...input.subject, summary: "Corrected" },
      context: input.context,
      payload: { body: "Corrected", target: "feed" },
      requestedFor: null,
    });
    await expect(await runtime.authorize(first.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
      StaleExternalActionError,
    );
    const successor = await runtime.repropose(
      first.action.id,
      workspaceId,
      "publish:corrected",
      ACTOR,
    );
    expect(successor.action.supersedesActionId).toBe(first.action.id);
    expect((await getExternalAction(db, workspaceId, first.action.id))?.supersededByActionId).toBe(
      successor.action.id,
    );

    const unsupported = await runtime.propose(
      {
        ...command(workspaceId),
        kind: "targeting_change",
        idempotencyKey: "targeting:unsupported",
      },
      ACTOR,
    );
    expect(unsupported.action.status).toBe("blocked");
    expect(unsupported.action.blocker?.code).toBe("adapter_unavailable");
  });

  // Sprint 52 Task 5 — revalidation can refuse outright (the draft left
  // `approved`, the connection was deleted) instead of returning a different
  // intent. That is the same fact as a fingerprint mismatch — what was proposed
  // no longer holds — so every revalidation site must land on `stale`, never
  // leak the preparation error to an HTTP caller as a 500.
  describe("revalidation that refuses outright", () => {
    const refusal = () =>
      new ExternalActionPreparationError(
        "draft_not_approved",
        "Only approved drafts can be published — run it through Review first.",
        409,
      );

    it("stales the action at authorize and raises the 409-mapped stale error", async () => {
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const queued = await runtime.propose(input, ACTOR);
      expect(queued.action.status).toBe("authorization_required");

      fake.setRevalidateError(refusal());
      await expect(await runtime.authorize(queued.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
        StaleExternalActionError,
      );
      const durable = await getExternalAction(db, workspaceId, queued.action.id);
      expect(durable?.status).toBe("stale");
      expect(durable?.blocker?.code).toBe("subject_changed");
      expect(fake.execute).not.toHaveBeenCalled();
      // No authorization was granted, so nothing false is on the record.
      expect((await getExternalActionDetail(db, workspaceId, queued.action.id))?.decisions).toEqual([]);
    });

    it("stales at propose time instead of throwing out of the dispatching branch", async () => {
      await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      fake.setRevalidateError(refusal());
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });

      const proposed = await runtime.propose(input, ACTOR);
      expect(proposed.action.status).toBe("stale");
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("stales a scheduled action on the next run rather than stranding it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-14T10:00:00Z"));
      try {
        await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
        const dueAt = Date.now() + 60_000;
        const input = command(workspaceId, { requestedFor: dueAt });
        const fake = fakeAdapter(input);
        const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
        expect((await runtime.propose(input, ACTOR)).action.status).toBe("scheduled");

        fake.setRevalidateError(refusal());
        vi.setSystemTime(dueAt + 1);
        const run = await runtime.run(workspaceId);
        expect(run[0]?.action.status).toBe("stale");
        expect(fake.execute).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a repropose whose subject can no longer be prepared", async () => {
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const queued = await runtime.propose(input, ACTOR);
      fake.setRevalidateError(refusal());
      await expect(await runtime.authorize(queued.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
        StaleExternalActionError,
      );

      await expect(
        await runtime.repropose(queued.action.id, workspaceId, "publish:retry", ACTOR),
      ).rejects.toBeInstanceOf(StaleExternalActionError);
      expect((await getExternalAction(db, workspaceId, queued.action.id))?.status).toBe("stale");
    });

    it("does not call a blocked action stale when its repropose cannot be prepared", async () => {
      await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      fake.setBlocker({ code: "connection_unhealthy", message: "Reconnect it.", retryable: true });
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const blocked = await runtime.propose(input, ACTOR);
      expect(blocked.action.status).toBe("blocked");

      // `repropose` accepts `blocked` as well as `stale`. A blocked action that
      // can no longer be prepared has not gone stale, and saying so would tell
      // the founder the content changed when a guardrail is what stopped it.
      fake.setRevalidateError(refusal());
      const failure = await runtime
        .repropose(blocked.action.id, workspaceId, "publish:retry", ACTOR)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExternalActionPreparationError);
      expect(failure).not.toBeInstanceOf(StaleExternalActionError);
      expect((failure as ExternalActionPreparationError).code).toBe("draft_not_approved");
      // Still blocked — `blocked → proposed` stays open once the cause is fixed.
      expect((await getExternalAction(db, workspaceId, blocked.action.id))?.status).toBe("blocked");
    });
  });

  // Sprint 52 Task 6 — a collapsed publish action never sits in the
  // authorization queue, so `deny` (a queue verb) is not the way to stop it.
  // Withdrawing an authorization that was already granted is its own act, and
  // it stays possible right up to the moment the action leaves the building.
  describe("withdrawing an authorization before dispatch", () => {
    it("cancels an authorized action that has not dispatched, and records who did it", async () => {
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const queued = await runtime.propose(input, ACTOR);
      // The collapsed shape: authorized without ever entering the queue.
      await transitionExternalAction(db, workspaceId, queued.action.id, "authorized", {
        authorizedAt: Date.now(),
      });

      const cancelled = await runtime.cancel(
        queued.action.id,
        workspaceId,
        ACTOR,
        "Changed my mind",
      );
      expect(cancelled.action.status).toBe("cancelled");
      expect(cancelled.action.completedAt).not.toBeNull();
      expect(fake.execute).not.toHaveBeenCalled();

      const decisions = (await getExternalActionDetail(db, workspaceId, queued.action.id))!.decisions;
      expect(decisions).toHaveLength(1);
      // The projected actor is the persisted identity; humanity is recorded on
      // the row (see the cadence tests) but is not part of the wire shape.
      expect(decisions[0]).toMatchObject({
        decision: "deny",
        actor: { userId: ACTOR.userId, label: ACTOR.label },
      });
      expect(
        (await db.select().from(externalActionDecisions)).map((d) => d.actorHuman),
      ).toEqual([true]);
      // The founder's own words survive…
      expect(decisions[0]?.reason).toContain("Changed my mind");
      // …without displacing the marker, which is the only thing that says this
      // was a withdrawal rather than a denial once the action reads `cancelled`.
      expect(decisions[0]?.reason).toContain(WITHDRAWN_BEFORE_DISPATCH);
    });

    it("keeps a withdrawal distinguishable from a denial that gives the same reason", async () => {
      const runtime = createExternalActionRuntime({
        db,
        adapters: { publish: fakeAdapter(command(workspaceId)).adapter },
      });
      const sameWords = "Wrong week for this one";

      const toDeny = await runtime.propose(command(workspaceId), ACTOR);
      await runtime.deny(toDeny.action.id, workspaceId, ACTOR, sameWords);

      const toWithdraw = await runtime.propose(command(workspaceId), ACTOR);
      await transitionExternalAction(db, workspaceId, toWithdraw.action.id, "authorized", {
        authorizedAt: Date.now(),
      });
      await runtime.cancel(toWithdraw.action.id, workspaceId, ACTOR, sameWords);

      // Both end `cancelled` with `decision: "deny"`, so the persisted reason is
      // the whole of the difference. A denial is never dressed up as one.
      const denial = (await getExternalActionDetail(db, workspaceId, toDeny.action.id))!.decisions[0]!;
      const withdrawal = (await getExternalActionDetail(db, workspaceId, toWithdraw.action.id))!
        .decisions[0]!;
      expect(denial.reason).toBe(sameWords);
      expect(withdrawal.reason).not.toBe(denial.reason);
      expect(withdrawal.reason).toContain(WITHDRAWN_BEFORE_DISPATCH);
    });

    it("never records 'before it was dispatched' against something that dispatched", async () => {
      await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      fake.setResult(execution("Provider unavailable"));
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const failed = await runtime.propose(input, ACTOR);
      expect(failed.action.status).toBe("failed");

      // No UI offers this, but the API allows it — `failed → cancelled` is a
      // legal edge — and a reason on the record must not be a lie.
      const cancelled = await runtime.cancel(failed.action.id, workspaceId, ACTOR, null);
      expect(cancelled.action.status).toBe("cancelled");
      const reason = (await getExternalActionDetail(db, workspaceId, failed.action.id))!.decisions[0]
        ?.reason;
      expect(reason).not.toContain(WITHDRAWN_BEFORE_DISPATCH);
      expect(reason).toContain("failed");
    });

    it("cancels a scheduled action so the runner never reaches its slot", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-14T10:00:00Z"));
      try {
        await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
        const dueAt = Date.now() + 60_000;
        const input = command(workspaceId, { requestedFor: dueAt });
        const fake = fakeAdapter(input);
        const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
        const scheduled = await runtime.propose(input, ACTOR);
        expect(scheduled.action.status).toBe("scheduled");

        const cancelled = await runtime.cancel(scheduled.action.id, workspaceId, ACTOR, null);
        expect(cancelled.action.status).toBe("cancelled");
        expect((await getExternalActionDetail(db, workspaceId, scheduled.action.id))!.decisions[0]?.reason)
          .toBe(WITHDRAWN_BEFORE_DISPATCH);

        vi.setSystemTime(dueAt + 1);
        expect(await runtime.run(workspaceId)).toEqual([]);
        expect(fake.execute).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses to cancel an action that already left the building", async () => {
      await setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
      const input = command(workspaceId);
      const fake = fakeAdapter(input);
      const runtime = createExternalActionRuntime({ db, adapters: { publish: fake.adapter } });
      const done = await runtime.propose(input, ACTOR);
      expect(done.action.status).toBe("succeeded");

      await expect(
        await runtime.cancel(done.action.id, workspaceId, ACTOR, null),
      ).rejects.toBeInstanceOf(InvalidExternalActionTransitionError);
      expect((await getExternalAction(db, workspaceId, done.action.id))?.status).toBe("succeeded");
      expect((await getExternalActionDetail(db, workspaceId, done.action.id))?.decisions).toEqual([]);
    });
  });
});
