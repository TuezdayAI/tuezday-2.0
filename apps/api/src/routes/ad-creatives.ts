import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AD_CREATIVE_FORMATS,
  APPROVAL_STATES,
  generateAdCreativesInputSchema,
  isAdCreativeTaskType,
  parseAdCreative,
  type ApprovalState,
} from "@tuezday/contracts";
import { composeAdCreativeInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import { and, eq } from "drizzle-orm";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { drafts } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { listAdCreativeSets, parseGeneratedVariants, withViolations } from "../services/ad-creatives";
import { getBrain } from "../services/brain";
import { composeCampaignOverlay, getCampaign, listCampaigns } from "../services/campaigns";
import { submitDraft } from "../services/drafts";
import { retrieveEvidence } from "../services/evidence";
import { storeGeneration } from "../services/generations";
import { resolveChannelGuidance } from "../services/guidance";
import { csvField } from "../services/leads";
import { getPersona } from "../services/personas";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerAdCreativeRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/ad-creatives/generate",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      const parsed = generateAdCreativesInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }

      const campaign = getCampaign(db, request.params.id, parsed.data.campaignId);
      if (!campaign) return reply.status(404).send({ error: "campaign_not_found" });
      if (campaign.status === "archived") {
        return reply.status(409).send({ error: "campaign_archived" });
      }
      let persona;
      if (parsed.data.personaId) {
        persona = getPersona(db, request.params.id, parsed.data.personaId);
        if (!persona) return reply.status(404).send({ error: "persona_not_found" });
      }

      const { docs } = getBrain(db, request.params.id);
      const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
      const evidenceResolution = await retrieveEvidence(
        db,
        evidence,
        request.params.id,
        {
          taskType: parsed.data.taskType,
          channel: "ads",
          campaignObjective: campaign.objective,
        },
        parsed.data.useEvidence ?? true,
      );

      const format = AD_CREATIVE_FORMATS[parsed.data.taskType];
      const variantCount = parsed.data.variantCount ?? format.variantCount?.default;
      const channelGuidance = resolveChannelGuidance(db, request.params.id, "ads");
      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: parsed.data.taskType,
        channel: "ads",
        channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
        persona: persona
          ? { name: persona.name, description: persona.description, overlay: persona.overlay }
          : undefined,
        campaign: { name: campaign.name, overlay: composeCampaignOverlay(campaign) },
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        taskInstruction: composeAdCreativeInstruction(parsed.data.taskType, variantCount),
        tokenBudget: parsed.data.tokenBudget,
      });

      let result;
      try {
        result = await llm.generate({ prompt: resolved.prompt });
      } catch (err) {
        if (err instanceof GatewayError) {
          return reply.status(502).send({ error: "generation_failed", message: err.message });
        }
        throw err;
      }

      const generation = storeGeneration(db, {
        workspaceId: request.params.id,
        taskType: parsed.data.taskType,
        channel: "ads",
        personaId: parsed.data.personaId ?? null,
        campaignId: campaign.id,
        resolved,
        output: result.text,
        model: result.model,
        provider: result.provider,
        durationMs: result.durationMs,
      });

      const variants = parseGeneratedVariants(parsed.data.taskType, result.text);
      if (variants.length === 0) {
        return reply.status(502).send({
          error: "generation_unparseable",
          message: `The model's output was not in the ${format.label} format. The generation is stored — try again.`,
          generationId: generation.id,
        });
      }

      const created = variants.map((content) =>
        submitDraft(db, {
          workspaceId: request.params.id,
          sourceGenerationId: generation.id,
          campaignId: campaign.id,
          taskType: parsed.data.taskType,
          channel: "ads",
          personaId: parsed.data.personaId ?? null,
          content,
        }, actorOf(request)),
      );
      return reply.status(201).send({
        generationId: generation.id,
        drafts: created.map(withViolations),
      });
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/ad-creatives", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listAdCreativeSets(db, request.params.id);
  });

  app.get<{
    Params: { id: string };
    Querystring: { taskType?: string; state?: string; campaignId?: string };
  }>("/workspaces/:id/ad-creatives/export.csv", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const taskType = request.query.taskType ?? "";
    if (!isAdCreativeTaskType(taskType)) {
      return reply.status(400).send({ error: "invalid_task_type" });
    }
    const state = (request.query.state ?? "approved") as ApprovalState;
    if (!(APPROVAL_STATES as readonly string[]).includes(state)) {
      return reply.status(400).send({ error: "invalid_state" });
    }

    const conditions = [
      eq(drafts.workspaceId, request.params.id),
      eq(drafts.taskType, taskType),
      eq(drafts.state, state),
    ];
    if (request.query.campaignId) conditions.push(eq(drafts.campaignId, request.query.campaignId));
    const rows = db
      .select()
      .from(drafts)
      .where(and(...conditions))
      .all();

    const campaignName = new Map(listCampaigns(db, request.params.id).map((c) => [c.id, c.name]));
    const format = AD_CREATIVE_FORMATS[taskType];
    const columns = format.fields.flatMap((f) =>
      f.maxCount > 1
        ? Array.from({ length: f.maxCount }, (_, i) => ({ key: f.key, index: i + 1 }))
        : [{ key: f.key, index: 1 }],
    );
    const header = [
      "campaign",
      ...columns.map((c) => {
        const field = format.fields.find((f) => f.key === c.key)!;
        return field.maxCount > 1 ? `${c.key}_${c.index}` : c.key;
      }),
      "state",
    ];

    const lines = [header.join(",")];
    for (const row of rows) {
      const parsed = parseAdCreative(taskType, row.content);
      if (!parsed) continue; // possible only for never-validated states
      const valueByKey = new Map(parsed.fields.map((f) => [`${f.key}:${f.index}`, f.value]));
      lines.push(
        [
          row.campaignId ? (campaignName.get(row.campaignId) ?? "") : "",
          ...columns.map((c) => valueByKey.get(`${c.key}:${c.index}`) ?? ""),
          row.state,
        ]
          .map(csvField)
          .join(","),
      );
    }
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="tuezday-ad-creatives-${taskType}-${state}.csv"`,
      )
      .send(lines.join("\n"));
  });
}
