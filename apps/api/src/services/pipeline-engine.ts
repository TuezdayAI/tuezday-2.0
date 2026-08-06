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
  type AgentStopReason,
} from "@tuezday/contracts";
import type { z } from "zod";
import { estimateTokens, type ContextSection, type ResolvedContext } from "@tuezday/brain";
import { toAgentTools } from "../agents/adapter";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../agents/registry";
import { AgentRunner } from "../agents/runner";
import { READ_TOOLS } from "../agents/tools/index";
import type { Db } from "../db";
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
import { submitDraft } from "./drafts";
import { llmBudgetExhausted } from "./entitlements";
import { storeGeneration } from "./generations";
import { getSignal, listSignals } from "./signals";
import { getWorkspace } from "./workspaces";

// Engine bounds (D-64.6). Constants until Sprint 65 gives the engine a
// worker loop and operator-policy knobs.
export const STEP_TIMEOUT_MS = 60_000;
export const RUN_MAX_DURATION_MS = 300_000;
export const STEP_MAX_ATTEMPTS = 2;

export interface PipelineEngineDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export class PipelineRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Pipeline run "${id}" not found.`);
    this.name = "PipelineRunNotFoundError";
  }
}

export class DuplicatePipelineRunError extends Error {
  constructor(key: string) {
    super(`A run with idempotency key "${key}" already exists.`);
    this.name = "DuplicatePipelineRunError";
  }
}

export class InvalidPipelineRunTransitionError extends Error {
  constructor(from: PipelineRunStatus, to: PipelineRunStatus) {
    super(`Cannot move a pipeline run from "${from}" to "${to}".`);
    this.name = "InvalidPipelineRunTransitionError";
  }
}

export class PipelineSignalNotFoundError extends Error {
  constructor(id: string) {
    super(`Signal "${id}" not found.`);
    this.name = "PipelineSignalNotFoundError";
  }
}

function rowToRun(row: PipelineRunRow): PipelineRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    taskKey: row.taskKey as PipelineTaskKey,
    mode: row.mode as PipelineRunMode,
    dryRunBatchId: row.dryRunBatchId,
    signalId: row.signalId,
    campaignId: row.campaignId,
    laneId: row.laneId,
    personaId: row.personaId,
    channel: row.channel as Channel,
    status: row.status as PipelineRunStatus,
    pausedAtStepKey: row.pausedAtStepKey,
    escalationReason: row.escalationReason,
    failureReason: row.failureReason,
    checklist: JSON.parse(row.checklistJson) as PipelineChecklistEntry[],
    result: row.resultJson ? (JSON.parse(row.resultJson) as ProposalOutput) : null,
    generationId: row.generationId,
    draftId: row.draftId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
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

export interface StartPipelineRunInput {
  workspaceId: string;
  definition: PipelineDefinition;
  signalId: string;
  channel: Channel;
  campaignId?: string | null;
  laneId?: string | null;
  personaId?: string | null;
  mode: PipelineRunMode;
  dryRunBatchId?: string | null;
  idempotencyKey?: string | null;
  createdBy: string;
}

/** Insert a queued run frozen against the definition's current version. */
export function startPipelineRun(db: Db, input: StartPipelineRunInput): PipelineRun {
  const signal = getSignal(db, input.workspaceId, input.signalId);
  if (!signal) throw new PipelineSignalNotFoundError(input.signalId);
  const now = Date.now();
  const row: PipelineRunRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    definitionId: input.definition.id,
    definitionVersion: input.definition.currentVersion,
    taskKey: input.definition.taskKey,
    mode: input.mode,
    dryRunBatchId: input.dryRunBatchId ?? null,
    signalId: input.signalId,
    campaignId: input.campaignId ?? null,
    laneId: input.laneId ?? null,
    personaId: input.personaId ?? null,
    channel: input.channel,
    status: "queued",
    pausedAtStepKey: null,
    escalationReason: null,
    failureReason: null,
    checklistJson: "[]",
    resultJson: null,
    generationId: null,
    draftId: null,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    idempotencyKey: input.idempotencyKey ?? null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdBy: input.createdBy,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  try {
    db.insert(pipelineRuns).values(row).run();
  } catch (err) {
    if (
      input.idempotencyKey &&
      err instanceof Error &&
      err.message.includes("UNIQUE")
    ) {
      throw new DuplicatePipelineRunError(input.idempotencyKey);
    }
    throw err;
  }
  return rowToRun(row);
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

function loadEngineState(db: Db, run: PipelineRunRow): EngineState {
  const rows = db
    .select()
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, run.id))
    .orderBy(sql`rowid`)
    .all();
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

function insertStepRow(
  db: Db,
  run: PipelineRunRow,
  step: { stepKey: string; iteration: number; attempt: number },
  values: Partial<PipelineRunStepRow> = {},
): string {
  const id = randomUUID();
  db.insert(pipelineRunSteps)
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
    })
    .run();
  return id;
}

function finishStepRow(db: Db, id: string, values: Partial<PipelineRunStepRow>): void {
  db.update(pipelineRunSteps)
    .set({ finishedAt: Date.now(), ...values })
    .where(eq(pipelineRunSteps.id, id))
    .run();
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
): string {
  const lines: string[] = [
    "## Triggering signal",
    `Source: ${signal.source}${signal.sourceUrl ? ` (${signal.sourceUrl})` : ""}`,
    signal.content,
    "",
    `## Target channel`,
    run.channel,
  ];
  const prior = spec.steps.filter((step) => outputs.has(step.key));
  if (prior.length > 0) {
    lines.push("", "## Prior step outputs");
    for (const step of prior) {
      lines.push(
        "",
        `### ${step.key} (${step.output})`,
        JSON.stringify(outputs.get(step.key), null, 2),
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
): Promise<StepPassResult> {
  const cached = state.cache.get(`${step.key}#${iteration}`);
  if (cached) return { ...cached, fromCache: true };

  const outputSchema = stepOutputSchemaFor(step.output);
  const tools = READ_TOOLS.filter((tool) => step.tools.includes(tool.name));
  const runner = new AgentRunner(db, metered);

  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= STEP_MAX_ATTEMPTS; attempt += 1) {
    const rowId = insertStepRow(db, run, {
      stepKey: step.key,
      iteration,
      attempt,
    });
    const ctx: ToolContext = {
      db,
      evidence: deps.evidence,
      safeFetch: deps.safeFetch,
      workspaceId: run.workspaceId,
      actor: { userId: null, label: run.createdBy },
      budget: DEFAULT_TOOL_BUDGET,
    };
    const result = await runner.run({
      workspaceId: run.workspaceId,
      task: `pipeline:${step.key}`,
      createdBy: run.createdBy,
      system: composeStepSystem(definitionName, workspaceName, step),
      messages: [
        {
          role: "user",
          content: composeStepUserMessage(run, signal, spec, state.outputs),
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
      finishStepRow(db, rowId, {
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
        finishStepRow(db, rowId, {
          ...usageValues,
          status: "succeeded",
          passes: 1,
          outputJson: JSON.stringify(parsed.data),
        });
        return { output: parsed.data, agentRunId: result.runId, fromCache: false };
      }
      lastFailure = "invalid_output";
      finishStepRow(db, rowId, {
        ...usageValues,
        status: "failed",
        failureReason: "invalid_output",
      });
      continue;
    }

    lastFailure = result.stopReason;
    finishStepRow(db, rowId, {
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

function runTotals(db: Db, runId: string): {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
} {
  const totals = db
    .select({
      inputTokens: sql<number>`coalesce(sum(${pipelineRunSteps.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${pipelineRunSteps.outputTokens}), 0)`,
      costCents: sql<number>`coalesce(sum(${pipelineRunSteps.costCents}), 0)`,
    })
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, runId))
    .get();
  return totals ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };
}

function finishRun(
  db: Db,
  run: PipelineRunRow,
  status: PipelineRunStatus,
  state: EngineState,
  values: Partial<PipelineRunRow> = {},
): PipelineRun {
  if (!canTransitionPipelineRun("running", status)) {
    throw new InvalidPipelineRunTransitionError("running", status);
  }
  const totals = runTotals(db, run.id);
  const patch: Partial<PipelineRunRow> = {
    status,
    checklistJson: JSON.stringify(state.checklist),
    ...totals,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...(status === "escalated" ? {} : { finishedAt: Date.now() }),
    ...values,
  };
  db.update(pipelineRuns).set(patch).where(eq(pipelineRuns.id, run.id)).run();
  const updated = db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, run.id))
    .get();
  return rowToRun(updated!);
}

/** The propose step (D-64.4/5): deterministic gate handoff, no LLM. */
function executePropose(
  db: Db,
  run: PipelineRunRow,
  spec: PipelineSpec,
  step: PipelineStepSpec,
  state: EngineState,
): { proposal: ProposalOutput; generationId: string | null; draftId: string | null } | null {
  const finalDraft = state.latestDraft;
  if (!finalDraft) return null;
  const taskType = "signal_response" as const;
  if (run.mode === "dry_run") {
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
  const generation = storeGeneration(db, {
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
  const draft = submitDraft(
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
  const existing = db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId)))
    .get();
  if (!existing) throw new PipelineRunNotFoundError(runId);

  if (llmBudgetExhausted(db, workspaceId)) {
    return { blocked: "llm_budget_exhausted", run: rowToRun(existing) };
  }

  // Claim fence (D-64.6): queued/escalated runs, or a running run whose
  // lease expired (crash recovery). A live concurrent execution wins.
  const now = Date.now();
  const leaseOwner = randomUUID();
  const claimed = db
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
    )
    .run();
  if (claimed.changes === 0) {
    return { blocked: "not_claimable", run: rowToRun(existing) };
  }
  const run = db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get()!;

  const versionRow = db
    .select()
    .from(pipelineDefinitionVersions)
    .where(
      and(
        eq(pipelineDefinitionVersions.definitionId, run.definitionId),
        eq(pipelineDefinitionVersions.version, run.definitionVersion),
      ),
    )
    .get();
  if (!versionRow) {
    const state = loadEngineState(db, run);
    return { run: finishRun(db, run, "failed", state, { failureReason: "definition_version_missing" }) };
  }
  const spec = JSON.parse(versionRow.specJson) as PipelineSpec;

  const signal = run.signalId ? getSignal(db, workspaceId, run.signalId) : undefined;
  const state = loadEngineState(db, run);
  if (!signal) {
    return { run: finishRun(db, run, "failed", state, { failureReason: "signal_missing" }) };
  }
  const workspace = getWorkspace(db, workspaceId);
  const workspaceName = workspace?.name ?? "workspace";
  const definitionRow = db
    .select({ name: pipelineDefinitions.name })
    .from(pipelineDefinitions)
    .where(eq(pipelineDefinitions.id, run.definitionId))
    .get();
  const definitionName = definitionRow?.name ?? run.taskKey;
  const metered = meteredLlm(deps.llm, db, {
    workspaceId,
    pipeline: "pipeline_run",
    campaignId: run.campaignId,
  });
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
      return { halted: finishRun(db, run, "failed", state, { failureReason: "run_timeout" }) };
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
    );
    if (pass.failure) {
      if (pass.failure.escalate) {
        return {
          halted: finishRun(db, run, "escalated", state, {
            pausedAtStepKey: step.key,
            escalationReason: pass.failure.escalate,
          }),
        };
      }
      return {
        halted: finishRun(db, run, "failed", state, { failureReason: pass.failure.reason }),
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
          halted: finishRun(db, run, "failed", state, { failureReason: "budget_exhausted" }),
        };
      }
      const escalate = escalationFor(spec, step, pass.output);
      if (escalate) {
        return {
          halted: finishRun(db, run, "escalated", state, {
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
      const handoff = executePropose(db, run, spec, step, state);
      if (!handoff) {
        return { run: finishRun(db, run, "failed", state, { failureReason: "no_draft_produced" }) };
      }
      const rowId = insertStepRow(db, run, { stepKey: step.key, iteration: 1, attempt: 1 });
      finishStepRow(db, rowId, {
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
        run: finishRun(db, run, "succeeded", state, {
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
            const rowId = insertStepRow(db, run, { stepKey: step.key, iteration: 1, attempt: 1 });
            finishStepRow(db, rowId, { status: "skipped", passes: 1 });
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
  return { run: finishRun(db, run, "failed", state, { failureReason: "no_propose_step" }) };
}

export function listPipelineRuns(
  db: Db,
  workspaceId: string,
  options: {
    definitionId?: string;
    mode?: PipelineRunMode;
    status?: PipelineRunStatus;
    limit?: number;
    offset?: number;
  } = {},
): { runs: PipelineRun[]; total: number } {
  const conditions = [eq(pipelineRuns.workspaceId, workspaceId)];
  if (options.definitionId) conditions.push(eq(pipelineRuns.definitionId, options.definitionId));
  if (options.mode) conditions.push(eq(pipelineRuns.mode, options.mode));
  if (options.status) conditions.push(eq(pipelineRuns.status, options.status));
  const where = and(...conditions);
  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(pipelineRuns)
      .where(where)
      .get()?.count ?? 0;
  const runs = db
    .select()
    .from(pipelineRuns)
    .where(where)
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(Math.min(options.limit ?? 20, 100))
    .offset(options.offset ?? 0)
    .all()
    .map(rowToRun);
  return { runs, total };
}

export function getPipelineRunDetail(
  db: Db,
  workspaceId: string,
  runId: string,
): PipelineRunDetail | undefined {
  const row = db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId)))
    .get();
  if (!row) return undefined;
  const steps = db
    .select()
    .from(pipelineRunSteps)
    .where(eq(pipelineRunSteps.runId, runId))
    .orderBy(sql`rowid`)
    .all()
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
  const row = db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.workspaceId, workspaceId), eq(pipelineRuns.id, runId)))
    .get();
  if (!row) throw new PipelineRunNotFoundError(runId);
  const status = row.status as PipelineRunStatus;

  if (input.action === "cancel") {
    if (!canTransitionPipelineRun(status, "cancelled")) {
      throw new InvalidPipelineRunTransitionError(status, "cancelled");
    }
    db.update(pipelineRuns)
      .set({
        status: "cancelled",
        failureReason: `cancelled: ${input.reason ?? ""}`.trim(),
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: Date.now(),
      })
      .where(eq(pipelineRuns.id, runId))
      .run();
    const updated = db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get()!;
    return { run: rowToRun(updated) };
  }

  if (status !== "escalated") {
    throw new InvalidPipelineRunTransitionError(status, "running");
  }
  return executePipelineRun(db, deps, workspaceId, runId);
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
      if (!getSignal(db, input.workspaceId, signalId)) {
        throw new PipelineSignalNotFoundError(signalId);
      }
    }
  } else {
    signalIds = listSignals(db, input.workspaceId)
      .slice(0, input.options.limit)
      .map((signal) => signal.id);
  }

  const runs: DryRunPipelineResult["runs"] = [];
  for (const signalId of signalIds) {
    const signal = getSignal(db, input.workspaceId, signalId)!;
    const started = startPipelineRun(db, {
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
