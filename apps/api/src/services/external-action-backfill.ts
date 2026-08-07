import { randomUUID } from "node:crypto";
import {
  EXTERNAL_ACTION_KINDS,
  type AutomationMode,
  type ExternalActionKind,
  type ExternalActionPolicyRule,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import { campaigns, externalActionPolicyRules, workspaces } from "../db/schema";

function campaignRule(
  automationMode: AutomationMode,
  actionKind: ExternalActionKind,
): ExternalActionPolicyRule {
  if (automationMode !== "scheduled_auto") return "human_required";

  switch (actionKind) {
    case "publish":
    case "send":
    case "reply":
    case "paid_launch":
      return "autonomous";
    case "budget_change":
    case "targeting_change":
      return "human_required";
  }
}

async function insertPolicy(
  db: DbExecutor,
  input: {
    workspaceId: string;
    scope: "workspace" | "campaign";
    scopeId: string;
    actionKind: ExternalActionKind;
    rule: ExternalActionPolicyRule;
  },
): Promise<void> {
  const now = Date.now();
  await db.insert(externalActionPolicyRules)
    .values({
      id: randomUUID(),
      ...input,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

/** Establish the conservative baseline for a workspace exactly once. */
export async function ensureWorkspaceActionPolicies(db: Db, workspaceId: string): Promise<void> {
  for (const actionKind of EXTERNAL_ACTION_KINDS) {
    await insertPolicy(db, {
      workspaceId,
      scope: "workspace",
      scopeId: workspaceId,
      actionKind,
      rule: "human_required",
    });
  }
}

/** Preserve existing campaign automation semantics while making them explicit. */
export async function ensureCampaignActionPolicies(
  db: DbExecutor,
  workspaceId: string,
  campaignId: string,
  automationMode: AutomationMode,
): Promise<void> {
  for (const actionKind of EXTERNAL_ACTION_KINDS) {
    await insertPolicy(db, {
      workspaceId,
      scope: "campaign",
      scopeId: campaignId,
      actionKind,
      rule: campaignRule(automationMode, actionKind),
    });
  }
}

/** Idempotently bootstrap policy rows for pre-authorization data. */
export async function backfillExternalActionPolicies(db: Db): Promise<void> {
  for (const workspace of await db.select({ id: workspaces.id }).from(workspaces).all()) {
    await ensureWorkspaceActionPolicies(db, workspace.id);
  }

  for (const campaign of await db
    .select({
      id: campaigns.id,
      workspaceId: campaigns.workspaceId,
      automationMode: campaigns.automationMode,
    })
    .from(campaigns)
    .all()) {
    await ensureCampaignActionPolicies(
      db,
      campaign.workspaceId,
      campaign.id,
      campaign.automationMode as AutomationMode,
    );
  }
}
