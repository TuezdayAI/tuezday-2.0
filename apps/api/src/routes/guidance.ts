import type { FastifyInstance, FastifyReply } from "fastify";
import { updateGuidanceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  asChannel,
  listChannelGuidance,
  listScopedGuidance,
  resetChannelGuidance,
  resolveChannelGuidance,
  setChannelGuidance,
  type GuidanceScope,
} from "../services/guidance";
import { getCampaign } from "../services/campaigns";
import { getPersona } from "../services/personas";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

/** Validate an optional persona/campaign scope against the workspace; 404s via reply. */
function scopeOr404(
  db: Db,
  workspaceId: string,
  scope: { personaId?: string; campaignId?: string },
  reply: FastifyReply,
): GuidanceScope | undefined {
  if (scope.personaId && !getPersona(db, workspaceId, scope.personaId)) {
    void reply.status(404).send({ error: "persona_not_found" });
    return undefined;
  }
  if (scope.campaignId && !getCampaign(db, workspaceId, scope.campaignId)) {
    void reply.status(404).send({ error: "campaign_not_found" });
    return undefined;
  }
  return { personaId: scope.personaId ?? null, campaignId: scope.campaignId ?? null };
}

export function registerGuidanceRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/guidance", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listChannelGuidance(db, request.params.id);
  });

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/guidance/overrides",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listScopedGuidance(db, request.params.id);
    },
  );

  app.get<{
    Params: { id: string; channel: string };
    Querystring: { personaId?: string; campaignId?: string };
  }>("/workspaces/:id/guidance/:channel/effective", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const channel = asChannel(request.params.channel);
    if (!channel) return reply.status(400).send({ error: "invalid_channel" });
    const resolved = resolveChannelGuidance(db, request.params.id, channel, {
      personaId: request.query.personaId ?? null,
      campaignId: request.query.campaignId ?? null,
    });
    return {
      channel,
      content: resolved.content,
      source: resolved.source,
      personaId: resolved.personaId,
      campaignId: resolved.campaignId,
      updatedAt: resolved.updatedAt,
      scopeLabel: resolved.scopeLabel ?? null,
    };
  });

  app.put<{ Params: { id: string; channel: string } }>(
    "/workspaces/:id/guidance/:channel",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const channel = asChannel(request.params.channel);
      if (!channel) return reply.status(400).send({ error: "invalid_channel" });
      const parsed = updateGuidanceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const scope = scopeOr404(db, request.params.id, parsed.data, reply);
      if (!scope) return reply;
      return setChannelGuidance(db, request.params.id, channel, parsed.data.content, scope);
    },
  );

  app.delete<{
    Params: { id: string; channel: string };
    Querystring: { personaId?: string; campaignId?: string };
  }>("/workspaces/:id/guidance/:channel", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const channel = asChannel(request.params.channel);
    if (!channel) return reply.status(400).send({ error: "invalid_channel" });
    return resetChannelGuidance(db, request.params.id, channel, {
      personaId: request.query.personaId ?? null,
      campaignId: request.query.campaignId ?? null,
    });
  });
}
