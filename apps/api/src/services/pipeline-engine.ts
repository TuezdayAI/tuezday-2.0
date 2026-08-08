import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  canTransitionPipelineRun,
  findingsOutputSchema,
  stepOutputSchemaFor,
  type Channel,
  type DryRunPipelineInput,
  type DryRunPipelineResult,
  type PipelineChecklistEntry,
  type PipelineDefinition,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineRunMode,
  type PipelineRunStatus,
  type PipelineRunStep,
  type PipelineSpec,
  type PipelineStepSpec,
  type PipelineStepStatus,
  type PipelineTaskKey,
  type ProposalOutput,
  type AgentQuestion,
  type AgentStopReason,
} from "@tuezday/contracts";
import type { z } from "zod";
import {
  estimateTokens,
  renderExamples,
  renderPreferences,
  type ContextSection,
  type ResolvedContext,
  type ResolveExamples,
  type ResolvePreferences,
} from "@tuezday/brain";
import { toAgentTools } from "../agents/adapter";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../agents/registry";
import { AgentRunner } from "../agents/runner";
import { simulatedAgentProposals, type AgentProposalService } from "../agents/proposals";
import { simulatedAgentQuestions, type AgentQuestionService } from "../agents/questions";
import { ALL_TOOLS } from "../agents/tools/index";
import { type Db, rowsAffected } from "../db";
import {
  pipelineDefinitions,
  pipelineDefinitionVersions,
  pipelineRuns,
  pipelineRunSteps,
  type PipelineRunRow,
  type PipelineRunStepRow,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { jsonSchemaFor } from "../llm/json-schema";
import { meteredLlm } from "../llm/metered";
import type { SafeFetchService } from "../safe-fetch/index";
import { listAnsweredQuestionsForPipelineRun } from "./agent-questions";
import { submitDraft } from "./drafts";
import { llmBudgetExhausted } from "./entitlements";
import { storeGeneration } from "./generations";
import {
  PipelineSignalNotFoundError,
  rowToRun,
  startPipelineRun,
} from "./pipeline-runs";
import { recordRuleApplications, retrievePreferenceRules } from "./preference-rules";
import { retrievePriorExamples } from "./prior-examples";
import { getSignal, listSignals } from "./signals";
import { getWorkspace } from "./workspaces";
// Queue-only creation lives in pipeline-runs.ts (leaf, no agent imports) so
// enqueuing services never load the engine. Re-exported for existing callers.
export {
  DuplicatePipelineRunError,
  PipelineSignalNotFoundError,
  startPipelineRun,
  type StartPipelineRunInput,
} from "./pipeline-runs";

// Engine bounds (D-64.6). Constants until Sprint 65 gives the engine a
// worker loop and operator-policy knobs.
export const STEP_TIMEOUT_MS = 60_000;
export const RUN_MAX_DURATION_MS = 300_000;
export const STEP_MAX_ATTEMPTS = 2;

export interface PipelineEngineDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  /**
   * Sprint 69: the gated write seam for the propose tools. Absent means they
   * are not offered at all (D-69.7) — there is no ungoverned fallback. A
   * non-live run gets the simulating implementation instead of this one, so a
   * dry run, a shadow run or an eval replay sees the same tools and mints
   * nothing (D-69.6).
   */
  proposals?: AgentProposalService;
  /**
   * Sprint 70: the ask seam. Same rule — absent means `ask_founder` is not
   * offered, and a non-live run gets the simulating one so a dry run never
   * suspends waiting for an answer nobody is going to give (D-70.5).
   */
  questions?: AgentQuestionService;
}

export class PipelineRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Pipeline run "${id}" not found.`);
    this.name = "PipelineRunNotFoundError";
  }
}

export class InvalidPipelineRunTransitionError extends Error {
  constructor(from: PipelineRunStatus, to: PipelineRunStatus) {
    super(`Cannot move a pipeline run from "${from}" to "${to}".`);
    this.name = "InvalidPipelineRunTransitionError";
  }
}

function rowToStep(row: PipelineRunStepRow): PipelineRunStep {
  return {
    id: row.id,
    runId: row.runId,
    stepKey: row.stepKey,
    iteration: row.iteration,
    attempt: row.attempt,
    status: row.status as PipelineStepStatus,
    agentRunId: row.agentRunId,
    output: row.outputJson ? (JSON.parse(row.outputJson) as unknown) : null,
    passes: row.passes === 1,
    failureReason: row.failureReason,
    stopReason: (row.stopReason as AgentStopReason | null) ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

interface StepPassResult {
  output: unknown;
  agentRunId: string | null;
  fromCache: boolean;
  /** Set when the pass could not produce a valid output. */
  failure?: { reason: string; escalate?: string };
}

interface EngineState {
  runId: string;
  workspaceId: string;
  checklist: PipelineChecklistEntry[];
  /** Latest output per step key. */
  outputs: Map<string, unknown>;
  /** Succeeded passes cached from prior sessions: `${stepKey}#${iteration}`. */
  cache: Map<string, { output: unknown; agentRunId: string | null }>;
  usedTokens: number;
  latestDraft: string | null;
}

