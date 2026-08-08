import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  EVAL_JUDGE_PASS,
  EVAL_REGRESSION_THRESHOLDS,
  findingsOutputSchema,
  type BuildEvalSuiteInput,
  type Channel,
  type CtaExpectation,
  type EvalCase,
  type EvalCaseOutcome,
  type EvalCaseResult,
  type EvalCheckResult,
  type EvalComparison,
  type EvalGatedMetric,
  type EvalMetricDelta,
  type EvalRubric,
  type EvalRun,
  type EvalRunDetail,
  type EvalRunMetrics,
  type EvalSuite,
  type EvalVerdict,
  type PipelineTaskKey,
  type RunEvalSuiteInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  agentRunSteps,
  agentRuns,
  approvalDecisions,
  drafts,
  evalCaseResults,
  evalCases,
  evalRuns,
  evalSuites,
  pipelineRunSteps,
  signals,
  type EvalCaseRow,
  type EvalRunRow,
  type EvalSuiteRow,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import type { SafeFetchService } from "../safe-fetch/index";
import { listBannedClaims } from "./banned-claims";
import { normalizedEditDistance } from "./edit-distance";
import { hardChecksPassed, runHardChecks } from "./eval-checks";
import { judgeDraft } from "./eval-judge";
import { resolveChannelGuidance } from "./guidance";
import { executePipelineRun } from "./pipeline-engine";
import { getPipelineDefinition, resolvePipelineDefinition } from "./pipeline-definitions";
import { startPipelineRun } from "./pipeline-runs";
import { getAutomationComparison } from "./pipeline-shadow";

/**
 * Sprint 67 — the replay harness (PRD §7, direction doc Move 6).
 *
 * Replays frozen historical cases through the pipeline engine in `dry_run`
 * mode (D-67.1) — real, metered, traced executions that write no generation
 * and no draft — then scores each result deterministically (and optionally
 * with a rubric judge) against what the founder actually did.
 *
 * This module imports the engine, so nothing in the agent tool registry may
 * ever import it (D-67.10).
 */

export interface EvalHarnessDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export class EvalSuiteNotFoundError extends Error {
  constructor(public readonly suiteId: string) {
    super(`Eval suite ${suiteId} not found`);
    this.name = "EvalSuiteNotFoundError";
  }
}

export class EvalDefinitionUnavailableError extends Error {
  constructor(public readonly taskKey: string) {
    super(`No active pipeline definition resolves for ${taskKey}`);
    this.name = "EvalDefinitionUnavailableError";
  }
}

const TASK_KEY: PipelineTaskKey = "signal_social_post";

// ---------------------------------------------------------------------------
// Suites (D-67.2)
// ---------------------------------------------------------------------------

function rowToSuite(row: EvalSuiteRow): EvalSuite {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    taskKey: row.taskKey as PipelineTaskKey,
    channel: row.channel as Channel,
    ctaExpectation: row.ctaExpectation as CtaExpectation,
    caseCount: row.caseCount,
    createdAt: row.createdAt,
  };
}

