import type { Campaign, Channel, Draft, Persona, Signal } from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
import { composeResolveCampaign } from "./campaigns";
import { submitDraft, type DraftActor } from "./drafts";
import { retrieveEvidence } from "./evidence";
import { getGenerationSettings } from "./generation-settings";
import { storeGeneration } from "./generations";
import { resolveChannelGuidance } from "./guidance";
import { selectiveContextInputs } from "./resolve-input";
import { runPreReview, setGenerationReview } from "./review";

export interface GenerateSignalDraftOptions {
  channel: Channel;
  persona?: Persona;
  campaign?: Campaign;
  useEvidence?: boolean;
  tokenBudget?: number;
}

/**
 * The shared signal→draft pipeline (Sprint 9): resolve context with the signal
 * injected (+ persona/campaign overlays + evidence), generate, store, and submit
 * the draft into review (`pending_review`). Used by the signals route and by the
 * Sprint 28 automation orchestrator so both share one brain-resolved path.
 *
 * Always returns a draft at `pending_review`; the caller decides what happens next
 * (a human approves it, or scheduled-auto auto-approves it through the gate).
 */
export async function generateSignalDraft(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspace: { id: string; name: string },
  signal: Signal,
  opts: GenerateSignalDraftOptions,
  actor: DraftActor,
): Promise<Draft> {
  const evidenceResolution = await retrieveEvidence(
    db,
    evidence,
    workspace.id,
    {
      taskType: "signal_response",
      channel: opts.channel,
      signalContent: signal.content,
      campaignObjective: opts.campaign?.objective,
    },
    opts.useEvidence ?? true,
  );

  const { docs } = getBrain(db, workspace.id);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const channelGuidance = resolveChannelGuidance(db, workspace.id, opts.channel);
  const personaInput = opts.persona
    ? { name: opts.persona.name, description: opts.persona.description, overlay: opts.persona.overlay }
    : undefined;
  const campaignInput = opts.campaign ? composeResolveCampaign(opts.campaign) : undefined;
  const selective = selectiveContextInputs(db, workspace.id);
  const resolved = resolveContext({
    workspaceName: workspace.name,
    docs: contents,
    taskType: "signal_response",
    channel: opts.channel,
    channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
    persona: personaInput,
    campaign: campaignInput,
    signal: { content: signal.content, source: signal.source, sourceUrl: signal.sourceUrl },
    ...selective,
    evidence: evidenceResolution.evidence,
    evidenceExclusionReason: evidenceResolution.exclusionReason,
    tokenBudget: opts.tokenBudget,
  });

  const result = await llm.generate({ prompt: resolved.prompt });
  const generation = storeGeneration(db, {
    workspaceId: workspace.id,
    taskType: "signal_response",
    channel: opts.channel,
    personaId: opts.persona?.id ?? null,
    campaignId: opts.campaign?.id ?? null,
    resolved,
    output: result.text,
    model: result.model,
    provider: result.provider,
    durationMs: result.durationMs,
  });

  const settings = getGenerationSettings(db, workspace.id);
  if (settings.reviewEnabled) {
    const review = await runPreReview(
      llm,
      {
        workspaceName: workspace.name,
        docs: contents,
        taskType: "signal_response",
        channel: opts.channel,
        channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
        persona: personaInput,
        campaign: campaignInput,
        ...selective,
      },
      result.text,
      settings.flagThreshold,
    );
    setGenerationReview(db, workspace.id, generation.id, review);
  }

  return submitDraft(
    db,
    {
      workspaceId: workspace.id,
      sourceGenerationId: generation.id,
      sourceSignalId: signal.id,
      campaignId: opts.campaign?.id ?? null,
      taskType: "signal_response",
      channel: opts.channel,
      personaId: opts.persona?.id ?? null,
      content: result.text,
    },
    actor,
  );
}
