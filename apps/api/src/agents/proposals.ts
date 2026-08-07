import type {
  AgentProposalTargetKind,
  CampaignPurpose,
  Channel,
  ExternalActionOriginSurface,
  ProposeToolName,
  TaskType,
} from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// The propose seam (Sprint 69, D-69.5).
//
// This module is a LEAF on purpose. The five propose tools import this
// interface and nothing else, so `agents/tools/index.ts` — which builds
// TOOLS_BY_NAME at module top-level — never reaches the external-action
// coordinator, the adapters, or `automation.ts` through them. A tool that
// imported the adapters directly would close the Sprint 65 cycle and leave the
// registry half-initialized at load.
//
// The concrete implementation lives in services/agent-proposals.ts and is
// injected on ToolContext, in the same shape as every other external
// dependency in this codebase: an interface with a real default.
// ---------------------------------------------------------------------------

/** Why a propose call could not be honoured. Returned to the model as data —
 * never thrown — so a refused proposal is something it can react to. */
export interface ProposalRefusal {
  ok: false;
  error: string;
  message: string;
  /** What the model could pass to make the same call succeed, when anything. */
  hint?: string;
}

export interface ProposalAccepted {
  ok: true;
  targetKind: AgentProposalTargetKind;
  /** The draft id or external action id the founder can now act on. Null only
   * in a simulated (dry / shadow / eval) run, where nothing was created. */
  id: string | null;
  /** For external actions: where the policy tree left it. */
  status: string;
  /** Human-readable one-liner, mirrored into the proposal ledger. */
  summary: string;
  /** True when this ran in a non-live mode and nothing durable happened. */
  simulated: boolean;
  /**
   * Sprint 78: the call was RECORDED and is waiting on a human to confirm it
   * in the conversation — nothing has reached a gate yet. The tool wrapper
   * uses this to tell the model the truth instead of Sprint 69's "proposed, a
   * human sees it wherever that kind of item is governed".
   */
  awaitingConfirmation?: boolean;
}

export type ProposalResult = ProposalAccepted | ProposalRefusal;

export interface ProposalOrigin {
  /** The agent run that called the tool — the attribution the queue shows. */
  agentRunId: string;
  workspaceId: string;
  /**
   * Sprint 78 (D-78.8): which agent surface asked, carried onto the minted
   * action so the authorization queue can say "proposed in chat" rather than
   * the weaker "proposed by an agent". Absent means the pipeline engine.
   */
  surface?: ExternalActionOriginSurface;
  /** The thread, when the surface is chat — recorded on the Sprint 69 ledger. */
  chatSessionId?: string;
  /**
   * Who confirmed it in the thread. Attribution only: it does NOT make the
   * minted action human-proposed (D-78.7), so the Sprint 52 publish gate and
   * the policy tree behave exactly as they would for a pipeline proposal.
   */
  confirmedByUserId?: string | null;
}

export interface ProposeDraftArgs {
  content: string;
  channel: Channel;
  taskType?: TaskType;
  campaignId?: string;
  personaId?: string;
  rationale: string;
}

export interface ProposePublicationArgs {
  draftId: string;
  scheduledFor?: number;
  target?: string;
  connectionId?: string;
  rationale: string;
}

export interface ProposeReplyArgs {
  inboxItemId: string;
  rationale: string;
}

export interface ProposeSequenceStepArgs {
  launchMessageId: string;
  rationale: string;
}

/**
 * Sprint 77 (D-77.7). A strict subset of `UpsertCampaignInput`: `status`,
 * `origin`, `automationMode` and `autoDailyCap` are absent because they are not
 * the model's to choose. The implementation forces `draft` / `system` /
 * `manual`, and that inertness is the gate.
 */
export interface ProposeCampaignArgs {
  name: string;
  objective?: string;
  kpi?: string;
  timeframe?: string;
  audience?: string;
  pillars?: string[];
  channels?: Channel[];
  personaIds?: string[];
  purpose?: CampaignPurpose;
  rationale: string;
}

export interface ProposeAdMutationArgs {
  launchId: string;
  dailyBudgetCents?: number;
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  rationale: string;
}

export interface AgentProposalService {
  proposeDraft(origin: ProposalOrigin, args: ProposeDraftArgs): Promise<ProposalResult>;
  proposePublication(
    origin: ProposalOrigin,
    args: ProposePublicationArgs,
  ): Promise<ProposalResult>;
  proposeReply(origin: ProposalOrigin, args: ProposeReplyArgs): Promise<ProposalResult>;
  proposeSequenceStep(
    origin: ProposalOrigin,
    args: ProposeSequenceStepArgs,
  ): Promise<ProposalResult>;
  proposeAdMutation(
    origin: ProposalOrigin,
    args: ProposeAdMutationArgs,
  ): Promise<ProposalResult>;
  /** Sprint 77 — creates an inert `draft`-status campaign (D-77.7). */
  proposeCampaign(origin: ProposalOrigin, args: ProposeCampaignArgs): Promise<ProposalResult>;
}

/**
 * The non-live implementation (D-69.6). Dry runs, shadow runs and eval replays
 * get this one: the model sees the identical tool surface — which is what makes
 * a shadow A/B comparison compare two runs of the same agent rather than two
 * different agents — and nothing durable happens.
 *
 * Omitting the tools instead would have been the easier change and the wrong
 * one: an eval replay of eighty historical cases would then measure an agent
 * the founder never runs.
 */
export function simulatedAgentProposals(): AgentProposalService {
  const simulate = (tool: ProposeToolName, summary: string): Promise<ProposalResult> =>
    Promise.resolve({
      ok: true,
      targetKind:
        tool === "propose_draft"
          ? "draft"
          : tool === "propose_campaign"
            ? "campaign"
            : "external_action",
      id: null,
      status: "simulated",
      summary,
      simulated: true,
    });

  return {
    proposeDraft: (_origin, args) =>
      simulate("propose_draft", `Would submit a ${args.channel} draft for review.`),
    proposePublication: (_origin, args) =>
      simulate("propose_publication", `Would propose publishing draft ${args.draftId}.`),
    proposeReply: (_origin, args) =>
      simulate("propose_reply", `Would propose replying to inbox item ${args.inboxItemId}.`),
    proposeSequenceStep: (_origin, args) =>
      simulate(
        "propose_sequence_step",
        `Would propose sending launch message ${args.launchMessageId}.`,
      ),
    proposeAdMutation: (_origin, args) =>
      simulate("propose_ad_mutation", `Would propose an ad mutation on launch ${args.launchId}.`),
    proposeCampaign: (_origin, args) =>
      simulate("propose_campaign", `Would create the campaign "${args.name}" as a draft.`),
  };
}
