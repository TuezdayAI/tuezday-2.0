import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import { getWorkspaceInsights } from "../../services/insights";
import type { Tool } from "../registry";

const input = toolInputSchemas.get_workspace_insights;
type Input = z.infer<typeof input>;

/**
 * The cross-campaign, per-channel rollup — the "what's working?" read. Takes no
 * arguments: the workspace is already the tool context's scope.
 */
export const getWorkspaceInsightsTool: Tool<Input, unknown> = {
  name: "get_workspace_insights",
  description:
    "Get the whole workspace's performance rollup: per-campaign spend, published and sent counts, approval rates, and a per-channel breakdown (published, impressions, spend, sent, replied). Use this for 'what is working' questions before drilling into one campaign.",
  input,
  access: "read",
  async run(ctx) {
    return await getWorkspaceInsights(ctx.db, ctx.workspaceId);
  },
};
