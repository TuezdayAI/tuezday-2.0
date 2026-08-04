import { and, desc, eq } from "drizzle-orm";
import {
  agentMessageSchema,
  type AgentMessage,
  type AgentRunDetail,
  type AgentRunStep,
  type AgentRunSummary,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { agentRuns, agentRunSteps, type AgentRunRow, type AgentRunStepRow } from "../db/schema";

// ---------------------------------------------------------------------------
// Agent Inspector reads (Sprint 57): a straight view over the Sprint 56
// agent_runs / agent_run_steps rows, JSON columns parsed server-side so the
// web app gets typed objects. Read-only — the runner owns all writes.
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // A malformed persisted row must not take the Inspector down with it.
    return null;
  }
}

function parseMessage(value: string | null): AgentMessage | null {
  const parsed = agentMessageSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : null;
}

function parseMessages(value: string): AgentMessage[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const message = agentMessageSchema.safeParse(entry);
    return message.success ? [message.data] : [];
  });
}

function rowToSummary(row: AgentRunRow): AgentRunSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    task: row.task,
    createdBy: row.createdBy,
    status: row.status as AgentRunSummary["status"],
    stopReason: row.stopReason as AgentRunSummary["stopReason"],
    error: row.error,
    model: row.model,
    provider: row.provider,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      costCents: row.costCents,
    },
    stepCount: row.stepCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function rowToStep(row: AgentRunStepRow): AgentRunStep {
  return {
    id: row.id,
    stepIndex: row.stepIndex,
    kind: row.kind as AgentRunStep["kind"],
    message: parseMessage(row.messageJson),
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    toolArgs: parseJson(row.toolArgsJson),
    toolResult: parseJson(row.toolResultJson),
    toolError: row.toolError,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      costCents: row.costCents,
    },
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export function listAgentRuns(
  db: Db,
  workspaceId: string,
  options: { limit?: number; task?: string } = {},
): AgentRunSummary[] {
  const conditions = [eq(agentRuns.workspaceId, workspaceId)];
  if (options.task) conditions.push(eq(agentRuns.task, options.task));
  return db
    .select()
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.startedAt))
    .limit(options.limit ?? DEFAULT_LIST_LIMIT)
    .all()
    .map(rowToSummary);
}

export function getAgentRunDetail(
  db: Db,
  workspaceId: string,
  runId: string,
): AgentRunDetail | undefined {
  const row = db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.id, runId)))
    .get();
  if (!row) return undefined;
  const steps = db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(agentRunSteps.stepIndex)
    .all()
    .map(rowToStep);
  return {
    ...rowToSummary(row),
    system: row.system,
    inputMessages: parseMessages(row.inputMessages),
    output: parseJson(row.outputJson),
    steps,
  };
}
