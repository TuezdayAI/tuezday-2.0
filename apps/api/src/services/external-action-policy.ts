import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  EXTERNAL_ACTION_KINDS,
  upsertExternalActionPoliciesInputSchema,
  type EffectiveExternalActionPolicy,
  type ExternalActionKind,
  type ExternalActionPolicyContribution,
  type ExternalActionPolicyRule,
  type ExternalActionPolicyRuleRecord,
  type ExternalActionPolicyScope,
  type ExternalActionPolicyView,
  type UpsertExternalActionPoliciesInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  campaignLaneRevisions,
  campaignLanes,
  campaigns,
  connections,
  externalActionPolicyRules,
  personas,
  workspaces,
  type ExternalActionPolicyRuleRow,
} from "../db/schema";
import { ensureWorkspaceActionPolicies } from "./external-action-backfill";

export class ExternalActionPolicyScopeNotFoundError extends Error {
  constructor() {
    super("Policy scope not found");
    this.name = "ExternalActionPolicyScopeNotFoundError";
  }
}

export class ExternalActionPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalActionPolicyInputError";
  }
}

export class ExternalActionPolicyConflictError extends Error {
  constructor(readonly current: ExternalActionPolicyView) {
    super("Action policy changed after this editor loaded.");
    this.name = "ExternalActionPolicyConflictError";
  }
}

export interface ExternalActionPolicyContext {
  workspaceId: string;
  actionKind: ExternalActionKind;
  campaignId: string | null;
  personaId: string | null;
  connectionId: string | null;
  laneRevisionId: string | null;
}

interface ScopeRecord {
  label: string;
  context: Omit<ExternalActionPolicyContext, "workspaceId" | "actionKind">;
}

function rowToRule(row: ExternalActionPolicyRuleRow): ExternalActionPolicyRuleRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope as ExternalActionPolicyScope,
    scopeId: row.scopeId,
    actionKind: row.actionKind as ExternalActionKind,
    rule: row.rule as ExternalActionPolicyRule,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function emptyContext(): ScopeRecord["context"] {
  return { campaignId: null, personaId: null, connectionId: null, laneRevisionId: null };
}

function scopeRecord(
  db: Db,
  workspaceId: string,
  scope: ExternalActionPolicyScope,
  scopeId: string,
): ScopeRecord | undefined {
  if (scope === "workspace") {
    const row = db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.id, scopeId), eq(workspaces.id, workspaceId)))
      .get();
    return row ? { label: row.name, context: emptyContext() } : undefined;
  }
  if (scope === "campaign") {
    const row = db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(and(eq(campaigns.id, scopeId), eq(campaigns.workspaceId, workspaceId)))
      .get();
    return row
      ? { label: row.name, context: { ...emptyContext(), campaignId: scopeId } }
      : undefined;
  }
  if (scope === "persona") {
    const row = db
      .select({ name: personas.name })
      .from(personas)
      .where(and(eq(personas.id, scopeId), eq(personas.workspaceId, workspaceId)))
      .get();
    return row
      ? { label: row.name, context: { ...emptyContext(), personaId: scopeId } }
      : undefined;
  }
  if (scope === "connection") {
    const row = db
      .select({
        displayName: connections.displayName,
        externalAccountName: connections.externalAccountName,
        providerKey: connections.providerKey,
      })
      .from(connections)
      .where(and(eq(connections.id, scopeId), eq(connections.workspaceId, workspaceId)))
      .get();
    return row
      ? {
          label: row.displayName || row.externalAccountName || row.providerKey,
          context: { ...emptyContext(), connectionId: scopeId },
        }
      : undefined;
  }

  const row = db
    .select({
      name: campaignLaneRevisions.name,
      key: campaignLaneRevisions.key,
      laneName: campaignLanes.name,
      personaId: campaignLaneRevisions.personaId,
      connectionId: campaignLaneRevisions.publishingConnectionId,
      campaignId: campaignLanes.campaignId,
    })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLaneRevisions.laneId, campaignLanes.id))
    .where(
      and(
        eq(campaignLaneRevisions.id, scopeId),
        eq(campaignLaneRevisions.workspaceId, workspaceId),
      ),
    )
    .get();
  return row
    ? {
        label: row.name || row.laneName || row.key || "Campaign lane",
        context: {
          campaignId: row.campaignId,
          personaId: row.personaId,
          connectionId: row.connectionId,
          laneRevisionId: scopeId,
        },
      }
    : undefined;
}

