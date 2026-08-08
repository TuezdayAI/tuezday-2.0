// Sprint 79 (PRD §10, Move 9c): the durable half of a background agent.
//
// Everything here is state a human can read and change: create, watch, steer,
// cancel, acknowledge. It never imports the runner or the executor — recording
// a steer and APPLYING one are separate concerns, the same separation Sprint 70
// made between recording an answer and resuming a run (D-70.7). That is what
// lets the executor import this module without a cycle.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AGENT_TASKS_PER_WORKSPACE,
  AGENT_TASK_MAX_COST_CENTS,
  AGENT_TASK_STEERS_PER_TASK,
  AGENT_TASK_TERMINAL_STATUSES,
  AGENT_TASK_TRANSCRIPT_MAX_CHARS,
  agentTaskMessageSchema,
  agentTaskSchema,
  isAgentTaskTerminal,
  type AgentMessage,
  type AgentStopReason,
  type AgentTask,
  type AgentTaskBudgetWarning,
  type AgentTaskDetail,
  type AgentTaskMessage,
  type AgentTaskStatus,
} from "@tuezday/contracts";
import { type Db, rowsAffected } from "../db";
import {
  agentQuestions,
  agentRuns,
  agentRunSteps,
  agentTaskMessages,
  agentTasks,
  type AgentTaskMessageRow,
  type AgentTaskRow,
} from "../db/schema";
import { rowToAgentQuestion } from "./agent-questions";
import { rowToStep, rowToSummary } from "./agent-runs";
import { enqueueBackgroundJob } from "./background-jobs";
import { listChatProposalsForTask } from "./chat-proposals";
import { remainingLlmBudgetCents } from "./entitlements";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const TITLE_MAX_CHARS = 120;

export function rowToAgentTask(row: AgentTaskRow): AgentTask {
  return agentTaskSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    userId: row.userId,
    createdBy: row.createdBy,
    request: row.request,
    title: row.title,
    status: row.status as AgentTaskStatus,
    agentRunId: row.agentRunId,
    stopReason: row.stopReason as AgentStopReason | null,
    error: row.error,
    output: row.outputText,
    stepCount: row.stepCount,
    subagentCount: row.subagentCount,
    steerCount: row.steerCount,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      costCents: row.costCents,
    },
    cancelRequestedAt: row.cancelRequestedAt,
    acknowledgedAt: row.acknowledgedAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

function rowToTaskMessage(row: AgentTaskMessageRow): AgentTaskMessage {
  return agentTaskMessageSchema.parse({
    id: row.id,
    taskId: row.taskId,
    role: "steer",
    content: row.content,
    consumedAt: row.consumedAt,
    consumedAtStep: row.consumedAtStep,
    createdAt: row.createdAt,
  });
}

/** The first line of the request, which is what a founder scanning a list of
 * running tasks actually recognises. A model-written title would cost a call
 * and a wait before the work the founder asked for even starts. */
