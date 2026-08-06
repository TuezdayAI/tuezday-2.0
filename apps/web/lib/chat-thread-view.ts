import {
  CHAT_THREAD_TOKEN_CAP,
  type AgentStopReason,
  type ChatCitation,
  type ChatMessage,
  type ChatSession,
} from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Pure view helpers for the chat drawer (Sprint 76). Kept out of the component
// so the copy and the arithmetic are testable without rendering React.
// ---------------------------------------------------------------------------

/** Cost display. Sub-cent turns are the common case and must not read as free. */
export function formatCost(cents: number): string {
  if (cents <= 0) return "$0.00";
  if (cents < 1) return `<$0.01`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

/** Warn while there is still room to act on the warning, not once it is spent. */
const CAP_WARNING_AT = 0.8;

export interface ThreadBudgetView {
  tokens: number;
  cap: number;
  fraction: number;
  exhausted: boolean;
  warning: string | null;
}

export function threadBudgetView(session: ChatSession): ThreadBudgetView {
  const tokens = session.totalInputTokens + session.totalOutputTokens;
  const fraction = tokens / CHAT_THREAD_TOKEN_CAP;
  const exhausted = tokens >= CHAT_THREAD_TOKEN_CAP;
  return {
    tokens,
    cap: CHAT_THREAD_TOKEN_CAP,
    fraction,
    exhausted,
    warning: exhausted
      ? "This conversation has reached its limit. Start a new one to keep going — set its goal and scope from here."
      : fraction >= CAP_WARNING_AT
        ? `This conversation is near its limit (${formatTokens(tokens)} of ${formatTokens(CHAT_THREAD_TOKEN_CAP)} tokens). Wrap up or start a new one soon.`
        : null,
  };
}

/** What a non-complete turn tells the founder, under the answer. */
export function stopReasonNote(stopReason: AgentStopReason | null): string | null {
  switch (stopReason) {
    case null:
    case "complete":
      return null;
    case "max_steps":
      return "Stopped at this turn's step limit.";
    case "max_tokens":
      return "Stopped at this turn's token limit.";
    case "timeout":
      return "Stopped — this turn took too long.";
    case "needs_human":
      return "Stopped: it needs an answer from you to continue.";
    case "error":
      return "Stopped on an error.";
    default:
      return null;
  }
}

/**
 * Where a citation chip navigates. Refs are `<kind>:<id>`; `brain` refs are
 * `<docType>#<sectionId>`; a fetched page's ref is its URL.
 *
 * An unrecognized ref returns null and the chip renders unlinked — better a
 * chip that does not navigate than one that navigates somewhere wrong.
 */
export function citationHref(citation: ChatCitation, workspaceId: string): string | null {
  const base = `/workspaces/${workspaceId}`;
  if (citation.kind === "brain") {
    const [docType] = citation.ref.split("#");
    return docType ? `${base}/brain?doc=${encodeURIComponent(docType)}` : null;
  }
  if (citation.kind === "evidence") {
    return `${base}/evidence?document=${encodeURIComponent(citation.ref)}`;
  }
  if (/^https?:\/\//.test(citation.ref)) return citation.ref;

  const separator = citation.ref.indexOf(":");
  if (separator < 0) return null;
  const kind = citation.ref.slice(0, separator);
  const id = citation.ref.slice(separator + 1);
  if (!id) return null;

  switch (kind) {
    case "campaign":
      return `${base}/campaigns/${encodeURIComponent(id)}`;
    case "persona":
      return `${base}/personas`;
    case "publication":
      return `${base}/content?publication=${encodeURIComponent(id)}`;
    case "draft":
      return `${base}/review?draft=${encodeURIComponent(id)}`;
    case "discovery_item":
      return `${base}/discovery?item=${encodeURIComponent(id)}`;
    case "outreach_sequence":
      return `${base}/outreach/${encodeURIComponent(id)}`;
    case "guidance":
      return `${base}/guidance`;
    case "workspace":
      return `${base}/insights`;
    case "metrics":
    case "channel":
      return `${base}/insights`;
    default:
      return null;
  }
}

export function agentRunHref(workspaceId: string, agentRunId: string): string {
  return `/workspaces/${workspaceId}/inspector?run=${encodeURIComponent(agentRunId)}`;
}

/** Scope chips for the thread header. Unbound scope shows nothing, not "none". */
export function scopeChips(
  session: ChatSession,
  names: { campaignName?: string | null; personaName?: string | null },
): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (session.campaignId) {
    chips.push({ key: "campaign", label: names.campaignName ?? "Campaign" });
  }
  if (session.personaId) {
    chips.push({ key: "persona", label: names.personaName ?? "Persona" });
  }
  if (session.channel) chips.push({ key: "channel", label: session.channel });
  return chips;
}

/** Tool messages are transcript, not conversation — they never render as bubbles. */
export function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== "tool");
}

export function threadTitle(session: ChatSession): string {
  return session.title.trim() || "New conversation";
}
