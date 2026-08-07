import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  AGENT_PROPOSALS_PER_DAY,
  upsertCampaignInputSchema,
  type AgentProposalTargetKind,
  type Channel,
  type ProposeToolName,
} from "@tuezday/contracts";
import type {
  AgentProposalService,
  ProposalOrigin,
  ProposalResult,
  ProposeAdMutationArgs,
  ProposeCampaignArgs,
  ProposeDraftArgs,
  ProposePublicationArgs,
  ProposeReplyArgs,
  ProposeSequenceStepArgs,
} from "../agents/proposals";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import { launchMessages } from "../db/schema";
import { estimateTokens } from "@tuezday/brain";
import { getLaunch } from "./ad-launches";
import { createCampaign } from "./campaigns";
import { countProposalsToday, recordAgentProposal } from "./agent-proposal-ledger";
import { deriveTitle } from "./cadences";
import { getDraft, submitDraft } from "./drafts";
import {
  ExternalActionPreparationError,
  deriveReplyIdempotencyKey,
  prepareBudgetChangeAction,
  preparePublicationAction,
  prepareReplyAction,
  prepareTargetingChangeAction,
} from "./external-action-adapters";
import {
  ExternalActionIdempotencyConflictError,
  type ExternalActionCommand,
  type ExternalActionRuntime,
} from "./external-action-coordinator";
import {
  deriveEmailSendIdempotencyKey,
  prepareEmailAction,
} from "./external-action-email";
import { storeGeneration } from "./generations";
import { getInboxItem } from "./inbox";
import { resolvePersonaSocialConnection } from "./persona-social-accounts";
import { listPublications } from "./publications";

// ---------------------------------------------------------------------------
// The propose seam's live implementation (Sprint 69).
//
// Every method here does the same three things: build a command with the SAME
// builder the human route uses, hand it to the SAME runtime, and record what
// happened in the proposal ledger. No policy is decided in this file — that is
// the entire point of the sprint. If a proposal is refused, it is refused by a
// gate that was already refusing it before an agent existed.
//
// This module is deliberately NOT a leaf; it is injected into ToolContext so
// that the tools themselves can be (D-69.5).
// ---------------------------------------------------------------------------

export interface AgentProposalDeps {
  db: Db;
  runtime: ExternalActionRuntime;
  fabric: ConnectorFabric;
  fetcher: typeof fetch;
}

/**
 * A deterministic idempotency key for the ad-mutation proposals, whose contract
 * requires a UUID (the ads routes mint one per click). A random one would let a
 * retrying agent stack two identical budget changes in the queue; hashing the
 * intent means the second call returns the first action, exactly as every other
 * propose path already behaves.
 */
