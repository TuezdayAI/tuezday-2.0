import {
  CHAT_GOAL_MAX_CHARS,
  CHAT_TURN_BOUNDS,
  type AgentMessage,
  type AgentToolCall,
  type ChatCitation,
  type ChatMessage,
  type ChatSession,
  type ChatStreamEvent,
  type ChatTurnResult,
} from "@tuezday/contracts";
import { toAgentTools } from "../agents/adapter";
import { DEFAULT_TOOL_BUDGET, type ToolActor, type ToolContext } from "../agents/registry";
import { AgentRunner, type AgentRunEvent } from "../agents/runner";
import { READ_TOOLS } from "../agents/tools/index";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import type { SafeFetchService } from "../safe-fetch/index";
import {
  addSessionUsage,
  appendMessage,
  getSession,
  getSessionRow,
  listActiveMessages,
  setSessionGoalIfEmpty,
  setSessionTitleIfEmpty,
  threadTokens,
  type ThreadUsage,
} from "./chat";
import { buildChatContext } from "./chat-context";
import { citationsForToolCall, dedupeCitations } from "./chat-citations";
import { maybeCompact } from "./chat-compaction";

// ---------------------------------------------------------------------------
// One chat turn (Sprint 76). Replaces the Sprint 42 prompt-engineered
// tool-loop in copilot.ts.
//
// Every assistant turn is an `agent_run` driven by the AgentRunner over the
// Sprint 57 registry, so the Agent Inspector works for chat with no new
// tracing code — this is the whole reason chat comes after Sprint 57.
//
// READ-ONLY BY CONSTRUCTION (D-76.9). Two independent things make that true,
// and both are asserted by tests:
//   1. the tool list is filtered to `access === "read"`;
//   2. the ToolContext is built WITHOUT `proposals` and `questions`, so the
//      propose and ask tools cannot be constructed even if the filter were
//      wrong. There is no "propose without a gate" state.
// The write half arrives in Sprint 78 and reuses this service.
// ---------------------------------------------------------------------------

export interface ChatTurnDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export interface ChatTurnActor {
  userId: string | null;
  label: string;
}

/** The read tools a chat turn may call — the filter, evaluated once. */
export const CHAT_TOOLS = READ_TOOLS.filter((tool) => tool.access === "read");

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "At most 6 words. No quotes, no trailing period." },
    goal: {
      type: "string",
      description:
        "One sentence stating the outcome the user is after, in their own framing. Empty string if they only asked a question.",
    },
  },
  required: ["title", "goal"],
} as const;

const TITLE_SYSTEM =
  "You label a GTM working conversation from its opening message. Return a short title and, when the user is trying to achieve something rather than just asking a question, a one-sentence statement of that outcome. Never invent specifics the message does not contain.";

function toAgentMessages(messages: ChatMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push({ role: "user", content: message.content });
        break;
      case "assistant":
        out.push({ role: "assistant", content: message.content });
        break;
      case "compaction":
        // A summary of folded turns enters as user-role context: it is history
        // being handed to the model, not something the model said.
        out.push({ role: "user", content: message.content });
        break;
      case "tool":
        // Persisted tool messages are transcript, not replay: their call ids
        // belong to a finished run, and a tool result whose call the model
        // cannot see reads as an orphan. The assistant turn that used them
        // already carries their conclusions.
        break;
    }
  }
  return out;
}

