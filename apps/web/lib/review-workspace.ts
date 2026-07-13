import type {
  ApprovalState,
  Channel,
  Draft,
  InboxItemStatus,
  WorkflowStatus,
} from "@tuezday/contracts";

export const REVIEW_TABS = ["approvals", "inbox"] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

export function reviewTab(value: string | null): ReviewTab {
  return REVIEW_TABS.includes(value as ReviewTab) ? (value as ReviewTab) : "approvals";
}

export function reviewHref(
  workspaceId: string,
  opts?: { tab?: ReviewTab; campaign?: string },
): string {
  const params = new URLSearchParams();
  if (opts?.tab) params.set("tab", opts.tab);
  if (opts?.campaign) params.set("campaign", opts.campaign);
  const query = params.toString();
  return `/workspaces/${workspaceId}/review${query ? `?${query}` : ""}`;
}

const DRAFT_WORKFLOW_STATUS: Record<ApprovalState, WorkflowStatus> = {
  draft: "draft",
  pending_review: "review_required",
  edited: "changes_requested",
  approved: "approved",
  rejected: "rejected",
};

export function draftWorkflowStatus(state: ApprovalState): WorkflowStatus {
  return DRAFT_WORKFLOW_STATUS[state];
}

// Unread and read items both await a human decision; the status filter keeps
// them distinguishable while the badge speaks the canonical vocabulary.
const INBOX_WORKFLOW_STATUS: Record<InboxItemStatus, WorkflowStatus> = {
  unread: "review_required",
  read: "review_required",
  replied: "completed",
  dismissed: "archived",
};

export function inboxWorkflowStatus(status: InboxItemStatus): WorkflowStatus {
  return INBOX_WORKFLOW_STATUS[status];
}

export interface DraftFilters {
  state: ApprovalState | "all";
  campaignId: string | "all";
  channel: Channel | "all";
}

export function filterDrafts(drafts: Draft[], filters: DraftFilters): Draft[] {
  return drafts.filter(
    (d) =>
      (filters.state === "all" || d.state === filters.state) &&
      (filters.campaignId === "all" || d.campaignId === filters.campaignId) &&
      (filters.channel === "all" || d.channel === filters.channel),
  );
}

export function draftChannels(drafts: Draft[]): Channel[] {
  const seen: Channel[] = [];
  for (const d of drafts) if (!seen.includes(d.channel)) seen.push(d.channel);
  return seen;
}

export function queueNeighbors(
  orderedIds: string[],
  currentId: string,
): { prev: string | null; next: string | null } {
  const index = orderedIds.indexOf(currentId);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: orderedIds[index - 1] ?? null,
    next: orderedIds[index + 1] ?? null,
  };
}
