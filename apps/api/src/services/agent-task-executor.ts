// Sprint 79 (PRD §10, Move 9c): the moving half of a background agent.
//
// One claimed queue job → one AgentRunner loop → one resolved task. Everything
// durable is in services/agent-tasks.ts; this file is what turns a row into a
// run and back again.
//
// The invariant worth restating here, because this is where it would be
// easiest to break: a background task is the SAME agent as a chat turn. Same
// resolved brain context (`buildChatContext`), same registry, same recorder,
// same gate. It is given three things a turn is not — much larger bounds, a
// `delegate` tool, and a step-boundary hook — and nothing else.

import { randomUUID } from "node:crypto";
import {
  AGENT_TASK_BOUNDS,
  AGENT_TASK_SUBAGENTS_PER_TASK,
  AGENT_PROPOSALS_PER_RUN,
  CHAT_GOAL_MAX_CHARS,
  type AgentMessage,
  type AgentStopReason,
  type AgentTask,
  type ChatProposal,
  type ChatSession,
} from "@tuezday/contracts";
import { toAgentTools } from "../agents/adapter";
import type { AgentQuestionService } from "../agents/questions";
import type { AnyTool, ToolActor, ToolContext } from "../agents/registry";
import { AgentRunner } from "../agents/runner";
import { ASK_TOOLS, DELEGATE_TOOLS, PROPOSE_TOOLS, READ_TOOLS } from "../agents/tools/index";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import type { SafeFetchService } from "../safe-fetch/index";
import {
  drainSteerMessages,
  getAgentTask,
  isCancelRequested,
  markAgentTaskRunning,
  readAgentTaskTranscript,
  resolveAgentTask,
  saveAgentTaskTranscript,
} from "./agent-tasks";
import { appendMessage, getSession } from "./chat";
import { buildChatContext } from "./chat-context";
import { cardsForToolCall, dedupeCards } from "./chat-cards";
import { citationsForToolCall, dedupeCitations } from "./chat-citations";
import { attachProposalsToMessage, createChatProposalRecorder } from "./chat-proposals";
import { createTaintTracker, isUntrustedTool, wrapUntrusted } from "./chat-quarantine";
import { createSubagentService } from "./subagents";

export interface AgentTaskExecutorDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  /** The live Sprint 70 ask service. Absent means the task cannot ask, which
   * is the correct behaviour for a non-live mode, not a reason to fail. */
  questions?: AgentQuestionService;
}

export interface RunAgentTaskOptions {
  /** The queue's abort signal — shutdown, lease loss, or a cancelled task. */
  signal?: AbortSignal;
  /** Renews the lease. A false result means this process no longer owns the
   * job and must stop touching it (D-79.9). */
  heartbeat?: () => Promise<boolean>;
}

export type RunAgentTaskResult =
  | { status: "resolved"; task: AgentTask }
  /** The task was cancelled or claimed by nobody — a normal outcome the queue
   * should record as complete, not retry. */
  | { status: "skipped"; reason: string };

/**
 * The system suffix that tells the orchestrator what is different about being
 * a background run. Everything before it is the ordinary resolved context
 * bundle, which is the point (§0.2 of the spec).
 */
const ORCHESTRATOR_DIRECTIVE = [
  "You are running in the background. Nobody is watching this stream, so work to the end of the request rather than checking in — but you have far more room than a chat turn does, so use it.",
  "Delegate the self-contained parts. A worker reads what you would otherwise have to read yourself and hands back a short report, which keeps your own context for the reasoning only you can do. Give each worker a brief that stands alone: it cannot see this conversation.",
  "You cannot publish, send or spend. What you can do is put things forward: a proposal is recorded and a person confirms it later. Say plainly, at the end, what you proposed and what you did not.",
  "If something genuinely blocks you and no tool can settle it, ask — the task suspends and resumes when they answer. Ask once, about the thing that actually blocks you.",
  "Finish with a written answer to what was asked. It is the only thing most people will read.",
].join(" ");

function buildSystem(base: string): string {
  return `${base}\n\n${ORCHESTRATOR_DIRECTIVE}`;
}

/** The task's tool surface: every read tool, the propose tools, `delegate`,
 * and — only when there is a live ask service behind it — `ask_founder`. A
 * question nobody can answer is worse than no question (D-70.1). */
function toolsForTask(canAsk: boolean): readonly AnyTool[] {
  return [...READ_TOOLS, ...PROPOSE_TOOLS, ...DELEGATE_TOOLS, ...(canAsk ? ASK_TOOLS : [])];
}

/**
 * The scopeless session a task without a thread resolves its context against.
 * Never written; `id` is empty so the pin lookup finds nothing, which is the
 * truth — a task created from the API has no pinned context.
 */
function standInSession(task: AgentTask): ChatSession {
  return {
    id: "",
    workspaceId: task.workspaceId,
    userId: task.userId,
    title: task.title,
    goal: task.request.slice(0, CHAT_GOAL_MAX_CHARS),
    campaignId: null,
    personaId: null,
    channel: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostCents: 0,
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
  };
}