async function loadEngineState(db: Db, run: PipelineRunRow): Promise<EngineState> {
  const rows = await db
    .select()
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, run.id))
    .orderBy(asc(pipelineRunSteps.seq));
  const state: EngineState = {
    runId: run.id,
    workspaceId: run.workspaceId,
    checklist: JSON.parse(run.checklistJson) as PipelineChecklistEntry[],
    outputs: new Map(),
    cache: new Map(),
    usedTokens: 0,
    latestDraft: null,
  };
  for (const row of rows) {
    state.usedTokens += row.inputTokens + row.outputTokens;
    if (row.status !== "succeeded") continue;
    const output = row.outputJson ? (JSON.parse(row.outputJson) as unknown) : null;
    state.cache.set(`${row.stepKey}#${row.iteration}`, {
      output,
      agentRunId: row.agentRunId,
    });
    state.outputs.set(row.stepKey, output);
    const content = (output as { content?: unknown } | null)?.content;
    if (typeof content === "string") state.latestDraft = content;
  }
  return state;
}

async function insertStepRow(
  db: Db,
  run: PipelineRunRow,
  step: { stepKey: string; iteration: number; attempt: number },
  values: Partial<PipelineRunStepRow> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(pipelineRunSteps)
    .values({
      id,
      runId: run.id,
      stepKey: step.stepKey,
      iteration: step.iteration,
      attempt: step.attempt,
      status: "running",
      agentRunId: null,
      outputJson: null,
      passes: 0,
      failureReason: null,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      startedAt: Date.now(),
      finishedAt: null,
      createdAt: Date.now(),
      ...values,
    });
  return id;
}

async function finishStepRow(db: Db, id: string, values: Partial<PipelineRunStepRow>): Promise<void> {
  await db.update(pipelineRunSteps)
    .set({ finishedAt: Date.now(), ...values })
    .where(eq(pipelineRunSteps.id, id));
}

function composeStepSystem(
  definitionName: string,
  workspaceName: string,
  step: PipelineStepSpec,
): string {
  return [
    `You are executing the "${step.title}" step of the "${definitionName}" content pipeline for the workspace "${workspaceName}".`,
    step.goal,
    "When you are done, answer with JSON matching the required response schema — nothing else.",
  ].join("\n\n");
}

function composeStepUserMessage(
  run: PipelineRunRow,
  signal: { content: string; source: string; sourceUrl: string | null },
  spec: PipelineSpec,
  outputs: Map<string, unknown>,
  step: PipelineStepSpec,
  priorExamples: ResolveExamples | null,
  preferences: ResolvePreferences | null,
  answers: AgentQuestion[],
): string {
  const lines: string[] = [
    "## Triggering signal",
    `Source: ${signal.source}${signal.sourceUrl ? ` (${signal.sourceUrl})` : ""}`,
    signal.content,
    "",
    `## Target channel`,
    run.channel,
  ];
  // Sprint 70 (D-70.3): what this run already asked and was told. First in the
  // message, before anything the model might re-derive from — an answer the
  // founder gave outranks every other input in the bundle, and putting it here
  // is what stops the resumed step from asking the same thing again.
  if (answers.length > 0) {
    lines.push("", "## Answers you already have");
    for (const answered of answers) {
      lines.push(`- You asked: “${answered.question}” — the founder answered: “${answered.answer}”`);
    }
    lines.push("", "Treat those answers as settled. Do not ask them again.");
  }
  // Sprint 68 (Move 5): rules before examples — the instruction, then the
  // illustrations. Same guarantee as few-shot below: every draft step sees them.
  if (step.output === "draft" && preferences) {
    lines.push("", "## Learned preferences from your edits", renderPreferences(preferences));
  }
  // Sprint 66 (D-66.5): few-shot is a guarantee for drafting steps, not a
  // tool the model may skip — injected into every draft-output step's context.
  if (step.output === "draft" && priorExamples) {
    lines.push("", "## Prior examples from approval history", renderExamples(priorExamples));
  }
  const prior = spec.steps.filter((candidate) => outputs.has(candidate.key));
  if (prior.length > 0) {
    lines.push("", "## Prior step outputs");
    for (const priorStep of prior) {
      lines.push(
        "",
        `### ${priorStep.key} (${priorStep.output})`,
        JSON.stringify(outputs.get(priorStep.key), null, 2),
      );
    }
  }
  return lines.join("\n");
}

