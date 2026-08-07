import { resolveContext, type BrainContents, type ResolvedContext } from "@tuezday/brain";
import type { Channel, ChatSession } from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import { getBrain } from "./brain";
import { getCampaign } from "./campaigns";
import { retrieveEvidence } from "./evidence";
import { resolveChannelGuidance } from "./guidance";
import { getPersona, toResolvePersona } from "./personas";
import {
  campaignResolveInputs,
  preferenceRuleInputs,
  priorExampleInputs,
  selectiveContextInputs,
} from "./resolve-input";
import { getWorkspace } from "./workspaces";

// ---------------------------------------------------------------------------
// A chat thread's system prefix (Sprint 76).
//
// This is the whole reason chat is not "a chatbot pointed at an export": the
// prefix is a bundle from the SAME Context Resolver every generating surface
// goes through, assembled from the SAME helpers routes/generations.ts uses.
// The thread's scope binding (campaign / persona / channel) is what a
// generation request's parameters are — so a thread scoped to the launch
// campaign sees exactly the context a draft for that campaign would.
//
// The task type is `gtm_conversation`, which owns its own row of the context
// matrix (ICP and history in full: a strategy conversation is about the
// audience and about what already shipped) and its own TASK_INSTRUCTIONS entry
// in packages/brain — the conversation directive. That directive is therefore
// inspectable in /resolver like every other task instruction, rather than
// hidden in this service.
// ---------------------------------------------------------------------------

/** The channel a thread with no channel binding resolves against. */
export const DEFAULT_CHAT_CHANNEL: Channel = "web";

export interface ChatContext {
  resolved: ResolvedContext;
  /** The full system string handed to the runner: bundle + the thread's goal. */
  system: string;
  channel: Channel;
}

/**
 * The retrieval query a thread's evidence, examples and preference lookups run
 * against. A thread's standing intent is its goal; before a goal exists the
 * latest user message is the best available statement of what this is about.
 */
export function chatRetrievalQuery(session: ChatSession, latestUserMessage: string): string {
  const parts = [session.goal.trim(), latestUserMessage.trim()].filter(Boolean);
  return parts.join(" — ").slice(0, 500);
}

export async function buildChatContext(
  db: Db,
  evidence: EvidenceStore,
  session: ChatSession,
  latestUserMessage: string,
): Promise<ChatContext> {
  const workspace = getWorkspace(db, session.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace ${session.workspaceId}`);

  const channel = session.channel ?? DEFAULT_CHAT_CHANNEL;
  const query = chatRetrievalQuery(session, latestUserMessage);

  // A scope pointing at something deleted degrades to an unscoped thread rather
  // than failing the turn: the founder's conversation outlives the campaign.
  const campaign = session.campaignId
    ? (getCampaign(db, session.workspaceId, session.campaignId) ?? null)
    : null;
  const persona = session.personaId
    ? (getPersona(db, session.workspaceId, session.personaId) ?? null)
    : null;

  const evidenceResolution = await retrieveEvidence(
    db,
    evidence,
    session.workspaceId,
    {
      taskType: "gtm_conversation",
      channel,
      campaignObjective: campaign?.objective,
      conversation: query,
    },
    true,
  );

  const { docs } = getBrain(db, session.workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const channelGuidance = resolveChannelGuidance(db, session.workspaceId, channel, {
    personaId: session.personaId,
    campaignId: session.campaignId,
  });

  const resolved = resolveContext({
    workspaceName: workspace.name,
    docs: contents,
    taskType: "gtm_conversation",
    channel,
    channelGuidance: {
      content: channelGuidance.content,
      source: channelGuidance.source,
      scope: channelGuidance.scopeLabel,
    },
    persona: persona ? toResolvePersona(persona) : undefined,
    ...campaignResolveInputs(db, session.workspaceId, campaign),
    ...selectiveContextInputs(db, session.workspaceId),
    ...priorExampleInputs(db, session.workspaceId, {
      query,
      channel,
      taskType: "gtm_conversation",
    }),
    ...preferenceRuleInputs(db, session.workspaceId, {
      channel,
      taskType: "gtm_conversation",
    }),
    evidence: evidenceResolution.evidence,
    evidenceExclusionReason: evidenceResolution.exclusionReason,
  });

  // The goal rides ahead of the bundle rather than inside it: it is the user's
  // standing intent for this thread, not workspace context, and the resolver
  // has no layer that means "what this conversation is for".
  const goal = session.goal.trim();
  const system = goal
    ? `THREAD GOAL: ${goal}\n\n${resolved.prompt}`
    : resolved.prompt;

  return { resolved, system, channel };
}
