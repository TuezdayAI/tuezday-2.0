import type { ChatMessage, ChatProposal } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Pure view helpers for the confirmation card (Sprint 78). Kept out of the
// component so the copy — which is the part that decides whether a founder
// understands what they are confirming — is testable without rendering React.
// ---------------------------------------------------------------------------

export type ProposalTone = "pending" | "quarantined" | "confirmed" | "declined" | "failed";

export function proposalTone(proposal: ChatProposal): ProposalTone {
  if (proposal.status === "pending") {
    return proposal.quarantined ? "quarantined" : "pending";
  }
  return proposal.status;
}

/** Whether the card still has buttons on it. */
export function isActionable(proposal: ChatProposal): boolean {
  return proposal.status === "pending";
}

/**
 * The line under a resolved card. Says what happened AND where it went — a
 * founder who confirms a publication under `human_required` has not published
 * anything, and a card that just said "Confirmed" would let them think they had.
 */
export function proposalOutcome(proposal: ChatProposal): string | null {
  switch (proposal.status) {
    case "pending":
      return null;
    case "declined":
      return "You declined this.";
    case "failed":
      return proposal.errorMessage
        ? `Couldn't go through: ${proposal.errorMessage}`
        : "Couldn't go through.";
    case "confirmed":
      return producedLabel(proposal);
    default:
      return null;
  }
}

function producedLabel(proposal: ChatProposal): string {
  const kind = proposal.producedRef?.split(":")[0];
  switch (proposal.producedStatus) {
    case "pending_review":
      return "Confirmed — it's in your approval queue.";
    case "authorization_required":
      return "Confirmed — it's waiting for your authorization.";
    case "succeeded":
    case "dispatched":
      return "Confirmed — it went out.";
    default:
      return kind === "draft"
        ? "Confirmed — the draft was created."
        : `Confirmed${proposal.producedStatus ? ` — ${proposal.producedStatus.replace(/_/g, " ")}` : ""}.`;
  }
}

/**
 * Where the card's "open it" link goes once something exists. Mirrors
 * `citationHref`'s rule: an unroutable ref returns null and the card shows no
 * link rather than one that lands somewhere wrong.
 */
export function producedHref(proposal: ChatProposal, workspaceId: string): string | null {
  if (!proposal.producedRef) return null;
  const separator = proposal.producedRef.indexOf(":");
  if (separator < 0) return null;
  const kind = proposal.producedRef.slice(0, separator);
  const id = proposal.producedRef.slice(separator + 1);
  if (!id) return null;
  const base = `/workspaces/${workspaceId}`;
  if (kind === "draft") return `${base}/review?draft=${encodeURIComponent(id)}`;
  if (kind === "external_action") {
    return `${base}/review?tab=authorizations&action=${encodeURIComponent(id)}`;
  }
  return null;
}

/**
 * The warning above a quarantined card's buttons. Never suppresses the
 * buttons: the founder is the authority here, and hiding the choice would
 * teach them to click through warnings elsewhere.
 */
export function quarantineWarning(proposal: ChatProposal): string | null {
  if (!proposal.quarantined) return null;
  const reason = proposal.quarantineReason?.trim();
  return reason
    ? `Check this one carefully. ${reason}`
    : "Check this one carefully — it draws on content from outside your workspace.";
}

/** Cards for one assistant message, oldest first. */
export function proposalsForMessage(
  proposals: ChatProposal[],
  message: Pick<ChatMessage, "id">,
): ChatProposal[] {
  return proposals.filter((p) => p.messageId === message.id);
}

/** Cards recorded this turn that have no message yet — the live case. */
export function unattachedProposals(proposals: ChatProposal[]): ChatProposal[] {
  return proposals.filter((p) => p.messageId === null);
}

/** The composer's nudge when something is waiting on the founder. */
export function pendingSummary(proposals: ChatProposal[]): string | null {
  const pending = proposals.filter((p) => p.status === "pending").length;
  if (pending === 0) return null;
  return pending === 1
    ? "1 thing is waiting for you to confirm."
    : `${pending} things are waiting for you to confirm.`;
}

/** Merge a proposal update into a list, replacing by id and keeping order. */
export function mergeProposal(
  proposals: ChatProposal[],
  updated: ChatProposal,
): ChatProposal[] {
  const index = proposals.findIndex((p) => p.id === updated.id);
  if (index < 0) return [...proposals, updated];
  const next = [...proposals];
  next[index] = updated;
  return next;
}
