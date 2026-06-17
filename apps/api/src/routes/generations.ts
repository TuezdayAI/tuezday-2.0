import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DEFAULT_ANGLE_COUNT,
  generateAnglesInputSchema,
  generateRequestSchema,
  rateGenerationInputSchema,
} from "@tuezday/contracts";
import { composeAngleInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { generateAngles } from "../services/angles";
import { getBrain } from "../services/brain";
import { composeCampaignOverlay, getCampaign } from "../services/campaigns";
import { retrieveEvidence } from "../services/evidence";
import type { EvidenceStore } from "../evidence/store";
import { getGenerationSettings } from "../services/generation-settings";
import { listGenerations, rateGeneration, storeGeneration } from "../services/generations";
import { getPersona } from "../services/personas";
import { runPreReview, setGenerationReview } from "../services/review";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerGenerationRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/generate", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = generateRequestSchema.safeParse(request.body);
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

    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );

    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const settings = getGenerationSettings(db, request.params.id);

    const personaInput = persona
      ? { name: persona.name, description: persona.description, overlay: persona.overlay }
      : undefined;
    const campaignInput = campaign
      ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
      : undefined;

    try {
      // Angle step (Sprint 22): a manual `angle` is drafted from directly;
      // `autoAngle` generates candidates server-side and picks the strongest.
      let chosenAngle = parsed.data.angle?.trim() || undefined;
      let angles: string[] | undefined;
      if (!chosenAngle && parsed.data.autoAngle) {
        const count = parsed.data.angleCount ?? settings.angleCount ?? DEFAULT_ANGLE_COUNT;
        const angleResolved = resolveContext({
          workspaceName: workspace.name,
          docs: contents,
          taskType: parsed.data.taskType,
          channel: parsed.data.channel,
          persona: personaInput,
          campaign: campaignInput,
          evidence: evidenceResolution.evidence,
          evidenceExclusionReason: evidenceResolution.exclusionReason,
          tokenBudget: parsed.data.tokenBudget,
          taskInstruction: composeAngleInstruction(parsed.data.taskType, parsed.data.channel, count),
        });
        const angleResult = await generateAngles(llm, angleResolved, count);
        angles = angleResult.angles;
        chosenAngle = angles[0];
      }

      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        persona: personaInput,
        campaign: campaignInput,
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        angle: chosenAngle,
        tokenBudget: parsed.data.tokenBudget,
      });

      const result = await llm.generate({ prompt: resolved.prompt });
      const generation = storeGeneration(db, {
        workspaceId: request.params.id,
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        personaId: parsed.data.personaId ?? null,
        campaignId: parsed.data.campaignId ?? null,
        resolved,
        output: result.text,
        model: result.model,
        provider: result.provider,
        durationMs: result.durationMs,
      });

      // Dual-LLM pre-review (Sprint 22), best-effort, when enabled. Stored on
      // the generation and returned so the sandbox can show scores + issues.
      let review = null;
      if (settings.reviewEnabled) {
        review = await runPreReview(
          llm,
          {
            workspaceName: workspace.name,
            docs: contents,
            taskType: parsed.data.taskType,
            channel: parsed.data.channel,
            persona: personaInput,
            campaign: campaignInput,
          },
          result.text,
          settings.flagThreshold,
        );
        setGenerationReview(db, request.params.id, generation.id, review);
      }

      return reply
        .status(201)
        .send({ ...generation, review, angles, chosenAngle });
    } catch (err) {
      if (err instanceof GatewayError) {
        return reply.status(502).send({ error: "generation_failed", message: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/angles", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = generateAnglesInputSchema.safeParse(request.body);
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

    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );

    const settings = getGenerationSettings(db, request.params.id);
    const count = parsed.data.angleCount ?? settings.angleCount ?? DEFAULT_ANGLE_COUNT;
    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: parsed.data.taskType,
      channel: parsed.data.channel,
      persona: persona
        ? { name: persona.name, description: persona.description, overlay: persona.overlay }
        : undefined,
      campaign: campaign
        ? { name: campaign.name, overlay: composeCampaignOverlay(campaign) }
        : undefined,
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      tokenBudget: parsed.data.tokenBudget,
      taskInstruction: composeAngleInstruction(parsed.data.taskType, parsed.data.channel, count),
    });

    try {
      const result = await generateAngles(llm, resolved, count);
      return reply.status(201).send({ ...result, sections: resolved.sections });
    } catch (err) {
      if (err instanceof GatewayError) {
        return reply.status(502).send({ error: "generation_failed", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/generations", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listGenerations(db, request.params.id);
  });

  app.post<{ Params: { id: string; generationId: string } }>(
    "/workspaces/:id/generations/:generationId/rating",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = rateGenerationInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const rated = rateGeneration(
        db,
        request.params.id,
        request.params.generationId,
        parsed.data.rating,
      );
      if (!rated) return reply.status(404).send({ error: "generation_not_found" });
      return rated;
    },
  );
}
