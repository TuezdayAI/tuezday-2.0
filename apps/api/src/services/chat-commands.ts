import {
  chatCommand,
  type ChatCard,
  type ChatCommandName,
  type ChatMessage,
} from "@tuezday/contracts";
import { getTool } from "../agents/tools/index";
import { DEFAULT_TOOL_BUDGET, type ToolContext } from "../agents/registry";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { SafeFetchService } from "../safe-fetch/index";
import { appendMessage } from "./chat";
import { cardsForToolCall, dedupeCards } from "./chat-cards";
import { citationsForToolCall, dedupeCitations } from "./chat-citations";

// ---------------------------------------------------------------------------
// The command layer (Sprint 77, D-77.4).
//
// Two kinds, and the difference is whether a model runs at all.
//
// INSTANT commands are executed here, against the registry's read tools, and
// return cards. No LLM call, no cost, no inference. "What is waiting for me" is
// a query; paying a model to choose a tool for it buys a slower, less reliable
// answer than running the tool.
//
// DIRECTIVE commands are ordinary model turns (chat-turn.ts) whose intent is
// pinned by an instruction this module owns. The model still decides how; it
// no longer has to guess what. The text lives in the API on purpose — a client
// that could post arbitrary prose as a "command" would be a prompt-injection
// surface with a slash in front of it.
//
// Neither kind introduces a capability. An instant command calls tools chat
// already has; a directive command adds a sentence to a prompt. The §1.2
// invariant holds: chat owns no tools and no business logic.
// ---------------------------------------------------------------------------

/**
 * What each instant command actually runs. Named tools rather than direct
 * service calls, so a command and a model asking the same question read the
 * same rows through the same code — and so a tool's refusal reaches the founder
 * unchanged.
 */
const INSTANT_PLANS: Record<string, { tool: string; args: Record<string, unknown> }[]> = {
  status: [
    { tool: "get_workspace_insights", args: {} },
    { tool: "list_campaigns", args: { status: "active", limit: 5 } },
    { tool: "list_drafts", args: { state: "pending_review", limit: 5 } },
  ],
  approve: [{ tool: "list_drafts", args: { state: "pending_review", limit: 10 } }],
};

/**
 * The server-owned directives (D-77.4). Each says what the turn is FOR, in the
 * platform's own vocabulary, and none of them grants anything: a `/draft` turn
 * still holds exactly the tools the actor's role allows, and still stops at a
 * confirmation card.
 */
const DIRECTIVES: Record<string, string> = {
  draft:
    "COMMAND: /draft. The person wants written content produced and put up for review. Read what you need to ground it — the brain, prior approved posts, the campaign — then write the piece in full and call propose_draft with it. Do not publish or schedule anything. If the request is too thin to write from, ask them the one question that would unblock it rather than inventing specifics.",
  campaign:
    "COMMAND: /campaign. The person wants a campaign. Establish what it is for, who it is aimed at and how success is measured — reading the brain and existing campaigns first, and asking them only what you genuinely cannot infer. Then call propose_campaign with what the conversation actually established. Do not fill unstated fields with plausible-sounding invention; a thin campaign they can finish is better than a complete one that is wrong.",
  agent:
    "COMMAND: /agent. The person wants a goal worked end to end rather than a single answer. Plan it out loud in a short numbered list, do the reading, and put forward the concrete things that move it — one proposal at a time, in the order they have to happen. Say clearly at the end which parts you could not do here and what you would need.",
};

export function directiveFor(command: ChatCommandName): string | null {
  return DIRECTIVES[command] ?? null;
}

export interface ChatCommandDeps {
  db: Db;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
}

export interface ChatCommandActor {
  userId: string | null;
  label: string;
}

export type RunChatCommandOutcome =
  | { ok: true; userMessage: ChatMessage; message: ChatMessage; cards: ChatCard[] }
  | { ok: false; error: "not_instant" | "unknown_command" };

/**
 * Run an instant command. Both transcript rows are written, so the conversation
 * reads as a conversation and the next model turn can see what the founder
 * already looked at.
 */
export async function runChatCommand(
  deps: ChatCommandDeps,
  workspaceId: string,
  actor: ChatCommandActor,
  sessionId: string,
  command: ChatCommandName,
  argument: string,
): Promise<RunChatCommandOutcome> {
  const declared = chatCommand(command);
  if (!declared) return { ok: false, error: "unknown_command" };
  if (declared.kind !== "instant") return { ok: false, error: "not_instant" };

  const { db } = deps;
  const userMessage = appendMessage(db, workspaceId, sessionId, {
    role: "user",
    content: argument ? `/${command} ${argument}` : `/${command}`,
  });

  const ctx: ToolContext = {
    db,
    evidence: deps.evidence,
    safeFetch: deps.safeFetch,
    workspaceId,
    actor: { userId: actor.userId, label: actor.label },
    budget: DEFAULT_TOOL_BUDGET,
    // No agentRunId: nothing about this is a model run, and minting one would
    // put an empty trace in the Inspector for something that never inferred
    // anything. Without it the propose tools refuse by construction — which is
    // correct: an instant command reads, it never writes.
  };

  const cards: ChatCard[] = [];
  const citations = [];
  const lines: string[] = [];

  for (const step of INSTANT_PLANS[command] ?? []) {
    const tool = getTool(step.tool);
    if (!tool) continue;
    const parsed = tool.input.safeParse(step.args);
    if (!parsed.success) continue;
    let result: unknown;
    try {
      result = await tool.run(ctx, parsed.data as never);
    } catch (error) {
      // A read that fails is reported, not swallowed: a `/status` that quietly
      // omitted the approval queue would read as an empty queue.
      lines.push(
        `Couldn't read ${step.tool.replace(/_/g, " ")}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    cards.push(...cardsForToolCall(step.tool, parsed.data, result));
    citations.push(...citationsForToolCall(step.tool, parsed.data, result));
    const note = noteOf(result);
    if (note) lines.push(note);
  }

  const deduped = dedupeCards(cards);
  const message = appendMessage(db, workspaceId, sessionId, {
    role: "assistant",
    content: summarize(command, deduped, lines),
    citations: dedupeCitations(citations),
    cards: deduped,
    stopReason: "complete",
  });

  return { ok: true, userMessage, message, cards: deduped };
}

function noteOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const note = (result as { note?: unknown }).note;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

/**
 * The one line above the cards. Deliberately a count and not a summary: the
 * cards ARE the answer, and prose over them would be the wall of text this
 * sprint exists to remove.
 */
function summarize(command: ChatCommandName, cards: ChatCard[], notes: string[]): string {
  if (cards.length === 0) {
    return notes.length > 0 ? notes.join(" ") : "Nothing to show for that right now.";
  }
  const drafts = cards.filter((c) => c.kind === "draft").length;
  if (command === "approve") {
    return drafts === 1
      ? "1 draft is waiting for your review."
      : `${drafts} drafts are waiting for your review.`;
  }
  const campaigns = cards.filter((c) => c.kind === "campaign").length;
  const parts: string[] = [];
  if (campaigns > 0) parts.push(`${campaigns} active campaign${campaigns === 1 ? "" : "s"}`);
  if (drafts > 0) parts.push(`${drafts} draft${drafts === 1 ? "" : "s"} waiting for review`);
  return parts.length > 0 ? `Where things stand: ${parts.join(", ")}.` : "Where things stand:";
}
