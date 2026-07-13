import type {
  ExecutionResult,
  ExecutionResultKind,
  WorkflowStatus,
} from "@tuezday/contracts";

export const EXECUTION_KIND_LABELS: Record<ExecutionResultKind, string> = {
  publication: "Post",
  launch: "Targeted send",
  ad_launch: "Ad launch",
};

/** In-flight canonical state per kind; terminal result states map 1:1. */
const RUNNING_STATUS: Record<ExecutionResultKind, WorkflowStatus> = {
  publication: "publishing",
  launch: "sending",
  ad_launch: "launching",
};

export function executionWorkflowStatus(result: ExecutionResult): WorkflowStatus {
  return result.status === "running" ? RUNNING_STATUS[result.kind] : result.status;
}

/** "3 sent · 2 failed · 1 skipped" — successes and failures listed separately. */
export function destinationSummary(result: ExecutionResult): string {
  const { succeeded, failed, skipped, pending } = result.destinations;
  const parts: string[] = [];
  if (succeeded > 0) parts.push(`${succeeded} sent`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(" · ");
}

/** The surface that owns this result's detail and recovery actions. */
export function executionTargetHref(workspaceId: string, result: ExecutionResult): string {
  switch (result.kind) {
    case "publication":
      return `/workspaces/${workspaceId}/content`;
    case "launch":
      return `/workspaces/${workspaceId}/launches?launch=${result.id}`;
    case "ad_launch":
      return `/workspaces/${workspaceId}/ad-launches`;
  }
}
