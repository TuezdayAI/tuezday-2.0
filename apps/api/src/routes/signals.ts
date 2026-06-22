import type { FastifyInstance, FastifyReply } from "fastify";
import { createSignalInputSchema, draftSignalRequestSchema } from "@tuezday/contracts";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getCampaign } from "../services/campaigns";
import type { EvidenceStore } from "../evidence/store";
import { getPersona } from "../services/personas";
import { createSignal, getSignal, listSignals } from "../services/signals";
import { generateSignalDraft } from "../services/signal-drafting";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
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
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createSignalInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(createSignal(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/signals", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listSignals(db, request.params.id);
  });

  app.post<{ Params: { id: string; signalId: string } }>(
    "/workspaces/:id/signals/:signalId/draft",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const signal = getSignal(db, request.params.id, request.params.signalId);
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

      try {
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
