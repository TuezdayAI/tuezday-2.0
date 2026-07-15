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
  createExternalActionRuntime,
  type ExternalActionAdapter,
  type ExternalActionCommand,
  type ExternalActionIntent,
} from "../src/services/external-action-coordinator";
import { getExternalAction, getExternalActionDetail } from "../src/services/external-actions";
import { ensureWorkspaceActionPolicies } from "../src/services/external-action-backfill";
import {
  listExternalActionPolicies,
  upsertExternalActionPolicies,
} from "../src/services/external-action-policy";
import { createTestDb } from "./helpers";

const ACTOR = { userId: null, label: "Founder" };

function setWorkspacePolicies(
  db: Db,
  workspaceId: string,
  overrides: Partial<Record<ExternalActionKind, "autonomous" | "human_required">>,
) {
  const current = listExternalActionPolicies(db, workspaceId, "workspace", workspaceId);
  return upsertExternalActionPolicies(
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
  const execute = vi.fn(async () => result);
  const adapter: ExternalActionAdapter = {
    async revalidate() {
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
    setResult(next: ExternalActionExecutionRef) {
      result = next;
    },
  };
}

describe("external action lifecycle", () => {
  let db: Db;
  let workspaceId: string;

  beforeEach(() => {
    db = createTestDb();
    workspaceId = randomUUID();
    const now = Date.now();
    db.insert(workspaces)
      .values({ id: workspaceId, name: "Action Lab", createdAt: now, updatedAt: now })
      .run();
    ensureWorkspaceActionPolicies(db, workspaceId);
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
      runtime.propose(
        { ...input, payload: { body: "Changed", target: "feed" } },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ExternalActionIdempotencyConflictError);
  });

  it("dispatches autonomous work once and preserves its execution receipt", async () => {
    setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
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
    expect(getExternalActionDetail(db, workspaceId, queued.action.id)?.decisions[0]?.decision).toBe(
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
    expect(getExternalActionDetail(db, workspaceId, toDeny.action.id)?.decisions[0]?.reason).toBe(
      "Wrong destination",
    );
  });

  it("emits authorization analytics only after the durable decision commits", async () => {
    const now = Date.now();
    const userId = randomUUID();
    db.insert(users)
      .values({
        id: userId,
        email: "founder@action.test",
        name: "Founder",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const input = command(workspaceId);
    const fake = fakeAdapter(input);
    const capture = vi.fn(() => {
      expect(db.select().from(externalActionDecisions).all()).toHaveLength(1);
    });
    const analytics: AnalyticsSink = { capture };
    const runtime = createExternalActionRuntime({
      db,
      adapters: { publish: fake.adapter },
      analytics,
    });
    const queued = await runtime.propose(input, { userId, label: "Founder" });

    await runtime.authorize(queued.action.id, workspaceId, { userId, label: "Founder" });

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

    await expect(runtime.authorize(queued.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
      StaleExternalActionError,
    );
    expect(getExternalAction(db, workspaceId, queued.action.id)?.status).toBe("stale");
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("schedules future work and the runner dispatches it when due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-14T10:00:00Z"));
    try {
      setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
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
    setWorkspacePolicies(db, workspaceId, { publish: "autonomous" });
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
    await expect(runtime.authorize(first.action.id, workspaceId, ACTOR)).rejects.toBeInstanceOf(
      StaleExternalActionError,
    );
    const successor = await runtime.repropose(
      first.action.id,
      workspaceId,
      "publish:corrected",
      ACTOR,
    );
    expect(successor.action.supersedesActionId).toBe(first.action.id);
    expect(getExternalAction(db, workspaceId, first.action.id)?.supersededByActionId).toBe(
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
});