/**
 * Run one claimed agent task to a resting point.
 *
 * Never throws for a modelling or tool failure — like `runChatTurn` and the
 * runner itself, every outcome is a resolved task with a stop reason. A throw
 * from here means something structural broke and the queue should dead-letter
 * the job.
 */
export async function runAgentTask(
  db: Db,
  deps: AgentTaskExecutorDeps,
  workspaceId: string,
  taskId: string,
  options: RunAgentTaskOptions = {},
): Promise<RunAgentTaskResult> {
  const task = await getAgentTask(db, workspaceId, taskId);
  if (!task) return { status: "skipped", reason: "task_not_found" };
  if (task.cancelRequestedAt !== null || task.status === "cancelled") {
    await resolveAgentTask(db, taskId, {
      status: "cancelled",
      stopReason: "cancelled",
      error: null,
    });
    return { status: "skipped", reason: "cancelled_before_start" };
  }

  const runId = randomUUID();
  if (!(await markAgentTaskRunning(db, taskId, runId))) {
    // Somebody cancelled it, or another process already claimed it. Both are
    // normal races; neither is an error the operator should see.
    return { status: "skipped", reason: "not_claimable" };
  }

  // Metered to the same pipeline chat uses, so /billing's spend-by-pipeline
  // stays continuous — a background run is chat's work, moved (D-76.7).
  const llm = meteredLlm(deps.llm, db, { workspaceId, pipeline: "copilot" });

  const session = task.sessionId ? await getSession(db, workspaceId, task.sessionId) : undefined;
  const actor: ToolActor = { userId: task.userId, label: task.createdBy };

  // Cancellation is one signal the caller's shutdown signal folds into. The
  // step-boundary hook aborts it when the founder asks for a stop, which is
  // what lets a cancel land inside a step rather than at the next bound.
  const cancellation = new AbortController();
  const external = options.signal;
  const onExternalAbort = () => cancellation.abort(external?.reason);
  external?.addEventListener("abort", onExternalAbort, { once: true });
  if (external?.aborted) cancellation.abort(external.reason);

  const taint = createTaintTracker();
  // A task with no thread still gets the workspace's brain. `buildChatContext`
  // is driven by a session's SCOPE, not by its transcript, so a scopeless
  // stand-in resolves the same unscoped bundle a fresh thread would — which is
  // exactly right for "somebody asked for this from outside a conversation".
  const context = await buildChatContext(
    db,
    deps.evidence,
    session ?? standInSession(task),
    task.request,
    { mayPropose: true, safeFetch: deps.safeFetch },
  );
  for (const text of context.untrustedPinTexts) taint.observeUntrustedText(text);

  const system = buildSystem(context.system);
  const recordedProposals: ChatProposal[] = [];
  let subagentCount = 0;

  const subagents = createSubagentService({
    db,
    llm,
    evidence: deps.evidence,
    safeFetch: deps.safeFetch,
    actor,
    signal: cancellation.signal,
    onDelegated: () => {
      subagentCount += 1;
    },
  });

  const ctx: ToolContext = {
    db,
    evidence: deps.evidence,
    safeFetch: deps.safeFetch,
    workspaceId,
    actor,
    budget: {
      maxCalls: 60,
      perTool: { safe_fetch_url: 8, delegate: AGENT_TASK_SUBAGENTS_PER_TASK },
      maxProposals: AGENT_PROPOSALS_PER_RUN,
    },
    agentRunId: runId,
    agentTaskId: taskId,
    system,
    subagents,
    // The RECORDER, not the live gate — identical to a chat turn (D-78.1).
    // A background run proposes; a person still confirms.
    proposals: createChatProposalRecorder(db, {
      workspaceId,
      sessionId: task.sessionId,
      agentTaskId: taskId,
      taint,
      onRecorded: (proposal) => recordedProposals.push(proposal),
    }),
    ...(deps.questions ? { questions: deps.questions } : {}),
  };

  const citations = [] as ReturnType<typeof citationsForToolCall>;
  const cards = [] as ReturnType<typeof cardsForToolCall>;

  const tools = toAgentTools(toolsForTask(Boolean(ctx.questions)), ctx).map((tool) => ({
    ...tool,
    handler: async (args: unknown) => {
      const result = await tool.handler(args);
      const name = tool.definition.name;
      citations.push(...citationsForToolCall(name, args, result));
      cards.push(...cardsForToolCall(name, args, result));
      if (name.startsWith("propose_")) return result;
      taint.observe(name, result);
      return isUntrustedTool(name) ? wrapUntrusted(name, result) : result;
    },
  }));

  // Resume from where the last attempt stopped, when there was one (D-79.10).
  const priorTranscript = await readAgentTaskTranscript(db, taskId);
  const messages: AgentMessage[] =
    priorTranscript && priorTranscript.length > 0
      ? priorTranscript
      : [{ role: "user", content: task.request }];

  let heartbeatLost = false;

  const run = await new AgentRunner(db, llm).run({
    runId,
    workspaceId,
    task: "agent_task",
    createdBy: task.createdBy,
    system,
    messages,
    tools,
    maxSteps: AGENT_TASK_BOUNDS.maxSteps,
    maxTokens: AGENT_TASK_BOUNDS.maxTokens,
    timeoutMs: AGENT_TASK_BOUNDS.timeoutMs,
    signal: cancellation.signal,
    onStepBoundary: async ({ stepIndex }) => {
      // Renew the lease first: everything below writes, and writing under a
      // lease this process no longer holds is how two executors end up
      // running the same task.
      if (options.heartbeat && !(await options.heartbeat())) {
        heartbeatLost = true;
        cancellation.abort(new Error("lease_lost"));
        return { cancel: true };
      }
      if (await isCancelRequested(db, taskId)) {
        cancellation.abort(new Error("cancelled"));
        return { cancel: true };
      }
      const steers = await drainSteerMessages(db, taskId, stepIndex);
      if (steers.length === 0) return {};
      return {
        inject: steers.map((steer) => ({
          role: "user" as const,
          content: `The person who asked for this has sent a new instruction mid-run. It takes precedence over anything earlier that conflicts with it:\n\n${steer.content}`,
        })),
      };
    },
  });

  external?.removeEventListener("abort", onExternalAbort);

  const usage = {
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cachedTokens: run.usage.cachedTokens,
    costCents: run.usage.costCents,
  };
  const outputText = typeof run.output === "string" ? run.output.trim() : "";

  // A suspended run keeps its transcript so the resume continues rather than
  // restarts. Every other outcome is terminal and the transcript is dead
  // weight — the run's own steps are the durable record.
  if (run.stopReason === "needs_human" && !heartbeatLost) {
    await saveAgentTaskTranscript(db, taskId, run.messages);
    const suspended = await resolveAgentTask(db, taskId, {
      status: "awaiting_answer",
      stopReason: "needs_human",
      error: run.error ?? null,
      output: outputText || null,
      stepCount: run.toolCalls.length,
      subagentCount,
      usage,
    });
    return suspended
      ? { status: "resolved", task: suspended }
      : { status: "skipped", reason: "task_vanished" };
  }

  const { status, error } = outcomeFor(run.stopReason, run.error, heartbeatLost);
  await saveAgentTaskTranscript(db, taskId, []);
  const resolved = await resolveAgentTask(db, taskId, {
    status,
    stopReason: heartbeatLost ? "error" : run.stopReason,
    error,
    output: outputText || null,
    stepCount: run.toolCalls.length,
    subagentCount,
    usage,
  });
  if (!resolved) return { status: "skipped", reason: "task_vanished" };

  // Post back into the thread it came from. A task with no thread simply has
  // nowhere to post, and the inbox item is how its result is found (D-79.11).
  if (task.sessionId && session) {
    const message = await appendMessage(db, workspaceId, task.sessionId, {
      role: "assistant",
      content: threadAnswerFor(resolved, outputText),
      citations: dedupeCitations(citations),
      cards: dedupeCards(cards),
      agentRunId: runId,
      costCents: usage.costCents,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      stopReason: run.stopReason,
    });
    await attachProposalsToMessage(
      db,
      recordedProposals.map((proposal) => proposal.id),
      message.id,
    );
  }

  return { status: "resolved", task: resolved };
}

