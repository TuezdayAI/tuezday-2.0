import type { FastifyInstance, FastifyReply } from "fastify";
import { upsertCampaignInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  createCampaign,
  getCampaign,
  getCampaignDetail,
  listCampaigns,
  updateCampaign,
} from "../services/campaigns";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerCampaignRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/campaigns", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = upsertCampaignInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(createCampaign(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/campaigns", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listCampaigns(db, request.params.id);
  });

  app.get<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const campaign = getCampaign(db, request.params.id, request.params.campaignId);
      if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
      return getCampaignDetail(db, campaign);
    },
  );

  app.put<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertCampaignInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = updateCampaign(db, request.params.id, request.params.campaignId, parsed.data);
      if (!updated) return reply.status(404).send({ error: "campaign_not_found" });
      return updated;
    },
  );
}
