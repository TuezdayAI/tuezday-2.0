import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createCampaignPlanRevisionInputSchema,
  upsertCampaignLaneRevisionInputSchema,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import {
  CampaignPlanNotFoundError,
  PlanImmutableError,
  PlanValidationError,
  activatePlanRevision,
  createPlanRevision,
  getCurrentCampaignPlan,
} from "../services/campaign-plans";
import { upsertLaneRevision } from "../services/campaign-lanes";
import {
  backfillCampaignControlPlane,
  getCampaignControlPlaneSummary,
} from "../services/orchestration-backfill";
import { getWorkspace } from "../services/workspaces";

interface CampaignParams {
  id: string;
  campaignId: string;
}

interface RevisionParams extends CampaignParams {
  revisionId: string;
}

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

function sendPlanError(reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignPlanNotFoundError) {
    return reply.status(404).send({ error: "campaign_or_plan_not_found", message: error.message });
  }
  if (error instanceof PlanImmutableError) {
    return reply.status(409).send({ error: "plan_immutable", message: error.message });
  }
  if (error instanceof PlanValidationError) {
    return reply.status(409).send({ error: "plan_invalid", issues: error.issues });
  }
  throw error;
}

export function registerCampaignPlanRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: CampaignParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const detail = getCurrentCampaignPlan(db, request.params.id, request.params.campaignId);
      if (!detail) return reply.status(404).send({ error: "plan_not_found" });
      return detail;
    },
  );

  app.get<{ Params: CampaignParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan/summary",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return getCampaignControlPlaneSummary(db, request.params.id, request.params.campaignId);
      } catch (error) {
        return sendPlanError(reply, error);
      }
    },
  );

  app.post<{ Params: CampaignParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan/revisions",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createCampaignPlanRevisionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        });
      }
      try {
        return reply
          .status(201)
          .send(
            createPlanRevision(
              db,
              request.params.id,
              request.params.campaignId,
              parsed.data,
              actorOf(request),
            ),
          );
      } catch (error) {
        return sendPlanError(reply, error);
      }
    },
  );

  app.put<{ Params: RevisionParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan/revisions/:revisionId/lanes",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = upsertCampaignLaneRevisionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        });
      }
      try {
        return upsertLaneRevision(
          db,
          request.params.id,
          request.params.campaignId,
          request.params.revisionId,
          parsed.data,
        );
      } catch (error) {
        return sendPlanError(reply, error);
      }
    },
  );

  app.post<{ Params: RevisionParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan/revisions/:revisionId/activate",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return activatePlanRevision(
          db,
          request.params.id,
          request.params.campaignId,
          request.params.revisionId,
        );
      } catch (error) {
        return sendPlanError(reply, error);
      }
    },
  );

  app.post<{ Params: CampaignParams }>(
    "/workspaces/:id/campaigns/:campaignId/plan/backfill",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return backfillCampaignControlPlane(db, request.params.id, request.params.campaignId);
      } catch (error) {
        return sendPlanError(reply, error);
      }
    },
  );
}