async function runAgentStepPass(
  db: Db,
  deps: PipelineEngineDeps,
  metered: LlmGateway,
  run: PipelineRunRow,
  definitionName: string,
  workspaceName: string,
  signal: { content: string; source: string; sourceUrl: string | null },
  spec: PipelineSpec,
  step: PipelineStepSpec,
  iteration: number,
  state: EngineState,
  priorExamples: ResolveExamples | null,
  preferences: ResolvePreferences | null,
  answers: AgentQuestion[],
): Promise<StepPassResult> {
  const cached = state.cache.get(`${step.key}#${iteration}`);
  if (cached) return { ...cached, fromCache: true };

  const outputSchema = stepOutputSchemaFor(step.output);
  // Sprint 69: a live run gets the real propose seam, every other mode the
  // simulating one, and a deps object without either gets no propose tools at
  // all rather than an ungoverned write path.
  const proposals: AgentProposalService | null =
    run.mode === "live" ? (deps.proposals ?? null) : simulatedAgentProposals();
  const questions: AgentQuestionService | null =
    run.mode === "live" ? (deps.questions ?? null) : simulatedAgentQuestions();
  const tools = ALL_TOOLS.filter(
    (tool) =>
      step.tools.includes(tool.name) &&
      (tool.access !== "propose" || proposals !== null) &&
      (tool.access !== "ask" || questions !== null),
  );
  const runner = new AgentRunner(db, metered);

  // Attempts continue where the last execution left off. A pass that failed
  // (or, since Sprint 70, stopped to ask) leaves its attempt rows behind, and
  // the run's step history is keyed by (step, iteration, attempt) — so resuming
  // at attempt 1 would collide with the row that recorded why it stopped. The
  // per-execution bound below is unchanged; only the numbering carries over.
  const priorAttempts =
    ((await db
      .select({ used: sql<number>`coalesce(max(${pipelineRunSteps.attempt}), 0)` })
      .from(pipelineRunSteps)
      .where(
        and(
          eq(pipelineRunSteps.runId, run.id),
          eq(pipelineRunSteps.stepKey, step.key),
          eq(pipelineRunSteps.iteration, iteration),
        ),
      ))[0])?.used ?? 0;

  let lastFailure = "unknown";
  for (let pass = 1; pass <= STEP_MAX_ATTEMPTS; pass += 1) {
    const attempt = priorAttempts + pass;
    const rowId = await insertStepRow(db, run, {
      stepKey: step.key,
      iteration,
      attempt,
    });
    // Minted here, not by the runner: a propose tool has to be able to name
    // the run it is acting for while that run is still going.
    const agentRunId = randomUUID();
    const ctx: ToolContext = {
      db,
      evidence: deps.evidence,
      safeFetch: deps.safeFetch,
      workspaceId: run.workspaceId,
      actor: { userId: null, label: run.createdBy },
      budget: DEFAULT_TOOL_BUDGET,
      ...(proposals ? { proposals } : {}),
      ...(questions ? { questions } : {}),
      agentRunId,
      pipelineRunId: run.id,
      stepKey: step.key,
    };
    const result = await runner.run({
      workspaceId: run.workspaceId,
      runId: agentRunId,
      task: `pipeline:${step.key}`,
      createdBy: run.createdBy,
      system: composeStepSystem(definitionName, workspaceName, step),
      messages: [
        {
          role: "user",
          content: composeStepUserMessage(
            run,
            signal,
            spec,
            state.outputs,
            step,
            priorExamples,
            preferences,
            answers,
          ),
        },
      ],
      tools: toAgentTools(tools, ctx),
      responseSchema: jsonSchemaFor(outputSchema as z.ZodTypeAny),
      maxSteps: step.maxSteps,
      maxTokens: step.maxTokens,
      timeoutMs: STEP_TIMEOUT_MS,
      tier: step.tier,
    });
    state.usedTokens += result.usage.inputTokens + result.usage.outputTokens;
    const usageValues = {
      agentRunId: result.runId,
      stopReason: result.stopReason,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costCents: result.usage.costCents,
    };

    if (result.stopReason === "needs_human") {
      await finishStepRow(db, rowId, {
        ...usageValues,
        status: "failed",
        failureReason: "needs_human",
      });
      return {
        output: null,
        agentRunId: result.runId,
        fromCache: false,
        failure: {
          reason: "needs_human",
          escalate: `needs_human:${step.key}${result.error ? ` (${result.error})` : ""}`,
        },
      };
    }

    if (result.stopReason === "complete") {
      const parsed = outputSchema.safeParse(result.output);
      if (parsed.success) {
        await finishStepRow(db, rowId, {
          ...usageValues,
          status: "succeeded",
          passes: 1,
          outputJson: JSON.stringify(parsed.data),
        });
        return { output: parsed.data, agentRunId: result.runId, fromCache: false };
      }
      lastFailure = "invalid_output";
      await finishStepRow(db, rowId, {
        ...usageValues,
        status: "failed",
        failureReason: "invalid_output",
      });
      continue;
    }

    lastFailure = result.stopReason;
    await finishStepRow(db, rowId, {
      ...usageValues,
      status: "failed",
      failureReason: result.stopReason,
    });
  }
  return {
    output: null,
    agentRunId: null,
    fromCache: false,
    failure: { reason: `step_failed:${step.key} (${lastFailure})` },
  };
}

