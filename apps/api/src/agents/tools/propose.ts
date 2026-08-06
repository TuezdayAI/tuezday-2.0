import type { z } from "zod";
import { toolInputSchemas } from "@tuezday/contracts";
import type { ProposalOrigin, ProposalResult } from "../proposals";
import type { Tool, ToolContext } from "../registry";

// ---------------------------------------------------------------------------
// The five propose tools (Sprint 69).
//
// Every one of them is a thin call into `ctx.proposals` — the injected seam
// (D-69.5). None of them import the coordinator, the adapters, or any service
// that reaches `automation.ts`, which is what keeps `agents/tools/index.ts` a
// safe top-level module. The gate each proposal lands in already exists; this
// file adds no policy of its own, which is the whole point of the sprint.
// ---------------------------------------------------------------------------

/**
 * A propose tool with no injected service is a tool that could only write
 * ungoverned. It is filtered out of the tool list upstream (D-69.7); this is
 * the belt-and-braces case, and it refuses rather than falling back.
 */
function unavailable(): ProposalResult {
  return {
    ok: false,
    error: "proposals_unavailable",
    message: "This run cannot propose actions.",
  };
}

/**
 * Turn a service result into what the model reads. Refusals are data, so an
 * agent that pointed at the wrong draft can correct itself and try again
 * rather than losing the step.
 */
async function propose(
  ctx: ToolContext,
  call: (service: NonNullable<ToolContext["proposals"]>, origin: ProposalOrigin) => Promise<ProposalResult>,
): Promise<unknown> {
  if (!ctx.proposals || !ctx.agentRunId) return unavailable();
  const result = await call(ctx.proposals, {
    agentRunId: ctx.agentRunId,
    workspaceId: ctx.workspaceId,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    id: result.id,
    status: result.status,
    summary: result.summary,
    simulated: result.simulated,
    ...(result.awaitingConfirmation ? { awaitingConfirmation: true } : {}),
    // Sprint 78: in a conversation the call is recorded, not executed, and the
    // person decides. Saying "proposed" there would be a lie the model would
    // repeat to them.
    note: result.awaitingConfirmation
      ? "Recorded and shown to the person as something to confirm. NOTHING has happened yet and nothing will until they confirm it. Tell them plainly what you are asking for and why; do not call this again for the same thing, and do not describe it as done."
      : result.simulated
        ? "This run is not live, so nothing was created. Continue as if it had been."
        : "Proposed. A human sees it wherever that kind of item is governed; do not propose it again.",
  };
}

const draftInput = toolInputSchemas.propose_draft;
type DraftInput = z.infer<typeof draftInput>;

export const proposeDraftTool: Tool<DraftInput, unknown> = {
  name: "propose_draft",
  description:
    "Submit written content to the founder's approval queue as a draft. Use this when you have written something worth a human reading; it never publishes or sends. Requires the finished content, the channel it is for, and a one-line rationale the founder will see.",
  input: draftInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposeDraft(origin, args)),
};

const publicationInput = toolInputSchemas.propose_publication;
type PublicationInput = z.infer<typeof publicationInput>;

export const proposePublicationTool: Tool<PublicationInput, unknown> = {
  name: "propose_publication",
  description:
    "Propose publishing an already-approved draft to its social account. The draft must have cleared the approval queue — unapproved content is refused. The workspace's action policy decides whether it posts or waits for a human to authorize it. Routing is resolved for you; pass a target only if asked to.",
  input: publicationInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposePublication(origin, args)),
};

const replyInput = toolInputSchemas.propose_reply;
type ReplyInput = z.infer<typeof replyInput>;

export const proposeReplyTool: Tool<ReplyInput, unknown> = {
  name: "propose_reply",
  description:
    "Propose posting the approved reply for one inbox item. The reply draft must already exist and be approved. The action policy decides whether it posts or waits for authorization.",
  input: replyInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposeReply(origin, args)),
};

const sequenceInput = toolInputSchemas.propose_sequence_step;
type SequenceInput = z.infer<typeof sequenceInput>;

export const proposeSequenceStepTool: Tool<SequenceInput, unknown> = {
  name: "propose_sequence_step",
  description:
    "Propose sending one outbound sequence message that is already drafted and approved. Recipient safety, suppression and the verified sender are checked by the platform, not by you.",
  input: sequenceInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposeSequenceStep(origin, args)),
};

const adInput = toolInputSchemas.propose_ad_mutation;
type AdInput = z.infer<typeof adInput>;

export const proposeAdMutationTool: Tool<AdInput, unknown> = {
  name: "propose_ad_mutation",
  description:
    "Propose changing a live ad launch: either its daily budget (dailyBudgetCents) or its targeting (countries and/or an age range) — exactly one of the two per call. Spend changes are governed by the workspace's action policy.",
  input: adInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposeAdMutation(origin, args)),
};

const campaignInput = toolInputSchemas.propose_campaign;
type CampaignInput = z.infer<typeof campaignInput>;

/**
 * Sprint 77 (D-77.7). The sixth propose tool, and the first whose gate is the
 * created record's own status rather than a queue: a `draft`-status campaign
 * runs no automation, matches no discovery signals and is refused by
 * `campaignExecutionError` until a human activates it on the campaign page.
 *
 * The description says so plainly, because a model that believed this launched
 * something would report it as launched.
 */
export const proposeCampaignTool: Tool<CampaignInput, unknown> = {
  name: "propose_campaign",
  description:
    "Create a new campaign as a DRAFT for the founder to review and activate. Use this when the user wants a campaign that does not exist yet. It creates the campaign record only — nothing is generated, published, sent or automated, and the campaign stays inert until a human activates it. Give it a name and as much of the objective, KPI, timeframe, audience, pillars and channels as the conversation actually established; do not invent the rest.",
  input: campaignInput,
  access: "propose",
  run: (ctx, args) => propose(ctx, (service, origin) => service.proposeCampaign(origin, args)),
};
