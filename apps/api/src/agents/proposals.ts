import type {
  AgentProposalTargetKind,
  Channel,
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
}

export type ProposalResult = ProposalAccepted | ProposalRefusal;

export interface ProposalOrigin {
  /** The agent run that called the tool — the attribution the queue shows. */
  agentRunId: string;
  workspaceId: string;
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
      targetKind: tool === "propose_draft" ? "draft" : "external_action",
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
  };
}
