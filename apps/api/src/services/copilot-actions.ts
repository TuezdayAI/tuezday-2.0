import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CHANNELS,
  TASK_TYPES,
  type Channel,
  type CopilotWriteTool,
  type ExternalActionActor,
  type TaskType,
} from "@tuezday/contracts";
import { resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import type { EvidenceStore } from "../evidence/store";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
import { submitDraft, type DraftActor } from "./drafts";
import { storeGeneration } from "./generations";
import { resolveChannelGuidance } from "./guidance";
import { resolveExternalActionPolicy } from "./external-action-policy";
import type {
  ExternalActionCommand,
  ExternalActionRuntime,
  ExternalActionRuntimeActor,
} from "./external-action-coordinator";
import { getWorkspace } from "./workspaces";

// ---------------------------------------------------------------------------
// Gated write-tool registry (Sprint 42, Part 2).
//
// The copilot PROPOSES a write; a human CONFIRMS; the write only ever creates a
// GATED item — a draft in `pending_review`, or an external action parked at
// `authorization_required`. Every tool has two halves:
//   • propose(ctx, args) — renders a preview and computes a commitPayload. It
//     performs NO write (it may read to build the preview / policy note).
//   • commit(ctx, payload, actor) — performs exactly ONE gated enqueue.
// There is no path here to authorize / approve / dispatch: `propose_action`
// uses `runtime.proposeForReview`, which always parks at authorization_required
// (never auto-dispatches, even under an autonomous policy). This registry is
// the WRITE whitelist, disjoint from the read registry in copilot-tools.ts.
// ---------------------------------------------------------------------------

export interface CopilotActionContext {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  runtime: ExternalActionRuntime;
  workspaceId: string;
}

export interface CopilotProposeResult {
  /** One-line description of what will be created (not executed). */
  summary: string;
  /** The rendered content / action detail the user is confirming. */
  preview: string;
  /** Set when the effective policy would block or require review before send. */
  policyNote?: string;
  /** JSON-serializable everything `commit` needs — persisted with the proposal. */
  commitPayload: Record<string, unknown>;
}

export interface CopilotCommitResult {
  /** Confirmation line persisted as the committed assistant message. */
  summary: string;
  /** The gated item created, e.g. "draft:<id>" / "external_action:<id>". */
  producedRef: string;
}

export interface CopilotActionTool {
  name: CopilotWriteTool;
  description: string;
  argsSchema: z.ZodType<Record<string, unknown>>;
  propose(ctx: CopilotActionContext, args: Record<string, unknown>): Promise<CopilotProposeResult>;
  commit(
    ctx: CopilotActionContext,
    payload: Record<string, unknown>,
    actor: ExternalActionRuntimeActor,
  ): Promise<CopilotCommitResult>;
}

const PREVIEW_CHARS = 4_000;

function draftActor(actor: ExternalActionRuntimeActor): DraftActor {
  // Deliberately not `actor.human`: this conversion fails closed (Sprint 52).
  // A copilot commit is a person talking to a tool, not a person reading a
  // draft, so it must not be able to stand in for an approval. Copilot commits
  // only ever `submit` drafts — they never approve — so nothing here consults
  // it today. If an approve path is ever added, decide humanity there
  // deliberately rather than letting the caller's flag flow in.
  return { userId: actor.userId, label: actor.label, human: false };
}

/** Resolve a deterministic context bundle for a content draft (no LLM call). */
function resolveForContent(
  db: Db,
  workspaceId: string,
  taskType: TaskType,
  channel: Channel,
  brief: string,
) {
  const workspace = getWorkspace(db, workspaceId);
  const { docs } = getBrain(db, workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const channelGuidance = resolveChannelGuidance(db, workspaceId, channel);
  return resolveContext({
    workspaceName: workspace?.name ?? "Workspace",
    docs: contents,
    taskType,
    channel,
    channelGuidance: { content: channelGuidance.content, source: channelGuidance.source },
    taskInstruction: brief,
  });
}

// ---------------------------------------------------------------------------
// draft_content — grounded content draft into the approval gate
// ---------------------------------------------------------------------------

const contentArgs = z
  .object({
    brief: z.string().min(1),
    taskType: z.enum(TASK_TYPES).optional(),
    channel: z.enum(CHANNELS).optional(),
    personaId: z.string().uuid().optional(),
    campaignId: z.string().uuid().optional(),
  })
  .passthrough();

const draftContent: CopilotActionTool = {
  name: "draft_content",
  description:
    'Draft a piece of content (e.g. a LinkedIn post, cold email) grounded in the brain and submit it into Review. Args: { brief (what to write), channel?, taskType?, personaId?, campaignId? }. Nothing is sent — it creates a draft awaiting approval.',
  argsSchema: contentArgs,
  async propose(ctx, args) {
    const brief = String(args.brief ?? "").trim();
    const channel = (args.channel as Channel | undefined) ?? "linkedin";
    const taskType =
      (args.taskType as TaskType | undefined) ??
      (channel === "email" ? "outbound_email" : "linkedin_post");
    const resolved = resolveForContent(ctx.db, ctx.workspaceId, taskType, channel, brief);
    const result = await ctx.llm.generate({ prompt: resolved.prompt });
    const content = result.text.trim();
    return {
      summary: `Draft a ${channel} ${taskType.replace(/_/g, " ")} and send it to Review`,
      preview: content.slice(0, PREVIEW_CHARS),
      commitPayload: {
        taskType,
        channel,
        personaId: args.personaId ?? null,
        campaignId: args.campaignId ?? null,
        brief,
        content,
      },
    };
  },
  async commit(ctx, payload, actor) {
    const taskType = payload.taskType as TaskType;
    const channel = payload.channel as Channel;
    const content = String(payload.content ?? "");
    const brief = String(payload.brief ?? "");
    // Re-resolve the (deterministic) context so the stored generation carries a
    // faithful prompt/trace; the OUTPUT is the text the user already confirmed.
    const resolved = resolveForContent(ctx.db, ctx.workspaceId, taskType, channel, brief);
    const generation = storeGeneration(ctx.db, {
      workspaceId: ctx.workspaceId,
      taskType,
      channel,
      personaId: (payload.personaId as string | null) ?? null,
      campaignId: (payload.campaignId as string | null) ?? null,
      resolved,
      output: content,
      model: "copilot",
      provider: "copilot",
      durationMs: 0,
    });
    const draft = submitDraft(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        sourceGenerationId: generation.id,
        campaignId: (payload.campaignId as string | null) ?? null,
        taskType,
        channel,
        personaId: (payload.personaId as string | null) ?? null,
        content,
      },
      draftActor(actor),
    );
    return { summary: `Draft created and sent to Review.`, producedRef: `draft:${draft.id}` };
  },
};

// ---------------------------------------------------------------------------
// draft_reply — grounded reply draft into the approval gate
// ---------------------------------------------------------------------------

const replyArgs = z
  .object({
    inboundContent: z.string().min(1),
    channel: z.enum(CHANNELS).optional(),
    personaId: z.string().uuid().optional(),
  })
  .passthrough();

const draftReply: CopilotActionTool = {
  name: "draft_reply",
  description:
    'Draft a reply to an inbound message (a lead reply, comment, or DM), grounded in the brain, and submit it into Review. Args: { inboundContent (what they said), channel?, personaId? }. Nothing is sent.',
  argsSchema: replyArgs,
  async propose(ctx, args) {
    const inbound = String(args.inboundContent ?? "").trim();
    const channel = (args.channel as Channel | undefined) ?? "email";
    const brief = `Write a concise, on-voice reply to this inbound message:\n"""${inbound}"""`;
    const resolved = resolveForContent(ctx.db, ctx.workspaceId, "engagement_reply", channel, brief);
    const result = await ctx.llm.generate({ prompt: resolved.prompt });
    const content = result.text.trim();
    return {
      summary: `Draft a ${channel} reply and send it to Review`,
      preview: content.slice(0, PREVIEW_CHARS),
      commitPayload: {
        channel,
        personaId: args.personaId ?? null,
        inbound,
        brief,
        content,
      },
    };
  },
  async commit(ctx, payload, actor) {
    const channel = payload.channel as Channel;
    const content = String(payload.content ?? "");
    const brief = String(payload.brief ?? "");
    const resolved = resolveForContent(ctx.db, ctx.workspaceId, "engagement_reply", channel, brief);
    const generation = storeGeneration(ctx.db, {
      workspaceId: ctx.workspaceId,
      taskType: "engagement_reply",
      channel,
      personaId: (payload.personaId as string | null) ?? null,
      resolved,
      output: content,
      model: "copilot",
      provider: "copilot",
      durationMs: 0,
    });
    const draft = submitDraft(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        sourceGenerationId: generation.id,
        taskType: "engagement_reply",
        channel,
        personaId: (payload.personaId as string | null) ?? null,
        content,
      },
      draftActor(actor),
    );
    return { summary: `Reply draft created and sent to Review.`, producedRef: `draft:${draft.id}` };
  },
};

