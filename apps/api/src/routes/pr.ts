import type { FastifyInstance, FastifyReply } from "fastify";
import {
  APPROVAL_STATES,
  createMediaContactInputSchema,
  importMediaContactsInputSchema,
  pressKitRequestSchema,
  prPitchRequestSchema,
  type ApprovalState,
} from "@tuezday/contracts";
import { composePrPitchInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import { and, eq, isNotNull } from "drizzle-orm";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { drafts } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getBrain } from "../services/brain";
import { campaignExecutionError, composeResolveCampaign, getCampaign } from "../services/campaigns";
import { selectiveContextInputs } from "../services/resolve-input";
import { submitDraft } from "../services/drafts";
import { retrieveEvidence } from "../services/evidence";
import { getGenerationSettings } from "../services/generation-settings";
import { storeGeneration } from "../services/generations";
import { resolveChannelGuidance } from "../services/guidance";
import { csvField } from "../services/leads";
import {
  createMediaContact,
  deleteMediaContact,
  getMediaContact,
  importMediaContactsCsv,
  listMediaContacts,
} from "../services/media-contacts";
import { getPersona, toResolvePersona } from "../services/personas";
import { runPreReview, setGenerationReview } from "../services/review";
import { getSignal } from "../services/signals";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerPrRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/media-contacts", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createMediaContactInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(createMediaContact(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/media-contacts", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listMediaContacts(db, request.params.id);
  });

  app.delete<{ Params: { id: string; contactId: string } }>(
    "/workspaces/:id/media-contacts/:contactId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      if (!deleteMediaContact(db, request.params.id, request.params.contactId)) {
        return reply.status(404).send({ error: "media_contact_not_found" });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/media-contacts/import",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = importMediaContactsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return importMediaContactsCsv(db, request.params.id, parsed.data.csv);
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/pr/pitch", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = prPitchRequestSchema.safeParse(request.body);
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
      const campaignError = campaignExecutionError(campaign);
      if (campaignError) return reply.status(409).send({ error: campaignError });
    }
    let signal;
    if (parsed.data.signalId) {
      signal = getSignal(db, request.params.id, parsed.data.signalId);
      if (!signal) return reply.status(404).send({ error: "signal_not_found" });
    }
    const contactRecords = [];
    for (const contactId of parsed.data.contactIds) {
      const contact = getMediaContact(db, request.params.id, contactId);
      if (!contact) {
        return reply.status(404).send({ error: "media_contact_not_found", message: contactId });
      }
      contactRecords.push(contact);
    }

    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: "pr_pitch",
        channel: "pr",
        signalContent: signal?.content,
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );
    const taskInstruction = composePrPitchInstruction(parsed.data.pitchType);
    const channelGuidance = resolveChannelGuidance(db, request.params.id, "pr", {
      personaId: parsed.data.personaId ?? null,
      campaignId: parsed.data.campaignId ?? null,
    });
    const settings = getGenerationSettings(db, request.params.id);
    const selective = selectiveContextInputs(db, request.params.id);

    const results = [];
    for (const contact of contactRecords) {
      const resolved = resolveContext({
        workspaceName: workspace.name,
        docs: contents,
        taskType: "pr_pitch",
        channel: "pr",
        channelGuidance: {
          content: channelGuidance.content,
          source: channelGuidance.source,
          scope: channelGuidance.scopeLabel,
        },
        persona: persona ? toResolvePersona(persona) : undefined,
        campaign: campaign ? composeResolveCampaign(campaign) : undefined,
        ...selective,
        mediaContact: {
          name: contact.name,
          type: contact.type,
          outlet: contact.outlet,
          beat: contact.beat,
          coverageNotes: contact.coverageNotes,
        },
        signal: signal
          ? { content: signal.content, source: signal.source, sourceUrl: signal.sourceUrl }
          : undefined,
        evidence: evidenceResolution.evidence,
        evidenceExclusionReason: evidenceResolution.exclusionReason,
        taskInstruction,
        tokenBudget: parsed.data.tokenBudget,
      });

      try {
        const result = await llm.generate({ prompt: resolved.prompt });
        const generation = storeGeneration(db, {
          workspaceId: request.params.id,
          taskType: "pr_pitch",
          channel: "pr",
          personaId: parsed.data.personaId ?? null,
          campaignId: parsed.data.campaignId ?? null,
          mediaContactId: contact.id,
          resolved,
          output: result.text,
          model: result.model,
          provider: result.provider,
          durationMs: result.durationMs,
        });
        if (settings.reviewEnabled) {
          const review = await runPreReview(
            llm,
            {
              workspaceName: workspace.name,
              docs: contents,
              taskType: "pr_pitch",
              channel: "pr",
              channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
              persona: persona ? toResolvePersona(persona) : undefined,
              campaign: campaign ? composeResolveCampaign(campaign) : undefined,
              ...selective,
            },
            result.text,
            settings.flagThreshold,
          );
          setGenerationReview(db, request.params.id, generation.id, review);
        }
        const draft = submitDraft(db, {
          workspaceId: request.params.id,
          sourceGenerationId: generation.id,
          sourceSignalId: signal?.id ?? null,
          campaignId: parsed.data.campaignId ?? null,
          mediaContactId: contact.id,
          taskType: "pr_pitch",
          channel: "pr",
          personaId: parsed.data.personaId ?? null,
          content: result.text,
        }, actorOf(request));
        results.push({ contactId: contact.id, generationId: generation.id, draftId: draft.id });
      } catch (err) {
        if (err instanceof GatewayError) {
          results.push({ contactId: contact.id, error: err.message });
        } else {
          throw err;
        }
      }
    }
    return { results };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/pr/press-kit", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    const parsed = pressKitRequestSchema.safeParse(request.body ?? {});
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
      const campaignError = campaignExecutionError(campaign);
      if (campaignError) return reply.status(409).send({ error: campaignError });
    }

    const { docs } = getBrain(db, request.params.id);
    const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
    const evidenceResolution = await retrieveEvidence(
      db,
      evidence,
      request.params.id,
      {
        taskType: "press_boilerplate",
        channel: "pr",
        campaignObjective: campaign?.objective,
      },
      parsed.data.useEvidence ?? true,
    );
    const channelGuidance = resolveChannelGuidance(db, request.params.id, "pr", {
      personaId: parsed.data.personaId ?? null,
      campaignId: parsed.data.campaignId ?? null,
    });
    const selective = selectiveContextInputs(db, request.params.id);
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: "press_boilerplate",
      channel: "pr",
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: persona ? toResolvePersona(persona) : undefined,
      campaign: campaign ? composeResolveCampaign(campaign) : undefined,
      ...selective,
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      tokenBudget: parsed.data.tokenBudget,
    });

    try {
      const result = await llm.generate({ prompt: resolved.prompt });
      const generation = storeGeneration(db, {
        workspaceId: request.params.id,
        taskType: "press_boilerplate",
        channel: "pr",
        personaId: parsed.data.personaId ?? null,
        campaignId: parsed.data.campaignId ?? null,
        resolved,
        output: result.text,
        model: result.model,
        provider: result.provider,
        durationMs: result.durationMs,
      });
      const settings = getGenerationSettings(db, request.params.id);
      if (settings.reviewEnabled) {
        const review = await runPreReview(
          llm,
          {
            workspaceName: workspace.name,
            docs: contents,
            taskType: "press_boilerplate",
            channel: "pr",
            channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
            persona: persona ? toResolvePersona(persona) : undefined,
            campaign: campaign ? composeResolveCampaign(campaign) : undefined,
            ...selective,
          },
          result.text,
          settings.flagThreshold,
        );
        setGenerationReview(db, request.params.id, generation.id, review);
      }
      const draft = submitDraft(db, {
        workspaceId: request.params.id,
        sourceGenerationId: generation.id,
        campaignId: parsed.data.campaignId ?? null,
        taskType: "press_boilerplate",
        channel: "pr",
        personaId: parsed.data.personaId ?? null,
        content: result.text,
      }, actorOf(request));
      return reply.status(201).send(draft);
    } catch (err) {
      if (err instanceof GatewayError) {
        return reply.status(502).send({ error: "generation_failed", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { state?: string } }>(
    "/workspaces/:id/pr/export.csv",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const state = (request.query.state ?? "approved") as ApprovalState;
      if (!(APPROVAL_STATES as readonly string[]).includes(state)) {
        return reply.status(400).send({ error: "invalid_state" });
      }
      const contactById = new Map(
        listMediaContacts(db, request.params.id).map((c) => [c.id, c]),
      );
      const rows = db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.workspaceId, request.params.id),
            eq(drafts.state, state),
            isNotNull(drafts.mediaContactId),
          ),
        )
        .all();

      const lines = ["name,email,type,outlet,beat,content"];
      for (const row of rows) {
        const contact = contactById.get(row.mediaContactId!);
        if (!contact) continue;
        lines.push(
          [contact.name, contact.email, contact.type, contact.outlet, contact.beat, row.content]
            .map(csvField)
            .join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="tuezday-pr-${state}.csv"`)
        .send(lines.join("\n"));
    },
  );
}
