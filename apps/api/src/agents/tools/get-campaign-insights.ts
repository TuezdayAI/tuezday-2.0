import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { getCampaign, listCampaigns } from "../../services/campaigns";
import { getCampaignInsights } from "../../services/insights";
import type { Tool } from "../registry";

const input = toolInputSchemas.get_campaign_insights;
type Input = z.infer<typeof input>;

/**
 * One campaign's performance rollup — the same aggregate `/campaigns/:id`
 * renders, so chat and the page can never disagree about a number.
 */
export const getCampaignInsightsTool: Tool<Input, unknown> = {
  name: "get_campaign_insights",
  description:
    "Get one campaign's performance: paid spend and ad metrics, published/sent counts, approval quality, and the outreach funnel. Requires campaignId — use list_campaigns to resolve a name to an id.",
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
    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      insights: getCampaignInsights(ctx.db, campaign),
    };
  },
};
