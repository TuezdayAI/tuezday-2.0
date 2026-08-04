import type { z } from "zod";
import { toolInputSchemas, type Campaign, type CampaignLaneRevisionView } from "@tuezday/contracts";
import { getCurrentCampaignPlan } from "../../services/campaign-plans";
import { getCampaign, listCampaigns } from "../../services/campaigns";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.get_campaign_plan;
type Input = z.infer<typeof input>;

function campaignSummary(campaign: Campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    purpose: campaign.purpose,
    objective: campaign.objective,
    kpi: campaign.kpi,
    timeframe: campaign.timeframe,
    audience: campaign.audience,
    pillars: campaign.pillars,
    channels: campaign.channels,
    automationMode: campaign.automationMode,
  };
}

function laneSummary(lane: CampaignLaneRevisionView) {
  return {
    key: lane.key,
    name: lane.name,
    status: lane.status,
    channel: lane.channel,
    format: lane.format,
    personaId: lane.personaId,
    audienceId: lane.audienceId,
    deliveryMode: lane.deliveryMode,
    plannedQuantity: lane.plannedQuantity,
    reactivePeriod: lane.reactivePeriod,
    reactiveCap: lane.reactiveCap,
  };
}

/**
 * One campaign plus its current activated plan revision and lanes — the
 * persona × channel × format × cadence threads production actually runs on.
 */
export const getCampaignPlanTool: Tool<Input, unknown> = {
  name: "get_campaign_plan",
  description:
    "Get one campaign's brief (objective, KPI, timeframe, audience, pillars, channels) plus its current activated plan revision and production lanes. Requires campaignId; an unknown id returns the available campaigns.",
  input,
  access: "read",
  async run(ctx, { campaignId }) {
    const campaign = getCampaign(ctx.db, ctx.workspaceId, campaignId);
    if (!campaign) {
      return {
        error: "not_found",
        note: `No campaign with id ${campaignId} in this workspace.`,
        availableCampaigns: listCampaigns(ctx.db, ctx.workspaceId).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
        })),
      };
    }
    const detail = getCurrentCampaignPlan(ctx.db, ctx.workspaceId, campaignId);
    if (!detail) {
      return {
        campaign: campaignSummary(campaign),
        plan: null,
        note: "This campaign has no activated plan revision yet.",
      };
    }
    return {
      campaign: campaignSummary(campaign),
      plan: {
        revision: detail.plan.revision,
        status: detail.plan.status,
        objective: detail.plan.objective,
        kpi: detail.plan.kpi,
        timeframe: detail.plan.timeframe,
        startAt: detail.plan.startAt,
        endAt: detail.plan.endAt,
        pillars: detail.plan.pillars,
        offers: detail.plan.offers,
        ctas: detail.plan.ctas,
        guidance: compactText(detail.plan.guidance, 1000),
      },
      lanes: detail.lanes.map(laneSummary),
    };
  },
};