function checklistEvidence(step: PipelineStepSpec, output: unknown): string {
  switch (step.output) {
    case "brief": {
      const brief = output as { keyFacts?: unknown[] };
      return `Brief with ${brief.keyFacts?.length ?? 0} key facts`;
    }
    case "angles": {
      const angles = output as { angles?: unknown[] };
      return `${angles.angles?.length ?? 0} candidate angles`;
    }
    case "draft": {
      const draft = output as { content?: string };
      return `Draft of ${draft.content?.length ?? 0} characters`;
    }
    case "findings": {
      const findings = output as { score?: number; findings?: unknown[] };
      return `Score ${findings.score ?? "?"} with ${findings.findings?.length ?? 0} findings`;
    }
    case "proposal":
      return "Proposal handed to the approval gate";
  }
}

function escalationFor(
  spec: PipelineSpec,
  step: PipelineStepSpec,
  output: unknown,
): string | null {
  if (!spec.escalation) return null;
  const record = output as { confidence?: unknown; guardrailUncertain?: unknown };
  if (
    typeof spec.escalation.minConfidence === "number" &&
    typeof record.confidence === "number" &&
    record.confidence < spec.escalation.minConfidence
  ) {
    return `low_confidence:${step.key} (${record.confidence} < ${spec.escalation.minConfidence})`;
  }
  if (spec.escalation.onGuardrailUncertain && record.guardrailUncertain === true) {
    return `guardrail_uncertain:${step.key}`;
  }
  return null;
}

function latestScore(state: EngineState, scoreFrom: string): number | null {
  const output = state.outputs.get(scoreFrom);
  const parsed = findingsOutputSchema.safeParse(output);
  return parsed.success ? parsed.data.score : null;
}

async function runTotals(db: Db, runId: string): Promise<{
      inputTokens: number;
      outputTokens: number;
      costCents: number;
    }> {
  const totals = (await db
    .select({
      inputTokens: sql<number>`coalesce(sum(${pipelineRunSteps.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${pipelineRunSteps.outputTokens}), 0)`,
      costCents: sql<number>`coalesce(sum(${pipelineRunSteps.costCents}), 0)`,
    })
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, runId)))[0];
  return totals ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };
}

async function finishRun(
  db: Db,
  run: PipelineRunRow,
  status: PipelineRunStatus,
  state: EngineState,
  values: Partial<PipelineRunRow> = {},
): Promise<PipelineRun> {
  if (!canTransitionPipelineRun("running", status)) {
    throw new InvalidPipelineRunTransitionError("running", status);
  }
  const totals = await runTotals(db, run.id);
  const patch: Partial<PipelineRunRow> = {
    status,
    checklistJson: JSON.stringify(state.checklist),
    ...totals,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...(status === "escalated" ? {} : { finishedAt: Date.now() }),
    ...values,
  };
  await db.update(pipelineRuns).set(patch).where(eq(pipelineRuns.id, run.id));
  const updated = (await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, run.id)))[0];
  return rowToRun(updated!);
}

