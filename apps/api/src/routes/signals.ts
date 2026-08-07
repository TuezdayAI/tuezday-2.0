import type { FastifyInstance, FastifyReply } from "fastify";
import { createSignalInputSchema, draftSignalRequestSchema } from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { assertLlmBudget } from "../services/entitlements";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { campaignExecutionError, getCampaign } from "../services/campaigns";
import type { EvidenceStore } from "../evidence/store";
import { getPersona } from "../services/personas";
import { runPreReview, setGenerationReview } from "../services/review";
import {
  SignalReferenceNotFoundError,
  createSignalWithMatching,
  getSignal,
  listSignals,
} from "../services/signals";
import { generateSignalDraft } from "../services/signal-drafting";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerSignalRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/signals", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createSignalInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    // Sprint 45: auto-match unmapped signals; explicit persona/campaign input
    // becomes one trusted match with no LLM call. LLM failures never block
    // creation (the service catches them and returns the signal matchless).
    try {
      const signal = await createSignalWithMatching(db, llm, request.params.id, parsed.data);
      return reply.status(201).send(signal);
    } catch (err) {
      if (err instanceof SignalReferenceNotFoundError) {
        return reply.status(404).send({ error: "related_object_not_found" });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/signals", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return await listSignals(db, request.params.id);
  });

  app.post<{ Params: { id: string; signalId: string } }>(
    "/workspaces/:id/signals/:signalId/draft",
    async (request, reply) => {
      const workspace = await workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const signal = await getSignal(db, request.params.id, request.params.signalId);
      if (!signal) return reply.status(404).send({ error: "signal_not_found" });

      const parsed = draftSignalRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      let persona;
      if (parsed.data.personaId) {
        persona = await getPersona(db, request.params.id, parsed.data.personaId);
        if (!persona) return reply.status(404).send({ error: "persona_not_found" });
      }

      let campaign;
      if (parsed.data.campaignId) {
        campaign = await getCampaign(db, request.params.id, parsed.data.campaignId);
        if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
        const campaignError = campaignExecutionError(campaign);
        if (campaignError) return reply.status(409).send({ error: campaignError });
      }

      try {
        await assertLlmBudget(db, request.params.id);
        const draft = await generateSignalDraft(
          db,
          llm,
          evidence,
          workspace,
          signal,
          {
            channel: parsed.data.channel,
            persona,
            campaign,
            useEvidence: parsed.data.useEvidence,
            tokenBudget: parsed.data.tokenBudget,
          },
          actorOf(request),
        );
        return reply.status(201).send(draft);
      } catch (err) {
        if (err instanceof GatewayError) {
          return reply.status(502).send({ error: "generation_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