// ---------------------------------------------------------------------------
// propose_action — a governed external action, parked for human authorization
// ---------------------------------------------------------------------------

// Launch scope: send / publish / reply (the ads trio is deferred — see spec).
const PROPOSE_ACTION_KINDS = ["send", "publish", "reply"] as const;

const proposeActionArgs = z
  .object({
    kind: z.enum(PROPOSE_ACTION_KINDS),
    title: z.string().min(1),
    detail: z.string().min(1),
    channel: z.string().optional(),
    destination: z.string().optional(),
    campaignId: z.string().uuid().optional(),
    personaId: z.string().uuid().optional(),
  })
  .passthrough();

function nullContext(campaignId: string | null, personaId: string | null) {
  return {
    campaignId,
    campaignName: null,
    personaId,
    personaName: null,
    connectionId: null,
    connectionName: null,
    laneRevisionId: null,
    laneName: null,
  };
}

const proposeAction: CopilotActionTool = {
  name: "propose_action",
  description:
    'Propose a governed external action (kind: "send" | "publish" | "reply") for a human to authorize. Args: { kind, title, detail, channel?, destination?, campaignId?, personaId? }. It is parked at authorization_required — it never sends by itself; a human authorizes it in the actions queue.',
  argsSchema: proposeActionArgs,
  async propose(ctx, args) {
    const kind = args.kind as (typeof PROPOSE_ACTION_KINDS)[number];
    const campaignId = (args.campaignId as string | undefined) ?? null;
    const personaId = (args.personaId as string | undefined) ?? null;
    // Same policy resolution the manual path uses — surfaced before the user
    // confirms so a blocked/human-required action is never a surprise.
    let policyNote: string | undefined;
    try {
      const policy = resolveExternalActionPolicy(ctx.db, {
        workspaceId: ctx.workspaceId,
        actionKind: kind,
        campaignId,
        personaId,
        connectionId: null,
        laneRevisionId: null,
      });
      if (policy.effective === "human_required") {
        policyNote = "This action requires human authorization — it will wait in the actions queue.";
      }
    } catch {
      // A missing scope reference shouldn't block proposing; the coordinator
      // re-checks policy on commit.
      policyNote = undefined;
    }
    return {
      summary: `Propose a governed "${kind}" action for authorization`,
      preview: `${String(args.title)}\n\n${String(args.detail)}`.slice(0, PREVIEW_CHARS),
      policyNote,
      commitPayload: {
        kind,
        title: String(args.title),
        detail: String(args.detail),
        channel: (args.channel as string | undefined) ?? null,
        destination: (args.destination as string | undefined) ?? null,
        campaignId,
        personaId,
      },
    };
  },
  async commit(ctx, payload, actor) {
    const kind = payload.kind as (typeof PROPOSE_ACTION_KINDS)[number];
    const command: ExternalActionCommand = {
      workspaceId: ctx.workspaceId,
      kind,
      idempotencyKey: `copilot:${kind}:${randomUUID()}`,
      subject: {
        kind: "draft",
        id: randomUUID(),
        title: String(payload.title),
        summary: String(payload.detail),
        channel: (payload.channel as string | null) ?? null,
        destination: (payload.destination as string | null) ?? null,
      },
      context: nullContext(
        (payload.campaignId as string | null) ?? null,
        (payload.personaId as string | null) ?? null,
      ),
      payload: { detail: String(payload.detail) },
      requestedFor: null,
    };
    // proposeForReview ALWAYS parks at authorization_required — never dispatch.
    const submission = await ctx.runtime.proposeForReview(command, actor);
    return {
      summary: `Action proposed and waiting for authorization in the actions queue.`,
      producedRef: `external_action:${submission.action.id}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry (the write whitelist)
// ---------------------------------------------------------------------------

export const COPILOT_ACTION_TOOLS: readonly CopilotActionTool[] = [
  draftContent,
  draftReply,
  proposeAction,
];

const ACTION_TOOLS_BY_NAME = new Map<string, CopilotActionTool>(
  COPILOT_ACTION_TOOLS.map((t) => [t.name, t]),
);

export function getCopilotActionTool(name: string): CopilotActionTool | undefined {
  return ACTION_TOOLS_BY_NAME.get(name);
}
