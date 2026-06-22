import type { FastifyInstance, FastifyReply } from "fastify";
import {
  addAudienceMembersInputSchema,
  attachAudienceInputSchema,
  upsertAudienceInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  addAudienceMembers,
  attachAudience,
  createAudience,
  deleteAudience,
  detachAudience,
  getAudienceDetail,
  listAudiences,
  listCampaignAudiences,
  loadPeople,
  removeAudienceMember,
  updateAudience,
} from "../services/audiences";
import { getCampaign } from "../services/campaigns";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

function invalid(reply: FastifyReply, parsed: { error: { issues: { message: string }[] } }) {
  return reply.status(400).send({
    error: "invalid_input",
    message: parsed.error.issues.map((i) => i.message).join("; "),
  });
}

export function registerAudienceRoutes(app: FastifyInstance, db: Db): void {
  // The unified people pool — leads + CRM contacts not linked to a lead.
  app.get<{ Params: { id: string } }>("/workspaces/:id/people", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return loadPeople(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/audiences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = upsertAudienceInputSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed);
    return reply.status(201).send(createAudience(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/audiences", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listAudiences(db, request.params.id);
  });

  app.get<{ Params: { id: string; audienceId: string } }>(
    "/workspaces/:id/audiences/:audienceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getAudienceDetail(db, request.params.id, request.params.audienceId);
      if (!detail) return reply.status(404).send({ error: "audience_not_found" });
      return detail;
    },
  );

  app.put<{ Params: { id: string; audienceId: string } }>(
    "/workspaces/:id/audiences/:audienceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertAudienceInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed);
      const updated = updateAudience(db, request.params.id, request.params.audienceId, parsed.data);
      if (!updated) return reply.status(404).send({ error: "audience_not_found" });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; audienceId: string } }>(
    "/workspaces/:id/audiences/:audienceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteAudience(db, request.params.id, request.params.audienceId)) {
        return reply.status(404).send({ error: "audience_not_found" });
      }
      return reply.status(204).send();
    },
  );

  // --- static-list membership -------------------------------------------------

  app.post<{ Params: { id: string; audienceId: string } }>(
    "/workspaces/:id/audiences/:audienceId/members",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = addAudienceMembersInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed);
      const result = addAudienceMembers(
        db,
        request.params.id,
        request.params.audienceId,
        parsed.data.members,
      );
      if (!result.ok) {
        if (result.error === "not_a_static_list") {
          return reply.status(409).send({ error: "not_a_static_list" });
        }
        return reply
          .status(404)
          .send({ error: result.detail === "audience" ? "audience_not_found" : "member_not_found" });
      }
      return { added: result.added };
    },
  );

  app.delete<{ Params: { id: string; audienceId: string; memberType: string; memberId: string } }>(
    "/workspaces/:id/audiences/:audienceId/members/:memberType/:memberId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const removed = removeAudienceMember(
        db,
        request.params.id,
        request.params.audienceId,
        request.params.memberType,
        request.params.memberId,
      );
      if (!removed) return reply.status(404).send({ error: "member_not_found" });
      return reply.status(204).send();
    },
  );

  // --- campaign attachment ----------------------------------------------------

  app.get<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/audiences",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getCampaign(db, request.params.id, request.params.campaignId)) {
        return reply.status(404).send({ error: "campaign_not_found" });
      }
      return listCampaignAudiences(db, request.params.id, request.params.campaignId);
    },
  );

  app.post<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/audiences",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!getCampaign(db, request.params.id, request.params.campaignId)) {
        return reply.status(404).send({ error: "campaign_not_found" });
      }
      const parsed = attachAudienceInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed);
      const result = attachAudience(
        db,
        request.params.id,
        request.params.campaignId,
        parsed.data.audienceId,
      );
      if (!result.ok) return reply.status(404).send({ error: "audience_not_found" });
      return reply.status(201).send(
        listCampaignAudiences(db, request.params.id, request.params.campaignId),
      );
    },
  );

  app.delete<{ Params: { id: string; campaignId: string; audienceId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/audiences/:audienceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!detachAudience(db, request.params.id, request.params.campaignId, request.params.audienceId)) {
        return reply.status(404).send({ error: "not_attached" });
      }
      return reply.status(204).send();
    },
  );
}
