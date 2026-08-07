import { randomUUID } from "node:crypto";
import { and, asc, eq, gte } from "drizzle-orm";
import {
  CHAT_PROPOSALS_PER_DAY,
  CHAT_PROPOSALS_PER_THREAD,
  toolInputSchemas,
  type ChatProposal,
  type ChatProposalIntent,
  type ChatProposalStatus,
  type ProposeToolName,
} from "@tuezday/contracts";
import type {
  AgentProposalService,
  ProposalOrigin,
  ProposalResult,
} from "../agents/proposals";
import type { Db } from "../db";
import { chatProposals, type ChatProposalRow } from "../db/schema";
import { getLaunch } from "./ad-launches";
import { appendMessage } from "./chat";
import { buildProposalIntent, type IntentNames } from "./chat-proposal-intent";
import type { TaintTracker } from "./chat-quarantine";
import { getCampaign } from "./campaigns";
import { deriveTitle } from "./cadences";
import { getDraft } from "./drafts";
import { getPersona } from "./personas";

// ---------------------------------------------------------------------------
// Confirm-before-propose (Sprint 78).
//
// A propose-tool call inside a chat turn records one of these and returns. The
// run finishes. Nothing has touched the Sprint 69 gate, the policy tree, the
// approval queue or an external system, and nothing will until a human
// confirms in the thread (D-78.1).
//
// On confirmation this module calls `services/agent-proposals.ts` — the SAME
// implementation the pipeline engine calls, injected rather than imported, and
// not modified by this sprint. Every precondition, every refusal and every
// policy decision therefore comes from the gate that was already deciding them
// before chat could write (D-78.2).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIntent(json: string): ChatProposalIntent {
  try {
    return JSON.parse(json) as ChatProposalIntent;
  } catch {
    return {
      title: "Unreadable proposal",
      detail: [],
      effect: "This proposal's details could not be read back and it cannot be confirmed.",
      rationale: "",
    };
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function rowToChatProposal(row: ChatProposalRow): ChatProposal {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    messageId: row.messageId,
    agentRunId: row.agentRunId,
    tool: row.tool as ProposeToolName,
    intent: parseIntent(row.intentJson),
    status: row.status as ChatProposalStatus,
    quarantined: row.quarantined,
    quarantineReason: row.quarantineReason,
    producedRef: row.producedRef,
    producedStatus: row.producedStatus,
    error: row.error,
    errorMessage: row.errorMessage,
    confirmedByUserId: row.confirmedByUserId,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listChatProposals(db: Db, sessionId: string): ChatProposal[] {
  return db
    .select()
    .from(chatProposals)
    .where(eq(chatProposals.sessionId, sessionId))
    .orderBy(asc(chatProposals.createdAt))
    .all()
    .map(rowToChatProposal);
}

export function getChatProposal(
  db: Db,
  workspaceId: string,
  proposalId: string,
): ChatProposal | undefined {
  const row = db
    .select()
    .from(chatProposals)
    .where(and(eq(chatProposals.workspaceId, workspaceId), eq(chatProposals.id, proposalId)))
    .get();
  return row ? rowToChatProposal(row) : undefined;
}

/** Every proposal a thread has ever recorded — the per-thread cap's count. */
export function countChatProposalsForThread(db: Db, sessionId: string): number {
  return db
    .select({ id: chatProposals.id })
    .from(chatProposals)
    .where(eq(chatProposals.sessionId, sessionId))
    .all().length;
}

/** Chat proposals recorded workspace-wide in the trailing 24 hours. */
export function countChatProposalsToday(db: Db, workspaceId: string, now = Date.now()): number {
  return db
    .select({ id: chatProposals.id })
    .from(chatProposals)
    .where(
      and(
        eq(chatProposals.workspaceId, workspaceId),
        gte(chatProposals.createdAt, now - DAY_MS),
      ),
    )
    .all().length;
}

/**
 * Hang a turn's proposals under the assistant message once it exists. The
 * proposals are recorded mid-run, before there is a message to point at.
 */
export function attachProposalsToMessage(db: Db, ids: string[], messageId: string): void {
  for (const id of ids) {
    db.update(chatProposals).set({ messageId }).where(eq(chatProposals.id, id)).run();
  }
}

// ---------------------------------------------------------------------------
// The recorder — an AgentProposalService that records instead of executing
// ---------------------------------------------------------------------------

export interface ChatProposalRecorderContext {
  workspaceId: string;
  sessionId: string;
  /** Decides whether a proposal derives only from untrusted content (D-78.6). */
  taint: TaintTracker;
  /** Called once per recorded proposal — the turn streams it and collects the id. */
  onRecorded?: (proposal: ChatProposal) => void;
  now?: () => number;
}

/**
 * Names for the ids the model passed, looked up here rather than in the pure
 * intent builder. Failure to resolve one is not an error: the card shows the
 * raw id, which is still checkable, and the confirmation path will refuse a
 * bad id with the platform's own message.
 */
function namesFor(db: Db, workspaceId: string, args: Record<string, unknown>): IntentNames {
  const names: IntentNames = {};
  if (typeof args.campaignId === "string") {
    names.campaignName = getCampaign(db, workspaceId, args.campaignId)?.name ?? null;
  }
  if (typeof args.personaId === "string") {
    names.personaName = getPersona(db, workspaceId, args.personaId)?.name ?? null;
  }
  if (typeof args.draftId === "string") {
    const draft = getDraft(db, workspaceId, args.draftId);
    names.draftTitle = draft ? deriveTitle(draft.content) : null;
  }
  if (typeof args.launchId === "string") {
    names.launchName = getLaunch(db, workspaceId, args.launchId)?.name ?? null;
  }
  return names;
}

export function createChatProposalRecorder(
  db: Db,
  ctx: ChatProposalRecorderContext,
): AgentProposalService {
  const now = ctx.now ?? Date.now;

  /**
   * The two chat caps (D-78.4), checked before recording rather than at
   * confirmation, because a model that has hit them will otherwise keep
   * proposing into a queue nobody can act on. Returned as data, never thrown —
   * the model reads the refusal and wraps up.
   */
  function capped(): ProposalResult | null {
    const thread = countChatProposalsForThread(db, ctx.sessionId);
    if (thread >= CHAT_PROPOSALS_PER_THREAD) {
      return {
        ok: false,
        error: "chat_proposal_cap_reached",
        message: `This conversation has already put ${thread} things forward for confirmation.`,
        hint: "Summarise what is left to do and let them work through what is already on the table, or start a new conversation.",
      };
    }
    const today = countChatProposalsToday(db, ctx.workspaceId, now());
    if (today >= CHAT_PROPOSALS_PER_DAY) {
      return {
        ok: false,
        error: "chat_proposal_cap_reached",
        message: `This workspace has proposed ${today} things in chat in the last 24 hours.`,
        hint: "Say what you would have proposed and leave it for tomorrow.",
      };
    }
    return null;
  }

  function record(
    origin: ProposalOrigin,
    tool: ProposeToolName,
    args: Record<string, unknown>,
  ): ProposalResult {
    const capReached = capped();
    if (capReached) return capReached;

    const intent = buildProposalIntent(tool, args, namesFor(db, ctx.workspaceId, args));
    const verdict = ctx.taint.assess(args);

    const row: ChatProposalRow = {
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      messageId: null,
      agentRunId: origin.agentRunId,
      tool,
      argsJson: JSON.stringify(args),
      intentJson: JSON.stringify(intent),
      status: "pending",
      quarantined: verdict.quarantined,
      quarantineReason: verdict.reason,
      producedRef: null,
      producedStatus: null,
      error: null,
      errorMessage: null,
      confirmedByUserId: null,
      resolvedAt: null,
      createdAt: now(),
    };
    db.insert(chatProposals).values(row).run();
    const proposal = rowToChatProposal(row);
    ctx.onRecorded?.(proposal);

    return {
      ok: true,
      targetKind:
        tool === "propose_draft"
          ? "draft"
          : tool === "propose_campaign"
            ? "campaign"
            : "external_action",
      id: proposal.id,
      status: "awaiting_confirmation",
      summary: intent.title,
      simulated: false,
      awaitingConfirmation: true,
    };
  }

  return {
    proposeDraft: (origin, args) =>
      Promise.resolve(record(origin, "propose_draft", { ...args })),
    proposePublication: (origin, args) =>
      Promise.resolve(record(origin, "propose_publication", { ...args })),
    proposeReply: (origin, args) =>
      Promise.resolve(record(origin, "propose_reply", { ...args })),
    proposeSequenceStep: (origin, args) =>
      Promise.resolve(record(origin, "propose_sequence_step", { ...args })),
    proposeAdMutation: (origin, args) =>
      Promise.resolve(record(origin, "propose_ad_mutation", { ...args })),
    proposeCampaign: (origin, args) =>
      Promise.resolve(record(origin, "propose_campaign", { ...args })),
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ChatProposalActor {
  userId: string | null;
  label: string;
}

export type ResolveChatProposalOutcome =
  | { ok: true; proposal: ChatProposal }
  | { ok: false; error: "not_found" | "already_resolved"; proposal?: ChatProposal };

function resolveRow(
  db: Db,
  id: string,
  patch: Partial<ChatProposalRow>,
): ChatProposal | undefined {
  db.update(chatProposals).set(patch).where(eq(chatProposals.id, id)).run();
  const row = db.select().from(chatProposals).where(eq(chatProposals.id, id)).get();
  return row ? rowToChatProposal(row) : undefined;
}

/**
 * Execute a pending proposal through the live Sprint 69 service.
 *
 * The arguments are re-validated against the tool's own schema before dispatch:
 * the row was written by a previous process and a shape that no longer parses
 * must fail here, legibly, rather than reach an adapter half-formed.
 */
export async function confirmChatProposal(
  db: Db,
  live: AgentProposalService,
  workspaceId: string,
  actor: ChatProposalActor,
  proposalId: string,
): Promise<ResolveChatProposalOutcome> {
  const existing = getChatProposal(db, workspaceId, proposalId);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "pending") {
    return { ok: false, error: "already_resolved", proposal: existing };
  }

  const row = db.select().from(chatProposals).where(eq(chatProposals.id, proposalId)).get()!;
  const parsed = toolInputSchemas[existing.tool].safeParse(parseArgs(row.argsJson));
  const at = Date.now();

  if (!parsed.success) {
    const failed = fail(db, existing, actor, at, {
      error: "invalid_arguments",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
    return { ok: true, proposal: failed };
  }

  const origin: ProposalOrigin = {
    // The run that asked keeps the attribution, so the authorization queue and
    // the Inspector point at the conversation turn that produced this.
    agentRunId: existing.agentRunId ?? proposalId,
    workspaceId,
    surface: "chat",
    chatSessionId: existing.sessionId,
    confirmedByUserId: actor.userId,
  };

  const args = parsed.data as never;
  const result = await dispatch(live, existing.tool, origin, args);

  if (!result.ok) {
    const failed = fail(db, existing, actor, at, {
      error: result.error,
      message: result.message + (result.hint ? ` ${result.hint}` : ""),
    });
    return { ok: true, proposal: failed };
  }

  // The ref's prefix IS the target kind, which is why the enum and the web
  // router share a vocabulary — `campaign:` routes to the campaign page with
  // no new case in either place beyond naming it.
  const producedRef = result.id ? `${result.targetKind}:${result.id}` : null;

  const updated = resolveRow(db, proposalId, {
    status: "confirmed",
    producedRef,
    producedStatus: result.status,
    confirmedByUserId: actor.userId,
    resolvedAt: at,
  });

  // The receipt is a real transcript message, so the next turn's model knows
  // this happened and does not offer to do it again.
  appendMessage(db, workspaceId, existing.sessionId, {
    role: "assistant",
    content: `${result.summary} (${describeStatus(result.status)})`,
    producedRef,
  });

  return { ok: true, proposal: updated ?? existing };
}

export function declineChatProposal(
  db: Db,
  workspaceId: string,
  actor: ChatProposalActor,
  proposalId: string,
): ResolveChatProposalOutcome {
  const existing = getChatProposal(db, workspaceId, proposalId);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "pending") {
    return { ok: false, error: "already_resolved", proposal: existing };
  }
  const updated = resolveRow(db, proposalId, {
    status: "declined",
    confirmedByUserId: actor.userId,
    resolvedAt: Date.now(),
  });
  // Declining writes no message. The card is struck through in place, which
  // says it plainly, and the model reads the proposal list on the next turn.
  return { ok: true, proposal: updated ?? existing };
}

/**
 * A refusal from the gate is recorded AND written into the thread, so the next
 * turn's model sees the real reason and can correct itself instead of
 * proposing the same impossible thing again (D-78.2).
 */
function fail(
  db: Db,
  existing: ChatProposal,
  actor: ChatProposalActor,
  at: number,
  refusal: { error: string; message: string },
): ChatProposal {
  const updated = resolveRow(db, existing.id, {
    status: "failed",
    error: refusal.error,
    errorMessage: refusal.message,
    confirmedByUserId: actor.userId,
    resolvedAt: at,
  });
  appendMessage(db, existing.workspaceId, existing.sessionId, {
    role: "assistant",
    content: `That couldn't go through: ${refusal.message}`,
  });
  return updated ?? existing;
}

function dispatch(
  live: AgentProposalService,
  tool: ProposeToolName,
  origin: ProposalOrigin,
  args: never,
): Promise<ProposalResult> {
  switch (tool) {
    case "propose_draft":
      return live.proposeDraft(origin, args);
    case "propose_publication":
      return live.proposePublication(origin, args);
    case "propose_reply":
      return live.proposeReply(origin, args);
    case "propose_sequence_step":
      return live.proposeSequenceStep(origin, args);
    case "propose_ad_mutation":
      return live.proposeAdMutation(origin, args);
    case "propose_campaign":
      return live.proposeCampaign(origin, args);
    default: {
      const exhaustive: never = tool;
      return Promise.resolve({
        ok: false,
        error: "unknown_tool",
        message: `No confirmation path for ${String(exhaustive)}.`,
      });
    }
  }
}

/** Where the gate left it, said once, in the founder's language. */
function describeStatus(status: string): string {
  switch (status) {
    case "pending_review":
      return "waiting for you in Review";
    case "draft":
      // A proposed campaign. Says what is true: it exists and does nothing.
      return "created as a draft campaign, inert until you activate it";
    case "authorization_required":
      return "waiting for your authorization";
    case "proposed":
    case "ready":
      return "queued";
    case "dispatched":
    case "succeeded":
      return "sent";
    default:
      return status.replace(/_/g, " ");
  }
}
