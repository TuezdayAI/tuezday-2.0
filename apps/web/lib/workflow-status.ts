import {
  WORKFLOW_STATUS_META,
  type WorkflowStatus,
  type WorkflowStatusFamily,
} from "@tuezday/contracts";
import type { IconName } from "@/src/components/ui/icon";

const FAMILY_ICON: Record<WorkflowStatusFamily, IconName> = {
  attention: "warning",
  progress: "status-generating",
  ready: "status-approved",
  blocked: "status-rejected",
  informational: "info",
};

export function workflowStatusView(status: WorkflowStatus) {
  const meta = WORKFLOW_STATUS_META[status];
  return { ...meta, icon: FAMILY_ICON[meta.family] };
}
