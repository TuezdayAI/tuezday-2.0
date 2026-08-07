import { randomUUID } from "node:crypto";
import {
  CHAT_GOAL_MAX_CHARS,
  CHAT_TURN_BOUNDS,
  type AgentMessage,
  type AgentToolCall,
  type ChatCard,
  type ChatCitation,
  type ChatCommandName,
  type ChatMessage,
  type ChatProposal,
  type ChatSession,
  type ChatStreamEvent,
  type ChatTurnResult,
  type WorkspaceRole,
} from "@tuezday/contracts";
import { toAgentTools } from "../agents/adapter";
import {
  DEFAULT_TOOL_BUDGET,
  type AnyTool,
  type ToolActor,
  type ToolContext,
} from "../agents/registry";
import { AgentRunner, type AgentRunEvent } from "../agents/runner";
import { PROPOSE_TOOLS, READ_TOOLS } from "../agents/tools/index";
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
import { cardsForToolCall, dedupeCards } from "./chat-cards";
import { citationsForToolCall, dedupeCitations } from "./chat-citations";
import { directiveFor } from "./chat-commands";
import { maybeCompact } from "./chat-compaction";
import {
  attachProposalsToMessage,
  createChatProposalRecorder,
  listChatProposals,
} from "./chat-proposals";
import { createTaintTracker, isUntrustedTool, wrapUntrusted } from "./chat-quarantine";

// ---------------------------------------------------------------------------
// One chat turn (Sprint 76). Replaces the Sprint 42 prompt-engineered
// tool-loop in copilot.ts.
//
// Every assistant turn is an `agent_run` driven by the AgentRunner over the
// Sprint 57 registry, so the Agent Inspector works for chat with no new
// tracing code — this is the whole reason chat comes after Sprint 57.
//
// THE WRITE BOUNDARY (D-76.9, extended in Sprint 78). Two independent things
// decide it, and both are asserted by tests:
//   1. the tool list, filtered by the actor's role (`chatToolsForActor`);
//   2. the ToolContext, which carries `proposals` only when that actor may
//      write — so the propose tools cannot be *constructed* for a read-only
//      actor even if the filter were wrong. There is no "propose without a
//      gate" state, and there never was one.
//
// What propose means here is narrower than it means in a pipeline: the service
// bound to `proposals` is the RECORDER (services/chat-proposals.ts), which
// writes a pending row and returns. Nothing reaches the Sprint 69 gate until a
// human confirms it in the thread (D-78.1).
// ---------------------------------------------------------------------------

export interface ChatTurnDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export interface ChatTurnOptions {
  /**
   * The directive command this message was sent under (Sprint 77, D-77.4). The
   * INSTRUCTION is looked up here, never taken from the client: a request body
   * that could supply system text would be a prompt-injection surface with a
   * slash in front of it. An instant command never reaches this path.
   */
  command?: ChatCommandName;
}

export interface ChatTurnActor {
  userId: string | null;
  label: string;
  /** Workspace role, from the auth guard. Absent for the system actor. */
  role?: WorkspaceRole;
  /** True only for a signed-in person (auth/guard.ts `actorOf`). */
  human?: boolean;
}

/** The read tools every chat turn may call — the Sprint 76 floor. */
export const CHAT_TOOLS = READ_TOOLS.filter((tool) => tool.access === "read");

/** The propose tools a writing actor may additionally call (Sprint 78). */
export const CHAT_PROPOSE_TOOLS = PROPOSE_TOOLS.filter((tool) => tool.access === "propose");

/**
 * Roles that may put something forward for confirmation in chat (D-78.3).
 *
 * This platform has no read-only workspace role today — `WORKSPACE_ROLES` is
 * `["owner", "member"]` and both write freely through every existing route, so
 * granting both here matches what those roles already mean everywhere else.
 * Inventing a chat-only restriction would put an authorization rule in chat,
 * which the PRD's §1.2 invariant forbids and which would be trivially bypassed
 * by using the app normally.
 *
 * What this list DOES buy is the seam: the day a `viewer` role exists, its
 * chat is read-only by construction with no change to this file — an
 * unrecognised role never reaches the allowlist, and the system actor never
 * does either.
 */
const PROPOSING_ROLES: readonly WorkspaceRole[] = ["owner", "member"];

export function actorMayPropose(actor: ChatTurnActor): boolean {
  if (actor.human === false) return false;
  if (!actor.userId) return false;
  return actor.role !== undefined && PROPOSING_ROLES.includes(actor.role);
}

