import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveRequestSchema, upsertPersonaInputSchema } from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import { getBrain } from "../services/brain";
import { composeCampaignOverlay, getCampaign } from "../services/campaigns";
import { retrieveEvidence } from "../services/evidence";
import { resolveChannelGuidance } from "../services/guidance";
import type { EvidenceStore } from "../evidence/store";
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  updatePersona,
} from "../services/personas";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerPersonaRoutes(app: FastifyInstance, db: Db, evidence: EvidenceStore): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/personas", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = upsertPersonaInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(createPersona(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/personas", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listPersonas(db, request.params.id);
  });

  app.put<{ Params: { id: string; personaId: string } }>(
    "/workspaces/:id/personas/:personaId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertPersonaInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = updatePersona(db, request.params.id, request.params.personaId, parsed.data);
      if (!updated) return reply.status(404).send({ error: "persona_not_found" });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; personaId: string } }>(
    "/workspaces/:id/personas/:personaId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = deletePersona(db, request.params.id, request.params.personaId);
      if (!deleted) return reply.status(404).send({ error: "persona_not_found" });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/resolve", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = resolveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    let persona;
    if (parsed.data.personaId) {
      persona = getPersona(db, request.params.id, parsed.data.personaId);
      if (!persona) return reply.status(404).send({ error: "persona_not_found" });
    }

    let campaign;
    if (parsed.data.campaignId) {
      campaign = getCampaign(db, request.params.id, parsed.data.campaignId);
      if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
      if (campaign.status === "archived") {
        return reply.status(409).send({ error: "campaign_archived" });
      }
    }

    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );

    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const channelGuidance = resolveChannelGuidance(db, request.params.id, parsed.data.channel);

    return resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: parsed.data.taskType,
      channel: parsed.data.channel,
      channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
      persona: persona
        ? { name: persona.name, description: persona.description, overlay: persona.overlay }
        : undefined,
      campaign: campaign
        ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
        : undefined,
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      tokenBudget: parsed.data.tokenBudget,
    });
  });
}
