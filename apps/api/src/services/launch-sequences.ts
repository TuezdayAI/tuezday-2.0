import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import {
  type Channel,
  type Connection,
  type Draft,
  type LaunchStatus,
  type Person,
  type SequenceChannel,
  type SequenceRecipient,
  type SequenceRecipientStatus,
  type SequenceRunResult,
  type SequenceStep,
  type SetSequenceInput,
  type StopSequenceInput,
  type TaskType,
  SEQUENCE_CHANNELS,
} from "@tuezday/contracts";
import { composeFollowupInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import {
  drafts,
  inboxItems,
  launchMessages,
  launches,
  sequenceRecipients,
  sequenceSteps,
  type DraftRow,
  type LaunchRow,
  type SequenceRecipientRow,
  type SequenceStepRow,
} from "../db/schema";
import type { ConnectorFabric } from "../connectors/fabric";
import { socialAdapterFor } from "../connectors/social";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { getAudienceDetail, loadPeople } from "./audiences";
import { getSocialAutomationSettings, utcDayBounds } from "./automation";
import { getBrain } from "./brain";
import { composeResolveCampaign, getCampaign } from "./campaigns";
import { resolveChannelGuidance } from "./guidance";
import { selectiveContextInputs } from "./resolve-input";
import { listConnections, providerByKey } from "./connections";
import { applyDraftAction, submitDraft, type DraftActor } from "./drafts";
import { retrieveEvidence } from "./evidence";
import { storeGeneration } from "./generations";
import { getPersona, toResolvePersona } from "./personas";
import { resolveDraftAccount } from "./resolve-account";
import { getWorkspace } from "./workspaces";

type Fetcher = typeof fetch;
const HOUR_MS = 60 * 60 * 1000;

/** Sequence advance always acts as the system identity — generation + the
 * auto-approval in scheduled_auto are attributed to `system`, like Sprint 28/29. */
const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system" };

/** Each sequenced channel maps to a task type + resolver channel (personalized). */
const SEQUENCE_GEN: Record<SequenceChannel, { taskType: TaskType; channel: Channel }> = {
  email: { taskType: "outbound_email", channel: "email" },
  x: { taskType: "x_dm", channel: "x" },
};

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function launchRowById(db: Db, workspaceId: string, launchId: string): LaunchRow | undefined {
  return db
    .select()
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.id, launchId)))
    .get();
}

function stepRows(db: Db, launchId: string): SequenceStepRow[] {
  return db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.launchId, launchId))
    .orderBy(asc(sequenceSteps.channel), asc(sequenceSteps.stepNumber))
    .all();
}

function rowToStep(row: SequenceStepRow): SequenceStep {
  return {
    id: row.id,
    launchId: row.launchId,
    channel: row.channel as SequenceChannel,
    stepNumber: row.stepNumber,
    instruction: row.instruction,
    delayHours: row.delayHours,
  };
}

export function hasSequence(db: Db, launchId: string): boolean {
  return db.select({ id: sequenceSteps.id }).from(sequenceSteps).where(eq(sequenceSteps.launchId, launchId)).get() !== undefined;
}

export function listSequenceSteps(db: Db, launchId: string): SequenceStep[] {
  return stepRows(db, launchId).map(rowToStep);
}

function totalStepsByChannel(steps: SequenceStepRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps) counts[s.channel] = (counts[s.channel] ?? 0) + 1;
  return counts;
}

function rowToRecipient(row: SequenceRecipientRow, totalSteps: number): SequenceRecipient {
  return {
    id: row.id,
    launchId: row.launchId,
    channel: row.channel as SequenceChannel,
    recipientType: row.recipientType as SequenceRecipient["recipientType"],
    recipientId: row.recipientId,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    recipientHandle: row.recipientHandle,
    currentStep: row.currentStep,
    totalSteps,
    status: row.status as SequenceRecipientStatus,
    nextDueAt: row.nextDueAt,
    lastSentAt: row.lastSentAt,
    stoppedReason: row.stoppedReason,
    updatedAt: row.updatedAt,
  };
}

