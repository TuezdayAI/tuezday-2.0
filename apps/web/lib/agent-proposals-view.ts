import type { AgentProposal } from "@tuezday/contracts";

/**
 * How a proposal reads on the inspector (Sprint 69).
 *
 * The ledger keeps the summary the service wrote and the rationale the model
 * gave, and both matter: the summary says what would happen, the rationale says
 * why the agent thought it should. Showing only the first turns the trace into
 * a log; showing only the second makes it unauditable.
 */
export function proposalLine(proposal: AgentProposal): string {
  return `${proposal.summary} — “${proposal.rationale}”`;
}

/**
 * A proposal whose target has been deleted still belongs in the trace, but it
 * can no longer be opened, so it is shown muted rather than as a live link.
 */
export function proposalResolved(proposal: AgentProposal): boolean {
  return Boolean(proposal.draftId ?? proposal.externalActionId);
}

export function proposalTone(proposal: AgentProposal): "neutral" | "draft" {
  return proposalResolved(proposal) ? "neutral" : "draft";
}

/** Where the founder goes to act on it. Null once the target is gone. */
export function proposalHref(workspaceId: string, proposal: AgentProposal): string | null {
  if (proposal.draftId) return `/workspaces/${workspaceId}/review?draft=${proposal.draftId}`;
  if (proposal.externalActionId) {
    return `/workspaces/${workspaceId}/review?tab=authorizations&action=${proposal.externalActionId}`;
  }
  return null;
}

/** One line for a run summary: "proposed 2 things, 1 still open". */
export function proposalsSummary(proposals: AgentProposal[]): string {
  if (proposals.length === 0) return "Proposed nothing.";
  const open = proposals.filter(proposalResolved).length;
  const noun = proposals.length === 1 ? "proposal" : "proposals";
  return `${proposals.length} ${noun} · ${open} still available to act on`;
}