function requireScope(
  db: Db,
  workspaceId: string,
  scope: ExternalActionPolicyScope,
  scopeId: string,
): ScopeRecord {
  if (scope === "workspace" && scopeId !== workspaceId) {
    throw new ExternalActionPolicyScopeNotFoundError();
  }
  const record = scopeRecord(db, workspaceId, scope, scopeId);
  if (!record) throw new ExternalActionPolicyScopeNotFoundError();
  return record;
}

function storedRule(
  db: Db,
  workspaceId: string,
  scope: ExternalActionPolicyScope,
  scopeId: string,
  actionKind: ExternalActionKind,
): ExternalActionPolicyRule | undefined {
  return db
    .select({ rule: externalActionPolicyRules.rule })
    .from(externalActionPolicyRules)
    .where(
      and(
        eq(externalActionPolicyRules.workspaceId, workspaceId),
        eq(externalActionPolicyRules.scope, scope),
        eq(externalActionPolicyRules.scopeId, scopeId),
        eq(externalActionPolicyRules.actionKind, actionKind),
      ),
    )
    .get()?.rule as ExternalActionPolicyRule | undefined;
}

function contribution(
  scope: ExternalActionPolicyScope,
  scopeId: string,
  scopeLabel: string,
  rule: ExternalActionPolicyRule,
): ExternalActionPolicyContribution {
  return { scope, scopeId, scopeLabel, rule };
}

export function resolveExternalActionPolicy(
  db: Db,
  context: ExternalActionPolicyContext,
): EffectiveExternalActionPolicy {
  const workspace = requireScope(db, context.workspaceId, "workspace", context.workspaceId);
  const workspaceRule =
    storedRule(db, context.workspaceId, "workspace", context.workspaceId, context.actionKind) ??
    "human_required";
  const contributingRules = [
    contribution("workspace", context.workspaceId, workspace.label, workspaceRule),
  ];
  let effective: EffectiveExternalActionPolicy["effective"] =
    workspaceRule === "autonomous" ? "autonomous" : "human_required";

  if (context.campaignId) {
    const record = requireScope(db, context.workspaceId, "campaign", context.campaignId);
    const rule =
      storedRule(db, context.workspaceId, "campaign", context.campaignId, context.actionKind) ??
      "inherit";
    contributingRules.push(contribution("campaign", context.campaignId, record.label, rule));
    if (rule !== "inherit") effective = rule;
  }

  const safetyScopes = [
    ["persona", context.personaId],
    ["connection", context.connectionId],
    ["lane", context.laneRevisionId],
  ] as const;
  for (const [scope, scopeId] of safetyScopes) {
    if (!scopeId) continue;
    const record = requireScope(db, context.workspaceId, scope, scopeId);
    const rule =
      storedRule(db, context.workspaceId, scope, scopeId, context.actionKind) ?? "inherit";
    contributingRules.push(contribution(scope, scopeId, record.label, rule));
    if (rule === "human_required") effective = "human_required";
  }

  return { effective, contributingRules };
}