export function listSequenceRecipients(db: Db, launchId: string): SequenceRecipient[] {
  const totals = totalStepsByChannel(stepRows(db, launchId));
  return db
    .select()
    .from(sequenceRecipients)
    .where(eq(sequenceRecipients.launchId, launchId))
    .orderBy(asc(sequenceRecipients.channel), asc(sequenceRecipients.recipientName))
    .all()
    .map((r) => rowToRecipient(r, totals[r.channel] ?? 0));
}

function activeRecipientRows(db: Db, launchId: string): SequenceRecipientRow[] {
  return db
    .select()
    .from(sequenceRecipients)
    .where(and(eq(sequenceRecipients.launchId, launchId), eq(sequenceRecipients.status, "active")))
    .all();
}

function updateRecipient(db: Db, id: string, patch: Partial<SequenceRecipientRow>): void {
  db.update(sequenceRecipients)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(sequenceRecipients.id, id))
    .run();
}

function setLaunchStatus(db: Db, launchId: string, status: LaunchStatus): void {
  db.update(launches).set({ status, updatedAt: Date.now() }).where(eq(launches.id, launchId)).run();
}

function currentMessage(db: Db, sequenceRecipientId: string, stepNumber: number) {
  return db
    .select()
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.sequenceRecipientId, sequenceRecipientId),
        eq(launchMessages.stepNumber, stepNumber),
      ),
    )
    .get();
}

function draftRow(db: Db, draftId: string | null): DraftRow | undefined {
  if (!draftId) return undefined;
  return db.select().from(drafts).where(eq(drafts.id, draftId)).get();
}

