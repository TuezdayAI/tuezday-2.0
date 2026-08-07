import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  recordRolloutDecisionInputSchema,
  shadowVerdictInputSchema,
  updateCampaignAutomationInputSchema,
  updateSocialAutomationSettingsInputSchema,
} from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import {
  getSocialAutomationSettings,
  runAutomationWithLease,
  updateSocialAutomationSettings,
} from "../services/automation";
import { setCampaignAutomation } from "../services/campaigns";
import {
  getAutomationComparison,
  listRolloutDecisions,
  listShadowPairs,
  recordRolloutDecision,
  recordShadowVerdict,
} from "../services/pipeline-shadow";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
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
  instanceId: string,
): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/automation/settings",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await getSocialAutomationSettings(db, request.params.id);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id/automation/settings",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateSocialAutomationSettingsInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      return await updateSocialAutomationSettings(db, request.params.id, parsed.data);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/automation/run",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await runAutomationWithLease(
        {
          db,
          llm,
          evidence,
          leaseMs: 60_000,
          heartbeatMs: 20_000,
        },
        request.params.id,
        `${instanceId}:automation:${randomUUID()}`,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Sprint 65 — shadow A/B measurement + rollout decisions
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/automation/comparison",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await getAutomationComparison(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { reviewed?: string } }>(
    "/workspaces/:id/automation/shadow-pairs",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const reviewed =
        request.query.reviewed === "true"
          ? true
          : request.query.reviewed === "false"
            ? false
            : undefined;
      return await listShadowPairs(db, request.params.id, { reviewed });
    },
  );

  app.post<{ Params: { id: string; pairId: string } }>(
    "/workspaces/:id/automation/shadow-pairs/:pairId/verdict",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = shadowVerdictInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const pair = await recordShadowVerdict(
        db,
        request.params.id,
        request.params.pairId,
        parsed.data,
        { userId: actorOf(request).userId },
      );
      if (!pair) return reply.status(404).send({ error: "pair_not_found" });
      return pair;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/automation/rollout-decisions",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await listRolloutDecisions(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/automation/rollout-decisions",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = recordRolloutDecisionInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const record = await recordRolloutDecision(db, request.params.id, parsed.data, {
        userId: actorOf(request).userId,
      });
      return reply.status(201).send(record);
    },
  );

  app.patch<{ Params: { id: string; campaignId: string } }>(
    "/workspaces/:id/campaigns/:campaignId/automation",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateCampaignAutomationInputSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const campaign = await setCampaignAutomation(
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
