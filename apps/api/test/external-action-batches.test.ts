import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  authorizationBatchDetailSchema,
  type ExternalAction,
  type ExternalActionSubmission,
} from "@tuezday/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import {
  campaigns,
  externalActionBatchItems,
  externalActionBatches,
  externalActions,
  workspaces,
} from "../src/db/schema";
import {
  StaleExternalActionError,
  type ExternalActionRuntime,
} from "../src/services/external-action-coordinator";
import {
  createAuthorizationBatchPreview,
  getAuthorizationBatchDetail,
  runAuthorizationBatch,
} from "../src/services/external-action-batches";
import { getExternalAction } from "../src/services/external-actions";
import { buildAuthedApp, createTestDb } from "./helpers";

const ACTOR = { userId: null, label: "Founder" };

function seedWorkspace(db: Db, name = "Batch Lab"): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(workspaces).values({ id, name, createdAt: now, updatedAt: now }).run();
  return id;
}

function seedCampaign(db: Db, workspaceId: string, name = "Launch"): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(campaigns)
    .values({ id, workspaceId, name, createdAt: now, updatedAt: now })
    .run();
  return id;
}

function seedAction(
  db: Db,
  workspaceId: string,
  options: {
    campaignId?: string | null;
    status?: string;
    kind?: string;
    requestedFor?: number | null;
    createdAt?: number;
    summary?: string;
  } = {},
): string {
  const id = randomUUID();
  const createdAt = options.createdAt ?? Date.now();
  const campaignId = options.campaignId ?? null;
  const kind = options.kind ?? "publish";
  db.insert(externalActions)
    .values({
      id,
      workspaceId,
      kind,
      status: options.status ?? "authorization_required",
      subjectKind: "draft",
      subjectId: randomUUID(),
      draftId: null,
      campaignId,
      personaId: null,
      connectionId: null,
      laneRevisionId: null,
      payloadJson: "{}",
      subjectSnapshotJson: JSON.stringify({
        subject: {
          kind: "draft",
          id: randomUUID(),
          title: "Launch post",
          summary: options.summary ?? `Authorize ${kind} action`,
          channel: "linkedin",
          destination: "Founder account",
        },
        context: {
          campaignId,
          campaignName: campaignId ? "Launch" : null,
          personaId: null,
          personaName: null,
          connectionId: null,
          connectionName: null,
          laneRevisionId: null,
          laneName: null,
        },
      }),
      requestedFor: options.requestedFor ?? null,
      idempotencyKey: `batch-test:${id}`,
      fingerprint: id.replaceAll("-", "").repeat(2),
      policySnapshotJson: JSON.stringify({
        effective: "human_required",
        contributingRules: [],
      }),
      blockerCode: null,
      blockerDetail: null,
      blockerRetryable: null,
      supersedesActionId: null,
      supersededByActionId: null,
      executionKind: null,
      executionId: null,
      executionReceiptJson: null,
      proposedByUserId: null,
      proposedByLabel: "Founder",
      createdAt,
      updatedAt: createdAt,
      authorizedAt: null,
      dispatchedAt: null,
      completedAt: null,
    })
    .run();
  return id;
}

function succeededSubmission(action: ExternalAction): ExternalActionSubmission {
  const now = Math.max(Date.now(), action.createdAt);
  const execution = {
    kind: "publication" as const,
    id: randomUUID(),
    status: "published",
    url: "https://example.com/post",
    error: null,
  };
  return {
    action: {
      ...action,
      status: "succeeded",
      execution,
      authorizedAt: now,
      dispatchedAt: now,
      completedAt: now,
      updatedAt: now,
    },
    execution,
  };
}

function runtimeWithAuthorize(
  authorize: ExternalActionRuntime["authorize"],
): ExternalActionRuntime {
  return {
    authorize,
    propose: vi.fn(),
    deny: vi.fn(),
    repropose: vi.fn(),
    run: vi.fn(),
  };
}

