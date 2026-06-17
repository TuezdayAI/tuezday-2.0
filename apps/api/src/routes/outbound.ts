import type { FastifyInstance, FastifyReply } from "fastify";
import {
  APPROVAL_STATES,
  createLeadInputSchema,
  importLeadsInputSchema,
  outboundDraftRequestSchema,
  type ApprovalState,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import { and, eq, isNotNull } from "drizzle-orm";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { drafts } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getBrain } from "../services/brain";
import { composeCampaignOverlay, getCampaign } from "../services/campaigns";
import { submitDraft } from "../services/drafts";
import { retrieveEvidence } from "../services/evidence";
import { storeGeneration } from "../services/generations";
import { resolveChannelGuidance } from "../services/guidance";
import { createLead, csvField, deleteLead, getLead, importLeadsCsv, listLeads } from "../services/leads";
import { getPersona } from "../services/personas";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerOutboundRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/leads", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createLeadInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(createLead(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/leads", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listLeads(db, request.params.id);
  });

  app.delete<{ Params: { id: string; leadId: string } }>(
    "/workspaces/:id/leads/:leadId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteLead(db, request.params.id, request.params.leadId)) {
        return reply.status(404).send({ error: "lead_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/leads/import", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = importLeadsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return importLeadsCsv(db, request.params.id, parsed.data.csv);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/outbound/draft", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = outboundDraftRequestSchema.safeParse(request.body);
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
    const leadRecords = [];
    for (const leadId of parsed.data.leadIds) {
      const lead = getLead(db, request.params.id, leadId);
      if (!lead) return reply.status(404).send({ error: "lead_not_found", message: leadId });
      leadRecords.push(lead);
    }

    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: "outbound_email",
        channel: "email",
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );

    const channelGuidance = resolveChannelGuidance(db, request.params.id, "email");
    const results = [];
    for (const lead of leadRecords) {
      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: "outbound_email",
        channel: "email",
        channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
        persona: persona
          ? { name: persona.name, description: persona.description, overlay: persona.overlay }
          : undefined,
        campaign: campaign
          ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
          : undefined,
        lead: { name: lead.name, company: lead.company, role: lead.role, notes: lead.notes },
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        tokenBudget: parsed.data.tokenBudget,
      });

      try {
        const result = await llm.generate({ prompt: resolved.prompt });
        const generation = storeGeneration(db, {
          workspaceId: request.params.id,
          taskType: "outbound_email",
          channel: "email",
          personaId: parsed.data.personaId ?? null,
          campaignId: parsed.data.campaignId ?? null,
          leadId: lead.id,
          resolved,
          output: result.text,
          model: result.model,
          provider: result.provider,
          durationMs: result.durationMs,
        });
        const draft = submitDraft(db, {
          workspaceId: request.params.id,
          sourceGenerationId: generation.id,
          campaignId: parsed.data.campaignId ?? null,
          leadId: lead.id,
          taskType: "outbound_email",
          channel: "email",
          personaId: parsed.data.personaId ?? null,
          content: result.text,
        }, actorOf(request));
        results.push({ leadId: lead.id, generationId: generation.id, draftId: draft.id });
      } catch (err) {
        if (err instanceof GatewayError) {
          results.push({ leadId: lead.id, error: err.message });
        } else {
          throw err;
        }
      }
    }
    return { results };
  });

  app.get<{ Params: { id: string }; Querystring: { state?: string } }>(
    "/workspaces/:id/outbound/export.csv",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const state = (request.query.state ?? "approved") as ApprovalState;
      if (!(APPROVAL_STATES as readonly string[]).includes(state)) {
        return reply.status(400).send({ error: "invalid_state" });
      }
      const leadById = new Map(listLeads(db, request.params.id).map((l) => [l.id, l]));
      const rows = db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.workspaceId, request.params.id),
            eq(drafts.state, state),
            isNotNull(drafts.leadId),
          ),
        )
        .all();

      const lines = ["name,email,company,role,channel,content"];
      for (const row of rows) {
        const lead = leadById.get(row.leadId!);
        if (!lead) continue;
        lines.push(
          [lead.name, lead.email, lead.company, lead.role, row.channel, row.content]
            .map(csvField)
            .join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="tuezday-outbound-${state}.csv"`)
        .send(lines.join("\n"));
    },
  );
}
