import { randomUUID } from "node:crypto";
import type {
  ChatCitation,
  ChatMessage,
  ChatProposal,
  ChatTurnResult,
  ConfirmChatProposalInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { appendMessage, getPendingProposal, listMessages } from "./chat";
import { COPILOT_TOOLS, getCopilotTool, type CopilotToolContext } from "./copilot-tools";
import {
  COPILOT_ACTION_TOOLS,
  getCopilotActionTool,
  type CopilotActionContext,
} from "./copilot-actions";
import type { ExternalActionRuntime } from "./external-action-coordinator";

// ---------------------------------------------------------------------------
// Grounded, read-only chat copilot (Sprint 42, Part 1).
//
// A prompt-engineered tool-loop over the existing `generate` (no gateway
// change): the model emits either a final prose answer or a single-line
// {"tool","args"} JSON; the service runs the whitelisted read tool, feeds the
// summary back, and re-generates — bounded by MAX_ITERS, degrading to a
// best-effort answer on gateway/parse failure. Mirrors the discovery
// `scoreUnscoredItems` try/catch discipline. Nothing here mutates state.
// ---------------------------------------------------------------------------

export interface CopilotDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  /**
   * The external-action coordinator. When present, the copilot may PROPOSE
   * gated write actions (Sprint 42 P2); when absent, it stays read-only. The
   * runtime is the only path to external actions and always parks proposals at
   * authorization_required (`proposeForReview`) — the copilot never dispatches.
   */
  runtime?: ExternalActionRuntime;
}

export interface CopilotActor {
  userId: string | null;
  label: string;
  /** Whether a person is behind this turn — stated, never inferred (Sprint 52). */
  human: boolean;
}

const MAX_ITERS = 6;
const HISTORY_WINDOW = 20;
const MSG_EXCERPT_CHARS = 1_200;

const READONLY_PREAMBLE = [
  "You are Tuezday's GTM copilot: a grounded assistant for one workspace.",
  "Answer strictly from the workspace's brain, evidence corpus, and live data — never invent numbers or facts.",
  "You have read-only tools; you cannot change anything. If asked to perform an action (draft, send, launch, edit),",
  "explain that executing actions arrives in a later release and answer only what you can read today.",
  "Always ground claims in the tool results and cite your sources.",
].join(" ");

const ACTIONS_PREAMBLE = [
  "You are Tuezday's GTM copilot: a grounded assistant for one workspace.",
  "Answer strictly from the workspace's brain, evidence corpus, and live data — never invent numbers or facts.",
  "You have READ tools and WRITE tools. Read tools answer questions. Write tools PROPOSE a change —",
  "they never execute: a proposal always waits for the human to confirm, and even then it only creates a",
  "draft in review or an action awaiting authorization. Call a write tool only when the user clearly asks you to",
  "draft, reply, or propose an action. Otherwise answer with read tools. Always ground claims and cite sources.",
].join(" ");

/** Plain-text affirmatives that confirm a pending proposal. */
const AFFIRMATIVES = new Set([
  "yes",
  "y",
  "yes.",
  "confirm",
  "confirmed",
  "do it",
  "go ahead",
  "send it",
  "ok",
  "okay",
  "sure",
  "yep",
  "yeah",
]);

function isAffirmative(message: string): boolean {
  return AFFIRMATIVES.has(message.trim().toLowerCase().replace(/[!.]+$/, ""));
}

const RESPONSE_INSTRUCTION = [
  "Respond with EITHER:",
  '(a) a single line of JSON to call a tool: {"tool":"<tool_name>","args":{...}} — and nothing else on that line; OR',
  "(b) your final answer in plain prose, grounded in the tool results above.",
  "Call a tool only when you still need data you do not already have. When you have enough, give the final answer.",
].join("\n");

/** Pull the first JSON object out of a model response; tolerate fences/noise. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface Observation {
  tool: string;
  args: unknown;
  summary: string;
}

function buildPrompt(
  history: ChatMessage[],
  observations: Observation[],
  actionsEnabled: boolean,
): string {
  const lines: string[] = [actionsEnabled ? ACTIONS_PREAMBLE : READONLY_PREAMBLE, "", "READ TOOLS:"];
  for (const t of COPILOT_TOOLS) lines.push(`- ${t.name}: ${t.description}`);
  if (actionsEnabled) {
    lines.push("", "WRITE TOOLS (each only PROPOSES — the user must confirm; nothing is sent):");
    for (const t of COPILOT_ACTION_TOOLS) lines.push(`- ${t.name}: ${t.description}`);
  }

  lines.push("", "CONVERSATION SO FAR:");
  for (const m of history.slice(-HISTORY_WINDOW)) {
    const who =
      m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : `TOOL(${m.toolName ?? "?"})`;
    lines.push(`${who}: ${m.content.slice(0, MSG_EXCERPT_CHARS)}`);
  }

  if (observations.length > 0) {
    lines.push("", "TOOL RESULTS THIS TURN:");
    for (const o of observations) {
      lines.push(`${o.tool}(${JSON.stringify(o.args)}) => ${o.summary}`);
    }
  }

  lines.push("", RESPONSE_INSTRUCTION);
  return lines.join("\n");
}

/** Compose a best-effort answer from whatever the tools already returned. */
function degradedAnswer(observations: Observation[]): string {
  if (observations.length === 0) {
    return "I couldn't reach the assistant service just now. Please try again in a moment.";
  }
  const found = observations
    .filter((o) => o.summary.trim())
    .map((o) => `From ${o.tool}: ${o.summary}`)
    .join("\n\n");
  return `I couldn't compose a full answer, but here's what I found:\n\n${found}`;
}

function dedupeCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const c of citations) {
    const key = `${c.kind}:${c.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Run one copilot turn: persist the user message, run the bounded tool-loop,
 * persist the assistant (and any tool) messages, and return the grounded
 * answer + its provenance. Never throws on gateway/parse failure — it degrades.
 */
export async function runCopilotTurn(
  db: Db,
  deps: CopilotDeps,
  workspaceId: string,
  actor: CopilotActor,
  sessionId: string,
  userMessage: string,
): Promise<ChatTurnResult> {
  // A plain "yes" to a pending proposal confirms it — no LLM round-trip. This
  // must be checked BEFORE the user message is appended (which would retire the
  // proposal from the "latest message" pending window).
  const pending = getPendingProposal(db, sessionId);
  if (pending && isAffirmative(userMessage)) {
    appendMessage(db, workspaceId, sessionId, { role: "user", content: userMessage });
    return commitCopilotProposal(db, deps, workspaceId, actor, sessionId, {
      confirmToken: pending.proposal.confirmToken,
      decision: "confirm",
    });
  }

  appendMessage(db, workspaceId, sessionId, { role: "user", content: userMessage });

  const actionsEnabled = !!deps.runtime;
  const history = listMessages(db, sessionId);
  const toolCtx: CopilotToolContext = { db, evidence: deps.evidence, workspaceId };
  const observations: Observation[] = [];
  const citations: ChatCitation[] = [];
  const toolCalls: { tool: string; ok: boolean }[] = [];
  let answer = "";

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const prompt = buildPrompt(history, observations, actionsEnabled);

    let text: string;
    try {
      const result = await deps.llm.generate({ prompt, maxOutputTokens: 1_024 });
      text = result.text;
    } catch (err) {
      // Gateway failure (missing key / provider error): degrade, never throw.
      if (err instanceof GatewayError) {
        answer = degradedAnswer(observations);
        break;
      }
      throw err;
    }

    const parsed = parseJsonObject(text);
    const toolName = parsed && typeof parsed.tool === "string" ? parsed.tool : null;
    const readTool = toolName ? getCopilotTool(toolName) : undefined;
    const actionTool = toolName && actionsEnabled ? getCopilotActionTool(toolName) : undefined;

    const rawArgs =
      parsed && parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {};

    // --- Write tool: PROPOSE only, then end the turn awaiting confirmation. ---
    if (parsed && toolName && actionTool) {
      const valid = actionTool.argsSchema.safeParse(rawArgs);
      if (!valid.success) {
        const issue = valid.error.issues.map((i) => i.message).join("; ");
        toolCalls.push({ tool: toolName, ok: false });
        observations.push({
          tool: toolName,
          args: rawArgs,
          summary: `Invalid arguments (${issue}). Ask the user for what's missing, or answer.`,
        });
        continue;
      }

      const actionCtx: CopilotActionContext = {
        db,
        llm: deps.llm,
        evidence: deps.evidence,
        runtime: deps.runtime!,
        workspaceId,
      };
      let proposed;
      try {
        proposed = await actionTool.propose(actionCtx, valid.data as Record<string, unknown>);
        toolCalls.push({ tool: toolName, ok: true });
      } catch (err) {
        toolCalls.push({ tool: toolName, ok: false });
        observations.push({
          tool: toolName,
          args: valid.data,
          summary: `Could not prepare that action: ${err instanceof Error ? err.message : String(err)}.`,
        });
        continue;
      }

      const proposal: ChatProposal = {
        toolKind: toolName as ChatProposal["toolKind"],
        summary: proposed.summary,
        preview: proposed.preview,
        confirmToken: randomUUID(),
        ...(proposed.policyNote ? { policyNote: proposed.policyNote } : {}),
      };
      const noteLine = proposed.policyNote ? `\n\n⚠︎ ${proposed.policyNote}` : "";
      const content = `${proposed.summary}. Review the proposal below, then Confirm to create it (nothing is sent) — or Discard.${noteLine}`;
      const finalCitations = dedupeCitations(citations);
      appendMessage(db, workspaceId, sessionId, {
        role: "assistant",
        content,
        citations: finalCitations,
        proposal,
        proposalArgs: proposed.commitPayload,
      });
      return {
        answer: content,
        citations: finalCitations,
        toolCalls,
        status: "awaiting_confirmation",
        proposal,
      };
    }

    // --- Read tool: run it and feed the observation back into the loop. ---
    if (parsed && toolName && readTool) {
      const valid = readTool.argsSchema.safeParse(rawArgs);
      if (!valid.success) {
        const issue = valid.error.issues.map((i) => i.message).join("; ");
        toolCalls.push({ tool: toolName, ok: false });
        observations.push({
          tool: toolName,
          args: rawArgs,
          summary: `Invalid arguments (${issue}). Answer from what you already have.`,
        });
        continue;
      }

      let summary: string;
      let toolCitations: ChatCitation[] | undefined;
      try {
        const out = await readTool.run(toolCtx, valid.data as Record<string, unknown>);
        summary = out.summary;
        toolCitations = out.citations;
        toolCalls.push({ tool: toolName, ok: true });
      } catch (err) {
        toolCalls.push({ tool: toolName, ok: false });
        observations.push({
          tool: toolName,
          args: valid.data,
          summary: `Tool failed: ${err instanceof Error ? err.message : String(err)}.`,
        });
        continue;
      }

      if (toolCitations && toolCitations.length > 0) citations.push(...toolCitations);
      observations.push({ tool: toolName, args: valid.data, summary });
      const toolMsg = appendMessage(db, workspaceId, sessionId, {
        role: "tool",
        content: summary,
        toolName,
        citations: toolCitations ?? [],
      });
      history.push(toolMsg);
      continue;
    }

    // Final answer. Support a {"answer": "..."} envelope, else raw text.
    answer =
      parsed && typeof parsed.answer === "string" ? parsed.answer.trim() : text.trim();
    break;
  }

  // Hit the iteration cap without ever settling on a final answer.
  if (!answer) answer = degradedAnswer(observations);

  const finalCitations = dedupeCitations(citations);
  appendMessage(db, workspaceId, sessionId, {
    role: "assistant",
    content: answer,
    citations: finalCitations,
  });

  return { answer, citations: finalCitations, toolCalls, status: "answered" };
}

