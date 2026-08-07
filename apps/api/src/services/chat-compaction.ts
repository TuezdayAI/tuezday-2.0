import { estimateTokens } from "@tuezday/brain";
import {
  CHAT_COMPACTION_KEEP_RECENT,
  CHAT_COMPACTION_THRESHOLD,
  CHAT_TURN_BOUNDS,
  type ChatMessage,
  type ChatSession,
} from "@tuezday/contracts";
import { AgentRunner } from "../agents/runner";
import type { Db } from "../db";
import type { LlmGateway } from "../llm/gateway";
import { appendMessage, setCompactedThrough, type ThreadUsage } from "./chat";

// ---------------------------------------------------------------------------
// Transcript compaction (Sprint 76, D-76.11).
//
// The PRD: "summarize older turns, keep pinned entities verbatim, record the
// compaction as a step in the trace so nothing silently disappears." Two
// artifacts make that true here — a `compaction`-role message, visible in the
// transcript, and its own agent_run, inspectable and metered like any other.
// Nothing is deleted: the folded messages stay in the table, they simply stop
// being replayed to the model.
// ---------------------------------------------------------------------------

const COMPACTION_TOKEN_LIMIT = Math.floor(
  CHAT_TURN_BOUNDS.maxTokens * CHAT_COMPACTION_THRESHOLD,
);

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "A dense summary of the conversation so far: what the user wants, what has been established, what was decided, and what is still open.",
    },
    pinnedEntities: {
      type: "array",
      items: { type: "string" },
      description:
        "Names and ids that must survive verbatim — campaigns, personas, channels, dates, product names, metrics quoted.",
    },
    openQuestions: {
      type: "array",
      items: { type: "string" },
      description: "Questions asked of the user that have not yet been answered.",
    },
  },
  required: ["summary", "pinnedEntities", "openQuestions"],
} as const;

const SYSTEM = [
  "You compact a working GTM conversation so it can continue within a token budget.",
  "Preserve decisions, constraints, stated preferences, numbers already quoted, and every question still awaiting an answer.",
  "Preserve names and ids exactly — a campaign or persona whose id you paraphrase becomes unreachable.",
  "Drop pleasantries, restatements, and reasoning the conversation already superseded.",
  "You are summarizing, not advising: add nothing that was not said.",
].join(" ");

export interface CompactionResult {
  message: ChatMessage;
  summarizedThrough: string;
  agentRunId: string | null;
  usage: ThreadUsage;
}

/** Rough size of what would be replayed to the model. */
export function estimateTranscriptTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, m) => total + estimateTokens(m.content), 0);
}

export function shouldCompact(messages: ChatMessage[]): boolean {
  // Nothing to fold if everything would be kept verbatim anyway.
  if (messages.length <= CHAT_COMPACTION_KEEP_RECENT + 1) return false;
  return estimateTranscriptTokens(messages) > COMPACTION_TOKEN_LIMIT;
}

function renderTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const who =
        m.role === "user"
          ? "USER"
          : m.role === "assistant"
            ? "ASSISTANT"
            : m.role === "compaction"
              ? "EARLIER SUMMARY"
              : `TOOL(${m.toolName ?? "?"})`;
      return `${who}: ${m.content}`;
    })
    .join("\n\n");
}

function renderSummary(parsed: {
  summary: string;
  pinnedEntities: string[];
  openQuestions: string[];
}): string {
  const lines = ["[Earlier in this conversation]", "", parsed.summary.trim()];
  if (parsed.pinnedEntities.length > 0) {
    lines.push("", "Pinned: " + parsed.pinnedEntities.map((e) => e.trim()).filter(Boolean).join(" · "));
  }
  if (parsed.openQuestions.length > 0) {
    lines.push("", "Still open:", ...parsed.openQuestions.map((q) => `- ${q.trim()}`));
  }
  return lines.join("\n");
}

/**
 * Fold everything but the newest `CHAT_COMPACTION_KEEP_RECENT` messages into a
 * summary, when the transcript has outgrown the per-turn budget. Returns null
 * when no compaction was needed.
 *
 * Never throws. A gateway failure degrades to a truncation marker that states
 * plainly that the earlier turns were dropped without being summarized — losing
 * fidelity is survivable, losing the turn is not, and a silent drop is the one
 * outcome the PRD rules out.
 */
export async function maybeCompact(
  db: Db,
  llm: LlmGateway,
  session: ChatSession,
  messages: ChatMessage[],
): Promise<CompactionResult | null> {
  if (!shouldCompact(messages)) return null;

  const foldable = messages.slice(0, messages.length - CHAT_COMPACTION_KEEP_RECENT);
  const last = foldable.at(-1);
  if (!last) return null;

  const runner = new AgentRunner(db, llm);
  let content: string;
  let agentRunId: string | null = null;
  const usage: ThreadUsage = { inputTokens: 0, outputTokens: 0, costCents: 0 };

  try {
    const run = await runner.run({
      workspaceId: session.workspaceId,
      task: "chat:compaction",
      createdBy: session.userId ? `user:${session.userId}` : "system",
      system: SYSTEM,
      messages: [{ role: "user", content: renderTranscript(foldable) }],
      responseSchema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      // No tools: compaction reads the transcript it was handed and nothing
      // else. One model call is the whole job.
      maxSteps: 1,
      maxTokens: CHAT_TURN_BOUNDS.maxTokens,
      timeoutMs: 60_000,
      tier: "cheap",
    });
    agentRunId = run.runId;
    usage.inputTokens = run.usage.inputTokens;
    usage.outputTokens = run.usage.outputTokens;
    usage.costCents = run.usage.costCents;

    const output = run.output as
      | { summary?: unknown; pinnedEntities?: unknown; openQuestions?: unknown }
      | null;
    const summary = typeof output?.summary === "string" ? output.summary : "";
    if (run.stopReason !== "complete" || !summary.trim()) {
      throw new Error(run.error ?? "compaction produced no summary");
    }
    content = renderSummary({
      summary,
      pinnedEntities: Array.isArray(output?.pinnedEntities)
        ? output.pinnedEntities.filter((e): e is string => typeof e === "string")
        : [],
      openQuestions: Array.isArray(output?.openQuestions)
        ? output.openQuestions.filter((q): q is string => typeof q === "string")
        : [],
    });
  } catch {
    content = [
      "[Earlier in this conversation]",
      "",
      `${foldable.length} earlier messages were dropped to stay within the context budget, and could not be summarized because the model was unavailable. They remain in the transcript above; the assistant can no longer see them. Re-state anything from them that still matters.`,
    ].join("\n");
  }

  const message = await appendMessage(db, session.workspaceId, session.id, {
    role: "compaction",
    content,
    agentRunId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costCents: usage.costCents,
  });
  await setCompactedThrough(db, session.id, last.id);

  return { message, summarizedThrough: last.id, agentRunId, usage };
}
