import type { FastifyInstance, FastifyReply } from "fastify";
import {
  updateCampaignAutomationInputSchema,
  updateSocialAutomationSettingsInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import {
  getSocialAutomationSettings,
  runAutomation,
  updateSocialAutomationSettings,
} from "../services/automation";
import { setCampaignAutomation } from "../services/campaigns";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalid(reply: FastifyReply, issues: { message: string }[]) {
  return reply
    .status(400)
    .send({ error: "invalid_input", message: issues.map((i) => i.message).join("; ") });
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/automation/settings",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return getSocialAutomationSettings(db, request.params.id);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id/automation/settings",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateSocialAutomationSettingsInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      return updateSocialAutomationSettings(db, request.params.id, parsed.data);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/automation/run",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return runAutomation(db, llm, evidence, request.params.id);
    },
  );

  app.patch<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/automation",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateCampaignAutomationInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const campaign = setCampaignAutomation(
        db,
        request.params.id,
        request.params.campaignId,
        parsed.data,
      );
      if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
      return campaign;
    },
  );
}