/** The tool list for this actor, and nothing about the prompt decides it. */
export function chatToolsForActor(actor: ChatTurnActor): readonly AnyTool[] {
  return actorMayPropose(actor) ? [...CHAT_TOOLS, ...CHAT_PROPOSE_TOOLS] : CHAT_TOOLS;
}

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
  options: ChatTurnOptions = {},
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

  const mayPropose = actorMayPropose(actor);
  const taint = createTaintTracker();
  const context = await buildChatContext(db, deps.evidence, current, userMessage, {
    mayPropose,
    safeFetch: deps.safeFetch,
  });
  // A pinned page or discovery item is attacker-controlled text that reached
  // the model through the PREFIX, before it took a step. The turn is tainted
  // from the start (D-77.6), or the quarantine rule would have a hole in it
  // exactly where a founder pasted a link somebody sent them.
  for (const text of context.untrustedPinTexts) taint.observeUntrustedText(text);

  const directive = options.command ? directiveFor(options.command) : null;
  const system = directive ? `${context.system}\n\n${directive}` : context.system;

  const toolActor: ToolActor = { userId: actor.userId, label: actor.label };
  const recordedProposals: ChatProposal[] = [];
  // Minted here rather than inside the runner: a propose tool attributes its
  // proposal to the run that called it, so the id has to exist before the tool
  // context does.
  const runId = randomUUID();

  // `proposals` is present only for an actor who may write (D-78.3), and even
  // then it is the RECORDER, not the live gate — so a propose call inside a
  // chat turn cannot execute anything, whatever the model intends.
  const toolCtx: ToolContext = {
    db,
    evidence: deps.evidence,
    safeFetch: deps.safeFetch,
    workspaceId,
    actor: toolActor,
    budget: DEFAULT_TOOL_BUDGET,
    agentRunId: runId,
    ...(mayPropose
      ? {
          proposals: createChatProposalRecorder(db, {
            workspaceId,
            sessionId,
            taint,
            onRecorded: (proposal) => {
              recordedProposals.push(proposal);
              emit({ type: "proposal", proposal });
            },
          }),
        }
      : {}),
  };

  const citations: ChatCitation[] = [];
  const cards: ChatCard[] = [];
  const toolCalls: { tool: string; ok: boolean }[] = [];
  const callsById = new Map<string, AgentToolCall>();
  // The runner reports step boundaries on its own events, not to the tool
  // handler, so the card frame carries the step the client last saw start.
  let currentStep = 0;

  const tools = toAgentTools(chatToolsForActor(actor), toolCtx).map((tool) => ({
    ...tool,
    handler: async (args: unknown) => {
      const result = await tool.handler(args);
      const name = tool.definition.name;
      citations.push(...citationsForToolCall(name, args, result));
      // Cards are computed from the RAW result, before the untrusted wrapper
      // below: the envelope is for the model, and a card rendering
      // "--- BEGIN UNTRUSTED CONTENT ---" as its body would be absurd. The
      // card's own kind already tells the web layer what it is looking at.
      const produced = cardsForToolCall(name, args, result);
      if (produced.length > 0) {
        cards.push(...produced);
        emit({ type: "card", stepIndex: currentStep, cards: produced });
      }
      // The propose tools' own results are not content the model read, so they
      // neither taint the turn nor count as trusted grounding for it.
      if (tool.definition.name.startsWith("propose_")) return result;
      taint.observe(name, result);
      // Untrusted results are wrapped before the model — and therefore before
      // `agent_run_steps.tool_result_json` — sees them, so the boundary is in
      // the trace by construction rather than by a parallel log (D-78.6).
      return isUntrustedTool(name) ? wrapUntrusted(name, result) : result;
    },
  }));

  const onRunEvent = (event: AgentRunEvent) => {
    switch (event.type) {
      case "step_start":
        currentStep = event.stepIndex;
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
    runId,
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
  const dedupedCards = dedupeCards(cards);
  const message = appendMessage(db, workspaceId, sessionId, {
    role: "assistant",
    content: answer,
    citations: dedupeCitations(citations),
    cards: dedupedCards,
    agentRunId: run.runId,
    costCents: run.usage.costCents,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    stopReason: run.stopReason,
  });
  attachProposalsToMessage(
    db,
    recordedProposals.map((p) => p.id),
    message.id,
  );

  addSessionUsage(db, sessionId, turnUsage);
  const after = getSession(db, workspaceId, sessionId);

  // Re-read rather than returning what we collected: `messageId` was written
  // after the rows were, and the client renders cards keyed on it.
  const proposals =
    recordedProposals.length === 0
      ? []
      : listChatProposals(db, sessionId).filter((p) => p.messageId === message.id);

  const result: ChatTurnResult = {
    answer,
    citations: message.citations,
    cards: message.cards,
    toolCalls,
    message,
    proposals,
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