function derivedUuid(...parts: (string | number)[]): string {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function refuse(error: string, message: string, hint?: string): ProposalResult {
  return { ok: false, error, message, ...(hint ? { hint } : {}) };
}

/**
 * A preparation error is the existing gate speaking — "that draft is not
 * approved", "no verified sender", "the launch already went out". Passing its
 * own code and message through unaltered is the honest thing: the model reads
 * the same refusal a founder would see on the route, and we avoid inventing a
 * second vocabulary for conditions the platform already names.
 */
function refuseFromError(error: unknown): ProposalResult {
  if (error instanceof ExternalActionPreparationError) {
    return refuse(error.code, error.message);
  }
  if (error instanceof ExternalActionIdempotencyConflictError) {
    return refuse(
      "already_proposed",
      "An action for this subject already exists with different details.",
    );
  }
  throw error;
}

export function createAgentProposals(deps: AgentProposalDeps): AgentProposalService {
  const { db, runtime, fabric, fetcher } = deps;

  async function record(
    origin: ProposalOrigin,
    tool: ProposeToolName,
    target: {
      kind: AgentProposalTargetKind;
      draftId?: string;
      externalActionId?: string;
      campaignId?: string;
    },
    summary: string,
    rationale: string,
  ): Promise<void> {
    await recordAgentProposal(db, {
      workspaceId: origin.workspaceId,
      agentRunId: origin.agentRunId,
      tool,
      targetKind: target.kind,
      draftId: target.draftId ?? null,
      externalActionId: target.externalActionId ?? null,
      campaignId: target.campaignId ?? null,
      summary,
      rationale,
      chatSessionId: origin.chatSessionId ?? null,
    });
  }

  /** The daily cap (D-69.8). Read before any command is built, so a capped
   * workspace never touches an adapter. */
  async function capped(origin: ProposalOrigin): Promise<ProposalResult | null> {
    const used = await countProposalsToday(db, origin.workspaceId);
    if (used < AGENT_PROPOSALS_PER_DAY) return null;
    return refuse(
      "proposal_cap_reached",
      `This workspace has already made ${used} agent proposals in the last 24 hours.`,
      "Summarise what you would have proposed and leave it for a human.",
    );
  }

  /**
   * The shared tail for the four external-action tools: propose through the
   * runtime, record the ledger row, report where the policy tree left it.
   * `runtime.propose` — not `proposeForReview` (D-69.1): under `human_required`
   * the action parks, under `autonomous` it goes, and it is gated identically
   * to the same action proposed by a person.
   */
  async function proposeAction(
    origin: ProposalOrigin,
    tool: ProposeToolName,
    command: ExternalActionCommand,
    summary: string,
    rationale: string,
  ): Promise<ProposalResult> {
    const submission = await runtime.propose(command, {
      userId: null,
      // Sprint 78 (D-78.7): a founder confirming in chat is attribution, not
      // humanity — `human: false` keeps the Sprint 52 publish gate and the
      // policy tree behaving exactly as they do for a pipeline proposal.
      label: `agent:${origin.agentRunId}`,
      human: false,
      origin: "agent",
      originRunId: origin.agentRunId,
      originSurface: origin.surface ?? "pipeline",
    });
    await record(
      origin,
      tool,
      { kind: "external_action", externalActionId: submission.action.id },
      summary,
      rationale,
    );
    return {
      ok: true,
      targetKind: "external_action",
      id: submission.action.id,
      status: submission.action.status,
      summary,
      simulated: false,
    };
  }

  return {
    async proposeDraft(origin, args: ProposeDraftArgs): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      // D-69.2: a draft is not an external action, so this lands in the
      // approval gate rather than the policy tree. The generation exists so the
      // draft has provenance in Review like every other draft — the trace names
      // the run and the reason, which is all the agent actually contributed.
      const trace = `Written by agent run ${origin.agentRunId}.\n\nReason given: ${args.rationale}`;
      const generation = await storeGeneration(db, {
        workspaceId: origin.workspaceId,
        taskType: args.taskType ?? "signal_response",
        channel: args.channel as Channel,
        personaId: args.personaId ?? null,
        campaignId: args.campaignId ?? null,
        resolved: {
          sections: [
            {
              key: "agent:rationale",
              layer: "task",
              title: "Why the agent proposed this",
              content: trace,
              included: true,
              reason: "Stated by the agent when it called propose_draft.",
              tokens: estimateTokens(trace),
            },
          ],
          includedTokens: estimateTokens(trace),
          tokenBudget: 0,
          overBudget: false,
          prompt: args.rationale,
          resolveMode: "draft",
        },
        output: args.content,
        model: "agent",
        provider: "agent",
        durationMs: 0,
      });
      const draft = await submitDraft(
        db,
        {
          workspaceId: origin.workspaceId,
          sourceGenerationId: generation.id,
          campaignId: args.campaignId ?? null,
          taskType: args.taskType ?? "signal_response",
          channel: args.channel as Channel,
          personaId: args.personaId ?? null,
          content: args.content,
        },
        // Never `human: true` — a machine-written draft must not be able to
        // collapse the Sprint 52 publish gate on its own authority.
        { userId: null, label: `agent:${origin.agentRunId}`, human: false },
      );
      const summary = `Submitted a ${args.channel} draft for review.`;
      await record(origin, "propose_draft", { kind: "draft", draftId: draft.id }, summary, args.rationale);
      return {
        ok: true,
        targetKind: "draft",
        id: draft.id,
        status: draft.state,
        summary,
        simulated: false,
      };
    },

    async proposePublication(
      origin,
      args: ProposePublicationArgs,
    ): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      const draft = await getDraft(db, origin.workspaceId, args.draftId);
      if (!draft) return refuse("draft_not_found", `No draft ${args.draftId} in this workspace.`);

      // D-69.9: routing is the platform's job when the model does not name a
      // connection — asking a model for a connection UUID means either a
      // hallucination or a new read tool that enumerates credentials to
      // something that just read a web page. When it *does* name one, it goes
      // straight to publishIntent, which validates it exactly as it validates
      // a human's choice on the route. No second opinion is added here.
      let connectionId = args.connectionId;
      if (!connectionId) {
        const routed = await resolvePersonaSocialConnection(db, origin.workspaceId, {
          personaId: draft.personaId,
          channel: draft.channel,
        });
        if (!routed.ok) {
          return refuse(
            routed.error,
            "This draft has no social account it can publish from.",
            "Ask a human to assign a primary social account to the draft's persona, or pass connectionId.",
          );
        }
        connectionId = routed.connection.id;
      }
      const target =
        args.target ??
        (await listPublications(db, origin.workspaceId)).find(
          (publication) =>
            publication.connectionId === connectionId && publication.status === "published",
        )?.target;
      if (!target) {
        return refuse(
          "target_unknown",
          "This account has no previous successful publication to copy a destination from.",
          "Pass `target` explicitly (for example the subreddit or page to post to).",
        );
      }

      try {
        const command = await preparePublicationAction(
          db,
          origin.workspaceId,
          draft.id,
          {
            connectionId,
            target,
            title: deriveTitle(draft.content),
            ...(args.scheduledFor ? { scheduledFor: args.scheduledFor } : {}),
          },
          { idempotencyKey: `agent:publish:${draft.id}:${args.scheduledFor ?? 0}` },
        );
        return await proposeAction(
          origin,
          "propose_publication",
          command,
          `Proposed publishing "${deriveTitle(draft.content)}" to ${target}.`,
          args.rationale,
        );
      } catch (error) {
        return refuseFromError(error);
      }
    },

    async proposeReply(origin, args: ProposeReplyArgs): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      const item = await getInboxItem(db, origin.workspaceId, args.inboxItemId);
      if (!item) {
        return refuse("inbox_item_not_found", `No inbox item ${args.inboxItemId}.`);
      }
      if (item.postedReplyExternalId) {
        return refuse("already_replied", "This item has already been replied to.");
      }
      if (!item.replyDraftId) {
        return refuse(
          "reply_not_approved",
          "This item has no reply draft yet.",
          "Draft a reply and get it approved before proposing to post it.",
        );
      }
      const draft = await getDraft(db, origin.workspaceId, item.replyDraftId);
      if (!draft || draft.state !== "approved") {
        return refuse(
          "reply_not_approved",
          "The reply draft has not cleared the approval queue.",
          "A human approves the reply first; only then can it be posted.",
        );
      }
      try {
        const command = await prepareReplyAction(db, origin.workspaceId, item.id, {
          idempotencyKey: deriveReplyIdempotencyKey(item.id, draft),
          automated: false,
        });
        return await proposeAction(
          origin,
          "propose_reply",
          command,
          `Proposed replying to ${item.authorHandle ?? "an inbox item"}.`,
          args.rationale,
        );
      } catch (error) {
        return refuseFromError(error);
      }
    },

    async proposeSequenceStep(
      origin,
      args: ProposeSequenceStepArgs,
    ): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      const message = await db
        .select()
        .from(launchMessages)
        .where(
          and(
            eq(launchMessages.workspaceId, origin.workspaceId),
            eq(launchMessages.id, args.launchMessageId),
          ),
        )
        .get();
      if (!message) {
        return refuse("launch_message_not_found", `No sequence message ${args.launchMessageId}.`);
      }
      if (message.status === "sent") {
        return refuse("already_sent", "This sequence message has already gone out.");
      }
      const draft = message.draftId ? await getDraft(db, origin.workspaceId, message.draftId) : undefined;
      if (!draft || draft.state !== "approved") {
        return refuse(
          "message_not_approved",
          "This sequence message has no approved draft.",
          "The message's draft clears Review before it can be sent.",
        );
      }
      try {
        const command = await prepareEmailAction(db, origin.workspaceId, {
          origin: "launch_message",
          originId: message.id,
          idempotencyKey: deriveEmailSendIdempotencyKey(message.id, {
            draftId: draft.id,
            content: draft.content,
            stepNumber: message.stepNumber,
          }),
        });
        return await proposeAction(
          origin,
          "propose_sequence_step",
          command,
          `Proposed sending step ${message.stepNumber} to ${message.recipientEmail || message.recipientName}.`,
          args.rationale,
        );
      } catch (error) {
        return refuseFromError(error);
      }
    },

    /**
     * Sprint 77 (D-77.7). The one propose tool whose gate is the created
     * record's own status. `upsertCampaignInputSchema.parse` supplies every
     * default, and the four fields that decide whether a campaign DOES anything
     * — status, origin, automation mode, daily cap — are overwritten here after
     * parsing rather than taken from the model. A campaign in `draft` runs no
     * automation, invalidates no matching, and is refused by
     * `campaignExecutionError`; it exists on /campaigns for a human to finish
     * and activate, which is the whole of the guarantee.
     */
    async proposeCampaign(origin, args: ProposeCampaignArgs): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      const parsed = upsertCampaignInputSchema.safeParse({
        name: args.name,
        purpose: args.purpose ?? "initiative",
        objective: args.objective ?? "",
        kpi: args.kpi ?? "",
        timeframe: args.timeframe ?? "",
        audience: args.audience ?? "",
        pillars: args.pillars ?? [],
        channels: args.channels ?? [],
        // Personas are validated as uuids by the campaign contract; a model
        // that guessed an id gets the contract's own refusal rather than a
        // campaign silently missing the persona it was told to use.
        personaIds: args.personaIds ?? [],
      });
      if (!parsed.success) {
        return refuse(
          "invalid_arguments",
          parsed.error.issues.map((issue) => issue.message).join("; "),
          "Pass a valid campaign name, and persona ids taken from list_personas.",
        );
      }

      const campaign = await createCampaign(
        db,
        origin.workspaceId,
        {
          ...parsed.data,
          // Not negotiable, whatever was parsed: this is the gate.
          status: "draft",
          automationMode: "manual",
          autoDailyCap: null,
        },
        { origin: "system" },
      );
      const summary = `Created the campaign "${campaign.name}" as a draft.`;
      await record(
        origin,
        "propose_campaign",
        { kind: "campaign", campaignId: campaign.id },
        summary,
        args.rationale,
      );
      return {
        ok: true,
        targetKind: "campaign",
        id: campaign.id,
        status: campaign.status,
        summary,
        simulated: false,
      };
    },

    async proposeAdMutation(origin, args: ProposeAdMutationArgs): Promise<ProposalResult> {
      const capReached = await capped(origin);
      if (capReached) return capReached;

      const wantsBudget = args.dailyBudgetCents !== undefined;
      const wantsTargeting =
        args.countries !== undefined || args.ageMin !== undefined || args.ageMax !== undefined;
      if (wantsBudget === wantsTargeting) {
        return refuse(
          "invalid_arguments",
          "Change either the budget or the targeting, not both and not neither.",
          "Pass dailyBudgetCents, or all of countries, ageMin and ageMax.",
        );
      }
      const launch = await getLaunch(db, origin.workspaceId, args.launchId);
      if (!launch) return refuse("launch_not_found", `No ad launch ${args.launchId}.`);

      try {
        if (wantsBudget) {
          const command = await prepareBudgetChangeAction(
            db,
            fabric,
            fetcher,
            origin.workspaceId,
            launch.id,
            {
              dailyBudgetCents: args.dailyBudgetCents!,
              idempotencyKey: derivedUuid("budget", launch.id, args.dailyBudgetCents!),
            },
          );
          return await proposeAction(
            origin,
            "propose_ad_mutation",
            command,
            `Proposed a daily budget of ${(args.dailyBudgetCents! / 100).toFixed(2)} on "${launch.name}".`,
            args.rationale,
          );
        }
        // A targeting change replaces the whole spec at the ads API, so a
        // partial one would silently reset the fields it left out.
        if (args.countries === undefined || args.ageMin === undefined || args.ageMax === undefined) {
          return refuse(
            "invalid_arguments",
            "A targeting change replaces the whole targeting spec.",
            "Pass countries, ageMin and ageMax together.",
          );
        }
        const command = await prepareTargetingChangeAction(
          db,
          fabric,
          fetcher,
          origin.workspaceId,
          launch.id,
          {
            countries: args.countries,
            ageMin: args.ageMin,
            ageMax: args.ageMax,
            idempotencyKey: derivedUuid(
              "targeting",
              launch.id,
              args.countries.join(","),
              args.ageMin,
              args.ageMax,
            ),
          },
        );
        return await proposeAction(
          origin,
          "propose_ad_mutation",
          command,
          `Proposed new targeting (${args.countries.join(", ")}, ${args.ageMin}–${args.ageMax}) on "${launch.name}".`,
          args.rationale,
        );
      } catch (error) {
        return refuseFromError(error);
      }
    },
  };
}