/** Auto-title and derive the thread goal from the opening exchange (D-76.12). */
async function autoTitle(
  db: Db,
  llm: LlmGateway,
  session: ChatSession,
  userMessage: string,
): Promise<ThreadUsage> {
  const usage: ThreadUsage = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  if (session.title.trim() && session.goal.trim()) return usage;

  try {
    const run = await new AgentRunner(db, llm).run({
      workspaceId: session.workspaceId,
      task: "chat:title",
      createdBy: session.userId ? `user:${session.userId}` : "system",
      system: TITLE_SYSTEM,
      messages: [{ role: "user", content: userMessage.slice(0, 2_000) }],
      responseSchema: TITLE_SCHEMA as unknown as Record<string, unknown>,
      maxSteps: 1,
      maxTokens: 2_000,
      timeoutMs: 30_000,
      tier: "cheap",
    });
    usage.inputTokens = run.usage.inputTokens;
    usage.outputTokens = run.usage.outputTokens;
    usage.costCents = run.usage.costCents;

    const output = run.output as { title?: unknown; goal?: unknown } | null;
    if (typeof output?.title === "string") {
      setSessionTitleIfEmpty(db, session.id, output.title.slice(0, 200));
    }
    if (typeof output?.goal === "string") {
      setSessionGoalIfEmpty(db, session.id, output.goal.slice(0, CHAT_GOAL_MAX_CHARS));
    }
  } catch {
    // A thread without a title is a cosmetic loss; failing the turn over it
    // is not. The first user message stands in until a later turn retries.
  }
  if (!session.title.trim()) {
    setSessionTitleIfEmpty(db, session.id, userMessage.slice(0, 80));
  }
  return usage;
}

/**
 * Run one turn: persist the user message, compact if the transcript has
 * outgrown its budget, run the agent loop over the read tools, then persist
 * the grounded answer with its citations, cost and run id.
 *
 * Never throws on a model or tool failure — every outcome is a result with a
 * stop reason, matching the AgentRunner's own contract. The caller has already
 * checked the workspace budget and the thread cap; this function assumes a
 * turn it starts is a turn it may finish.
 */
