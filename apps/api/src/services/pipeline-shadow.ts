import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  ApprovalState,
  AutomationComparison,
  AutomationGenerationPath,
  AutomationPathMetrics,
  Channel,
  PipelineRunStatus,
  PipelineShadowPair,
  RecordRolloutDecisionInput,
  RolloutDecision,
  ShadowVerdict,
  ShadowVerdictInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  drafts,
  llmUsageEvents,
  pipelineRolloutDecisions,
  pipelineRuns,
  pipelineShadowPairs,
  socialAutomationSettings,
  type DraftRow,
  type PipelineShadowPairRow,
} from "../db/schema";
import { normalizedEditDistance } from "./edit-distance";

const DAY_MS = 24 * 60 * 60 * 1000;
export const COMPARISON_WINDOW_DAYS = 30;

/** Shadow run + pair identity — mirrors automaticDraftKey the way the live
 * engine run reuses it verbatim (D-65.2). */
export function shadowPairKey(input: {
  workspaceId: string;
  signalId: string;
  campaignId: string;
  channel: Channel;
}): string {
  return [
    "shadow:v1",
    input.workspaceId,
    input.signalId,
    input.campaignId,
    input.channel,
  ].join(":");
}

export function createShadowPair(
  db: Db,
  input: {
    workspaceId: string;
    pairKey: string;
    signalId: string;
    campaignId: string | null;
    channel: Channel;
    draftId: string;
    runId: string;
  },
): PipelineShadowPairRow {
  const row: PipelineShadowPairRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    pairKey: input.pairKey,
    signalId: input.signalId,
    campaignId: input.campaignId,
    channel: input.channel,
    draftId: input.draftId,
    runId: input.runId,
    verdict: null,
    verdictNotes: "",
    verdictByUserId: null,
    verdictAt: null,
    createdAt: Date.now(),
  };
  db.insert(pipelineShadowPairs).values(row).run();
  return row;
}

function proposalContentOf(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    return null;
  }
}

function toPair(
  pair: PipelineShadowPairRow,
  draft: { content: string; state: string } | null,
  run: { status: string; resultJson: string | null },
): PipelineShadowPair {
  return {
    id: pair.id,
    workspaceId: pair.workspaceId,
    signalId: pair.signalId,
    campaignId: pair.campaignId,
    channel: pair.channel as Channel,
    draftId: pair.draftId,
    runId: pair.runId,
    draftContent: draft?.content ?? null,
    draftState: (draft?.state as ApprovalState | undefined) ?? null,
    proposalContent: proposalContentOf(run.resultJson),
    runStatus: run.status as PipelineRunStatus,
    verdict: pair.verdict as ShadowVerdict | null,
    verdictNotes: pair.verdictNotes,
    verdictAt: pair.verdictAt,
    createdAt: pair.createdAt,
  };
}

export function listShadowPairs(
  db: Db,
  workspaceId: string,
  options: { reviewed?: boolean; limit?: number } = {},
): PipelineShadowPair[] {
  const conditions = [eq(pipelineShadowPairs.workspaceId, workspaceId)];
  if (options.reviewed === true) conditions.push(isNotNull(pipelineShadowPairs.verdict));
  if (options.reviewed === false) conditions.push(isNull(pipelineShadowPairs.verdict));
  return db
    .select({
      pair: pipelineShadowPairs,
      draftContent: drafts.content,
      draftState: drafts.state,
      runStatus: pipelineRuns.status,
      runResultJson: pipelineRuns.resultJson,
    })
    .from(pipelineShadowPairs)
    .innerJoin(pipelineRuns, eq(pipelineShadowPairs.runId, pipelineRuns.id))
    .leftJoin(drafts, eq(pipelineShadowPairs.draftId, drafts.id))
    .where(and(...conditions))
    .orderBy(desc(pipelineShadowPairs.createdAt), sql`${pipelineShadowPairs}.rowid desc`)
    .limit(Math.min(options.limit ?? 50, 100))
    .all()
    .map((row) =>
      toPair(
        row.pair,
        row.draftContent === null ? null : { content: row.draftContent, state: row.draftState! },
        { status: row.runStatus, resultJson: row.runResultJson },
      ),
    );
}

