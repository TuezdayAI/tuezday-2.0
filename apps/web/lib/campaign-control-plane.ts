import type {
  CampaignLaneRevisionView,
  CampaignPlanDetail,
  CampaignStatus,
  LaneStatus,
  PlanRevisionStatus,
  WorkflowStatus,
} from "@tuezday/contracts";

export const CAMPAIGN_TABS = ["overview", "plan", "channels"] as const;
export type CampaignWorkspaceTab = (typeof CAMPAIGN_TABS)[number];

export function campaignTab(value: string | null): CampaignWorkspaceTab {
  return CAMPAIGN_TABS.includes(value as CampaignWorkspaceTab)
    ? (value as CampaignWorkspaceTab)
    : "overview";
}

export function campaignStatus(status: CampaignStatus): WorkflowStatus {
  return status;
}

export function planStatus(status: PlanRevisionStatus): WorkflowStatus {
  return status === "active" ? "active" : status;
}

export function laneStatus(status: LaneStatus): WorkflowStatus {
  return status === "retired" ? "archived" : status;
}

export function editablePlan(revisions: CampaignPlanDetail[]): CampaignPlanDetail | null {
  return revisions.find(({ plan }) => plan.status === "draft") ?? null;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatLaneSchedule(
  lane: Pick<
    CampaignLaneRevisionView,
    "deliveryMode" | "plannedQuantity" | "schedule" | "reactivePeriod" | "reactiveCap"
  >,
): string {
  if (lane.deliveryMode === "reactive") {
    return `Up to ${lane.reactiveCap ?? 0} reactive / ${lane.reactivePeriod ?? "period"}`;
  }
  const planned = `${lane.plannedQuantity} planned`;
  const schedule = lane.schedule
    ? `${lane.schedule.daysOfWeek.map((day) => DAY[day]).join(", ")} · ${lane.schedule.timeOfDay} · ${lane.schedule.timezone}`
    : "Schedule required";
  if (lane.deliveryMode === "planned") return `${planned} · ${schedule}`;
  return `${planned} · ${schedule} · up to ${lane.reactiveCap ?? 0} reactive / ${lane.reactivePeriod ?? "period"}`;
}
