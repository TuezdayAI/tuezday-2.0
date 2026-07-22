import {
  campaignPlanWorkspaceSchema,
  type Campaign,
  type CampaignLaneRevisionView,
  type CampaignPlanIssue,
  type CampaignPlanWorkspace,
  type Channel,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { getCampaign } from "./campaigns";
import { listCadenceRows } from "./cadences";
import { listCampaignAudiences } from "./audiences";
import { upsertLaneRevision } from "./campaign-lanes";
import {
  activatePlanRevision,
  createPlanRevision,
  getCurrentCampaignPlan,
  listCampaignPlanDetails,
} from "./campaign-plans";
import { CampaignPlanNotFoundError } from "./campaign-plan-errors";

export type BackfillStatus = "backfilled" | "needs_configuration" | "already_backfilled";

export interface BackfillResult {
  status: BackfillStatus;
  planRevisionId: string;
  issues: CampaignPlanIssue[];
}

export interface ControlPlaneSummary {
  planRevision: number | null;
  laneCount: number;
  configurationIssueCount: number;
}

const LEGACY_FORMAT_BY_CHANNEL: Partial<Record<Channel, string>> = {
  linkedin: "linkedin_post",
  instagram: "instagram_post",
  x: "x_post",
};

export function getCampaignConfigurationIssues(
  campaign: Campaign,
  lanes: readonly Pick<CampaignLaneRevisionView, "channel" | "status">[],
): CampaignPlanIssue[] {
  const activeChannels = new Set(
    lanes.filter((lane) => lane.status === "active").map((lane) => lane.channel),
  );
  return campaign.channels
    .filter((channel) => !activeChannels.has(channel))
    .map((channel) => ({
      path: `channels.${channel}`,
      code: "execution_mapping_missing",
      message: `Choose a persona, publishing account, format, and schedule for ${channel}.`,
    }));
}

export function getCampaignPlanWorkspace(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignPlanWorkspace {
  const campaign = getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const revisions = listCampaignPlanDetails(db, workspaceId, campaignId);
  const workingRevision =
    revisions.find(({ plan }) => plan.status === "draft") ??
    revisions.find(({ plan }) => plan.id === campaign.currentPlanRevisionId) ??
    null;
  return campaignPlanWorkspaceSchema.parse({
    currentPlanRevisionId: campaign.currentPlanRevisionId,
    revisions,
    issues: getCampaignConfigurationIssues(campaign, workingRevision?.lanes ?? []),
  });
}

export function getCampaignControlPlaneSummary(
  db: Db,
  workspaceId: string,
  campaignId: string,
): ControlPlaneSummary {
  const campaign = getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const detail = getCurrentCampaignPlan(db, workspaceId, campaignId);
  if (!detail) {
    return {
      planRevision: null,
      laneCount: 0,
      configurationIssueCount: campaign.channels.length,
    };
  }
  return {
    planRevision: detail.plan.revision,
    laneCount: detail.lanes.length,
    configurationIssueCount: getCampaignConfigurationIssues(campaign, detail.lanes).length,
  };
}

export function backfillCampaignControlPlane(
  db: Db,
  workspaceId: string,
  campaignId: string,
): BackfillResult {
  const campaign = getCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new CampaignPlanNotFoundError();
  const existing = getCurrentCampaignPlan(db, workspaceId, campaignId);
  if (existing) {
    return {
      status: "already_backfilled",
      planRevisionId: existing.plan.id,
      issues: getCampaignConfigurationIssues(campaign, existing.lanes),
    };
  }

  const campaignAudiences = listCampaignAudiences(db, workspaceId, campaignId);
  const plan = createPlanRevision(
    db,
    workspaceId,
    campaignId,
    {
      objective: campaign.objective,
      kpi: campaign.kpi,
      timeframe: campaign.timeframe,
      startAt: null,
      endAt: null,
      audienceIds: campaignAudiences.map((audience) => audience.id),
      pillars: campaign.pillars,
      offers: [],
      ctas: [],
      guidance: campaign.overlay,
    },
    { userId: null },
  );

  const laneChannels = new Set<string>();
  const cadences = listCadenceRows(db, workspaceId).filter(
    (cadence) => cadence.campaignId === campaignId && cadence.status === "active",
  );
  for (const cadence of cadences) {
    const format = LEGACY_FORMAT_BY_CHANNEL[cadence.channel];
    if (!cadence.personaId || !format) continue;
    const key = `legacy-${cadence.channel}-${cadence.personaId.slice(0, 8)}-${cadence.id.slice(0, 8)}`;
    upsertLaneRevision(db, workspaceId, campaignId, plan.id, {
      key,
      name: cadence.name,
      personaId: cadence.personaId,
      // Several attached audiences cannot be assigned to one lane safely.
      audienceId: campaignAudiences.length === 1 ? campaignAudiences[0]!.id : null,
      channel: cadence.channel,
      format,
      publishingConnectionId: cadence.connectionId,
      providerTarget: cadence.target,
      deliveryMode: "planned",
      plannedQuantity: cadence.daysOfWeek.length,
      schedule: {
        daysOfWeek: cadence.daysOfWeek,
        timeOfDay: cadence.timeOfDay,
        timezone: cadence.timezone,
      },
      reactivePeriod: null,
      reactiveCap: null,
      status: "active",
    });
    laneChannels.add(cadence.channel);
  }

  const issues = getCampaignConfigurationIssues(
    campaign,
    Array.from(laneChannels).map((channel) => ({ channel: channel as Channel, status: "active" as const })),
  );
  activatePlanRevision(db, workspaceId, campaignId, plan.id);
  return {
    status: issues.length > 0 ? "needs_configuration" : "backfilled",
    planRevisionId: plan.id,
    issues,
  };
}