/** The propose step (D-64.4/5): deterministic gate handoff, no LLM. */
async function executePropose(
  db: Db,
  run: PipelineRunRow,
  spec: PipelineSpec,
  step: PipelineStepSpec,
  state: EngineState,
  priorExamples: ResolveExamples | null,
  preferences: ResolvePreferences | null,
): Promise<{ proposal: ProposalOutput; generationId: string | null; draftId: string | null } | null> {
  const finalDraft = state.latestDraft;
  if (!finalDraft) return null;
  const taskType = "signal_response" as const;
  // Sprint 65 (D-65.2): every non-live mode ends simulated — dry runs and
  // shadow runs never touch the gate.
  if (run.mode !== "live") {
    return {
      proposal: {
        content: finalDraft,
        channel: run.channel as Channel,
        taskType,
        generationId: null,
        draftId: null,
        simulated: true,
      },
      generationId: null,
      draftId: null,
    };
  }

  // Honest provenance (D-64.5): the generation's trace is the pipeline's
  // actual inputs — one section per completed step pass, in checklist order.
  const sections: ContextSection[] = state.checklist
    .filter((entry) => entry.stepKey !== step.key)
    .map((entry) => {
      const output = state.outputs.get(entry.stepKey);
      const content = JSON.stringify(output ?? null, null, 2);
      return {
        key: `pipeline:${entry.stepKey}`,
        layer: "task" as const,
        title: `Pipeline step: ${entry.stepKey} (iteration ${entry.iteration})`,
        content,
        included: true,
        reason: `Output of pipeline step "${entry.stepKey}"`,
        tokens: estimateTokens(content),
      };
    });
  // Sprint 68: same rule for the learned-preference block. Unshifted after the
  // examples block so the stored provenance reads in bundle order: rules first.
  if (preferences) {
    const preferencesContent = renderPreferences(preferences);
    sections.unshift({
      key: "preferences",
      layer: "preferences",
      title: "Learned preferences from your edits",
      content: preferencesContent,
      included: true,
      reason: `Applied ${preferences.rules.length} rule(s) learned from this workspace's own edits; injected into every draft step. Each is reversible on the Preferences page.`,
      tokens: estimateTokens(preferencesContent),
    });
  }
  // Sprint 66: the few-shot block injected into draft steps is a real input —
  // provenance says so, in the same layer the resolver traces it under.
  if (priorExamples) {
    const examplesContent = renderExamples(priorExamples);
    sections.unshift({
      key: "examples",
      layer: "examples",
      title: "Prior examples from your approval history",
      content: examplesContent,
      included: true,
      reason: `Retrieved ${priorExamples.approved.length} approved and ${priorExamples.rejected.length} rejected/corrected prior output(s) for query: "${priorExamples.query}"; injected into every draft step.`,
      tokens: estimateTokens(examplesContent),
    });
  }
  const draftStep = spec.steps.find(
    (candidate) => candidate.kind === "agent" && candidate.output === "draft",
  );
  const resolved: ResolvedContext = {
    sections,
    includedTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
    tokenBudget: spec.budget.maxTokens,
    overBudget: false,
    prompt: draftStep ? draftStep.goal : step.goal,
    resolveMode: "draft",
  };
  // Sequential like the legacy signal-draft path: generation first, then the
  // gate submission (submitDraft owns its own transaction).
  const generation = await storeGeneration(db, {
    workspaceId: run.workspaceId,
    taskType,
    channel: run.channel as Channel,
    personaId: run.personaId,
    campaignId: run.campaignId,
    resolved,
    output: finalDraft,
    model: "pipeline",
    provider: "pipeline",
    durationMs: 0,
  });
  // Sprint 68 (D-68.6): only a live run that actually produced a generation
  // counts as a rule application. Dry and shadow runs returned above, so an
  // eval replay of eighty historical cases cannot inflate the hit count that
  // promotion and retirement read.
  await recordRuleApplications(db, (preferences?.rules ?? []).map((rule) => rule.id));
  const draft = await submitDraft(
    db,
    {
      workspaceId: run.workspaceId,
      sourceGenerationId: generation.id,
      sourceSignalId: run.signalId,
      campaignId: run.campaignId,
      taskType,
      channel: run.channel as Channel,
      personaId: run.personaId,
      content: finalDraft,
    },
    { userId: null, label: run.createdBy, human: false },
  );
  return {
    proposal: {
      content: finalDraft,
      channel: run.channel as Channel,
      taskType,
      generationId: generation.id,
      draftId: draft.id,
      simulated: false,
    },
    generationId: generation.id,
    draftId: draft.id,
  };
}

export type ExecutePipelineRunResult =
  | { blocked: "llm_budget_exhausted" | "not_claimable"; run: PipelineRun }
  | { blocked?: undefined; run: PipelineRun };

