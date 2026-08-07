import type { ChatCard, ChatCardAction, ChatCardKind, ChatPin, ChatPinKind } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Pure view helpers for the result cards and the pin chips (Sprint 77).
//
// Kept out of the component for the same reason Sprint 76 and 78 kept theirs
// out: the routing and the copy are what decide whether a card is useful, and
// both are testable without rendering React.
// ---------------------------------------------------------------------------

/**
 * Where a card navigates. Cards use the same `<kind>:<id>` refs citations use,
 * so this is `citationHref`'s rule applied to a slightly wider vocabulary — and
 * an unroutable ref returns null and the card renders without a link, never a
 * link that lands somewhere wrong.
 */
export function cardHref(card: ChatCard, workspaceId: string): string | null {
  const base = `/workspaces/${workspaceId}`;
  const separator = card.ref.indexOf(":");
  if (separator < 0) return null;
  const kind = card.ref.slice(0, separator);
  const id = card.ref.slice(separator + 1);
  if (!id) return null;

  switch (kind) {
    case "campaign":
      return `${base}/campaigns/${encodeURIComponent(id)}`;
    case "draft":
      return `${base}/review?draft=${encodeURIComponent(id)}`;
    case "publication":
      return `${base}/content?publication=${encodeURIComponent(id)}`;
    case "persona":
      return `${base}/personas`;
    case "discovery_item":
      return `${base}/discovery?item=${encodeURIComponent(id)}`;
    case "evidence":
      return `${base}/evidence?document=${encodeURIComponent(id)}`;
    case "outreach_sequence":
      return `${base}/outreach/${encodeURIComponent(id)}`;
    case "brain": {
      // `brain:<docType>#<sectionId>` — the page takes the doc, not the anchor.
      const [docType] = id.split("#");
      return docType ? `${base}/brain?doc=${encodeURIComponent(docType)}` : null;
    }
    case "workspace":
    case "metrics":
    case "campaign_metrics":
      return `${base}/insights`;
    default:
      return null;
  }
}

/** The record id inside a ref, for the routes a card action calls. */
export function cardRecordId(card: ChatCard): string | null {
  const separator = card.ref.indexOf(":");
  if (separator < 0) return null;
  return card.ref.slice(separator + 1) || null;
}

const KIND_LABELS: Record<ChatCardKind, string> = {
  campaign: "Campaign",
  draft: "Draft",
  publication: "Published",
  persona: "Persona",
  metric: "Metrics",
  evidence: "Evidence",
  signal: "Signal",
  brain: "Brain",
};

export function cardKindLabel(kind: ChatCardKind): string {
  return KIND_LABELS[kind];
}

/** Whether a card offers a given button. */
export function cardHasAction(card: ChatCard, action: ChatCardAction): boolean {
  return card.actions.includes(action);
}

/** True when a card can be acted on rather than only opened. */
export function cardIsInteractive(card: ChatCard): boolean {
  return card.actions.some((a) => a !== "open");
}

/**
 * The HTTP call one card action makes (D-77.3). This is the whole "no parallel
 * mutation path" claim in one function: the same method and path `/review`
 * uses, so the decision-log record is identical because the code that writes it
 * is identical.
 */
export function cardActionRequest(
  card: ChatCard,
  action: Exclude<ChatCardAction, "open">,
  workspaceId: string,
): { path: string; method: "POST" } | null {
  const id = cardRecordId(card);
  if (!id || card.kind !== "draft") return null;
  return { path: `/workspaces/${workspaceId}/drafts/${id}/${action}`, method: "POST" };
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const PIN_LABELS: Record<ChatPinKind, string> = {
  campaign: "Campaign",
  persona: "Persona",
  draft: "Draft",
  signal: "Signal",
  brain_section: "Brain",
  url: "Link",
};

export function pinKindLabel(kind: ChatPinKind): string {
  return PIN_LABELS[kind];
}

/**
 * The one-line explanation above the chips. States the consequence, because a
 * chip the founder does not understand is context they cannot debug — which is
 * the exact failure this feature exists to fix.
 */
export function pinsSummary(pins: ChatPin[]): string | null {
  if (pins.length === 0) return null;
  return pins.length === 1
    ? "1 thing is pinned to this conversation — every turn sees it."
    : `${pins.length} things are pinned to this conversation — every turn sees them.`;
}

/** Untrusted pin kinds, warned about in the UI exactly as they are in the prefix. */
export function pinIsUntrusted(pin: ChatPin): boolean {
  return pin.kind === "url" || pin.kind === "signal";
}

// ---------------------------------------------------------------------------
// The composer's `/` and `@` parsing
// ---------------------------------------------------------------------------

/**
 * The command-palette trigger: a `/word` being typed at the START of an
 * otherwise empty composer. Mid-message slashes ("and/or", a pasted URL) are
 * deliberately not commands.
 */
export function commandQuery(text: string): string | null {
  const match = /^\/([a-z_]*)$/i.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** The mention-picker trigger: the `@word` currently being typed. */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([\w-]*)$/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** Replace the in-progress `@mention` with nothing — the chip carries it now. */
export function clearMention(text: string): string {
  return text.replace(/(?:^|\s)@[\w-]*$/, (m) => (m.startsWith(" ") ? " " : ""));
}

/**
 * A URL pasted into the composer, which becomes a pin (D-77.6). Only http(s):
 * safe-fetch would refuse anything else, and offering a chip that cannot
 * resolve teaches the founder the feature is unreliable.
 */
export function pastedUrl(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"']+/i.exec(text.trim());
  if (!match) return null;
  try {
    return new URL(match[0]).toString();
  } catch {
    return null;
  }
}