export function recordShadowVerdict(
  db: Db,
  workspaceId: string,
  pairId: string,
  input: ShadowVerdictInput,
  actor: { userId: string | null },
): PipelineShadowPair | undefined {
  const existing = db
    .select()
    .from(pipelineShadowPairs)
    .where(and(eq(pipelineShadowPairs.workspaceId, workspaceId), eq(pipelineShadowPairs.id, pairId)))
    .get();
  if (!existing) return undefined;
  db.update(pipelineShadowPairs)
    .set({
      verdict: input.verdict,
      verdictNotes: input.notes,
      verdictByUserId: actor.userId,
      verdictAt: Date.now(),
    })
    .where(eq(pipelineShadowPairs.id, pairId))
    .run();
  const [pair] = listShadowPairsById(db, workspaceId, pairId);
  return pair;
}

function listShadowPairsById(db: Db, workspaceId: string, pairId: string): PipelineShadowPair[] {
  return db
    .select({
      pair: pipelineShadowPairs,
      draftContent: drafts.content,
      draftState: drafts.state,
      runStatus: pipelineRuns.status,
      runResultJson: pipelineRuns.resultJson,
    })
    .from(pipelineShadowPairs)
    .innerJoin(pipelineRuns, eq(pipelineShadowPairs.runId, pipelineRuns.id))
    .leftJoin(drafts, eq(pipelineShadowPairs.draftId, drafts.id))
    .where(and(eq(pipelineShadowPairs.workspaceId, workspaceId), eq(pipelineShadowPairs.id, pairId)))
    .all()
    .map((row) =>
      toPair(
        row.pair,
        row.draftContent === null ? null : { content: row.draftContent, state: row.draftState! },
        { status: row.runStatus, resultJson: row.runResultJson },
      ),
    );
}

// ---------------------------------------------------------------------------
// Comparison (D-65.8)
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Gate outcomes over one side's automation drafts. Edit distance is measured
 * on approved drafts only — what shipped vs what was generated. */
function draftMetrics(rows: Pick<DraftRow, "state" | "originalContent" | "content">[]): Omit<
  AutomationPathMetrics,
  "costCents"
> {
  const approvedRows = rows.filter((row) => row.state === "approved");
  const approved = approvedRows.length;
  const rejected = rows.filter((row) => row.state === "rejected").length;
  const decided = approved + rejected;
  const distances = approvedRows.map((row) =>
    normalizedEditDistance(row.originalContent, row.content),
  );
  return {
    drafts: rows.length,
    decided,
    approved,
    rejected,
    approvalRate: decided > 0 ? round1((100 * approved) / decided) : null,
    avgEditDistance:
      distances.length > 0
        ? round1(distances.reduce((sum, d) => sum + d, 0) / distances.length)
        : null,
  };
}

/** The workspace's generation path, read directly so this module never imports
 * the automation orchestrator (which imports this one). */
export function getGenerationPath(db: Db, workspaceId: string): AutomationGenerationPath {
  const row = db
    .select({ generationPath: socialAutomationSettings.generationPath })
    .from(socialAutomationSettings)
    .where(eq(socialAutomationSettings.workspaceId, workspaceId))
    .get();
  return (row?.generationPath ?? "legacy") as AutomationGenerationPath;
}

function setGenerationPath(db: Db, workspaceId: string, path: AutomationGenerationPath): void {
  const now = Date.now();
  db.insert(socialAutomationSettings)
    .values({ workspaceId, generationPath: path, updatedAt: now })
    .onConflictDoUpdate({
      target: socialAutomationSettings.workspaceId,
      set: { generationPath: path, updatedAt: now },
    })
    .run();
}

