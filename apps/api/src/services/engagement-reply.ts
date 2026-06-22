import type { Campaign, Draft, InboxItem, Persona } from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
import { composeCampaignOverlay } from "./campaigns";
import { submitDraft, type DraftActor } from "./drafts";
import { retrieveEvidence } from "./evidence";
import { storeGeneration } from "./generations";

export interface GenerateReplyContext {
  /** Our original post/DM that drew this reply, when known. */
  post?: { title: string; content: string };
  persona?: Persona;
  campaign?: Campaign;
  useEvidence?: boolean;
  tokenBudget?: number;
}

/**
 * The reply→draft pipeline (Sprint 29), mirroring `generateSignalDraft`: resolve
 * context with the inbound **conversation** injected (+ persona/campaign overlays
 * + evidence), generate, store, and submit a reply draft into review
 * (`pending_review`). The caller decides what happens next — a human approves it,
 * or (when the master switch + scheduled_auto campaign allow) it auto-approves.
 */
export async function generateEngagementReply(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  workspace: { id: string; name: string },
  item: InboxItem,
  ctx: GenerateReplyContext,
  actor: DraftActor,
): Promise<Draft> {
  const evidenceResolution = await retrieveEvidence(
    db,
    evidence,
    workspace.id,
    {
      taskType: "engagement_reply",
      channel: item.channel,
      // Retrieve evidence relevant to what the person actually said.
      signalContent: item.content,
      campaignObjective: ctx.campaign?.objective,
    },
    ctx.useEvidence ?? true,
  );

  const { docs } = getBrain(db, workspace.id);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const resolved = resolveContext({
    workspaceName: workspace.name,
    docs: contents,
    taskType: "engagement_reply",
    channel: item.channel,
    persona: ctx.persona
      ? { name: ctx.persona.name, description: ctx.persona.description, overlay: ctx.persona.overlay }
      : undefined,
    campaign: ctx.campaign
      ? { name: ctx.campaign.name, overlay: composeCampaignOverlay(ctx.campaign) }
      : undefined,
    conversation: {
      originalPost: ctx.post?.content,
      inboundAuthor: item.authorHandle || item.authorName || "someone",
      inboundMessage: item.content,
      source: item.providerKey,
    },
    evidence: evidenceResolution.evidence,
    evidenceExclusionReason: evidenceResolution.exclusionReason,
    tokenBudget: ctx.tokenBudget,
  });

  const result = await llm.generate({ prompt: resolved.prompt });
  const generation = storeGeneration(db, {
    workspaceId: workspace.id,
    taskType: "engagement_reply",
    channel: item.channel,
    personaId: ctx.persona?.id ?? null,
    campaignId: ctx.campaign?.id ?? null,
    resolved,
    output: result.text,
    model: result.model,
    provider: result.provider,
    durationMs: result.durationMs,
  });

  return submitDraft(
    db,
    {
      workspaceId: workspace.id,
      sourceGenerationId: generation.id,
      campaignId: ctx.campaign?.id ?? null,
      taskType: "engagement_reply",
      channel: item.channel,
      personaId: ctx.persona?.id ?? null,
      content: result.text,
    },
    actor,
  );
}
