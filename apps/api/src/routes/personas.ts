import type { FastifyInstance, FastifyReply } from "fastify";
import {
  resolveRequestSchema,
  upsertPersonaInputSchema,
  upsertPersonaSocialAccountInputSchema,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import { getBrain } from "../services/brain";
import { composeResolveCampaign, getCampaign } from "../services/campaigns";
import { selectiveContextInputs } from "../services/resolve-input";
import { retrieveEvidence } from "../services/evidence";
import { resolveChannelGuidance } from "../services/guidance";
import type { EvidenceStore } from "../evidence/store";
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  toResolvePersona,
  updatePersona,
} from "../services/personas";
import { resolveDraftAccount } from "../services/resolve-account";
import {
  createPersonaSocialAccount,
  deletePersonaSocialAccount,
  listPersonaSocialAccounts,
  updatePersonaSocialAccount,
} from "../services/persona-social-accounts";
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

  app.get<{ Params: { id: string; personaId: string } }>(
    "/workspaces/:id/personas/:personaId/social-accounts",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getPersona(db, request.params.id, request.params.personaId)) {
        return reply.status(404).send({ error: "persona_not_found" });
      }
      return listPersonaSocialAccounts(db, request.params.id, request.params.personaId);
    },
  );

  app.post<{ Params: { id: string; personaId: string } }>(
    "/workspaces/:id/personas/:personaId/social-accounts",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getPersona(db, request.params.id, request.params.personaId)) {
        return reply.status(404).send({ error: "persona_not_found" });
      }
      const parsed = upsertPersonaSocialAccountInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = createPersonaSocialAccount(
        db,
        request.params.id,
        request.params.personaId,
        parsed.data,
      );
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return reply.status(201).send(result.assignment);
    },
  );

  app.patch<{ Params: { id: string; personaId: string; assignmentId: string } }>(
    "/workspaces/:id/personas/:personaId/social-accounts/:assignmentId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getPersona(db, request.params.id, request.params.personaId)) {
        return reply.status(404).send({ error: "persona_not_found" });
      }
      const parsed = upsertPersonaSocialAccountInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const result = updatePersonaSocialAccount(
        db,
        request.params.id,
        request.params.personaId,
        request.params.assignmentId,
        parsed.data,
      );
      if (!result.ok && result.error === "assignment_not_found") {
        return reply.status(404).send({ error: result.error });
      }
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return result.assignment;
    },
  );

  app.delete<{ Params: { id: string; personaId: string; assignmentId: string } }>(
    "/workspaces/:id/personas/:personaId/social-accounts/:assignmentId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getPersona(db, request.params.id, request.params.personaId)) {
        return reply.status(404).send({ error: "persona_not_found" });
      }
      const deleted = deletePersonaSocialAccount(
        db,
        request.params.id,
        request.params.personaId,
        request.params.assignmentId,
      );
      if (!deleted) return reply.status(404).send({ error: "assignment_not_found" });
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
    const channelGuidance = resolveChannelGuidance(db, request.params.id, parsed.data.channel, {
      personaId: parsed.data.personaId ?? null,
      campaignId: parsed.data.campaignId ?? null,
    });

    return resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: parsed.data.taskType,
      channel: parsed.data.channel,
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: persona ? toResolvePersona(persona) : undefined,
      campaign: campaign ? composeResolveCampaign(campaign) : undefined,
      account: resolveDraftAccount(db, request.params.id, {
        personaId: parsed.data.personaId,
        channel: parsed.data.channel,
      }),
      ...selectiveContextInputs(db, request.params.id),
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      tokenBudget: parsed.data.tokenBudget,
    });
  });
}