/**
 * Execute (or resume) one run to its next resting state: succeeded, failed,
 * escalated, or cancelled. Deterministic between steps: the walk order,
 * revise-loop control, escalation checks, retries, and budget enforcement
 * all live here — never inside a prompt. Succeeded step passes are cached
 * and replayed on resume, which is also what makes crash recovery a re-call.
 */
export async function executePipelineRun(
  db: Db,
  deps: PipelineEngineDeps,
  workspaceId: string,
  runId: string,
): Promise<ExecutePipelineRunResult> {
  const existing = (await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId))))[0];
  if (!existing) throw new PipelineRunNotFoundError(runId);

  if (await llmBudgetExhausted(db, workspaceId)) {
    return { blocked: "llm_budget_exhausted", run: rowToRun(existing) };
  }

  // Claim fence (D-64.6): queued/escalated runs, or a running run whose
  // lease expired (crash recovery). A live concurrent execution wins.
  const now = Date.now();
  const leaseOwner = randomUUID();
  const claimed = await db
    .update(pipelineRuns)
    .set({
      status: "running",
      leaseOwner,
      leaseExpiresAt: now + RUN_MAX_DURATION_MS,
      startedAt: existing.startedAt ?? now,
      pausedAtStepKey: null,
      escalationReason: null,
    })
    .where(
      and(
        eq(pipelineRuns.id, runId),
        sql`(${pipelineRuns.status} IN ('queued', 'escalated') OR (${pipelineRuns.status} = 'running' AND ${pipelineRuns.leaseExpiresAt} < ${now}))`,
      ),
    );
  if (rowsAffected(claimed) === 0) {
    return { blocked: "not_claimable", run: rowToRun(existing) };
  }
  const run = ((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0])!;

  const versionRow = (await db
    .select()
    .from(pipelineDefinitionVersions)
    .where(
      and(
        eq(pipelineDefinitionVersions.definitionId, run.definitionId),
        eq(pipelineDefinitionVersions.version, run.definitionVersion),
      ),
    ))[0];
  if (!versionRow) {
    const state = await loadEngineState(db, run);
    return { run: await finishRun(db, run, "failed", state, { failureReason: "definition_version_missing" }) };
  }
  const spec = JSON.parse(versionRow.specJson) as PipelineSpec;

  const signal = run.signalId ? await getSignal(db, workspaceId, run.signalId) : undefined;
  const state = await loadEngineState(db, run);
  if (!signal) {
    return { run: await finishRun(db, run, "failed", state, { failureReason: "signal_missing" }) };
  }
  const workspace = await getWorkspace(db, workspaceId);
  const workspaceName = workspace?.name ?? "workspace";
  // Sprint 66: retrieved once per run — every draft-output step sees the same
  // few-shot bundle, and the propose step traces exactly what was injected.
  const priorExamples = await retrievePriorExamples(db, workspaceId, {
    query: signal.content,
    channel: run.channel as Channel,
    taskType: "signal_response",
  });
  // Sprint 68: the same treatment for learned preference rules — retrieved
  // once per run, injected into every draft step, traced on the propose step.
  const preferences = await retrievePreferenceRules(db, workspaceId, {
    channel: run.channel as Channel,
    taskType: "signal_response",
  });
  const definitionRow = (await db
    .select({ name: pipelineDefinitions.name })
    .from(pipelineDefinitions)
    .where(eq(pipelineDefinitions.id, run.definitionId)))[0];
  const definitionName = definitionRow?.name ?? run.taskKey;
  const metered = meteredLlm(deps.llm, db, {
    workspaceId,
    pipeline: "pipeline_run",
    campaignId: run.campaignId,
  });
  // Sprint 70: everything this run has already asked and been told. Read once
  // per execution — a question asked mid-execution suspends the run, so no
  // later step in *this* pass can ever see a newer answer than these.
  const answeredQuestions = await listAnsweredQuestionsForPipelineRun(db, run.id);
  const deadline = now + RUN_MAX_DURATION_MS;
  // Escalation checks fire only on freshly executed passes: cached passes
  // were either checked before pausing or are the acknowledged pause point.

  const iterations = new Map<string, number>();
  for (const key of state.cache.keys()) {
    const [stepKey, iteration] = key.split("#") as [string, string];
    iterations.set(stepKey, Math.max(iterations.get(stepKey) ?? 0, Number(iteration)));
  }

  const runPass = async (
    step: PipelineStepSpec,
    iteration: number,
  ): Promise<StepPassResult | { halted: PipelineRun }> => {
    if (Date.now() >= deadline) {
      return { halted: await finishRun(db, run, "failed", state, { failureReason: "run_timeout" }) };
    }
    const pass = await runAgentStepPass(
      db,
      deps,
      metered,
      run,
      definitionName,
      workspaceName,
      signal,
      spec,
      step,
      iteration,
      state,
      priorExamples,
      preferences,
      answeredQuestions,
    );
    if (pass.failure) {
      if (pass.failure.escalate) {
        return {
          halted: await finishRun(db, run, "escalated", state, {
            pausedAtStepKey: step.key,
            escalationReason: pass.failure.escalate,
          }),
        };
      }
      return {
        halted: await finishRun(db, run, "failed", state, { failureReason: pass.failure.reason }),
      };
    }
    iterations.set(step.key, iteration);
    state.outputs.set(step.key, pass.output);
    const content = (pass.output as { content?: unknown } | null)?.content;
    if (typeof content === "string") state.latestDraft = content;
    if (!pass.fromCache) {
      state.checklist.push({
        stepKey: step.key,
        iteration,
        output: step.output,
        passes: true,
        evidence: checklistEvidence(step, pass.output),
        agentRunId: pass.agentRunId,
      });
      if (state.usedTokens > spec.budget.maxTokens) {
        return {
          halted: await finishRun(db, run, "failed", state, { failureReason: "budget_exhausted" }),
        };
      }
      const escalate = escalationFor(spec, step, pass.output);
      if (escalate) {
        return {
          halted: await finishRun(db, run, "escalated", state, {
            pausedAtStepKey: step.key,
            escalationReason: escalate,
          }),
        };
      }
    }
    return pass;
  };

  for (let index = 0; index < spec.steps.length; ) {
    const step = spec.steps[index]!;

    if (step.kind === "propose") {
      const handoff = await executePropose(db, run, spec, step, state, priorExamples, preferences);
      if (!handoff) {
        return { run: await finishRun(db, run, "failed", state, { failureReason: "no_draft_produced" }) };
      }
      const rowId = await insertStepRow(db, run, { stepKey: step.key, iteration: 1, attempt: 1 });
      await finishStepRow(db, rowId, {
        status: "succeeded",
        passes: 1,
        outputJson: JSON.stringify(handoff.proposal),
      });
      state.checklist.push({
        stepKey: step.key,
        iteration: 1,
        output: "proposal",
        passes: true,
        evidence: checklistEvidence(step, handoff.proposal),
        agentRunId: null,
      });
      return {
        run: await finishRun(db, run, "succeeded", state, {
          resultJson: JSON.stringify(handoff.proposal),
          generationId: handoff.generationId,
          draftId: handoff.draftId,
        }),
      };
    }

    if (step.loop) {
      const score = latestScore(state, step.loop.scoreFrom);
      const revisions = iterations.get(step.key) ?? 0;
      if (score !== null && score >= step.loop.threshold) {
        if (revisions === 0) {
          // Never needed: record the skip once so the checklist is complete.
          const alreadySkipped = state.checklist.some((entry) => entry.stepKey === step.key);
          if (!alreadySkipped) {
            const rowId = await insertStepRow(db, run, { stepKey: step.key, iteration: 1, attempt: 1 });
            await finishStepRow(db, rowId, { status: "skipped", passes: 1 });
            state.checklist.push({
              stepKey: step.key,
              iteration: 1,
              output: step.output,
              passes: true,
              evidence: `Skipped — ${step.loop.scoreFrom} score ${score} ≥ ${step.loop.threshold}`,
              agentRunId: null,
            });
          }
        }
        index += 1;
        continue;
      }
      if (revisions >= step.loop.maxIterations) {
        // Loop exhausted: proceed with the best we have (PRD: max iterations).
        index += 1;
        continue;
      }
      const revisePass = await runPass(step, revisions + 1);
      if ("halted" in revisePass) return { run: revisePass.halted };
      const scoreStep = spec.steps.find((candidate) => candidate.key === step.loop!.scoreFrom)!;
      const rescore = await runPass(scoreStep, (iterations.get(scoreStep.key) ?? 0) + 1);
      if ("halted" in rescore) return { run: rescore.halted };
      continue; // re-evaluate the loop condition with the fresh score
    }

    const pass = await runPass(step, Math.max(iterations.get(step.key) ?? 0, 1));
    if ("halted" in pass) return { run: pass.halted };
    index += 1;
  }

  // A validated spec always ends in propose; reaching here is a spec bug.
  return { run: await finishRun(db, run, "failed", state, { failureReason: "no_propose_step" }) };
}

