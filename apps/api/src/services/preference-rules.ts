// Sprint 68 (PRD Move 5): the learned-rule store, its relevance ranking, and
// the founder's levers over it.
//
// Leaf module (D-68.10): drizzle + contracts + edit-distance only. The resolver
// seam, the pipeline engine and the extraction service all reach it, so it must
// reach nothing back.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  PREFERENCE_ACTIVATE_CONFIDENCE,
  PREFERENCE_MERGE_DISTANCE,
  PREFERENCE_RULE_LIMIT,
  PROMOTE_MIN_CONFIDENCE,
  PROMOTE_MIN_OBSERVATIONS,
  RETIRE_AFTER_MS,
  preferenceRuleSchema,
  type Channel,
  type CreatePreferenceRuleInput,
  type PreferenceEdit,
  type PreferencePolarity,
  type PreferenceRule,
  type PreferenceRuleEvidence,
  type PreferenceRuleOrigin,
  type PreferenceRuleStatus,
  type TaskType,
} from "@tuezday/contracts";
import type { ResolvePreferenceRule, ResolvePreferences } from "@tuezday/brain";
import type { Db } from "../db";
import {
  preferenceEdits,
  preferenceRuleEvidence,
  preferenceRules,
  type PreferenceRuleRow,
} from "../db/schema";
import { normalizedEditDistance } from "./edit-distance";
import { rowToPreferenceEdit } from "./preference-edits";

const EVIDENCE_EXCERPT_CHARS = 300;

export function rowToPreferenceRule(row: PreferenceRuleRow): PreferenceRule {
  return preferenceRuleSchema.parse({
    ...row,
    polarity: row.polarity as PreferencePolarity,
    scopeTaskType: row.scopeTaskType as TaskType | null,
    scopeChannel: row.scopeChannel as Channel | null,
    status: row.status as PreferenceRuleStatus,
    origin: row.origin as PreferenceRuleOrigin,
  });
}

/**
 * Two rules are the same rule when they say the same thing in the same scope.
 * Normalization strips the wording noise the model varies between passes —
 * casing, punctuation, and the "always"/"never" prefix it sometimes adds.
 */
export function normalizeRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListPreferenceRulesOptions {
  status?: PreferenceRuleStatus;
}