export function titleForRequest(request: string): string {
  const firstLine = request.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const text = firstLine || request.trim();
  return text.length <= TITLE_MAX_CHARS ? text : `${text.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAgentTask(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<AgentTask | undefined> {
  const row = (await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.workspaceId, workspaceId), eq(agentTasks.id, taskId))))[0];
  return row ? rowToAgentTask(row) : undefined;
}

export interface ListAgentTasksOptions {
  status?: AgentTaskStatus;
  sessionId?: string;
  limit?: number;
}

export async function listAgentTasks(
  db: Db,
  workspaceId: string,
  options: ListAgentTasksOptions = {},
): Promise<AgentTask[]> {
  return (await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.workspaceId, workspaceId),
        options.status ? eq(agentTasks.status, options.status) : undefined,
        options.sessionId ? eq(agentTasks.sessionId, options.sessionId) : undefined,
      ),
    )
    .orderBy(desc(agentTasks.createdAt))
    .limit(Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)))
    .map(rowToAgentTask);
}

/** Terminal, unacknowledged tasks — the inbox projection's read (D-79.11). */
export async function listUnacknowledgedAgentTasks(
  db: Db,
  workspaceId: string,
  limit = MAX_LIST_LIMIT,
): Promise<AgentTask[]> {
  return (await db
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.workspaceId, workspaceId),
        inArray(agentTasks.status, [...AGENT_TASK_TERMINAL_STATUSES]),
        isNull(agentTasks.acknowledgedAt),
      ),
    )
    .orderBy(desc(agentTasks.finishedAt))
    .limit(limit))
    .map(rowToAgentTask);
}

export async function listAgentTaskMessages(
  db: Db,
  taskId: string,
): Promise<AgentTaskMessage[]> {
  return (await db
    .select()
    .from(agentTaskMessages)
    .where(eq(agentTaskMessages.taskId, taskId))
    .orderBy(asc(agentTaskMessages.createdAt), asc(agentTaskMessages.seq)))
    .map(rowToTaskMessage);
}

export async function getAgentTaskDetail(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<AgentTaskDetail | undefined> {
  const task = await getAgentTask(db, workspaceId, taskId);
  if (!task) return undefined;

  // Steps come from the CURRENT run only. A resumed task's earlier runs are
  // reachable through the Inspector by id; replaying all of them here would
  // show the founder the same reasoning three times.
  const steps = task.agentRunId
    ? (await db
        .select()
        .from(agentRunSteps)
        .where(eq(agentRunSteps.runId, task.agentRunId))
        .orderBy(asc(agentRunSteps.stepIndex)))
        .map(rowToStep)
    : [];

  const subagents = task.agentRunId
    ? (await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.parentRunId, task.agentRunId))
        .orderBy(asc(agentRuns.startedAt)))
        .map(rowToSummary)
    : [];

  return {
    ...task,
    steps,
    subagents,
    messages: await listAgentTaskMessages(db, taskId),
    questions: (await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.agentTaskId, taskId))
      .orderBy(desc(agentQuestions.createdAt)))
      .map(rowToAgentQuestion),
    proposals: await listChatProposalsForTask(db, taskId),
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateAgentTaskActor {
  userId: string | null;
  label: string;
}

export type CreateAgentTaskOutcome =
  | { ok: true; task: AgentTask; budgetWarning: AgentTaskBudgetWarning | null }
  | { ok: false; error: "agent_task_limit_reached"; limit: number };

/**
 * Count what the cap counts: work that is queued, running, or stopped waiting
 * for the founder. `awaiting_answer` counts because it still owns a slot the
 * founder has to clear — a workspace with two suspended tasks and no way to
 * start a third would otherwise look broken rather than blocked.
 */
export async function countActiveAgentTasks(db: Db, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.workspaceId, workspaceId),
        inArray(agentTasks.status, ["queued", "running", "awaiting_answer"]),
      ),
    );
  return rows[0]?.count ?? 0;
}

async function budgetWarningFor(
  db: Db,
  workspaceId: string,
): Promise<AgentTaskBudgetWarning | null> {
  const remaining = await remainingLlmBudgetCents(db, workspaceId);
  if (!Number.isFinite(remaining) || remaining > AGENT_TASK_MAX_COST_CENTS) return null;
  return {
    remainingCents: remaining,
    worstCaseCents: AGENT_TASK_MAX_COST_CENTS,
    message:
      `This task can cost up to $${(AGENT_TASK_MAX_COST_CENTS / 100).toFixed(2)} and there is ` +
      `$${(remaining / 100).toFixed(2)} left in this month's budget. It will stop early if the budget runs out.`,
  };
}

export interface CreateAgentTaskInputRow {
  request: string;
  sessionId?: string | null;
}

/**
 * Create a task and enqueue it. The queue row is written in the same call, so
 * a task that exists is always a task something will pick up — there is no
 * "created but never enqueued" state for an operator to discover later.
 */
export async function createAgentTask(
  db: Db,
  workspaceId: string,
  actor: CreateAgentTaskActor,
  input: CreateAgentTaskInputRow,
): Promise<CreateAgentTaskOutcome> {
  const active = await countActiveAgentTasks(db, workspaceId);
  if (active >= AGENT_TASKS_PER_WORKSPACE) {
    return { ok: false, error: "agent_task_limit_reached", limit: AGENT_TASKS_PER_WORKSPACE };
  }

  const now = Date.now();
  const id = randomUUID();
  const request = input.request.trim();
  const row = (await db
    .insert(agentTasks)
    .values({
      id,
      workspaceId,
      sessionId: input.sessionId ?? null,
      userId: actor.userId,
      createdBy: actor.label,
      request,
      title: titleForRequest(request),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning())[0]!;

  // The idempotency key is the task id: each task is its own piece of work,
  // and a resume enqueues under a distinct key (see `requeueAgentTask`).
  const job = await enqueueBackgroundJob(db, {
    payload: { kind: "agent_task", workspaceId, taskId: id },
    idempotencyKey: `agent_task:${id}:1`,
    // One attempt (D-79.9): a crashed task fails visibly rather than silently
    // spending the founder's budget twice on work they cannot see.
    maxAttempts: 1,
    // Above the recurring ticks: a founder is watching this one.
    priority: 10,
  });
  await db.update(agentTasks).set({ jobId: job.id, updatedAt: now }).where(eq(agentTasks.id, id));

  return {
    ok: true,
    task: rowToAgentTask({ ...row, jobId: job.id }),
    budgetWarning: await budgetWarningFor(db, workspaceId),
  };
}

/**
 * Put a suspended task back on the queue. Used when a question it asked is
 * answered (D-79.10) — the attempt number keeps the idempotency key unique, so
 * a task can suspend and resume as many times as the founder has answers.
 */
export async function requeueAgentTask(db: Db, taskId: string): Promise<boolean> {
  const row = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0];
  if (!row || row.status !== "awaiting_answer") return false;

  const now = Date.now();
  const updated = await db
    .update(agentTasks)
    .set({ status: "queued", stopReason: null, error: null, updatedAt: now })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, "awaiting_answer")));
  if (rowsAffected(updated) === 0) return false;

  const job = await enqueueBackgroundJob(db, {
    payload: { kind: "agent_task", workspaceId: row.workspaceId, taskId },
    idempotencyKey: `agent_task:${taskId}:${now}`,
    maxAttempts: 1,
    priority: 10,
  });
  await db.update(agentTasks).set({ jobId: job.id, updatedAt: now }).where(eq(agentTasks.id, taskId));
  return true;
}

