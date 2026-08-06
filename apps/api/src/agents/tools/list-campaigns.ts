import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { listCampaigns } from "../../services/campaigns";
import { compactText, type Tool } from "../registry";

const input = toolInputSchemas.list_campaigns;
type Input = z.infer<typeof input>;

const DEFAULT_LIMIT = 20;
const PURPOSE_CHARS = 200;

/**
 * The workspace's campaigns. This is how a model turns "the launch campaign"
 * into an id it can pass to get_campaign_plan / get_campaign_insights — without
 * it, every campaign-scoped tool is unreachable from a natural-language name.
 */
export const listCampaignsTool: Tool<Input, unknown> = {
  name: "list_campaigns",
  description:
    "List the workspace's campaigns with id, name, status, objective, KPI, timeframe and channels. Use this to resolve a campaign the user named in words into its id. Optionally filter by status.",
  input,
  access: "read",
  async run(ctx, { status, limit }) {
    const all = listCampaigns(ctx.db, ctx.workspaceId);
    const filtered = status ? all.filter((c) => c.status === status) : all;
    if (filtered.length === 0) {
      return {
        campaigns: [],
        note: status
          ? `No campaigns with status "${status}" in this workspace.`
          : "This workspace has no campaigns yet.",
      };
    }
    return {
      campaigns: filtered.slice(0, limit ?? DEFAULT_LIMIT).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        purpose: compactText(c.purpose, PURPOSE_CHARS),
        objective: c.objective,
        kpi: c.kpi,
        timeframe: c.timeframe,
        channels: c.channels,
      })),
      totalCount: filtered.length,
    };
  },
};
