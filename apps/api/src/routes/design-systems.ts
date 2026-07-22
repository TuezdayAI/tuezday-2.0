import type { FastifyInstance, FastifyReply } from "fastify";
import { updateDesignSystemInputSchema, upsertDesignOverlayInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { asChannel } from "../services/guidance";
import {
  deleteDesignOverlay,
  ensureDefaultDesignSystem,
  listDesignOverlays,
  resolveDesignSystem,
  updateDesignSystem,
  upsertDesignOverlay,
} from "../services/design-systems";
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
function scopeOk(
  db: Db,
  workspaceId: string,
  scope: { personaId?: string; campaignId?: string },
  reply: FastifyReply,
): boolean {
  if (scope.personaId && !getPersona(db, workspaceId, scope.personaId)) {
    void reply.status(404).send({ error: "persona_not_found" });
    return false;
  }
  if (scope.campaignId && !getCampaign(db, workspaceId, scope.campaignId)) {
    void reply.status(404).send({ error: "campaign_not_found" });
    return false;
  }
  return true;
}

export function registerDesignSystemRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/design-system", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return ensureDefaultDesignSystem(db, request.params.id);
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/design-system", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = updateDesignSystemInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return updateDesignSystem(db, request.params.id, parsed.data.content);
  });

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/design-system/overlays",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listDesignOverlays(db, request.params.id);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/workspaces/:id/design-system/overlays",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertDesignOverlayInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      if (!scopeOk(db, request.params.id, parsed.data, reply)) return reply;
      return upsertDesignOverlay(db, request.params.id, parsed.data);
    },
  );

  app.delete<{ Params: { id: string; overlayId: string } }>(
    "/workspaces/:id/design-system/overlays/:overlayId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = deleteDesignOverlay(db, request.params.id, request.params.overlayId);
      if (!deleted) return reply.status(404).send({ error: "overlay_not_found" });
      return { deleted: true };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { channel?: string; personaId?: string; campaignId?: string };
  }>("/workspaces/:id/design-system/resolve", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const channel = asChannel(request.query.channel ?? "");
    if (!channel) return reply.status(400).send({ error: "invalid_channel" });
    if (!scopeOk(db, request.params.id, request.query, reply)) return reply;
    return resolveDesignSystem(db, request.params.id, {
      channel,
      personaId: request.query.personaId ?? null,
      campaignId: request.query.campaignId ?? null,
    });
  });
}
