import type { FastifyInstance, FastifyReply } from "fastify";
import {
  OPPORTUNITY_STATUSES,
  opportunityDecisionInputSchema,
  routingPolicyPatchSchema,
  type OpportunityStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { actorOf } from "../auth/guard";
import type { LlmGateway } from "../llm/gateway";
import {
  InvalidOpportunityTransitionError,
  OpportunityNotFoundError,
  decideOpportunity,
  getOpportunityDetail,
  listOpportunities,
} from "../services/opportunities";
import { runOpportunityRouting } from "../services/opportunity-matching";
import { compileRoutingProfile, updateRoutingPolicy } from "../services/routing-profiles";
import { DEFAULT_DISCOVERY_POLICY } from "../runtime/operator-policy";
import { getWorkspace } from "../services/workspaces";
import { campaigns } from "../db/schema";
import { and, eq } from "drizzle-orm";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

async function campaignExists(db: Db, workspaceId: string, campaignId: string): Promise<boolean> {
  return (
    await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
      .get() !== undefined
  );
}

// Sprint 61: campaign opportunities & routing profiles — the shadow
// autonomy-governor surface (design §8.5–§8.6, §9, §11.2).
export function registerOpportunityRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
): void {
  app.get<{
    Params: { id: string };
    Querystring: {
      status?: string;
      campaignId?: string;
      storyId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/workspaces/:id/opportunities", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const { status, campaignId, storyId, limit, offset } = request.query;
    if (
      status !== undefined &&
      !OPPORTUNITY_STATUSES.includes(status as OpportunityStatus)
    ) {
      return reply.status(400).send({ error: "invalid_input", message: "unknown status" });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const parsedOffset = offset === undefined ? undefined : Number(offset);
    if (
      (parsedLimit !== undefined &&
        (!Number.isInteger(parsedLimit) || parsedLimit < 1)) ||
      (parsedOffset !== undefined &&
        (!Number.isInteger(parsedOffset) || parsedOffset < 0))
    ) {
      return reply.status(400).send({
        error: "invalid_input",
        message: "limit must be a positive integer and offset a non-negative integer",
      });
    }
    return await listOpportunities(db, request.params.id, {
      status: status as OpportunityStatus | undefined,
      campaignId,
      storyId,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  });

  app.get<{ Params: { id: string; opportunityId: string } }>(
    "/workspaces/:id/opportunities/:opportunityId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await getOpportunityDetail(db, request.params.id, request.params.opportunityId);
      } catch (err) {
        if (err instanceof OpportunityNotFoundError) {
          return reply.status(404).send({ error: "opportunity_not_found" });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; opportunityId: string } }>(
    "/workspaces/:id/opportunities/:opportunityId/decision",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = opportunityDecisionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await decideOpportunity(db, request.params.id, request.params.opportunityId, {
          action: parsed.data.action,
          reason: parsed.data.reason,
          actorUserId: actorOf(request).userId,
        });
      } catch (err) {
        if (err instanceof OpportunityNotFoundError) {
          return reply.status(404).send({ error: "opportunity_not_found" });
        }
        if (err instanceof InvalidOpportunityTransitionError) {
          return reply.status(400).send({
            error: "invalid_transition",
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/routing-profile",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      if (!await campaignExists(db, request.params.id, request.params.campaignId)) {
        return reply.status(404).send({ error: "campaign_not_found" });
      }
      const profile = await compileRoutingProfile(
        db,
        request.params.id,
        request.params.campaignId,
      );
      if (!profile) {
        return reply.status(404).send({ error: "no_active_plan" });
      }
      return profile;
    },
  );

  app.patch<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/routing-policy",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = routingPolicyPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      if (!await campaignExists(db, request.params.id, request.params.campaignId)) {
        return reply.status(404).send({ error: "campaign_not_found" });
      }
      const { profile } = await updateRoutingPolicy(
        db,
        request.params.id,
        request.params.campaignId,
        parsed.data,
      );
      // The policy update itself succeeded; a null profile just means no
      // active plan revision exists yet for the campaign.
      return { profile: profile ?? null };
    },
  );

  // Founder-triggered synchronous shadow run (D-60.5 precedent) so the layer
  // is demonstrable without the worker. Bounded by the same per-tick cap.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/opportunities/match",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await runOpportunityRouting(db, llm, {
        workspaceId: request.params.id,
        limit: DEFAULT_DISCOVERY_POLICY.maxRoutingStoriesPerTick,
        leaseMs: DEFAULT_DISCOVERY_POLICY.leaseMs,
        timeoutMs: DEFAULT_DISCOVERY_POLICY.routingTimeoutMs,
      });
    },
  );
}
