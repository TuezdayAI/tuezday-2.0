import { randomUUID } from "node:crypto";
import {
  EXTERNAL_ACTION_KINDS,
  type AutomationMode,
  type ExternalActionKind,
  type ExternalActionPolicyRule,
} from "@tuezday/contracts";
import type { Db } from "../db";
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

function insertPolicy(
  db: Db,
  input: {
    workspaceId: string;
    scope: "workspace" | "campaign";
    scopeId: string;
    actionKind: ExternalActionKind;
    rule: ExternalActionPolicyRule;
  },
): void {
  const now = Date.now();
  db.insert(externalActionPolicyRules)
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
export function ensureWorkspaceActionPolicies(db: Db, workspaceId: string): void {
  for (const actionKind of EXTERNAL_ACTION_KINDS) {
    insertPolicy(db, {
      workspaceId,
      scope: "workspace",
      scopeId: workspaceId,
      actionKind,
      rule: "human_required",
    });
  }
}

/** Preserve existing campaign automation semantics while making them explicit. */
export function ensureCampaignActionPolicies(
  db: Db,
  workspaceId: string,
  campaignId: string,
  automationMode: AutomationMode,
): void {
  for (const actionKind of EXTERNAL_ACTION_KINDS) {
    insertPolicy(db, {
      workspaceId,
      scope: "campaign",
      scopeId: campaignId,
      actionKind,
      rule: campaignRule(automationMode, actionKind),
    });
  }
}

/** Idempotently bootstrap policy rows for pre-authorization data. */
export function backfillExternalActionPolicies(db: Db): void {
  for (const workspace of db.select({ id: workspaces.id }).from(workspaces).all()) {
    ensureWorkspaceActionPolicies(db, workspace.id);
  }

  for (const campaign of db
    .select({
      id: campaigns.id,
      workspaceId: campaigns.workspaceId,
      automationMode: campaigns.automationMode,
    })
    .from(campaigns)
    .all()) {
    ensureCampaignActionPolicies(
      db,
      campaign.workspaceId,
      campaign.id,
      campaign.automationMode as AutomationMode,
    );
  }
}