// ---------------------------------------------------------------------------
// Steering, cancelling, acknowledging
// ---------------------------------------------------------------------------

export type SteerAgentTaskOutcome =
  | { ok: true; message: AgentTaskMessage }
  | { ok: false; error: "task_not_found" | "task_finished" | "steer_cap_reached" };

/**
 * Record a mid-flight instruction. It does not reach the model here — the
 * executor drains it at the next step boundary (D-79.7). A steer sent to a
 * finished task is refused rather than stored, because a founder who thinks
 * they redirected a run that had already stopped has been misled.
 */
export async function steerAgentTask(
  db: Db,
  workspaceId: string,
  taskId: string,
  content: string,
): Promise<SteerAgentTaskOutcome> {
  const task = await getAgentTask(db, workspaceId, taskId);
  if (!task) return { ok: false, error: "task_not_found" };
  if (isAgentTaskTerminal(task.status)) return { ok: false, error: "task_finished" };
  if (task.steerCount >= AGENT_TASK_STEERS_PER_TASK) {
    return { ok: false, error: "steer_cap_reached" };
  }

  const now = Date.now();
  const row = (await db
    .insert(agentTaskMessages)
    .values({
      id: randomUUID(),
      taskId,
      workspaceId,
      role: "steer",
      content: content.trim(),
      createdAt: now,
    })
    .returning())[0]!;
  await db
    .update(agentTasks)
    .set({ steerCount: sql`${agentTasks.steerCount} + 1`, updatedAt: now })
    .where(eq(agentTasks.id, taskId));

  return { ok: true, message: rowToTaskMessage(row) };
}

export type CancelAgentTaskOutcome =
  | { ok: true; task: AgentTask }
  | { ok: false; error: "task_not_found" | "task_finished" };

/**
 * Ask for a stop. A task that has not started yet is resolved immediately —
 * there is no run to interrupt, and leaving it queued so a worker can pick it
 * up and cancel it a second later would be theatre. A running task is marked
 * and the executor notices at its next step boundary or its next tool return.
 */
export async function cancelAgentTask(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<CancelAgentTaskOutcome> {
  const task = await getAgentTask(db, workspaceId, taskId);
  if (!task) return { ok: false, error: "task_not_found" };
  if (isAgentTaskTerminal(task.status)) return { ok: false, error: "task_finished" };

  const now = Date.now();
  if (task.status === "queued" || task.status === "awaiting_answer") {
    await db
      .update(agentTasks)
      .set({
        status: "cancelled",
        stopReason: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, task.status)));
  } else {
    await db
      .update(agentTasks)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(eq(agentTasks.id, taskId));
  }

  const after = await getAgentTask(db, workspaceId, taskId);
  return after ? { ok: true, task: after } : { ok: false, error: "task_not_found" };
}

export async function acknowledgeAgentTask(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<AgentTask | undefined> {
  const now = Date.now();
  await db
    .update(agentTasks)
    .set({ acknowledgedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentTasks.workspaceId, workspaceId),
        eq(agentTasks.id, taskId),
        isNull(agentTasks.acknowledgedAt),
      ),
    );
  return await getAgentTask(db, workspaceId, taskId);
}

// ---------------------------------------------------------------------------
// The executor's writes. Everything below is called from one place —
// agent-task-executor.ts — and is here so all table access stays together.
// ---------------------------------------------------------------------------

/** Move a claimed task to `running`. False means somebody cancelled it between
 * the enqueue and the claim, which is a normal outcome, not an error. */