export async function runChatTurn(
  db: Db,
  deps: ChatTurnDeps,
  workspaceId: string,
  actor: ChatTurnActor,
  sessionId: string,
  userMessage: string,
  onEvent?: (event: ChatStreamEvent) => void,
): Promise<ChatTurnResult | undefined> {
  const session = getSession(db, workspaceId, sessionId);
  if (!session) return undefined;
  const emit = onEvent ?? (() => {});

  const userRow = appendMessage(db, workspaceId, sessionId, {
    role: "user",
    content: userMessage,
  });
  emit({ type: "session", sessionId, userMessageId: userRow.id });

  // All chat model calls are metered to the existing `copilot` pipeline, so
  // /billing's spend-by-pipeline stays continuous across the rebuild (D-76.7).
  const llm = meteredLlm(deps.llm, db, { workspaceId, pipeline: "copilot" });

  const turnUsage: ThreadUsage = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  const addUsage = (usage: ThreadUsage) => {
    turnUsage.inputTokens += usage.inputTokens;
    turnUsage.outputTokens += usage.outputTokens;
    turnUsage.costCents += usage.costCents;
  };

  addUsage(await autoTitle(db, llm, session, userMessage));

  // Re-read: auto-titling may have set the goal, which the system prefix and
  // the retrieval query both read.
  const current = getSession(db, workspaceId, sessionId) ?? session;
  const sessionRow = getSessionRow(db, workspaceId, sessionId);

  let active = listActiveMessages(db, sessionId, sessionRow?.compactedThroughMessageId ?? null);
  const compaction = await maybeCompact(db, llm, current, active);
  if (compaction) {
    addUsage(compaction.usage);
    emit({
      type: "compaction",
      messageId: compaction.message.id,
      summarizedThrough: compaction.summarizedThrough,
      agentRunId: compaction.agentRunId,
    });
    active = listActiveMessages(db, sessionId, compaction.summarizedThrough);
  }

  const { system } = await buildChatContext(db, deps.evidence, current, userMessage);

  const toolActor: ToolActor = { userId: actor.userId, label: actor.label };
  // No `proposals`, no `questions` — the read-only boundary (D-76.9).
  const toolCtx: ToolContext = {
    db,
    evidence: deps.evidence,
    safeFetch: deps.safeFetch,
    workspaceId,
    actor: toolActor,
    budget: DEFAULT_TOOL_BUDGET,
  };

  const citations: ChatCitation[] = [];
  const toolCalls: { tool: string; ok: boolean }[] = [];
  const callsById = new Map<string, AgentToolCall>();

  const tools = toAgentTools(CHAT_TOOLS, toolCtx).map((tool) => ({
    ...tool,
    handler: async (args: unknown) => {
      const result = await tool.handler(args);
      citations.push(...citationsForToolCall(tool.definition.name, args, result));
      return result;
    },
  }));

  const onRunEvent = (event: AgentRunEvent) => {
    switch (event.type) {
      case "step_start":
        emit({ type: "step_start", stepIndex: event.stepIndex });
        break;
      case "text_delta":
        emit({ type: "text_delta", stepIndex: event.stepIndex, text: event.text });
        break;
      case "tool_call_start":
        callsById.set(event.call.id, event.call);
        emit({
          type: "tool_call_start",
          stepIndex: event.stepIndex,
          callId: event.call.id,
          name: event.call.name,
        });
        break;
      case "tool_call_end": {
        const call = callsById.get(event.callId);
        const ok = event.error === undefined;
        if (call) toolCalls.push({ tool: call.name, ok });
        emit({
          type: "tool_call_end",
          stepIndex: event.stepIndex,
          callId: event.callId,
          ok,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        break;
      }
      case "step_end":
        emit({
          type: "step_end",
          stepIndex: event.stepIndex,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        });
        break;
      default:
        break;
    }
  };

  const run = await new AgentRunner(db, llm).run({
    workspaceId,
    task: "chat",
    createdBy: actor.label,
    system,
    messages: toAgentMessages(active),
    tools,
    maxSteps: CHAT_TURN_BOUNDS.maxSteps,
    maxTokens: CHAT_TURN_BOUNDS.maxTokens,
    timeoutMs: CHAT_TURN_BOUNDS.timeoutMs,
    onEvent: onRunEvent,
  });

  addUsage({
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    costCents: run.usage.costCents,
  });

  const answer = answerFor(run.output, run.stopReason, run.error);
  const message = appendMessage(db, workspaceId, sessionId, {
    role: "assistant",
    content: answer,
    citations: dedupeCitations(citations),
    agentRunId: run.runId,
    costCents: run.usage.costCents,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    stopReason: run.stopReason,
  });

  addSessionUsage(db, sessionId, turnUsage);
  const after = getSession(db, workspaceId, sessionId);

  const result: ChatTurnResult = {
    answer,
    citations: message.citations,
    toolCalls,
    message,
    agentRunId: run.runId,
    stopReason: run.stopReason,
    costCents: turnUsage.costCents,
    threadTokens: after ? threadTokens(after) : turnUsage.inputTokens + turnUsage.outputTokens,
    threadCostCents: after?.totalCostCents ?? turnUsage.costCents,
  };

  emit({ type: "message", message });
  emit({
    type: "done",
    stopReason: run.stopReason,
    costCents: result.costCents,
    threadTokens: result.threadTokens,
    threadCostCents: result.threadCostCents,
  });
  return result;
}

/**
 * The text to show. A bound that tripped or a provider failure is stated to the
 * founder rather than rendered as an empty bubble — and whatever the model did
 * manage to say is kept, because a partial answer is still worth reading.
 */
function answerFor(output: unknown, stopReason: string, error: string | undefined): string {
  const text = typeof output === "string" ? output.trim() : "";
  if (stopReason === "complete") {
    return text || "I couldn't put together an answer for that. Try rephrasing it?";
  }
  const note =
    stopReason === "max_steps"
      ? "I ran out of steps before finishing this one — ask me to continue, or narrow the question."
      : stopReason === "max_tokens"
        ? "I hit this turn's token limit before finishing. Narrowing the question will help."
        : stopReason === "timeout"
          ? "That took too long and I had to stop."
          : `I couldn't finish that${error ? `: ${error}` : "."}`;
  return text ? `${text}\n\n_${note}_` : note;
}