function outcomeFor(
  stopReason: AgentStopReason,
  runError: string | undefined,
  heartbeatLost: boolean,
): { status: "succeeded" | "failed" | "cancelled"; error: string | null } {
  if (heartbeatLost) return { status: "failed", error: "lease_lost" };
  switch (stopReason) {
    case "complete":
      return { status: "succeeded", error: null };
    case "cancelled":
      return { status: "cancelled", error: null };
    case "error":
      return { status: "failed", error: runError ?? "error" };
    default:
      // A bound tripped. The work is real and partial, so this is a failure
      // with the bound named rather than a success with a caveat — the
      // founder decides whether to retry with a narrower request.
      return { status: "failed", error: stopReason };
  }
}

/** What the thread shows. A partial answer is still worth reading, so whatever
 * the run managed to write is kept and the reason it stopped is appended. */
function threadAnswerFor(task: AgentTask, text: string): string {
  if (task.status === "succeeded") {
    return text || "That finished, but it did not produce a written answer. The trace has what it did.";
  }
  const note =
    task.status === "cancelled"
      ? "You stopped this one. Everything it had done up to that point is in the trace."
      : task.error === "max_steps"
        ? "I ran out of steps on this one. Narrowing the request would help."
        : task.error === "max_tokens"
          ? "I hit this task's token limit before finishing."
          : task.error === "timeout"
            ? "That took too long and I had to stop."
            : task.error === "lease_lost"
              ? "This task was interrupted by a restart and did not finish. Nothing it proposed was lost — you can retry it."
              : `I couldn't finish that${task.error ? `: ${task.error}` : "."}`;
  return text ? `${text}\n\n_${note}_` : note;
}