function rowToCase(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    suiteId: row.suiteId,
    workspaceId: row.workspaceId,
    signalId: row.signalId,
    signalContent: row.signalContent,
    signalSource: row.signalSource,
    channel: row.channel as Channel,
    campaignId: row.campaignId,
    personaId: row.personaId,
    sourceDraftId: row.sourceDraftId,
    generatedContent: row.generatedContent,
    finalContent: row.finalContent,
    outcome: row.outcome as EvalCaseOutcome,
    rejectionReason: row.rejectionReason,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

/** `edited` = shipped, but not as written — the signal Sprint 68 will mine. */
function outcomeOf(state: string, originalContent: string, content: string): EvalCaseOutcome {
  if (state === "rejected") return "rejected";
  if (state === "edited") return "edited";
  return originalContent === content ? "approved" : "edited";
}

/**
 * Freeze the newest decided drafts on this channel into a suite. Content is
 * snapshotted rather than joined at read time: a trend line over a case set
 * that silently changes underneath it is worse than no trend line.
 */
export async function buildEvalSuite(
  db: Db,
  workspaceId: string,
  input: BuildEvalSuiteInput,
  actor: { userId: string | null },
): Promise<{ suite: EvalSuite; cases: EvalCase[] }> {
  const candidates = await db
    .select({ draft: drafts, signalContent: signals.content, signalSource: signals.source })
    .from(drafts)
    .innerJoin(signals, eq(drafts.sourceSignalId, signals.id))
    .where(
      and(
        eq(drafts.workspaceId, workspaceId),
        eq(drafts.taskType, "signal_response"),
        eq(drafts.channel, input.channel),
        inArray(drafts.state, ["approved", "rejected", "edited"]),
      ),
    )
    .orderBy(desc(drafts.updatedAt))
    .limit(input.limit);

  const now = Date.now();
  const suiteId = randomUUID();
  const draftIds = candidates.map((row) => row.draft.id);
  const reasons = await reasonsFor(db, workspaceId, draftIds);

  const caseRows: EvalCaseRow[] = candidates.map((row) => ({
    id: randomUUID(),
    suiteId,
    workspaceId,
    signalId: row.draft.sourceSignalId,
    signalContent: row.signalContent,
    signalSource: row.signalSource,
    channel: row.draft.channel,
    campaignId: row.draft.campaignId,
    personaId: row.draft.personaId,
    sourceDraftId: row.draft.id,
    generatedContent: row.draft.originalContent,
    finalContent: row.draft.content,
    outcome: outcomeOf(row.draft.state, row.draft.originalContent, row.draft.content),
    rejectionReason: reasons.get(row.draft.id) ?? null,
    decidedAt: row.draft.updatedAt,
    createdAt: now,
  }));

  const suiteRow: EvalSuiteRow = {
    id: suiteId,
    workspaceId,
    name: input.name,
    taskKey: TASK_KEY,
    channel: input.channel,
    ctaExpectation: input.ctaExpectation,
    caseCount: caseRows.length,
    createdByUserId: actor.userId,
    createdAt: now,
  };
  await db.insert(evalSuites).values(suiteRow);
  if (caseRows.length > 0) await db.insert(evalCases).values(caseRows);
  return { suite: rowToSuite(suiteRow), cases: caseRows.map(rowToCase) };
}

/** Newest stated reject reason per draft (Sprint 66's `approval_decisions.reason`). */
async function reasonsFor(db: Db, workspaceId: string, draftIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (draftIds.length === 0) return found;
  const rows = await db
    .select({ draftId: approvalDecisions.draftId, reason: approvalDecisions.reason })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.workspaceId, workspaceId),
        inArray(approvalDecisions.draftId, draftIds),
        eq(approvalDecisions.action, "reject"),
        isNotNull(approvalDecisions.reason),
      ),
    )
    .orderBy(desc(approvalDecisions.createdAt));
  for (const row of rows) {
    if (row.reason && !found.has(row.draftId)) found.set(row.draftId, row.reason);
  }
  return found;
}

export async function listEvalSuites(db: Db, workspaceId: string): Promise<EvalSuite[]> {
  return (await db
    .select()
    .from(evalSuites)
    .where(eq(evalSuites.workspaceId, workspaceId))
    .orderBy(desc(evalSuites.createdAt)))
    .map(rowToSuite);
}

export async function listEvalCases(db: Db, workspaceId: string, suiteId: string): Promise<EvalCase[]> {
  return (await db
    .select()
    .from(evalCases)
    .where(and(eq(evalCases.workspaceId, workspaceId), eq(evalCases.suiteId, suiteId))))
    .map(rowToCase);
}

// ---------------------------------------------------------------------------
// What a run actually retrieved — the citation-grounding corpus (D-67.6)
// ---------------------------------------------------------------------------

/**
 * System prompt + composed user message + every tool result, for every agent
 * step of a pipeline run. This is the ground a citation has to stand on.
 */
