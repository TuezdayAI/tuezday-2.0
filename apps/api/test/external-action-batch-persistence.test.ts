import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import {
  externalActionBatchItems,
  externalActionBatches,
  externalActions,
  workspaces,
} from "../src/db/schema";
import { createTestDb } from "./helpers";

function seedWorkspace(db: Db, name = "Batch Lab"): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(workspaces)
    .values({
      id,
      name,
      analyticsOptOut: false,
      websiteUrl: null,
      onboardingStep: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function seedAction(db: Db, workspaceId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(externalActions)
    .values({
      id,
      workspaceId,
      kind: "publish",
      status: "authorization_required",
      subjectKind: "draft",
      subjectId: randomUUID(),
      draftId: null,
      campaignId: null,
      personaId: null,
      connectionId: null,
      laneRevisionId: null,
      payloadJson: JSON.stringify({ target: "feed" }),
      subjectSnapshotJson: JSON.stringify({ title: "Post", summary: "Copy" }),
      requestedFor: null,
      idempotencyKey: `publish:${id}`,
      fingerprint: "a".repeat(64),
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
      createdAt: now,
      updatedAt: now,
      authorizedAt: null,
      dispatchedAt: null,
      completedAt: null,
    })
    .run();
  return id;
}

function batchRow(workspaceId: string, requestId = randomUUID()) {
  return {
    id: randomUUID(),
    workspaceId,
    requestId,
    selectionJson: JSON.stringify({ mode: "selected", actionIds: [] }),
    status: "preview",
    continuationCount: 0,
    createdByUserId: null,
    createdByLabel: "Founder",
    createdAt: Date.now(),
    confirmedAt: null,
    completedAt: null,
  };
}

function itemRow(workspaceId: string, batchId: string, actionId: string) {
  return {
    id: randomUUID(),
    workspaceId,
    batchId,
    actionId,
    snapshotJson: JSON.stringify({
      actionFingerprint: "a".repeat(64),
      actionUpdatedAt: 100,
      kind: "publish",
      campaignId: null,
      impact: "Publish the approved post to the founder account.",
      eligible: true,
      exclusionReason: null,
    }),
    status: "pending",
    submissionJson: null,
    error: null,
    processedAt: null,
  };
}

describe("external action batch persistence", () => {
  it("declares workspace lookup and uniqueness indexes", () => {
    const batchIndexes = getTableConfig(externalActionBatches).indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    }));
    expect(batchIndexes).toEqual(
      expect.arrayContaining([
        {
          name: "external_action_batches_workspace_request",
          unique: true,
          columns: ["workspace_id", "request_id"],
        },
        {
          name: "external_action_batches_workspace_status",
          unique: false,
          columns: ["workspace_id", "status"],
        },
      ]),
    );

    const itemIndexes = getTableConfig(externalActionBatchItems).indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    }));
    expect(itemIndexes).toEqual(
      expect.arrayContaining([
        {
          name: "external_action_batch_items_batch_action",
          unique: true,
          columns: ["batch_id", "action_id"],
        },
        {
          name: "external_action_batch_items_workspace_batch",
          unique: false,
          columns: ["workspace_id", "batch_id"],
        },
      ]),
    );
  });

  it("stores exact immutable preview JSON and nullable item outcomes", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const batch = batchRow(workspaceId);
    batch.selectionJson = JSON.stringify({ mode: "selected", actionIds: [actionId] });
    db.insert(externalActionBatches).values(batch).run();
    const item = itemRow(workspaceId, batch.id, actionId);
    db.insert(externalActionBatchItems).values(item).run();

    expect(db.select().from(externalActionBatches).get()?.selectionJson).toBe(
      batch.selectionJson,
    );
    expect(db.select().from(externalActionBatchItems).get()).toMatchObject({
      snapshotJson: item.snapshotJson,
      status: "pending",
      submissionJson: null,
      error: null,
      processedAt: null,
    });

    const submissionJson = JSON.stringify({ action: { id: actionId }, execution: null });
    db.update(externalActionBatchItems)
      .set({ status: "failed", submissionJson, error: "Provider failed", processedAt: 200 })
      .where(eq(externalActionBatchItems.id, item.id))
      .run();
    expect(db.select().from(externalActionBatchItems).get()).toMatchObject({
      snapshotJson: item.snapshotJson,
      status: "failed",
      submissionJson,
      error: "Provider failed",
      processedAt: 200,
    });
  });

  it("enforces workspace request idempotency and unique batch membership", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const otherWorkspaceId = seedWorkspace(db, "Other Batch Lab");
    const requestId = randomUUID();
    const batch = batchRow(workspaceId, requestId);
    db.insert(externalActionBatches).values(batch).run();
    expect(() =>
      db.insert(externalActionBatches)
        .values({ ...batchRow(workspaceId, requestId), id: randomUUID() })
        .run(),
    ).toThrow();
    expect(() =>
      db.insert(externalActionBatches).values(batchRow(otherWorkspaceId, requestId)).run(),
    ).not.toThrow();

    const actionId = seedAction(db, workspaceId);
    const item = itemRow(workspaceId, batch.id, actionId);
    db.insert(externalActionBatchItems).values(item).run();
    expect(() =>
      db.insert(externalActionBatchItems)
        .values({ ...item, id: randomUUID() })
        .run(),
    ).toThrow();
  });

  it("cascades batch deletion but restricts deletion of audited actions", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const batch = batchRow(workspaceId);
    db.insert(externalActionBatches).values(batch).run();
    db.insert(externalActionBatchItems).values(itemRow(workspaceId, batch.id, actionId)).run();

    expect(() =>
      db.delete(externalActions).where(eq(externalActions.id, actionId)).run(),
    ).toThrow();
    db.delete(externalActionBatches).where(eq(externalActionBatches.id, batch.id)).run();
    expect(db.select().from(externalActionBatchItems).all()).toEqual([]);
    expect(() =>
      db.delete(externalActions).where(eq(externalActions.id, actionId)).run(),
    ).not.toThrow();
  });
});