export function listExternalActionPolicies(
  db: Db,
  workspaceId: string,
  scope: ExternalActionPolicyScope,
  scopeId: string,
): ExternalActionPolicyView {
  const record = requireScope(db, workspaceId, scope, scopeId);
  ensureWorkspaceActionPolicies(db, workspaceId);
  const rules = db
    .select()
    .from(externalActionPolicyRules)
    .where(
      and(
        eq(externalActionPolicyRules.workspaceId, workspaceId),
        eq(externalActionPolicyRules.scope, scope),
        eq(externalActionPolicyRules.scopeId, scopeId),
      ),
    )
    .all()
    .map(rowToRule);
  const effective = EXTERNAL_ACTION_KINDS.map((actionKind) => ({
    actionKind,
    policy: resolveExternalActionPolicy(db, { workspaceId, actionKind, ...record.context }),
  }));
  const updatedAt = rules.reduce<number | null>(
    (latest, rule) => (latest === null || rule.updatedAt > latest ? rule.updatedAt : latest),
    null,
  );
  return { scope, scopeId, scopeLabel: record.label, rules, effective, updatedAt };
}

export function upsertExternalActionPolicies(
  db: Db,
  workspaceId: string,
  input: UpsertExternalActionPoliciesInput,
  actorUserId: string | null,
): ExternalActionPolicyView {
  const parsed = upsertExternalActionPoliciesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExternalActionPolicyInputError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  requireScope(db, workspaceId, parsed.data.scope, parsed.data.scopeId);
  if (
    parsed.data.scope !== "workspace" &&
    parsed.data.scope !== "campaign" &&
    parsed.data.rules.some((rule) => rule.rule === "autonomous")
  ) {
    throw new ExternalActionPolicyInputError(
      "Persona, connection, and lane policy may only inherit or require a human.",
    );
  }

  const current = listExternalActionPolicies(
    db,
    workspaceId,
    parsed.data.scope,
    parsed.data.scopeId,
  );
  if (current.updatedAt !== parsed.data.expectedUpdatedAt) {
    throw new ExternalActionPolicyConflictError(current);
  }

  db.transaction((tx) => {
    const existingRows = tx
      .select()
      .from(externalActionPolicyRules)
      .where(
        and(
          eq(externalActionPolicyRules.workspaceId, workspaceId),
          eq(externalActionPolicyRules.scope, parsed.data.scope),
          eq(externalActionPolicyRules.scopeId, parsed.data.scopeId),
        ),
      )
      .all();
    const transactionUpdatedAt = existingRows.reduce<number | null>(
      (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
      null,
    );
    if (transactionUpdatedAt !== parsed.data.expectedUpdatedAt) {
      throw new ExternalActionPolicyConflictError(current);
    }

    const now = Math.max(Date.now(), (transactionUpdatedAt ?? 0) + 1);
    const existingByKind = new Map(existingRows.map((row) => [row.actionKind, row]));
    for (const write of parsed.data.rules) {
      const existing = existingByKind.get(write.actionKind);
      if (parsed.data.scope !== "workspace" && write.rule === "inherit") {
        if (existing) {
          tx.delete(externalActionPolicyRules)
            .where(eq(externalActionPolicyRules.id, existing.id))
            .run();
        }
        continue;
      }
      if (existing) {
        tx.update(externalActionPolicyRules)
          .set({ rule: write.rule, updatedAt: now })
          .where(eq(externalActionPolicyRules.id, existing.id))
          .run();
      } else {
        tx.insert(externalActionPolicyRules)
          .values({
            id: randomUUID(),
            workspaceId,
            scope: parsed.data.scope,
            scopeId: parsed.data.scopeId,
            actionKind: write.actionKind,
            rule: write.rule,
            createdBy: actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }
  });
  return listExternalActionPolicies(db, workspaceId, parsed.data.scope, parsed.data.scopeId);
}

export function deleteExternalActionPolicy(db: Db, workspaceId: string, ruleId: string): boolean {
  const row = db
    .select()
    .from(externalActionPolicyRules)
    .where(
      and(
        eq(externalActionPolicyRules.workspaceId, workspaceId),
        eq(externalActionPolicyRules.id, ruleId),
      ),
    )
    .get();
  if (!row) return false;
  if (row.scope === "workspace") {
    throw new ExternalActionPolicyInputError("Workspace baseline policies cannot be deleted.");
  }
  db.delete(externalActionPolicyRules)
    .where(eq(externalActionPolicyRules.id, ruleId))
    .run();
  return true;
}
