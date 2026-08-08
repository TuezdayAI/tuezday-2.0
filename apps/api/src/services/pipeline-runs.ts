// Queue-only pipeline-run creation, split out of pipeline-engine.ts so that
// services which merely enqueue runs (automation.ts since Sprint 65) never
// import the engine. The engine pulls in the agent tool registry, and several
// agent tools transitively reach automation.ts through core services — an
// automation → engine import would close that cycle and leave the registry's
// READ_TOOLS half-initialized at module load.

import { randomUUID } from "node:crypto";
import type {
  Channel,
  PipelineChecklistEntry,
  PipelineDefinition,
  PipelineRun,
  PipelineRunMode,
  PipelineRunStatus,
  PipelineTaskKey,
  ProposalOutput,
} from "@tuezday/contracts";
import { isUniqueViolation, type Db } from "../db";
import { pipelineRuns, type PipelineRunRow } from "../db/schema";
import { getSignal } from "./signals";

export class DuplicatePipelineRunError extends Error {
  constructor(key: string) {
    super(`A run with idempotency key "${key}" already exists.`);
    this.name = "DuplicatePipelineRunError";
  }
}

export class PipelineSignalNotFoundError extends Error {
  constructor(id: string) {
    super(`Signal "${id}" not found.`);
    this.name = "PipelineSignalNotFoundError";
  }
}

export function rowToRun(row: PipelineRunRow): PipelineRun {
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
export async function startPipelineRun(db: Db, input: StartPipelineRunInput): Promise<PipelineRun> {
  const signal = await getSignal(db, input.workspaceId, input.signalId);
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
    await db.insert(pipelineRuns).values(row);
  } catch (err) {
    if (input.idempotencyKey && isUniqueViolation(err)) {
      throw new DuplicatePipelineRunError(input.idempotencyKey);
    }
    throw err;
  }
  return rowToRun(row);
}
