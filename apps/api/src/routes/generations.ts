import type { FastifyInstance, FastifyReply } from "fastify";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";
import {
  DEFAULT_ANGLE_COUNT,
  generateAnglesInputSchema,
  generateRequestSchema,
  rateGenerationInputSchema,
} from "@tuezday/contracts";
import { composeAngleInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import { assertWithinLimit, EntitlementError, getUsage } from "../services/entitlements";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { generateAngles } from "../services/angles";
import { getBrain } from "../services/brain";
import { composeResolveCampaign, getCampaign } from "../services/campaigns";
import { resolveChannelGuidance } from "../services/guidance";
import { retrieveEvidence } from "../services/evidence";
import type { EvidenceStore } from "../evidence/store";
import { getGenerationSettings } from "../services/generation-settings";
import { listGenerations, rateGeneration, storeGeneration } from "../services/generations";
import { getPersona, toResolvePersona } from "../services/personas";
import { resolveDraftAccount } from "../services/resolve-account";
import { selectiveContextInputs } from "../services/resolve-input";
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
  analytics: AnalyticsSink,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/generate", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;

    try {
      assertWithinLimit(db, request.params.id, "monthlyGenerations", getUsage(db, request.params.id).monthlyGenerations);
    } catch (err) {
      if (err instanceof EntitlementError) {
        return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
      }
      throw err;
    }

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
    const channelGuidance = resolveChannelGuidance(db, request.params.id, parsed.data.channel, {
      personaId: parsed.data.personaId ?? null,
      campaignId: parsed.data.campaignId ?? null,
    });
    const settings = getGenerationSettings(db, request.params.id);
    const selective = selectiveContextInputs(db, request.params.id);

    const personaInput = persona ? toResolvePersona(persona) : undefined;
    const campaignInput = campaign ? composeResolveCampaign(campaign) : undefined;
    const account = resolveDraftAccount(db, request.params.id, {
      personaId: parsed.data.personaId,
      channel: parsed.data.channel,
    });

    try {
      // Angle step (Sprint 22): a manual `angle` is drafted from directly;
      // `autoAngle` generates candidates server-side and picks the strongest.
      // Sprint 43: the angle call is the *brief* — Tier 1 + outlines, no zoom,
      // no evidence — and the chosen angle then feeds the draft's zoom query.
      let chosenAngle = parsed.data.angle?.trim() || undefined;
      let angles: string[] | undefined;
      if (!chosenAngle && parsed.data.autoAngle) {
        const count = parsed.data.angleCount ?? settings.angleCount ?? DEFAULT_ANGLE_COUNT;
        const angleResolved = resolveContext({
          workspaceName: workspace.name,
          docs: contents,
          taskType: parsed.data.taskType,
          channel: parsed.data.channel,
          channelGuidance: {
            content: channelGuidance.content,
            source: channelGuidance.source,
            scope: channelGuidance.scopeLabel,
          },
          persona: personaInput,
          campaign: campaignInput,
          account,
          ...selective,
          resolveMode: "brief",
          evidenceExclusionReason: "brief mode (angle step) runs without evidence.",
          tokenBudget: parsed.data.tokenBudget,
          taskInstruction: composeAngleInstruction(parsed.data.taskType, parsed.data.channel, count),
        });

        try {
          assertWithinLimit(db, request.params.id, "monthlyGenerations", getUsage(db, request.params.id).monthlyGenerations);
        } catch (err) {
          if (err instanceof EntitlementError) {
            return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
          }
          throw err;
        }

        const angleResult = await generateAngles(llm, angleResolved, count);
        angles = angleResult.angles;
        chosenAngle = angles[0];
      }

      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: parsed.data.taskType,
        channel: parsed.data.channel,
        channelGuidance: {
          content: channelGuidance.content,
          source: channelGuidance.source,
          scope: channelGuidance.scopeLabel,
        },
        persona: personaInput,
        campaign: campaignInput,
        account,
        ...selective,
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
            channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
            persona: personaInput,
            campaign: campaignInput,
            ...selective,
          },
          result.text,
          settings.flagThreshold,
        );
        setGenerationReview(db, request.params.id, generation.id, review);
      }

      track(db, analytics, {
        event: "generation.created",
        distinctId: request.actor.userId!,
        workspaceId: request.params.id,
        properties: { taskType: parsed.data.taskType, channel: parsed.data.channel },
      });

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

    // Sprint 43: angle suggestions run as the brief — Tier 1 + outlines only,
    // no zoom, no evidence retrieval. Cheap by construction.
    const settings = getGenerationSettings(db, request.params.id);
    const count = parsed.data.angleCount ?? settings.angleCount ?? DEFAULT_ANGLE_COUNT;
    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const channelGuidance = resolveChannelGuidance(db, request.params.id, parsed.data.channel, {
      personaId: parsed.data.personaId ?? null,
      campaignId: parsed.data.campaignId ?? null,
    });
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: parsed.data.taskType,
      channel: parsed.data.channel,
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: persona ? toResolvePersona(persona) : undefined,
      campaign: campaign ? composeResolveCampaign(campaign) : undefined,
      account: resolveDraftAccount(db, request.params.id, {
        personaId: parsed.data.personaId,
        channel: parsed.data.channel,
      }),
      ...selectiveContextInputs(db, request.params.id),
      resolveMode: "brief",
      evidenceExclusionReason: "brief mode (angle step) runs without evidence.",
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
