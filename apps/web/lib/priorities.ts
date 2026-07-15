import type { PriorityItem, PriorityItemKind, PriorityQueue } from "@tuezday/contracts";
import type { IconName } from "@/src/components/ui/icon";

const PRIORITY_META: Record<
  PriorityItemKind,
  { label: string; icon: IconName; cta: string }
> = {
  execution_failure: {
    label: "Execution failed",
    icon: "status-rejected",
    cta: "Resolve failure",
  },
  stale_action: {
    label: "Action is stale",
    icon: "warning",
    cta: "Review stale action",
  },
  policy_block: {
    label: "Action blocked",
    icon: "warning",
    cta: "Resolve blocker",
  },
  authorization: {
    label: "Authorization required",
    icon: "status-review",
    cta: "Open authorization",
  },
  content_review: {
    label: "Content review",
    icon: "review",
    cta: "Review content",
  },
  signal_triage: {
    label: "Signal needs review",
    icon: "signal",
    cta: "Review signal",
  },
};

/** Presentation metadata for one server-ranked priority. The API remains the
 * authority for ordering, status, explanation, campaign context, and recovery. */
export function priorityView(item: PriorityItem) {
  return {
    ...PRIORITY_META[item.kind],
    status: item.status,
    href: item.href,
  };
}

export function priorityQueueState(queue: PriorityQueue): "attention" | "all_clear" {
  return queue.items.length > 0 ? "attention" : "all_clear";
}