describe("authorization batches", () => {
  it("snapshots selected actions in caller order with durable exclusions and idempotency", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const otherWorkspaceId = seedWorkspace(db, "Other Lab");
    const firstId = seedAction(db, workspaceId, { summary: "First impact" });
    const staleId = seedAction(db, workspaceId, { status: "succeeded" });
    const otherId = seedAction(db, otherWorkspaceId);
    const requestId = randomUUID();

    const preview = createAuthorizationBatchPreview(
      db,
      workspaceId,
      { requestId, selection: { mode: "selected", actionIds: [staleId, firstId, otherId] } },
      ACTOR,
    );

    expect(preview.items.map((item) => item.actionId)).toEqual([staleId, firstId, otherId]);
    expect(preview.items.filter((item) => item.eligible)).toHaveLength(1);
    expect(preview.items.find((item) => item.actionId === staleId)?.exclusionReason).toBe(
      "not_authorization_required",
    );
    expect(preview.items.find((item) => item.actionId === otherId)?.exclusionReason).toBe(
      "workspace_mismatch",
    );
    expect(preview.items.find((item) => item.actionId === firstId)?.impact).toBe(
      "First impact",
    );
    expect(authorizationBatchDetailSchema.parse(preview)).toEqual(preview);

    const retry = createAuthorizationBatchPreview(
      db,
      workspaceId,
      { requestId, selection: { mode: "selected", actionIds: [firstId] } },
      ACTOR,
    );
    expect(retry).toEqual(preview);
  });

  it("bounds campaign previews at 100 and reports the continuation count", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const campaignId = seedCampaign(db, workspaceId);
    const ids = Array.from({ length: 112 }, (_, index) =>
      seedAction(db, workspaceId, {
        campaignId,
        requestedFor: 1_000 + index,
        createdAt: 2_000 + index,
      }),
    );
    seedAction(db, workspaceId, { campaignId, kind: "reply" });

    const preview = createAuthorizationBatchPreview(
      db,
      workspaceId,
      {
        requestId: randomUUID(),
        selection: { mode: "campaign", campaignId, kinds: ["publish"] },
      },
      ACTOR,
    );

    expect(preview.items).toHaveLength(100);
    expect(preview.items.map((item) => item.actionId)).toEqual(ids.slice(0, 100));
    expect(preview.batch.continuationCount).toBe(12);
    expect(preview.batch.includedCount).toBe(100);
    expect(authorizationBatchDetailSchema.parse(preview)).toEqual(preview);
  });

  it("persists partial outcomes and makes repeated confirmation idempotent", async () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const firstId = seedAction(db, workspaceId);
    const secondId = seedAction(db, workspaceId);
    const preview = createAuthorizationBatchPreview(
      db,
      workspaceId,
      {
        requestId: randomUUID(),
        selection: { mode: "selected", actionIds: [firstId, secondId] },
      },
      ACTOR,
    );
    const authorize = vi.fn(async (actionId: string) => {
      if (actionId === secondId) throw new Error("Provider failed");
      return succeededSubmission(getExternalAction(db, workspaceId, actionId)!);
    });
    const runtime = runtimeWithAuthorize(authorize);

    const result = await runAuthorizationBatch(db, runtime, workspaceId, preview.batch.id, ACTOR);
    expect(result.batch.status).toBe("partially_completed");
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(result.items[1]?.error).toBe("Provider failed");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorizationBatchDetailSchema.parse(result)).toEqual(result);

    const retry = await runAuthorizationBatch(db, runtime, workspaceId, preview.batch.id, ACTOR);
    expect(retry.items).toEqual(result.items);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("resumes only pending items after an interrupted running batch", async () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const firstId = seedAction(db, workspaceId);
    const secondId = seedAction(db, workspaceId);
    const preview = createAuthorizationBatchPreview(
      db,
      workspaceId,
      {
        requestId: randomUUID(),
        selection: { mode: "selected", actionIds: [firstId, secondId] },
      },
      ACTOR,
    );
    const firstItem = preview.items[0]!;
    const firstSubmission = succeededSubmission(getExternalAction(db, workspaceId, firstId)!);
    db.update(externalActionBatches)
      .set({ status: "running", confirmedAt: Date.now() })
      .where(eq(externalActionBatches.id, preview.batch.id))
      .run();
    db.update(externalActionBatchItems)
      .set({
        status: "succeeded",
        submissionJson: JSON.stringify(firstSubmission),
        processedAt: Date.now(),
      })
      .where(eq(externalActionBatchItems.id, firstItem.id))
      .run();
    const authorize = vi.fn(async (actionId: string) =>
      succeededSubmission(getExternalAction(db, workspaceId, actionId)!),
    );

    const result = await runAuthorizationBatch(
      db,
      runtimeWithAuthorize(authorize),
      workspaceId,
      preview.batch.id,
      ACTOR,
    );
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(secondId, workspaceId, ACTOR);
    expect(result.batch.status).toBe("completed");
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("preserves the coordinator's canonical stale outcome", async () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const preview = createAuthorizationBatchPreview(
      db,
      workspaceId,
      {
        requestId: randomUUID(),
        selection: { mode: "selected", actionIds: [actionId] },
      },
      ACTOR,
    );
    const action = getExternalAction(db, workspaceId, actionId)!;
    const staleAction: ExternalAction = {
      ...action,
      status: "stale",
      blocker: {
        code: "subject_changed",
        message: "The subject, destination, timing, context, or effective policy changed.",
        retryable: false,
      },
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };
    const authorize = vi.fn(async () => {
      throw new StaleExternalActionError(staleAction);
    });

    const result = await runAuthorizationBatch(
      db,
      runtimeWithAuthorize(authorize),
      workspaceId,
      preview.batch.id,
      ACTOR,
    );
    expect(result.batch.status).toBe("failed");
    expect(result.items[0]).toMatchObject({
      status: "stale",
      error: "The external action changed after it was proposed.",
      submission: { action: { id: actionId, status: "stale" } },
    });
    expect(authorizationBatchDetailSchema.parse(result)).toEqual(result);
  });

  it("exposes create, detail, and authorize routes with workspace isolation", async () => {
    const db = createTestDb();
    const app = await buildAuthedApp({ db });
    const workspace = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Route Lab" } });
    const workspaceId = workspace.json().id as string;
    const staleId = seedAction(db, workspaceId, { status: "succeeded" });
    const requestId = randomUUID();

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-action-batches`,
      payload: {
        requestId,
        selection: { mode: "selected", actionIds: [staleId] },
      },
    });
    expect(created.statusCode).toBe(201);
    const preview = authorizationBatchDetailSchema.parse(created.json());

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/external-action-batches/${preview.batch.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(preview);

    const confirmed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-action-batches/${preview.batch.id}/authorize`,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(authorizationBatchDetailSchema.parse(confirmed.json()).batch.status).toBe("failed");

    expect(getAuthorizationBatchDetail(db, randomUUID(), preview.batch.id)).toBeUndefined();
    await app.close();
  });
});