/** The bodies of the recipient's earlier steps, so a follow-up never repeats them. */
function priorBodies(db: Db, sequenceRecipientId: string, beforeStep: number): string[] {
  const rows = db
    .select({ message: launchMessages, draft: drafts })
    .from(launchMessages)
    .leftJoin(drafts, eq(launchMessages.draftId, drafts.id))
    .where(eq(launchMessages.sequenceRecipientId, sequenceRecipientId))
    .orderBy(asc(launchMessages.stepNumber))
    .all();
  return rows
    .filter(({ message }) => message.stepNumber < beforeStep)
    .map(({ draft }) => draft?.content ?? "")
    .filter((b) => b.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Sequence template (steps) + config
// ---------------------------------------------------------------------------

export type SetSequenceResult =
  | { ok: true; steps: SequenceStep[] }
  | { ok: false; error: "launch_not_found" | "channel_not_in_launch" };

export function setSequence(
  db: Db,
  workspaceId: string,
  launchId: string,
  input: SetSequenceInput,
): SetSequenceResult {
  const launch = launchRowById(db, workspaceId, launchId);
  if (!launch) return { ok: false, error: "launch_not_found" };
  const launchChannels = JSON.parse(launch.channelsJson) as string[];
  for (const step of input.steps) {
    if (!launchChannels.includes(step.channel)) return { ok: false, error: "channel_not_in_launch" };
  }
  const now = Date.now();
  db.delete(sequenceSteps).where(eq(sequenceSteps.launchId, launchId)).run();
  for (const step of input.steps) {
    db.insert(sequenceSteps)
      .values({
        id: randomUUID(),
        workspaceId,
        launchId,
        channel: step.channel,
        stepNumber: step.stepNumber,
        instruction: step.instruction,
        delayHours: step.delayHours,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return { ok: true, steps: listSequenceSteps(db, launchId) };
}

// ---------------------------------------------------------------------------
// Connections + guardrails (X DM auto-send)
// ---------------------------------------------------------------------------

function resolveXConnection(db: Db, launch: LaunchRow): Connection | undefined {
  const candidates = listConnections(db, launch.workspaceId).filter(
    (c) => c.providerKey === "twitter" && c.status === "connected",
  );
  if (launch.xConnectionId) return candidates.find((c) => c.id === launch.xConnectionId);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Sent X DMs on this connection on the given UTC day — the per-account cap. */
function countConnectionDmsForDay(db: Db, connectionId: string, dayMs: number): number {
  const { start, end } = utcDayBounds(dayMs);
  return db
    .select({ id: launchMessages.id })
    .from(launchMessages)
    .where(
      and(
        eq(launchMessages.connectionId, connectionId),
        eq(launchMessages.channel, "x"),
        eq(launchMessages.status, "sent"),
        gte(launchMessages.sentAt, start),
        lt(launchMessages.sentAt, end),
      ),
    )
    .all().length;
}

/** A reply we can observe stops the chain. Only X DMs have an inbound feed
 * (Sprint 29 inbox); email has none, so it is stopped manually. */
export function hasInboundReply(
  db: Db,
  workspaceId: string,
  handle: string | null,
  sinceMs: number,
): boolean {
  if (!handle) return false;
  const norm = handle.replace(/^@+/, "").toLowerCase();
  const rows = db
    .select()
    .from(inboxItems)
    .where(
      and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.kind, "dm"), eq(inboxItems.channel, "x")),
    )
    .all();
  return rows.some(
    (r) => r.authorHandle.replace(/^@+/, "").toLowerCase() === norm && r.externalCreatedAt > sinceMs,
  );
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface RunCtx {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  fabric: ConnectorFabric;
  fetcher: Fetcher;
  pool: Map<string, Person>;
}

interface RunAcc {
  enrolled: number;
  generated: number;
  autoApproved: number;
  sent: number;
  stopped: number;
  completed: number;
}

function newAcc(): RunAcc {
  return { enrolled: 0, generated: 0, autoApproved: 0, sent: 0, stopped: 0, completed: 0 };
}

function toRunResult(acc: RunAcc, nowMs: number): SequenceRunResult {
  return { ...acc, ranAt: nowMs };
}

interface GenResult {
  ok: boolean;
  draft?: Draft;
  messageId?: string;
}

/** Resolve → generate → store → gate → insert the per-recipient launch_message
 * for one step. Step 1 with no instruction uses the channel's default prompt;
 * any other step gets the follow-up framing + the recipient's prior bodies. */
async function generateStepMessage(
  ctx: RunCtx,
  launch: LaunchRow,
  recipient: SequenceRecipientRow,
  step: SequenceStepRow,
  prior: string[],
  nowMs: number,
): Promise<GenResult> {
  const channel = recipient.channel as SequenceChannel;
  const gen = SEQUENCE_GEN[channel];
  const workspace = getWorkspace(ctx.db, launch.workspaceId)!;
  const { docs } = getBrain(ctx.db, launch.workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const campaign = launch.campaignId ? getCampaign(ctx.db, launch.workspaceId, launch.campaignId) : undefined;
  const persona = launch.personaId ? getPersona(ctx.db, launch.workspaceId, launch.personaId) : undefined;
  const personaArg = persona ? toResolvePersona(persona) : undefined;
  const campaignArg = campaign ? composeResolveCampaign(campaign) : undefined;
  const person = ctx.pool.get(`${recipient.recipientType}:${recipient.recipientId}`);

  const useFollowup = step.stepNumber > 1 || step.instruction.trim().length > 0;
  const taskInstruction = useFollowup
    ? composeFollowupInstruction({
        channel,
        stepNumber: step.stepNumber,
        instruction: step.instruction,
        priorBodies: prior,
      })
    : undefined;

  const evidenceResolution = await retrieveEvidence(
    ctx.db,
    ctx.evidence,
    launch.workspaceId,
    { taskType: gen.taskType, channel: gen.channel, campaignObjective: campaign?.objective },
    true,
  );

  const insertFailed = (message: string): void => {
    ctx.db
      .insert(launchMessages)
      .values({
        id: randomUUID(),
        workspaceId: launch.workspaceId,
        launchId: launch.id,
        channel,
        kind: "personalized",
        recipientType: recipient.recipientType,
        recipientId: recipient.recipientId,
        recipientName: recipient.recipientName,
        recipientEmail: recipient.recipientEmail,
        recipientHandle: recipient.recipientHandle,
        draftId: null,
        status: "failed",
        skipReason: null,
        externalId: null,
        externalUrl: null,
        publicationId: null,
        sentAt: null,
        lastError: message.slice(0, 500),
        stepNumber: step.stepNumber,
        sequenceRecipientId: recipient.id,
        connectionId: null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .run();
  };

  try {
    // Sprint 43: pass the workspace's channel guidance — this path previously
    // fell back to the built-in default even when an override existed.
    // Sprint 44: scoped to the launch's persona/campaign, most-specific-wins.
    const channelGuidance = resolveChannelGuidance(ctx.db, launch.workspaceId, gen.channel, {
      personaId: launch.personaId,
      campaignId: launch.campaignId,
    });
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: gen.taskType,
      channel: gen.channel,
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: personaArg,
      campaign: campaignArg,
      account: resolveDraftAccount(ctx.db, launch.workspaceId, {
        personaId: launch.personaId,
        channel: gen.channel,
      }),
      lead: {
        name: recipient.recipientName,
        company: person?.company ?? "",
        role: person?.role ?? "",
        notes: "",
      },
      ...selectiveContextInputs(ctx.db, launch.workspaceId),
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      taskInstruction,
    });
    const result = await ctx.llm.generate({ prompt: resolved.prompt });
    const generation = storeGeneration(ctx.db, {
      workspaceId: launch.workspaceId,
      taskType: gen.taskType,
      channel: gen.channel,
      personaId: launch.personaId,
      campaignId: launch.campaignId,
      leadId: recipient.recipientType === "lead" ? recipient.recipientId : null,
      resolved,
      output: result.text,
      model: result.model,
      provider: result.provider,
      durationMs: result.durationMs,
    });
    const draft = submitDraft(
      ctx.db,
      {
        workspaceId: launch.workspaceId,
        sourceGenerationId: generation.id,
        campaignId: launch.campaignId,
        leadId: recipient.recipientType === "lead" ? recipient.recipientId : null,
        taskType: gen.taskType,
        channel: gen.channel,
        personaId: launch.personaId,
        content: result.text,
      },
      SYSTEM_ACTOR,
    );
    const messageId = randomUUID();
    ctx.db
      .insert(launchMessages)
      .values({
        id: messageId,
        workspaceId: launch.workspaceId,
        launchId: launch.id,
        channel,
        kind: "personalized",
        recipientType: recipient.recipientType,
        recipientId: recipient.recipientId,
        recipientName: recipient.recipientName,
        recipientEmail: recipient.recipientEmail,
        recipientHandle: recipient.recipientHandle,
        draftId: draft.id,
        status: "pending",
        skipReason: null,
        externalId: null,
        externalUrl: null,
        publicationId: null,
        sentAt: null,
        lastError: null,
        stepNumber: step.stepNumber,
        sequenceRecipientId: recipient.id,
        connectionId: null,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .run();
    return { ok: true, draft, messageId };
  } catch (err) {
    // A bad generation never aborts the run — record a failed message and move on.
    insertFailed(err instanceof GatewayError ? err.message : err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

interface DispatchResult {
  sent: boolean;
  sentAt?: number;
  blocked?: "kill_switch_on" | "connection_cap" | "no_connection";
  error?: string;
}

/** Send one X DM message row. Auto sends enforce the workspace kill switch +
 * per-connection daily cap; a block leaves the message pending (it retries). */
async function dispatchXMessage(
  ctx: RunCtx,
  launch: LaunchRow,
  messageId: string,
  body: string,
  recipientHandle: string,
  enforceGuardrails: boolean,
  nowMs: number,
): Promise<DispatchResult> {
  const conn = resolveXConnection(ctx.db, launch);
  if (!conn) {
    ctx.db
      .update(launchMessages)
      .set({ status: "failed", lastError: "No connected X account for this launch.", updatedAt: nowMs })
      .where(eq(launchMessages.id, messageId))
      .run();
    return { sent: false, blocked: "no_connection" };
  }
  if (enforceGuardrails) {
    const settings = getSocialAutomationSettings(ctx.db, launch.workspaceId);
    if (settings.killSwitch) return { sent: false, blocked: "kill_switch_on" };
    if (countConnectionDmsForDay(ctx.db, conn.id, nowMs) >= settings.perConnectionDailyCap) {
      return { sent: false, blocked: "connection_cap" };
    }
  }
  const provider = providerByKey("twitter");
  const adapter = provider ? socialAdapterFor(ctx.fabric, provider, conn) : undefined;
  try {
    if (!adapter?.sendDm) throw new Error("The X connection is not available — reconnect it.");
    const res = await adapter.sendDm({ recipientHandle, body });
    ctx.db
      .update(launchMessages)
      .set({
        status: "sent",
        sentAt: nowMs,
        externalId: res.externalId,
        externalUrl: res.url || null,
        connectionId: conn.id,
        lastError: null,
        updatedAt: nowMs,
      })
      .where(eq(launchMessages.id, messageId))
      .run();
    return { sent: true, sentAt: nowMs };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    ctx.db
      .update(launchMessages)
      .set({ status: "failed", lastError: message, updatedAt: nowMs })
      .where(eq(launchMessages.id, messageId))
      .run();
    return { sent: false, error: message };
  }
}

/** Generate (and, in scheduled_auto, approve + for X send) one step for a recipient. */
async function startStep(
  ctx: RunCtx,
  launch: LaunchRow,
  recipient: SequenceRecipientRow,
  step: SequenceStepRow,
  prior: string[],
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  const res = await generateStepMessage(ctx, launch, recipient, step, prior, nowMs);
  updateRecipient(ctx.db, recipient.id, { currentStep: step.stepNumber, nextDueAt: null });
  if (!res.ok || !res.draft || !res.messageId) return;
  acc.generated += 1;
  if (launch.automationMode === "scheduled_auto") {
    applyDraftAction(ctx.db, res.draft, "approve", SYSTEM_ACTOR);
    acc.autoApproved += 1;
    if (recipient.channel === "x") {
      const d = await dispatchXMessage(
        ctx,
        launch,
        res.messageId,
        res.draft.content,
        recipient.recipientHandle ?? "",
        true,
        nowMs,
      );
      if (d.sent) {
        acc.sent += 1;
        updateRecipient(ctx.db, recipient.id, { lastSentAt: d.sentAt! });
      }
    }
  }
}

async function advanceRecipient(
  ctx: RunCtx,
  launch: LaunchRow,
  stepsByChannel: Record<string, SequenceStepRow[]>,
  recipient: SequenceRecipientRow,
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  if (recipient.status !== "active") return;
  const chanSteps = (stepsByChannel[recipient.channel] ?? []).slice().sort((a, b) => a.stepNumber - b.stepNumber);
  const total = chanSteps.length;
  if (total === 0) return;

  // Stop-on-reply — only X DMs have an observable inbound reply (Sprint 29).
  if (launch.stopOnReply === 1 && recipient.channel === "x") {
    if (hasInboundReply(ctx.db, launch.workspaceId, recipient.recipientHandle, recipient.lastSentAt ?? 0)) {
      updateRecipient(ctx.db, recipient.id, { status: "replied", stoppedReason: "replied", nextDueAt: null });
      acc.stopped += 1;
      return;
    }
  }

  const k = recipient.currentStep;
  if (k === 0) {
    await startStep(ctx, launch, recipient, chanSteps[0]!, [], nowMs, acc);
    return;
  }

  let cur = currentMessage(ctx.db, recipient.id, k);
  if (!cur) return; // defensive — nothing generated for the current step yet

  // Approved but not sent: an X step dispatches on this run (in every mode — the
  // mode only governs auto-approval, not whether an approved step is sent); only
  // scheduled_auto enforces guardrails (a human already vetted the others). Email
  // always waits for the CSV export (the deliverability boundary, manual in every mode).
  if (draftRow(ctx.db, cur.draftId)?.state === "approved" && cur.status === "pending") {
    if (recipient.channel === "x") {
      const body = draftRow(ctx.db, cur.draftId)?.content ?? "";
      const d = await dispatchXMessage(
        ctx,
        launch,
        cur.id,
        body,
        recipient.recipientHandle ?? "",
        launch.automationMode === "scheduled_auto",
        nowMs,
      );
      if (d.sent) {
        acc.sent += 1;
        updateRecipient(ctx.db, recipient.id, { lastSentAt: d.sentAt! });
      }
      cur = currentMessage(ctx.db, recipient.id, k)!;
    }
  }

  if (cur.status === "sent") {
    if (recipient.lastSentAt !== cur.sentAt) updateRecipient(ctx.db, recipient.id, { lastSentAt: cur.sentAt });
    if (k >= total) {
      updateRecipient(ctx.db, recipient.id, { status: "completed", nextDueAt: null });
      acc.completed += 1;
      return;
    }
    const next = chanSteps[k]!; // index k → step number k+1
    const due = (cur.sentAt ?? nowMs) + next.delayHours * HOUR_MS;
    if (nowMs >= due) {
      await startStep(ctx, launch, recipient, next, priorBodies(ctx.db, recipient.id, next.stepNumber), nowMs, acc);
    } else if (recipient.nextDueAt !== due) {
      updateRecipient(ctx.db, recipient.id, { nextDueAt: due });
    }
  }
  // cur pending/failed (awaiting approval, export, or a failed send) → wait.
}

/** Flip a sequence launch to completed once no recipient is still active. */
function maybeCompleteSequenceLaunch(db: Db, launchId: string): void {
  const active = db
    .select({ id: sequenceRecipients.id })
    .from(sequenceRecipients)
    .where(and(eq(sequenceRecipients.launchId, launchId), eq(sequenceRecipients.status, "active")))
    .get();
  if (!active) {
    const any = db.select({ id: sequenceRecipients.id }).from(sequenceRecipients).where(eq(sequenceRecipients.launchId, launchId)).get();
    if (any) setLaunchStatus(db, launchId, "completed");
  }
}

async function runForLaunch(
  ctx: RunCtx,
  launch: LaunchRow,
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  const steps = stepRows(ctx.db, launch.id);
  if (steps.length === 0) return;
  const byChannel: Record<string, SequenceStepRow[]> = {};
  for (const s of steps) (byChannel[s.channel] ??= []).push(s);
  for (const recipient of activeRecipientRows(ctx.db, launch.id)) {
    await advanceRecipient(ctx, launch, byChannel, recipient, nowMs, acc);
  }
  maybeCompleteSequenceLaunch(ctx.db, launch.id);
}

function makeCtx(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
): RunCtx {
  const pool = new Map(loadPeople(db, workspaceId).map((p) => [`${p.type}:${p.id}`, p]));
  return { db, llm, evidence, fabric, fetcher, pool };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export type StartSequenceResult =
  | { ok: true; result: SequenceRunResult }
  | { ok: false; error: "launch_not_found" | "no_sequence" | "audience_not_found" };

/** Enroll the audience into each sequenced channel, then run the first tick. */
export async function startSequence(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  nowMs: number = Date.now(),
): Promise<StartSequenceResult> {
  const launch = launchRowById(db, workspaceId, launchId);
  if (!launch) return { ok: false, error: "launch_not_found" };
  const steps = stepRows(db, launchId);
  if (steps.length === 0) return { ok: false, error: "no_sequence" };
  if (!launch.audienceId) return { ok: false, error: "audience_not_found" };
  const audience = getAudienceDetail(db, workspaceId, launch.audienceId);
  if (!audience) return { ok: false, error: "audience_not_found" };

  const acc = newAcc();
  const sequencedChannels = [...new Set(steps.map((s) => s.channel as SequenceChannel))];
  const now = nowMs;
  for (const channel of sequencedChannels) {
    for (const member of audience.members) {
      const handle = member.xHandle?.trim();
      if (channel === "x" && !handle) continue; // no handle → not enrolled in the X chain
      const exists = db
        .select({ id: sequenceRecipients.id })
        .from(sequenceRecipients)
        .where(
          and(
            eq(sequenceRecipients.launchId, launchId),
            eq(sequenceRecipients.channel, channel),
            eq(sequenceRecipients.recipientType, member.type),
            eq(sequenceRecipients.recipientId, member.id),
          ),
        )
        .get();
      if (exists) continue;
      db.insert(sequenceRecipients)
        .values({
          id: randomUUID(),
          workspaceId,
          launchId,
          channel,
          recipientType: member.type,
          recipientId: member.id,
          recipientName: member.name,
          recipientEmail: member.email,
          recipientHandle: channel === "x" ? (handle ?? null) : null,
          currentStep: 0,
          status: "active",
          nextDueAt: now,
          lastSentAt: null,
          stoppedReason: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      acc.enrolled += 1;
    }
  }
  if (launch.status === "draft") setLaunchStatus(db, launchId, "ready");

  const ctx = makeCtx(db, llm, evidence, fabric, fetcher, workspaceId);
  const fresh = launchRowById(db, workspaceId, launchId)!;
  await runForLaunch(ctx, fresh, now, acc);
  return { ok: true, result: toRunResult(acc, now) };
}

/** Advance one launch's sequence now (founder "Run now" + deterministic tests). */
export async function runLaunchSequence(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  launchId: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; result: SequenceRunResult } | { ok: false; error: "launch_not_found" | "no_sequence" }> {
  const launch = launchRowById(db, workspaceId, launchId);
  if (!launch) return { ok: false, error: "launch_not_found" };
  if (stepRows(db, launchId).length === 0) return { ok: false, error: "no_sequence" };
  const acc = newAcc();
  const ctx = makeCtx(db, llm, evidence, fabric, fetcher, workspaceId);
  await runForLaunch(ctx, launch, nowMs, acc);
  return { ok: true, result: toRunResult(acc, nowMs) };
}

/** Advance every sequence launch in the workspace (the worker entry point). */
export async function runSequences(
  db: Db,
  llm: LlmGateway,
  evidence: EvidenceStore,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<SequenceRunResult> {
  const acc = newAcc();
  const launchIds = [
    ...new Set(
      db
        .select({ launchId: sequenceSteps.launchId })
        .from(sequenceSteps)
        .where(eq(sequenceSteps.workspaceId, workspaceId))
        .all()
        .map((r) => r.launchId),
    ),
  ];
  const ctx = makeCtx(db, llm, evidence, fabric, fetcher, workspaceId);
  for (const launchId of launchIds) {
    const launch = launchRowById(db, workspaceId, launchId);
    // Manual launches never advance on the worker tick — the founder drives them
    // with an explicit run. HITL + scheduled_auto auto-advance here.
    if (launch && launch.automationMode !== "manual") await runForLaunch(ctx, launch, nowMs, acc);
  }
  return toRunResult(acc, nowMs);
}

/** Manual stop: mark matching active recipients stopped/replied (email's only
 * stop path; also works as a manual stop on any channel). */
export function stopSequence(
  db: Db,
  workspaceId: string,
  launchId: string,
  input: StopSequenceInput,
): { ok: true; stopped: number } | { ok: false; error: "launch_not_found" } {
  if (!launchRowById(db, workspaceId, launchId)) return { ok: false, error: "launch_not_found" };
  const rows = activeRecipientRows(db, launchId).filter((r) => !input.channel || r.channel === input.channel);
  const emailSet = new Set((input.emails ?? []).map((e) => e.toLowerCase()));
  const refSet = new Set((input.recipients ?? []).map((ref) => `${ref.type}:${ref.id}`));
  const status: SequenceRecipientStatus = input.reason === "replied" ? "replied" : "stopped";
  let stopped = 0;
  for (const r of rows) {
    const match =
      input.all === true ||
      emailSet.has(r.recipientEmail.toLowerCase()) ||
      refSet.has(`${r.recipientType}:${r.recipientId}`);
    if (!match) continue;
    updateRecipient(db, r.id, { status, stoppedReason: input.reason, nextDueAt: null });
    stopped += 1;
  }
  return { ok: true, stopped };
}
