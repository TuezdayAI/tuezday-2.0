import type { ChatCitation, ChatMessage, ChatTurnResult } from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { appendMessage, listMessages } from "./chat";
import { COPILOT_TOOLS, getCopilotTool, type CopilotToolContext } from "./copilot-tools";

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
}

export interface CopilotActor {
  userId: string | null;
  label: string;
}

const MAX_ITERS = 6;
const HISTORY_WINDOW = 20;
const MSG_EXCERPT_CHARS = 1_200;

const SYSTEM_PREAMBLE = [
  "You are Tuezday's GTM copilot: a grounded, READ-ONLY assistant for one workspace.",
  "Answer strictly from the workspace's brain, evidence corpus, and live data — never invent numbers or facts.",
  "You have read-only tools; you cannot change anything. If asked to perform an action (draft, send, launch, edit),",
  "explain that executing actions arrives in a later release and answer only what you can read today.",
  "Always ground claims in the tool results and cite your sources.",
].join(" ");

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

function buildPrompt(history: ChatMessage[], observations: Observation[]): string {
  const lines: string[] = [SYSTEM_PREAMBLE, "", "TOOLS (all read-only):"];
  for (const t of COPILOT_TOOLS) lines.push(`- ${t.name}: ${t.description}`);

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
  _actor: CopilotActor,
  sessionId: string,
  userMessage: string,
): Promise<ChatTurnResult> {
  appendMessage(db, workspaceId, sessionId, { role: "user", content: userMessage });

  const history = listMessages(db, sessionId);
  const toolCtx: CopilotToolContext = { db, evidence: deps.evidence, workspaceId };
  const observations: Observation[] = [];
  const citations: ChatCitation[] = [];
  const toolCalls: { tool: string; ok: boolean }[] = [];
  let answer = "";

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const prompt = buildPrompt(history, observations);

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
    const tool = toolName ? getCopilotTool(toolName) : undefined;

    // A parsed object naming a whitelisted tool → run it. Anything else
    // (prose, unparseable text, or an unknown tool name) → final answer.
    if (parsed && toolName && tool) {
      const rawArgs =
        parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      const valid = tool.argsSchema.safeParse(rawArgs);
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
        const out = await tool.run(toolCtx, valid.data as Record<string, unknown>);
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

  return { answer, citations: finalCitations, toolCalls };
}