export function getAutomationComparison(
  db: Db,
  workspaceId: string,
  options: { windowDays?: number; now?: number } = {},
): AutomationComparison {
  const windowDays = options.windowDays ?? COMPARISON_WINDOW_DAYS;
  const now = options.now ?? Date.now();
  const since = now - windowDays * DAY_MS;

  // Legacy side: automation drafts are the ones carrying an automationKey.
  const legacyDrafts = db
    .select({
      state: drafts.state,
      originalContent: drafts.originalContent,
      content: drafts.content,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.workspaceId, workspaceId),
        isNotNull(drafts.automationKey),
        gte(drafts.createdAt, since),
      ),
    )
    .all();
  // Caveat stated on the wire schema: this sum includes founder-triggered
  // manual signal drafts — the legacy path has no per-draft cost attribution.
  const legacyCost =
    db
      .select({ total: sql<number>`coalesce(sum(${llmUsageEvents.costCents}), 0)` })
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.workspaceId, workspaceId),
          inArray(llmUsageEvents.pipeline, ["signal_draft", "review"]),
          gte(llmUsageEvents.createdAt, since),
        ),
      )
      .get()?.total ?? 0;

  // Engine side: live + shadow runs in the window (dry runs are founder
  // experiments, not the A/B), drafts joined from the live runs' gate handoff.
  const engineRuns = db
    .select({
      mode: pipelineRuns.mode,
      status: pipelineRuns.status,
      draftId: pipelineRuns.draftId,
      costCents: pipelineRuns.costCents,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.workspaceId, workspaceId),
        inArray(pipelineRuns.mode, ["live", "shadow"]),
        gte(pipelineRuns.createdAt, since),
      ),
    )
    .all();
  const engineDraftIds = engineRuns
    .filter((run) => run.mode === "live" && run.draftId !== null)
    .map((run) => run.draftId!);
  const engineDrafts =
    engineDraftIds.length > 0
      ? db
          .select({
            state: drafts.state,
            originalContent: drafts.originalContent,
            content: drafts.content,
          })
          .from(drafts)
          .where(and(eq(drafts.workspaceId, workspaceId), inArray(drafts.id, engineDraftIds)))
          .all()
      : [];

  const pairs = db
    .select({ verdict: pipelineShadowPairs.verdict })
    .from(pipelineShadowPairs)
    .where(
      and(
        eq(pipelineShadowPairs.workspaceId, workspaceId),
        gte(pipelineShadowPairs.createdAt, since),
      ),
    )
    .all();

  return {
    workspaceId,
    generationPath: getGenerationPath(db, workspaceId),
    windowDays,
    legacy: { ...draftMetrics(legacyDrafts), costCents: Math.round(legacyCost) },
    engine: {
      ...draftMetrics(engineDrafts),
      costCents: Math.round(engineRuns.reduce((sum, run) => sum + run.costCents, 0)),
      health: {
        runs: engineRuns.length,
        succeeded: engineRuns.filter((run) => run.status === "succeeded").length,
        failed: engineRuns.filter((run) => run.status === "failed").length,
        escalated: engineRuns.filter((run) => run.status === "escalated").length,
      },
    },
    shadow: {
      pairs: pairs.length,
      reviewed: pairs.filter((pair) => pair.verdict !== null).length,
      engineWins: pairs.filter((pair) => pair.verdict === "engine").length,
      legacyWins: pairs.filter((pair) => pair.verdict === "legacy").length,
      ties: pairs.filter((pair) => pair.verdict === "tie").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Rollout decisions (D-65.9)
// ---------------------------------------------------------------------------

const PATH_FOR_DECISION: Record<RecordRolloutDecisionInput["decision"], AutomationGenerationPath> =
  {
    adopt_engine: "pipeline",
    keep_legacy: "legacy",
    extend_shadow: "shadow",
  };

/** Freeze the comparison into an append-only record, then apply the matching
 * generation path. The record is the paper trail the PRD's acceptance names. */
export function recordRolloutDecision(
  db: Db,
  workspaceId: string,
  input: RecordRolloutDecisionInput,
  actor: { userId: string | null },
): RolloutDecision {
  const metrics = getAutomationComparison(db, workspaceId);
  const record: RolloutDecision = {
    id: randomUUID(),
    workspaceId,
    taskKey: "signal_social_post",
    decision: input.decision,
    rationale: input.rationale,
    metrics,
    decidedByUserId: actor.userId,
    createdAt: Date.now(),
  };
  db.insert(pipelineRolloutDecisions)
    .values({
      id: record.id,
      workspaceId,
      taskKey: record.taskKey,
      decision: record.decision,
      rationale: record.rationale,
      metricsJson: JSON.stringify(metrics),
      decidedByUserId: record.decidedByUserId,
      createdAt: record.createdAt,
    })
    .run();
  setGenerationPath(db, workspaceId, PATH_FOR_DECISION[input.decision]);
  return record;
}

export function listRolloutDecisions(db: Db, workspaceId: string): RolloutDecision[] {
  return db
    .select()
    .from(pipelineRolloutDecisions)
    .where(eq(pipelineRolloutDecisions.workspaceId, workspaceId))
    .orderBy(desc(pipelineRolloutDecisions.createdAt), sql`${pipelineRolloutDecisions}.rowid desc`)
    .all()
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      taskKey: row.taskKey as RolloutDecision["taskKey"],
      decision: row.decision as RolloutDecision["decision"],
      rationale: row.rationale,
      metrics: JSON.parse(row.metricsJson) as AutomationComparison,
      decidedByUserId: row.decidedByUserId,
      createdAt: row.createdAt,
    }));
}