export async function runCorpus(db: Db, pipelineRunId: string): Promise<string> {
  const agentRunIds = (await db
    .select({ agentRunId: pipelineRunSteps.agentRunId })
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, pipelineRunId)))
    .map((row) => row.agentRunId)
    .filter((id): id is string => id !== null);
  if (agentRunIds.length === 0) return "";

  const parts: string[] = [];
  for (const row of await db
    .select({ system: agentRuns.system, inputMessages: agentRuns.inputMessages })
    .from(agentRuns)
    .where(inArray(agentRuns.id, agentRunIds))) {
    parts.push(row.system, row.inputMessages);
  }
  for (const row of await db
    .select({ result: agentRunSteps.toolResultJson })
    .from(agentRunSteps)
    .where(inArray(agentRunSteps.runId, agentRunIds))) {
    if (row.result) parts.push(row.result);
  }
  return parts.join("\n");
}

/** Citations the critique step(s) attached to their findings (Sprint 66). */
export async function runCitations(db: Db, pipelineRunId: string): Promise<string[]> {
  const citations: string[] = [];
  for (const row of await db
    .select({ outputJson: pipelineRunSteps.outputJson })
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, pipelineRunId))) {
    if (!row.outputJson) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.outputJson);
    } catch {
      continue;
    }
    const findings = findingsOutputSchema.safeParse(parsed);
    if (!findings.success) continue;
    for (const finding of findings.data.findings) citations.push(finding.citation);
  }
  return citations;
}

// ---------------------------------------------------------------------------
// Metrics (D-67.7)
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round1((100 * numerator) / denominator) : null;
}