export async function listPipelineRuns(
  db: Db,
  workspaceId: string,
  options: {
    definitionId?: string;
    mode?: PipelineRunMode;
    status?: PipelineRunStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ runs: PipelineRun[]; total: number }> {
  const conditions = [eq(pipelineRuns.workspaceId, workspaceId)];
  if (options.definitionId) conditions.push(eq(pipelineRuns.definitionId, options.definitionId));
  if (options.mode) conditions.push(eq(pipelineRuns.mode, options.mode));
  if (options.status) conditions.push(eq(pipelineRuns.status, options.status));
  const where = and(...conditions);
  const total =
    ((await db
      .select({ count: sql<number>`count(*)` })
      .from(pipelineRuns)
      .where(where))[0])?.count ?? 0;
  const runs = (await db
    .select()
    .from(pipelineRuns)
    .where(where)
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(Math.min(options.limit ?? 20, 100))
    .offset(options.offset ?? 0))
    .map(rowToRun);
  return { runs, total };
}

export async function getPipelineRunDetail(
  db: Db,
  workspaceId: string,
  runId: string,
): Promise<PipelineRunDetail | undefined> {
  const row = (await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId))))[0];
  if (!row) return undefined;
  const steps = (await db
    .select()
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, runId))
    .orderBy(asc(pipelineRunSteps.seq)))
    .map(rowToStep);
  return { ...rowToRun(row), steps };
}

