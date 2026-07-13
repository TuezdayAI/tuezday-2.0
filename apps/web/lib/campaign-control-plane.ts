import type {
  Campaign,
  CampaignLaneRevisionView,
  CampaignPlanDetail,
  CampaignStatus,
  LaneStatus,
  PlanRevisionStatus,
  WorkflowStatus,
} from "@tuezday/contracts";

export type CampaignMutationResult =
  | { ok: true }
  | { ok: false; message: string };

export async function campaignMutationResult(
  request: () => Promise<Response>,
  fallbackMessage: string,
): Promise<CampaignMutationResult> {
  try {
    const response = await request();
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, message: body?.message ?? fallbackMessage };
  } catch {
    return { ok: false, message: fallbackMessage };
  }
}

export function dateOnlyToTimestamp(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function timestampToDateOnly(timestamp: number | null): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function orderCampaignInventory(campaigns: Campaign[]): Campaign[] {
  return campaigns
    .map((campaign, index) => ({ campaign, index }))
    .sort((left, right) => {
      const statusRank = Number(right.campaign.status === "active") - Number(left.campaign.status === "active");
      return statusRank || left.index - right.index;
    })
    .map(({ campaign }) => campaign);
}

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
