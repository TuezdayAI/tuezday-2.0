import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db";
import { getCampaign, listCampaigns } from "../services/campaigns";
import {
  getCampaignInsights,
  getWorkspaceInsights,
  toCampaignInsightsCsv,
  toWorkspaceInsightsCsv,
} from "../services/insights";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerInsightsRoutes(app: FastifyInstance, db: Db): void {
  // Per-campaign insights
  app.get<{ Params: { id: string; campaignId: string }; Querystring: { format?: string } }>(
    "/workspaces/:id/campaigns/:campaignId/insights",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const campaign = getCampaign(db, request.params.id, request.params.campaignId);
      if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
      const insights = getCampaignInsights(db, campaign);
      if (request.query.format === "csv") {
        return reply
          .header("Content-Type", "text/csv")
          .header(
            "Content-Disposition",
            `attachment; filename="campaign-insights-${campaign.id}.csv"`,
          )
          .send(toCampaignInsightsCsv(insights));
      }
      return insights;
    },
  );

  // Workspace-level insights
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/workspaces/:id/insights",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const insights = getWorkspaceInsights(db, request.params.id);
      if (request.query.format === "csv") {
        return reply
          .header("Content-Type", "text/csv")
          .header(
            "Content-Disposition",
            `attachment; filename="workspace-insights-${request.params.id}.csv"`,
          )
          .send(toWorkspaceInsightsCsv(insights));
      }
      return insights;
    },
  );
}