/** Operator decision on a paused/queued run (D-64.8). */
export async function decidePipelineRun(
  db: Db,
  deps: PipelineEngineDeps,
  workspaceId: string,
  runId: string,
  input: { action: "resume" | "cancel"; reason?: string },
): Promise<ExecutePipelineRunResult> {
  const row = (await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId))))[0];
  if (!row) throw new PipelineRunNotFoundError(runId);
  const status = row.status as PipelineRunStatus;

  if (input.action === "cancel") {
    if (!canTransitionPipelineRun(status, "cancelled")) {
      throw new InvalidPipelineRunTransitionError(status, "cancelled");
    }
    await db.update(pipelineRuns)
      .set({
        status: "cancelled",
        failureReason: `cancelled: ${input.reason ?? ""}`.trim(),
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: Date.now(),
      })
      .where(eq(pipelineRuns.id, runId));
    const updated = ((await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)))[0])!;
    return { run: rowToRun(updated) };
  }

  if (status !== "escalated") {
    throw new InvalidPipelineRunTransitionError(status, "running");
  }
  return await executePipelineRun(db, deps, workspaceId, runId);
}

/**
 * Replay a definition against historical signals (D-64.11 acceptance): what
 * would this version have produced? Dry runs are real engine executions —
 * metered, traced, checklisted — that never write generations or drafts.
 */
export async function runPipelineDryRun(
  db: Db,
  deps: PipelineEngineDeps,
  input: {
    workspaceId: string;
    definition: PipelineDefinition;
    options: DryRunPipelineInput;
    createdBy: string;
  },
): Promise<DryRunPipelineResult> {
  const batchId = randomUUID();
  let signalIds: string[];
  if (input.options.signalIds) {
    signalIds = input.options.signalIds;
    for (const signalId of signalIds) {
      if (!await getSignal(db, input.workspaceId, signalId)) {
        throw new PipelineSignalNotFoundError(signalId);
      }
    }
  } else {
    signalIds = (await listSignals(db, input.workspaceId))
      .slice(0, input.options.limit)
      .map((signal) => signal.id);
  }

  const runs: DryRunPipelineResult["runs"] = [];
  for (const signalId of signalIds) {
    const signal = (await getSignal(db, input.workspaceId, signalId))!;
    const started = await startPipelineRun(db, {
      workspaceId: input.workspaceId,
      definition: input.definition,
      signalId,
      channel: input.options.channel,
      campaignId: signal.suggestedCampaignId ?? null,
      personaId: signal.suggestedPersonaId ?? null,
      mode: "dry_run",
      dryRunBatchId: batchId,
      createdBy: input.createdBy,
    });
    const outcome = await executePipelineRun(db, deps, input.workspaceId, started.id);
    runs.push({
      runId: outcome.run.id,
      signalId,
      status: outcome.run.status,
      proposal: outcome.run.result,
      checklist: outcome.run.checklist,
      costCents: outcome.run.costCents,
      failureReason: outcome.run.failureReason,
      escalationReason: outcome.run.escalationReason,
    });
  }
  return { batchId, runs };
}
