import { resolveContext, type BrainContents, type ResolvedContext } from "@tuezday/brain";
import type { Channel, ChatPin, ChatSession } from "@tuezday/contracts";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { SafeFetchService } from "../safe-fetch/index";
import { getBrain } from "./brain";
import { getCampaign } from "./campaigns";
import { retrieveEvidence } from "./evidence";
import { resolveChannelGuidance } from "./guidance";
import { composePinnedContext, listChatPins, renderChatPins } from "./chat-pins";
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
  /** The full system string: goal + bundle + pinned context + capability. */
  system: string;
  channel: Channel;
  /** The thread's pins (Sprint 77) — the chips the drawer renders. */
  pins: ChatPin[];
  /**
   * The text of any pin that came from outside the workspace. The turn feeds
   * these to the taint tracker, so a pinned page taints the turn before the
   * model has taken a single step (D-77.6).
   */
  untrustedPinTexts: string[];
}

export interface ChatContextOptions {
  /** Whether this turn's actor may put things forward for confirmation. */
  mayPropose?: boolean;
  /** Needed to resolve `url` pins. Absent means url pins render nothing. */
  safeFetch?: SafeFetchService;
}

/**
 * The capability clause (Sprint 78, D-78.5).
 *
 * It lives here and not in `TASK_INSTRUCTIONS` because what a conversation may
 * DO is a property of this turn's actor, not of the task type: the same thread
 * read by two people with different roles has two different answers, and a
 * static map keyed on task type can only hold one. It still lands in
 * `agent_runs.system`, so it stays fully inspectable in the trace.
 */
export const CHAT_CAPABILITY_PROPOSE =
  "What you can do in this conversation: you can READ everything in this workspace, and you can PUT THINGS FORWARD for the person to confirm — a draft for review, publishing an approved draft, a reply, a sequence step, an ad change. Putting something forward does nothing on its own. It shows them a card; they confirm or decline; only then does it reach the workspace's approval gate and action policy, which decide what actually happens. So: never say something is done, created, queued, scheduled or sent when you have only proposed it. Say what you are asking them to confirm and why. Propose one thing at a time, only when the conversation has actually reached it, and only with details they have given you or you have read — never with invented specifics.";

export const CHAT_CAPABILITY_READ_ONLY =
  "What you can do in this conversation: you can READ everything in this workspace. You cannot change anything — not a draft, not a campaign, not a schedule, and nothing leaves the platform. When the conversation reaches the point of building something, say plainly what you would create and that acting on it is not available to you here. Never imply, in any phrasing, that something was created, queued, scheduled or sent.";

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
  options: ChatContextOptions = {},
): Promise<ChatContext> {
  const workspace = await getWorkspace(db, session.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace ${session.workspaceId}`);

  const channel = session.channel ?? DEFAULT_CHAT_CHANNEL;
  const query = chatRetrievalQuery(session, latestUserMessage);

  // A scope pointing at something deleted degrades to an unscoped thread rather
  // than failing the turn: the founder's conversation outlives the campaign.
  const campaign = session.campaignId
    ? (await getCampaign(db, session.workspaceId, session.campaignId) ?? null)
    : null;
  const persona = session.personaId
    ? (await getPersona(db, session.workspaceId, session.personaId) ?? null)
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

  const { docs } = await getBrain(db, session.workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const channelGuidance = await resolveChannelGuidance(db, session.workspaceId, channel, {
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
    ...await campaignResolveInputs(db, session.workspaceId, campaign),
    ...await selectiveContextInputs(db, session.workspaceId),
    ...await priorExampleInputs(db, session.workspaceId, {
      query,
      channel,
      taskType: "gtm_conversation",
    }),
    ...await preferenceRuleInputs(db, session.workspaceId, {
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
  const capability = options.mayPropose
    ? CHAT_CAPABILITY_PROPOSE
    : CHAT_CAPABILITY_READ_ONLY;

  // Pinned context (Sprint 77) sits between the bundle and the capability
  // clause: it is what THIS conversation is about, narrower than the workspace
  // bundle above it and above the rules that follow.
  const pins = await listChatPins(db, session.id);
  const rendered = await renderChatPins(db, options.safeFetch, session.workspaceId, pins);
  const pinned = composePinnedContext(pins, rendered);

  const system = [
    goal ? `THREAD GOAL: ${goal}` : "",
    resolved.prompt,
    pinned,
    capability,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    resolved,
    system,
    channel,
    pins,
    untrustedPinTexts: rendered.filter((pin) => pin.untrusted).map((pin) => pin.content),
  };
}