export async function listPreferenceRules(
  db: Db,
  workspaceId: string,
  options: ListPreferenceRulesOptions = {},
): Promise<PreferenceRule[]> {
  return (await db
    .select()
    .from(preferenceRules)
    .where(
      and(
        eq(preferenceRules.workspaceId, workspaceId),
        options.status ? eq(preferenceRules.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(preferenceRules.confidence), desc(preferenceRules.updatedAt))
    .all())
    .map(rowToPreferenceRule);
}

export async function getPreferenceRule(
  db: Db,
  workspaceId: string,
  ruleId: string,
): Promise<PreferenceRule | undefined> {
  const row = await db
    .select()
    .from(preferenceRules)
    .where(and(eq(preferenceRules.workspaceId, workspaceId), eq(preferenceRules.id, ruleId)))
    .get();
  return row ? rowToPreferenceRule(row) : undefined;
}

/** A rule's provenance: the excerpts it was learned from, newest first. */
export async function listRuleEvidence(db: Db, ruleId: string): Promise<PreferenceRuleEvidence[]> {
  const rows = await db
    .select()
    .from(preferenceRuleEvidence)
    .where(eq(preferenceRuleEvidence.ruleId, ruleId))
    .orderBy(desc(preferenceRuleEvidence.createdAt))
    .all();
  if (rows.length === 0) return [];
  const edits = await db
    .select()
    .from(preferenceEdits)
    .where(
      inArray(
        preferenceEdits.id,
        rows.map((row) => row.editId),
      ),
    )
    .all();
  const byId = new Map(edits.map((edit) => [edit.id, rowToPreferenceEdit(edit)]));
  return rows.map((row) => ({ ...row, edit: byId.get(row.editId) ?? null }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface UpsertRuleInput {
  rule: string;
  polarity: PreferencePolarity;
  scopeTaskType: TaskType | null;
  scopeChannel: Channel | null;
  confidence: number;
  origin: PreferenceRuleOrigin;
  /** The edit this observation came from, and the excerpt that justifies it. */
  evidence?: { editId: string; excerpt: string };
}

export interface UpsertRuleResult {
  rule: PreferenceRule;
  merged: boolean;
}

/**
 * Insert a learned rule, or merge it into the one it restates.
 *
 * A merge is the interesting case: the founder made the same correction twice,
 * which is exactly the evidence promotion is waiting for. It bumps the
 * observation count, raises confidence toward the higher reading, refreshes
 * `lastObservedAt`, and revives a rule that had been retired for going quiet.
 * A rule the founder explicitly **disabled** is never revived by a merge — the
 * switch-off has to mean something.
 */
export async function upsertPreferenceRule(
  db: Db,
  workspaceId: string,
  input: UpsertRuleInput,
  now = Date.now(),
): Promise<UpsertRuleResult> {
  const normalized = normalizeRule(input.rule);
  const existing = (await db
    .select()
    .from(preferenceRules)
    .where(eq(preferenceRules.workspaceId, workspaceId))
    .all())
    .filter(
      (row) =>
        row.scopeTaskType === input.scopeTaskType &&
        row.scopeChannel === input.scopeChannel &&
        normalizedEditDistance(normalizeRule(row.rule), normalized) <= PREFERENCE_MERGE_DISTANCE,
    )
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (existing) {
    const confidence = Math.max(existing.confidence, input.confidence);
    const observationCount = existing.observationCount + 1;
    const status: PreferenceRuleStatus =
      existing.status === "disabled" || existing.status === "promoted"
        ? (existing.status as PreferenceRuleStatus)
        : confidence >= PREFERENCE_ACTIVATE_CONFIDENCE
          ? "active"
          : "candidate";
    await db.update(preferenceRules)
      .set({
        confidence,
        observationCount,
        status,
        // A restatement revives a rule that had gone quiet — it is firing again.
        retiredAt: null,
        lastObservedAt: now,
        updatedAt: now,
      })
      .where(eq(preferenceRules.id, existing.id))
      .run();
    if (input.evidence) await addRuleEvidence(db, existing.id, input.evidence, now);
    return { rule: (await getPreferenceRule(db, workspaceId, existing.id))!, merged: true };
  }

  const row: PreferenceRuleRow = {
    id: randomUUID(),
    workspaceId,
    rule: input.rule.trim(),
    polarity: input.polarity,
    scopeTaskType: input.scopeTaskType,
    scopeChannel: input.scopeChannel,
    // D-68.9: confident enough to steer generation today, or visible as a
    // candidate the founder can promote in one click.
    status: input.confidence >= PREFERENCE_ACTIVATE_CONFIDENCE ? "active" : "candidate",
    origin: input.origin,
    confidence: input.confidence,
    observationCount: 1,
    appliedCount: 0,
    lastObservedAt: now,
    lastAppliedAt: null,
    promotedAt: null,
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(preferenceRules).values(row).run();
  if (input.evidence) await addRuleEvidence(db, row.id, input.evidence, now);
  return { rule: rowToPreferenceRule(row), merged: false };
}

export async function addRuleEvidence(
  db: Db,
  ruleId: string,
  evidence: { editId: string; excerpt: string },
  now = Date.now(),
): Promise<void> {
  await db.insert(preferenceRuleEvidence)
    .values({
      id: randomUUID(),
      ruleId,
      editId: evidence.editId,
      excerpt: evidence.excerpt.slice(0, EVIDENCE_EXCERPT_CHARS),
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [preferenceRuleEvidence.ruleId, preferenceRuleEvidence.editId],
    })
    .run();
}

/** A rule the founder wrote by hand. Active immediately — they are the source of truth. */
export async function createManualRule(
  db: Db,
  workspaceId: string,
  input: CreatePreferenceRuleInput,
  now = Date.now(),
): Promise<PreferenceRule> {
  return (await upsertPreferenceRule(
    db,
    workspaceId,
    {
      rule: input.rule,
      polarity: input.polarity,
      scopeTaskType: input.scopeTaskType ?? null,
      scopeChannel: input.scopeChannel ?? null,
      confidence: 100,
      origin: "manual",
    },
    now,
  )).rule;
}

export async function setRuleStatus(
  db: Db,
  workspaceId: string,
  ruleId: string,
  status: PreferenceRuleStatus,
  now = Date.now(),
): Promise<PreferenceRule | undefined> {
  const existing = await getPreferenceRule(db, workspaceId, ruleId);
  if (!existing) return undefined;
  await db.update(preferenceRules)
    .set({
      status,
      retiredAt: status === "retired" ? now : null,
      promotedAt: status === "promoted" ? now : existing.promotedAt,
      updatedAt: now,
    })
    .where(eq(preferenceRules.id, ruleId))
    .run();
  return await getPreferenceRule(db, workspaceId, ruleId);
}

export async function deletePreferenceRule(db: Db, workspaceId: string, ruleId: string): Promise<boolean> {
  const result = await db
    .delete(preferenceRules)
    .where(and(eq(preferenceRules.workspaceId, workspaceId), eq(preferenceRules.id, ruleId)))
    .run();
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Retrieval (D-68.5) — scope specificity, then confidence. Never BM25: a rule
// like "never open with a rhetorical question" shares no vocabulary with the
// signal it should govern, so lexical ranking would starve exactly the rules
// that generalize.
// ---------------------------------------------------------------------------

export interface PreferenceQuery {
  taskType?: TaskType;
  channel?: Channel;
  limit?: number;
}

/**
 * Specificity, given the row already passed `inScope`: 3 = pinned to this task
 * *and* channel, 2 = channel, 1 = task, 0 = global. A rule learned from
 * LinkedIn signal responses outranks one learned workspace-wide.
 */
function scopeTier(row: PreferenceRuleRow): number {
  if (row.scopeTaskType !== null && row.scopeChannel !== null) return 3;
  if (row.scopeChannel !== null) return 2;
  if (row.scopeTaskType !== null) return 1;
  return 0;
}

function inScope(row: PreferenceRuleRow, query: PreferenceQuery): boolean {
  if (row.scopeTaskType !== null && row.scopeTaskType !== query.taskType) return false;
  if (row.scopeChannel !== null && row.scopeChannel !== query.channel) return false;
  return true;
}

export function toResolveRule(rule: PreferenceRule): ResolvePreferenceRule {
  return {
    id: rule.id,
    rule: rule.rule,
    polarity: rule.polarity,
    confidence: rule.confidence,
    observationCount: rule.observationCount,
    scope:
      rule.scopeTaskType && rule.scopeChannel
        ? `${rule.scopeTaskType} on ${rule.scopeChannel}`
        : (rule.scopeChannel ?? rule.scopeTaskType ?? "all tasks"),
  };
}

/**
 * The top-N active rules that apply to this task, ranked for injection.
 * Read-only by contract (D-68.6) — `appliedCount` is a claim that a rule
 * shaped real output, so only a real generation may move it.
 */
export async function retrievePreferenceRules(
  db: Db,
  workspaceId: string,
  query: PreferenceQuery,
): Promise<ResolvePreferences | null> {
  const ranked = (await db
    .select()
    .from(preferenceRules)
    .where(and(eq(preferenceRules.workspaceId, workspaceId), eq(preferenceRules.status, "active")))
    .all())
    .filter((row) => inScope(row, query))
    .sort(
      (a, b) =>
        scopeTier(b) - scopeTier(a) ||
        b.confidence - a.confidence ||
        b.observationCount - a.observationCount ||
        (b.lastObservedAt ?? 0) - (a.lastObservedAt ?? 0),
    )
    .slice(0, query.limit ?? PREFERENCE_RULE_LIMIT);

  if (ranked.length === 0) return null;
  return { rules: ranked.map((row) => toResolveRule(rowToPreferenceRule(row))) };
}

/**
 * Record that these rules shaped a real generation. The only writer of
 * `appliedCount`, and both promotion and retirement read it — which is exactly
 * why a preview, the resolver inspector, and the eval harness must not call it.
 */
export async function recordRuleApplications(db: Db, ruleIds: string[], now = Date.now()): Promise<void> {
  for (const ruleId of ruleIds) {
    const row = await db.select().from(preferenceRules).where(eq(preferenceRules.id, ruleId)).get();
    if (!row) continue;
    await db.update(preferenceRules)
      .set({ appliedCount: row.appliedCount + 1, lastAppliedAt: now, updatedAt: now })
      .where(eq(preferenceRules.id, ruleId))
      .run();
  }
}

// ---------------------------------------------------------------------------
// Promotion and retirement
// ---------------------------------------------------------------------------

/**
 * The rules the weekly synthesis is allowed to fold into the brain (D-68.7):
 * re-derived by the founder's own edits at least twice, confident, and proven
 * to have shaped at least one generation. Computed before the LLM runs and
 * recorded on the synthesis, so promotion never depends on parsing prose.
 */
export async function listPromotableRules(db: Db, workspaceId: string): Promise<PreferenceRule[]> {
  return (await listPreferenceRules(db, workspaceId, { status: "active" })).filter(
    (rule) =>
      rule.observationCount >= PROMOTE_MIN_OBSERVATIONS &&
      rule.confidence >= PROMOTE_MIN_CONFIDENCE &&
      rule.appliedCount >= 1,
  );
}

/** Mark an accepted synthesis's promotion set: the brain doc now carries them. */
export async function markRulesPromoted(db: Db, ruleIds: string[], now = Date.now()): Promise<number> {
  let promoted = 0;
  for (const ruleId of ruleIds) {
    const result = await db
      .update(preferenceRules)
      .set({ status: "promoted", promotedAt: now, updatedAt: now })
      .where(and(eq(preferenceRules.id, ruleId), eq(preferenceRules.status, "active")))
      .run();
    promoted += result.changes;
  }
  return promoted;
}

/**
 * D-68.8: retire a rule only when it is *both* unobserved and unapplied inside
 * the window. Retiring on "not re-observed" alone would delete every rule that
 * is working, since a followed rule generates no further corrections.
 */
export async function retireStaleRules(db: Db, workspaceId: string, now = Date.now()): Promise<number> {
  const cutoff = now - RETIRE_AFTER_MS;
  const stale = (await db
    .select()
    .from(preferenceRules)
    .where(eq(preferenceRules.workspaceId, workspaceId))
    .all())
    .filter(
      (row) =>
        (row.status === "active" || row.status === "candidate") &&
        (row.lastObservedAt ?? row.createdAt) < cutoff &&
        (row.lastAppliedAt ?? 0) < cutoff,
    );
  for (const row of stale) {
    await db.update(preferenceRules)
      .set({ status: "retired", retiredAt: now, updatedAt: now })
      .where(eq(preferenceRules.id, row.id))
      .run();
  }
  return stale.length;
}

/** The excerpt stored as a rule's provenance — the founder's words when we have them. */
export function evidenceExcerpt(edit: PreferenceEdit): string {
  if (edit.instruction) return `Instruction: ${edit.instruction}`;
  return `Before: ${edit.beforeContent.slice(0, 140)}\nAfter: ${edit.afterContent.slice(0, 140)}`;
}