/**
 * Confirm or discard the session's pending proposal (Sprint 42 P2). On confirm
 * with a matching token, runs the write tool's commit half — the single gated
 * enqueue (a `pending_review` draft, or an action at `authorization_required`)
 * — and records what it produced. A missing/mismatched token or a discard
 * writes nothing. Never throws — a commit failure degrades to an answer.
 */
export async function commitCopilotProposal(
  db: Db,
  deps: CopilotDeps,
  workspaceId: string,
  actor: CopilotActor,
  sessionId: string,
  input: ConfirmChatProposalInput,
): Promise<ChatTurnResult> {
  const pending = getPendingProposal(db, sessionId);

  // Nothing to confirm, or the token doesn't match the current proposal.
  if (!pending || pending.proposal.confirmToken !== input.confirmToken) {
    const answer =
      "That proposal is no longer available to confirm. Ask me again and I'll prepare a fresh one.";
    appendMessage(db, workspaceId, sessionId, { role: "assistant", content: answer });
    return { answer, citations: [], toolCalls: [], status: "answered" };
  }

  if (input.decision === "discard") {
    const answer = "Okay — I've discarded that proposal. Nothing was created.";
    appendMessage(db, workspaceId, sessionId, { role: "assistant", content: answer });
    return { answer, citations: [], toolCalls: [], status: "answered" };
  }

  const tool = getCopilotActionTool(pending.proposal.toolKind);
  if (!tool || !deps.runtime) {
    const answer = "I can't complete that action right now. Please try again.";
    appendMessage(db, workspaceId, sessionId, { role: "assistant", content: answer });
    return { answer, citations: [], toolCalls: [{ tool: pending.proposal.toolKind, ok: false }], status: "answered" };
  }

  const actionCtx: CopilotActionContext = {
    db,
    llm: deps.llm,
    evidence: deps.evidence,
    runtime: deps.runtime,
    workspaceId,
  };
  try {
    const result = await tool.commit(actionCtx, pending.args, {
      userId: actor.userId,
      label: actor.label,
      human: actor.human,
    });
    appendMessage(db, workspaceId, sessionId, {
      role: "assistant",
      content: result.summary,
      producedRef: result.producedRef,
    });
    return {
      answer: result.summary,
      citations: [],
      toolCalls: [{ tool: pending.proposal.toolKind, ok: true }],
      status: "committed",
      producedRef: result.producedRef,
    };
  } catch (err) {
    const answer = `I couldn't complete that action: ${err instanceof Error ? err.message : String(err)}.`;
    appendMessage(db, workspaceId, sessionId, { role: "assistant", content: answer });
    return {
      answer,
      citations: [],
      toolCalls: [{ tool: pending.proposal.toolKind, ok: false }],
      status: "answered",
    };
  }
}