function mean(values: number[]): number | null {
  return values.length > 0
    ? round1(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

/** What the founder's outcome implies the harness should have said. */
function expectedVerdict(outcome: EvalCaseOutcome): EvalVerdict {
  return outcome === "rejected" ? "flag" : "pass";
}

export interface ScoredCase {
  outcome: EvalCaseOutcome;
  checks: EvalCheckResult[];
  judge: EvalRubric | null;
  verdict: EvalVerdict | null;
  editDistanceToFinal: number | null;
  costCents: number;
  durationMs: number;
  failureReason: string | null;
}

/** Pure aggregation — exported so the golden CI script scores identically. */
export function evalRunMetrics(
  scored: ScoredCase[],
  production: EvalRunMetrics["production"],
): EvalRunMetrics {
  const completed = scored.filter((entry) => entry.failureReason === null);
  const violations: Record<string, number> = {};
  for (const entry of completed) {
    for (const check of entry.checks) {
      if (check.status === "fail") violations[check.kind] = (violations[check.kind] ?? 0) + 1;
    }
  }
  const judged = completed.filter((entry) => entry.judge !== null);
  const rejectedCases = completed.filter((entry) => entry.outcome === "rejected");
  const approvedCases = completed.filter((entry) => entry.outcome === "approved");
  const agreed = completed.filter((entry) => entry.verdict === expectedVerdict(entry.outcome));

  return {
    cases: scored.length,
    completed: completed.length,
    failed: scored.length - completed.length,
    hardCheckPassRate: rate(
      completed.filter((entry) => hardChecksPassed(entry.checks)).length,
      completed.length,
    ),
    violations,
    judged: judged.length,
    avgJudgeScore: mean(judged.map((entry) => entry.judge!.overall)),
    avgEditDistanceToFinal: mean(
      completed
        .map((entry) => entry.editDistanceToFinal)
        .filter((value): value is number => value !== null),
    ),
    agreementRate: rate(agreed.length, completed.length),
    rejectRecall: rate(
      rejectedCases.filter((entry) => entry.verdict === "flag").length,
      rejectedCases.length,
    ),
    approvePassRate: rate(
      approvedCases.filter((entry) => entry.verdict === "pass").length,
      approvedCases.length,
    ),
    costCents: round1(scored.reduce((sum, entry) => sum + entry.costCents, 0)),
    avgDurationMs: Math.round(
      scored.length > 0
        ? scored.reduce((sum, entry) => sum + entry.durationMs, 0) / scored.length
        : 0,
    ),
    production,
  };
}

export function emptyEvalMetrics(): EvalRunMetrics {
  return evalRunMetrics([], null);
}

// ---------------------------------------------------------------------------
// Regression gate (D-67.9)
// ---------------------------------------------------------------------------

/**
 * Pure comparison, shared by the API and the golden CI script. A metric that is
 * null on either side is skipped and reported as such — an uncomputable number
 * must never be silently read as "no regression".
 */
export function compareEvalRuns(
  current: { id: string; metrics: EvalRunMetrics },
  baseline: { id: string; metrics: EvalRunMetrics; baselineLabel: string | null } | null,
): EvalComparison {
  const regressions: EvalMetricDelta[] = [];
  const improvements: EvalMetricDelta[] = [];
  const skipped: string[] = [];

  for (const [metric, rule] of Object.entries(EVAL_REGRESSION_THRESHOLDS) as Array<
    [EvalGatedMetric, { better: "higher" | "lower"; tolerance: number }]
  >) {
    const currentValue = current.metrics[metric];
    const baselineValue = baseline?.metrics[metric] ?? null;
    if (currentValue === null || baselineValue === null) {
      skipped.push(metric);
      continue;
    }
    const delta = round1(currentValue - baselineValue);
    // Signed so that positive always means "better", whichever way the metric runs.
    const gain = rule.better === "higher" ? delta : -delta;
    const entry: EvalMetricDelta = {
      metric,
      baseline: baselineValue,
      current: currentValue,
      delta,
      tolerance: rule.tolerance,
    };
    if (gain < -rule.tolerance) regressions.push(entry);
    else if (gain > 0) improvements.push(entry);
  }

  return {
    ok: regressions.length === 0,
    baselineLabel: baseline?.baselineLabel ?? null,
    baselineRunId: baseline?.id ?? null,
    currentRunId: current.id,
    regressions,
    improvements,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function rowToRun(row: EvalRunRow): EvalRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    suiteId: row.suiteId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    status: row.status as EvalRun["status"],
    judgeEnabled: row.judgeEnabled,
    metrics: JSON.parse(row.metricsJson) as EvalRunMetrics,
    baselineLabel: row.baselineLabel,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function rowToCaseResult(row: typeof evalCaseResults.$inferSelect): EvalCaseResult {
  return {
    id: row.id,
    runId: row.runId,
    caseId: row.caseId,
    pipelineRunId: row.pipelineRunId,
    producedContent: row.producedContent,
    checks: JSON.parse(row.checksJson) as EvalCheckResult[],
    judge: row.judgeJson ? (JSON.parse(row.judgeJson) as EvalRubric) : null,
    verdict: row.verdict as EvalVerdict | null,
    editDistanceToFinal: row.editDistanceToFinal,
    costCents: row.costCents,
    durationMs: row.durationMs,
    failureReason: row.failureReason,
  };
}

/**
 * Replay every case in the suite and score it. One eval run per call; each case
 * becomes one `dry_run` pipeline run tagged with this eval run's id, so any
 * result can be opened in the Agent Inspector.
 */
export async function runEvalSuite(
  db: Db,
  deps: EvalHarnessDeps,
  workspaceId: string,
  input: RunEvalSuiteInput,
  actor: { userId: string | null; label: string },
): Promise<EvalRunDetail> {
  const suiteRow = (await db
    .select()
    .from(evalSuites)
    .where(and(eq(evalSuites.workspaceId, workspaceId), eq(evalSuites.id, input.suiteId))))[0];
  if (!suiteRow) throw new EvalSuiteNotFoundError(input.suiteId);
  const suite = rowToSuite(suiteRow);

  const definition = input.definitionId
    ? await getPipelineDefinition(db, workspaceId, input.definitionId)
    : await resolvePipelineDefinition(db, { workspaceId, taskKey: suite.taskKey });
  if (!definition) throw new EvalDefinitionUnavailableError(suite.taskKey);

  const cases = await listEvalCases(db, workspaceId, suite.id);
  const now = Date.now();
  const runId = randomUUID();
  await db.insert(evalRuns)
    .values({
      id: runId,
      workspaceId,
      suiteId: suite.id,
      definitionId: definition.id,
      definitionVersion: definition.currentVersion,
      status: "running",
      judgeEnabled: input.judge,
      metricsJson: JSON.stringify(emptyEvalMetrics()),
      baselineLabel: null,
      failureReason: null,
      createdByUserId: actor.userId,
      createdAt: now,
      finishedAt: null,
    });

  const bannedClaims = (await listBannedClaims(db, workspaceId)).map((claim) => claim.phrase);
  const scored: ScoredCase[] = [];

  for (const evalCase of cases) {
    const scoredCase = await replayCase(db, deps, workspaceId, {
      runId,
      suite,
      evalCase,
      definition,
      bannedClaims,
      judge: input.judge,
      createdBy: `eval:${runId}`,
    });
    scored.push(scoredCase);
  }

  const metrics = evalRunMetrics(scored, await getAutomationComparison(db, workspaceId));
  await db.update(evalRuns)
    .set({
      status: "succeeded",
      metricsJson: JSON.stringify(metrics),
      baselineLabel: input.baselineLabel ?? null,
      finishedAt: Date.now(),
    })
    .where(eq(evalRuns.id, runId));

  return (await getEvalRunDetail(db, workspaceId, runId))!;
}

async function replayCase(
  db: Db,
  deps: EvalHarnessDeps,
  workspaceId: string,
  ctx: {
    runId: string;
    suite: EvalSuite;
    evalCase: EvalCase;
    definition: NonNullable<Awaited<ReturnType<typeof resolvePipelineDefinition>>>;
    bannedClaims: string[];
    judge: boolean;
    createdBy: string;
  },
): Promise<ScoredCase> {
  const { evalCase } = ctx;
  const startedAt = Date.now();
  const base = {
    outcome: evalCase.outcome,
    checks: [] as EvalCheckResult[],
    judge: null as EvalRubric | null,
    verdict: null as EvalVerdict | null,
    editDistanceToFinal: null as number | null,
    costCents: 0,
    durationMs: 0,
  };

  const fail = async (reason: string, costCents = 0): Promise<ScoredCase> => {
    const scoredCase: ScoredCase = {
      ...base,
      costCents,
      durationMs: Date.now() - startedAt,
      failureReason: reason,
    };
    await writeCaseResult(db, ctx.runId, evalCase.id, null, null, scoredCase);
    return scoredCase;
  };

  // The original signal may have been deleted since the case was frozen; the
  // case survives (D-67.2) but it cannot be replayed.
  if (!evalCase.signalId) return await fail("signal_deleted");

  const started = await startPipelineRun(db, {
    workspaceId,
    definition: ctx.definition,
    signalId: evalCase.signalId,
    channel: evalCase.channel,
    campaignId: evalCase.campaignId,
    personaId: evalCase.personaId,
    mode: "dry_run",
    dryRunBatchId: ctx.runId,
    createdBy: ctx.createdBy,
  });
  const outcome = await executePipelineRun(db, deps, workspaceId, started.id);
  const costCents = outcome.run.costCents;
  if (outcome.blocked) return await fail(outcome.blocked, costCents);
  if (outcome.run.status !== "succeeded") {
    return await fail(outcome.run.failureReason ?? outcome.run.escalationReason ?? "run_not_succeeded", costCents);
  }
  const produced = outcome.run.result?.content ?? null;
  if (!produced) return await fail("no_content", costCents);

  const checks = runHardChecks({
    content: produced,
    channel: evalCase.channel,
    bannedClaims: ctx.bannedClaims,
    ctaExpectation: ctx.suite.ctaExpectation,
    citations: await runCitations(db, started.id),
    corpus: await runCorpus(db, started.id),
  });

  let judge: EvalRubric | null = null;
  if (ctx.judge) {
    const guidance = await resolveChannelGuidance(db, workspaceId, evalCase.channel, {
      personaId: evalCase.personaId,
      campaignId: evalCase.campaignId,
    });
    judge = await judgeDraft(deps.llm, {
      content: produced,
      channel: evalCase.channel,
      signalContent: evalCase.signalContent,
      guidance: guidance.content,
      founderFinalContent: evalCase.finalContent,
      founderOutcome: evalCase.outcome,
      founderReason: evalCase.rejectionReason,
    });
  }

  const verdict: EvalVerdict =
    hardChecksPassed(checks) && (judge === null || judge.overall >= EVAL_JUDGE_PASS)
      ? "pass"
      : "flag";
  const scoredCase: ScoredCase = {
    outcome: evalCase.outcome,
    checks,
    judge,
    verdict,
    editDistanceToFinal: normalizedEditDistance(produced, evalCase.finalContent),
    costCents,
    durationMs: Date.now() - startedAt,
    failureReason: null,
  };
  await writeCaseResult(db, ctx.runId, evalCase.id, started.id, produced, scoredCase);
  return scoredCase;
}

async function writeCaseResult(
  db: Db,
  runId: string,
  caseId: string,
  pipelineRunId: string | null,
  producedContent: string | null,
  scored: ScoredCase,
): Promise<void> {
  await db.insert(evalCaseResults)
    .values({
      id: randomUUID(),
      runId,
      caseId,
      pipelineRunId,
      producedContent,
      checksJson: JSON.stringify(scored.checks),
      judgeJson: scored.judge ? JSON.stringify(scored.judge) : null,
      verdict: scored.verdict,
      editDistanceToFinal: scored.editDistanceToFinal,
      costCents: scored.costCents,
      durationMs: scored.durationMs,
      failureReason: scored.failureReason,
      createdAt: Date.now(),
    });
}

export async function listEvalRuns(db: Db, workspaceId: string, limit = 20): Promise<EvalRun[]> {
  return (await db
    .select()
    .from(evalRuns)
    .where(eq(evalRuns.workspaceId, workspaceId))
    .orderBy(desc(evalRuns.createdAt))
    .limit(Math.min(limit, 100)))
    .map(rowToRun);
}

export async function getEvalRunDetail(
  db: Db,
  workspaceId: string,
  runId: string,
): Promise<EvalRunDetail | undefined> {
  const row = (await db
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.workspaceId, workspaceId), eq(evalRuns.id, runId))))[0];
  if (!row) return undefined;
  const results = (await db
    .select()
    .from(evalCaseResults)
    .where(eq(evalCaseResults.runId, runId)))
    .map(rowToCaseResult);
  return { ...rowToRun(row), results };
}

/**
 * D-67.3 — labelling makes this run the named baseline. A label points at
 * exactly one run per workspace, so re-labelling moves it off whichever run
 * held it before rather than failing on the unique index.
 */
export async function labelBaseline(
  db: Db,
  workspaceId: string,
  runId: string,
  label: string,
): Promise<EvalRun | undefined> {
  const existing = (await db
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.workspaceId, workspaceId), eq(evalRuns.id, runId))))[0];
  if (!existing) return undefined;
  await db.transaction(async (tx) => {
    await tx.update(evalRuns)
      .set({ baselineLabel: null })
      .where(and(eq(evalRuns.workspaceId, workspaceId), eq(evalRuns.baselineLabel, label)));
    await tx.update(evalRuns).set({ baselineLabel: label }).where(eq(evalRuns.id, runId));
  });
  const updated = (await db.select().from(evalRuns).where(eq(evalRuns.id, runId)))[0];
  return updated ? rowToRun(updated) : undefined;
}

export async function findBaselineRun(
  db: Db,
  workspaceId: string,
  label?: string,
): Promise<EvalRun | undefined> {
  const conditions = [eq(evalRuns.workspaceId, workspaceId), isNotNull(evalRuns.baselineLabel)];
  if (label) conditions.push(eq(evalRuns.baselineLabel, label));
  const row = (await db
    .select()
    .from(evalRuns)
    .where(and(...conditions))
    .orderBy(desc(evalRuns.createdAt)))[0];
  return row ? rowToRun(row) : undefined;
}

/** The regression report for one run against a named (or latest) baseline. */
export async function getEvalComparison(
  db: Db,
  workspaceId: string,
  runId: string,
  baselineLabel?: string,
): Promise<EvalComparison | undefined> {
  const detail = await getEvalRunDetail(db, workspaceId, runId);
  if (!detail) return undefined;
  const baseline = await findBaselineRun(db, workspaceId, baselineLabel);
  return compareEvalRuns(
    { id: detail.id, metrics: detail.metrics },
    baseline && baseline.id !== detail.id
      ? { id: baseline.id, metrics: baseline.metrics, baselineLabel: baseline.baselineLabel }
      : null,
  );
}