export async function markAgentTaskRunning(
  db: Db,
  taskId: string,
  agentRunId: string,
): Promise<boolean> {
  const now = Date.now();
  const updated = await db
    .update(agentTasks)
    .set({
      status: "running",
      agentRunId,
      startedAt: sql`coalesce(${agentTasks.startedAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, taskId), inArray(agentTasks.status, ["queued"])));
  return rowsAffected(updated) > 0;
}

export async function isCancelRequested(db: Db, taskId: string): Promise<boolean> {
  const row = (await db
    .select({ cancelRequestedAt: agentTasks.cancelRequestedAt })
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId)))[0];
  return row?.cancelRequestedAt !== null && row?.cancelRequestedAt !== undefined;
}

/** Take the steers nobody has applied yet and mark them applied. Returns them
 * in the order they were written, so two instructions arriving together reach
 * the model in the order the founder typed them. */
export async function drainSteerMessages(
  db: Db,
  taskId: string,
  stepIndex: number,
): Promise<AgentTaskMessage[]> {
  const pending = (await db
    .select()
    .from(agentTaskMessages)
    .where(and(eq(agentTaskMessages.taskId, taskId), isNull(agentTaskMessages.consumedAt)))
    .orderBy(asc(agentTaskMessages.createdAt), asc(agentTaskMessages.seq)))
    .map(rowToTaskMessage);
  if (pending.length === 0) return [];

  const now = Date.now();
  await db
    .update(agentTaskMessages)
    .set({ consumedAt: now, consumedAtStep: stepIndex })
    .where(inArray(agentTaskMessages.id, pending.map((message) => message.id)));
  return pending;
}

/**
 * Persist the working transcript across a suspend (D-79.10). Bounded by
 * dropping the OLDEST tool results first: the opening request has to survive
 * or the resumed run does not know what it was asked, and the newest results
 * are the ones it was still reasoning about.
 */
export function boundTranscript(messages: AgentMessage[]): AgentMessage[] {
  const kept = [...messages];
  const size = () => JSON.stringify(kept).length;
  for (let i = 1; i < kept.length && size() > AGENT_TASK_TRANSCRIPT_MAX_CHARS; ) {
    if (kept[i]?.role === "tool") {
      kept.splice(i, 1);
      continue;
    }
    i += 1;
  }
  // Still too large with every tool result gone: drop from the middle, never
  // the first message and never the last three.
  while (kept.length > 4 && size() > AGENT_TASK_TRANSCRIPT_MAX_CHARS) {
    kept.splice(1, 1);
  }
  return kept;
}

export async function saveAgentTaskTranscript(
  db: Db,
  taskId: string,
  messages: AgentMessage[],
): Promise<void> {
  await db
    .update(agentTasks)
    .set({ transcriptJson: JSON.stringify(boundTranscript(messages)), updatedAt: Date.now() })
    .where(eq(agentTasks.id, taskId));
}

export async function readAgentTaskTranscript(
  db: Db,
  taskId: string,
): Promise<AgentMessage[] | null> {
  const row = (await db
    .select({ transcriptJson: agentTasks.transcriptJson })
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId)))[0];
  if (!row?.transcriptJson) return null;
  try {
    const parsed = JSON.parse(row.transcriptJson);
    return Array.isArray(parsed) ? (parsed as AgentMessage[]) : null;
  } catch {
    // A malformed transcript costs the resume its history, not its life.
    return null;
  }
}

export interface ResolveAgentTaskInput {
  status: AgentTaskStatus;
  stopReason?: AgentStopReason | null;
  error?: string | null;
  output?: string | null;
  stepCount?: number;
  subagentCount?: number;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; costCents: number };
}

/** Write the outcome. Usage ACCUMULATES across resumes — a task that suspended
 * twice cost the founder all three runs, and showing only the last would
 * understate it every time. */
export async function resolveAgentTask(
  db: Db,
  taskId: string,
  input: ResolveAgentTaskInput,
): Promise<AgentTask | undefined> {
  const now = Date.now();
  const usage = input.usage;
  await db
    .update(agentTasks)
    .set({
      status: input.status,
      stopReason: input.stopReason ?? null,
      error: input.error ?? null,
      ...(input.output === undefined ? {} : { outputText: input.output }),
      ...(input.stepCount === undefined
        ? {}
        : { stepCount: sql`${agentTasks.stepCount} + ${input.stepCount}` }),
      ...(input.subagentCount === undefined
        ? {}
        : { subagentCount: sql`${agentTasks.subagentCount} + ${input.subagentCount}` }),
      ...(usage
        ? {
            inputTokens: sql`${agentTasks.inputTokens} + ${usage.inputTokens}`,
            outputTokens: sql`${agentTasks.outputTokens} + ${usage.outputTokens}`,
            cachedTokens: sql`${agentTasks.cachedTokens} + ${usage.cachedTokens}`,
            costCents: sql`${agentTasks.costCents} + ${usage.costCents}`,
          }
        : {}),
      ...(isAgentTaskTerminal(input.status) ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(agentTasks.id, taskId));

  const row = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0];
  return row ? rowToAgentTask(row) : undefined;
}
