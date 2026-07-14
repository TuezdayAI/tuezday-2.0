import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AutomationMode, ExternalActionKind } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  campaigns,
  externalActionDecisions,
  externalActionPolicyRules,
  externalActions,
  workspaces,
} from "../src/db/schema";
import {
  backfillExternalActionPolicies,
  ensureCampaignActionPolicies,
  ensureWorkspaceActionPolicies,
} from "../src/services/external-action-backfill";
import { createTestDb } from "./helpers";

function seedWorkspace(db: Db, name = "Action Lab") {
  const now = Date.now();
  const id = randomUUID();
  db.insert(workspaces)
    .values({ id, name, analyticsOptOut: false, websiteUrl: null, onboardingStep: null, createdAt: now, updatedAt: now })
    .run();
  return id;
}

function seedCampaign(db: Db, workspaceId: string, automationMode: AutomationMode) {
  const now = Date.now();
  const id = randomUUID();
  db.insert(campaigns)
    .values({
      id,
      workspaceId,
      name: `${automationMode} campaign`,
      objective: "",
      kpi: "",
      timeframe: "",
      audience: "",
      pillarsJson: "[]",
      channelsJson: "[]",
      personaIdsJson: "[]",
      overlay: "",
      origin: "user",
      purpose: "initiative",
      status: "active",
      automationMode,
      autoDailyCap: null,
      currentPlanRevisionId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function rule(
  db: Db,
  workspaceId: string,
  scope: "workspace" | "campaign",
  scopeId: string,
  actionKind: ExternalActionKind,
) {
  return db
    .select()
    .from(externalActionPolicyRules)
    .where(
      and(
        eq(externalActionPolicyRules.workspaceId, workspaceId),
        eq(externalActionPolicyRules.scope, scope),
        eq(externalActionPolicyRules.scopeId, scopeId),
        eq(externalActionPolicyRules.actionKind, actionKind),
      ),
    )
    .get();
}

function actionRow(workspaceId: string, idempotencyKey = "publish:one") {
  const now = Date.now();
  return {
    id: randomUUID(),
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
    idempotencyKey,
    fingerprint: "a".repeat(64),
    policySnapshotJson: JSON.stringify({ effective: "human_required", contributingRules: [] }),
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
  };
}

describe("external action persistence", () => {
  it("creates safe workspace defaults for every action kind idempotently", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);

    ensureWorkspaceActionPolicies(db, workspaceId);
    ensureWorkspaceActionPolicies(db, workspaceId);

    const rows = db
      .select()
      .from(externalActionPolicyRules)
      .where(eq(externalActionPolicyRules.workspaceId, workspaceId))
      .all();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.scope === "workspace" && row.rule === "human_required"))
      .toBe(true);
  });

  it("preserves scheduled-auto execution while gating manual and human-in-loop campaigns", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const scheduled = seedCampaign(db, workspaceId, "scheduled_auto");
    const manual = seedCampaign(db, workspaceId, "manual");
    const hitl = seedCampaign(db, workspaceId, "human_in_the_loop");

    ensureCampaignActionPolicies(db, workspaceId, scheduled, "scheduled_auto");
    ensureCampaignActionPolicies(db, workspaceId, manual, "manual");
    ensureCampaignActionPolicies(db, workspaceId, hitl, "human_in_the_loop");

    expect(rule(db, workspaceId, "campaign", scheduled, "publish")?.rule).toBe("autonomous");
    expect(rule(db, workspaceId, "campaign", scheduled, "send")?.rule).toBe("autonomous");
    expect(rule(db, workspaceId, "campaign", scheduled, "reply")?.rule).toBe("autonomous");
    expect(rule(db, workspaceId, "campaign", scheduled, "paid_launch")?.rule).toBe("autonomous");
    expect(rule(db, workspaceId, "campaign", scheduled, "budget_change")?.rule).toBe("human_required");
    expect(rule(db, workspaceId, "campaign", scheduled, "targeting_change")?.rule).toBe("human_required");
    expect(rule(db, workspaceId, "campaign", manual, "publish")?.rule).toBe("human_required");
    expect(rule(db, workspaceId, "campaign", hitl, "publish")?.rule).toBe("human_required");
  });

  it("backfills every existing workspace and campaign without duplicate rows", () => {
    const db = createTestDb();
    const firstWorkspace = seedWorkspace(db, "First");
    const secondWorkspace = seedWorkspace(db, "Second");
    seedCampaign(db, firstWorkspace, "scheduled_auto");
    seedCampaign(db, secondWorkspace, "manual");

    backfillExternalActionPolicies(db);
    backfillExternalActionPolicies(db);

    expect(db.select().from(externalActionPolicyRules).all()).toHaveLength(24);
  });

  it("enforces one policy per scope/action and one action per idempotency key", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    ensureWorkspaceActionPolicies(db, workspaceId);
    const existing = rule(db, workspaceId, "workspace", workspaceId, "publish")!;

    expect(() =>
      db.insert(externalActionPolicyRules).values({ ...existing, id: randomUUID() }).run(),
    ).toThrow();

    const first = actionRow(workspaceId);
    db.insert(externalActions).values(first).run();
    expect(() =>
      db.insert(externalActions).values({ ...actionRow(workspaceId), idempotencyKey: first.idempotencyKey }).run(),
    ).toThrow();
  });

  it("cascades immutable decisions when their action is deleted", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const action = actionRow(workspaceId);
    db.insert(externalActions).values(action).run();
    db.insert(externalActionDecisions)
      .values({
        id: randomUUID(),
        workspaceId,
        actionId: action.id,
        decision: "deny",
        reason: "Wrong destination",
        actorUserId: null,
        actorLabel: "Founder",
        subjectFingerprint: action.fingerprint,
        policySnapshotJson: action.policySnapshotJson,
        createdAt: Date.now(),
      })
      .run();

    db.delete(externalActions).where(eq(externalActions.id, action.id)).run();
    expect(db.select().from(externalActionDecisions).all()).toEqual([]);
  });
});
