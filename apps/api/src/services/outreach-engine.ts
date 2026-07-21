import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import {
  type Draft,
  type MailboxSendingWindow,
  type OutreachRunResult,
  type Person,
} from "@tuezday/contracts";
import { composeFollowupInstruction, resolveContext, type BrainContents } from "@tuezday/brain";
import type { Db } from "../db";
import {
  audiences,
  drafts,
  emailSuppressions,
  inboxItems,
  mailboxes,
  outreachEnrollments,
  outreachMessages,
  outreachSequences,
  type AudienceRow,
  type DraftRow,
  type OutreachEnrollmentRow,
  type OutreachMessageRow,
  type OutreachSequenceRow,
  type OutreachSequenceStepRow,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { loadPeople, resolveAudienceMembers } from "./audiences";
import { getBrain } from "./brain";
import { composeResolveCampaign, getCampaign } from "./campaigns";
import { applyDraftAction, submitDraft, type DraftActor } from "./drafts";
import { deriveEmailSendIdempotencyKey, prepareEmailAction } from "./external-action-email";
import type { ExternalActionRuntime } from "./external-action-coordinator";
import { getExternalAction } from "./external-actions";
import { retrieveEvidence } from "./evidence";
import { storeGeneration } from "./generations";
import { resolveChannelGuidance } from "./guidance";
import { getMailbox, listConnectedMailboxes, mailboxDailySendCount } from "./mailboxes";
import { getPersona, toResolvePersona } from "./personas";
import { resolveDraftAccount } from "./resolve-account";
import { selectiveContextInputs } from "./resolve-input";
import { getWorkspace } from "./workspaces";
import {
  connectedPoolMailboxIds,
  getSequenceRow,
  listSteps,
  setStatus,
} from "./outreach-sequences";

const HOUR_MS = 60 * 60 * 1000;
const SYSTEM_ACTOR: DraftActor = { userId: null, label: "system" };

// Blocker codes worth a re-propose on the next tick (transient safety states).
const RETRYABLE_BLOCKERS = new Set([
  "permission_unknown",
  "suppressed",
  "kill_switch_on",
  "daily_cap_reached",
  "mailbox_cap_reached",
  "mailbox_unavailable",
]);

export interface OutreachDeps {
  llm: LlmGateway;
  evidence: EvidenceStore;
  runtime: ExternalActionRuntime;
}

interface RunCtx extends OutreachDeps {
  db: Db;
  pool: Map<string, Person>;
}

interface RunAcc {
  enrolled: number;
  generated: number;
  dispatched: number;
  stopped: number;
  completed: number;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Empty window = always open. Days/hours are evaluated in the mailbox's tz. */
export function isWithinSendingWindow(window: MailboxSendingWindow, nowMs: number): boolean {
  const hasBound =
    (window.days && window.days.length > 0) ||
    window.startHour !== undefined ||
    window.endHour !== undefined;
  if (!hasBound) return true;

  let hour: number;
  let day: number;
  if (window.timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: window.timezone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(new Date(nowMs));
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    day = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
  } else {
    const d = new Date(nowMs);
    hour = d.getUTCHours();
    day = d.getUTCDay();
  }
  if (window.days && window.days.length > 0 && !window.days.includes(day)) return false;
  if (window.startHour !== undefined && hour < window.startHour) return false;
  if (window.endHour !== undefined && hour >= window.endHour) return false;
  return true;
}

/** A pooled mailbox can send now if connected, within its window, and under cap. */
function mailboxSendableNow(db: Db, workspaceId: string, mailboxId: string, nowMs: number): boolean {
  const mailbox = getMailbox(db, workspaceId, mailboxId);
  if (!mailbox || mailbox.status !== "connected") return false;
  if (!isWithinSendingWindow(mailbox.sendingWindow, nowMs)) return false;
  return mailboxDailySendCount(db, workspaceId, mailboxId, nowMs) < mailbox.dailyCap;
}

/** Pick the pooled mailbox with the fewest sends today (spreads reputation). */
function leastLoadedMailbox(db: Db, workspaceId: string, sequenceId: string, nowMs: number): string | null {
  const pool = connectedPoolMailboxIds(db, workspaceId, sequenceId);
  if (pool.length === 0) return null;
  let best = pool[0]!;
  let bestLoad = mailboxDailySendCount(db, workspaceId, best, nowMs);
  for (const id of pool.slice(1)) {
    const load = mailboxDailySendCount(db, workspaceId, id, nowMs);
    if (load < bestLoad) {
      best = id;
      bestLoad = load;
    }
  }
  return best;
}

/** An inbound email reply from this recipient since `sinceMs` (S47 email inbox). */
export function hasInboundEmailReply(
  db: Db,
  workspaceId: string,
  recipientEmail: string,
  sinceMs: number,
): boolean {
  const target = normalize(recipientEmail);
  const rows = db
    .select({ author: inboxItems.authorHandle, at: inboxItems.externalCreatedAt })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, workspaceId),
        eq(inboxItems.kind, "email"),
        gte(inboxItems.externalCreatedAt, sinceMs + 1),
      ),
    )
    .all();
  return rows.some((r) => normalize(r.author) === target);
}

function isSuppressed(db: Db, workspaceId: string, email: string): boolean {
  return !!db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.normalizedEmail, normalize(email)),
      ),
    )
    .get();
}

function draftRow(db: Db, draftId: string): DraftRow | undefined {
  return db.select().from(drafts).where(eq(drafts.id, draftId)).get();
}

function messageRow(db: Db, messageId: string): OutreachMessageRow | undefined {
  return db.select().from(outreachMessages).where(eq(outreachMessages.id, messageId)).get();
}

function currentMessage(db: Db, enrollmentId: string, stepNumber: number): OutreachMessageRow | undefined {
  return db
    .select()
    .from(outreachMessages)
    .where(and(eq(outreachMessages.enrollmentId, enrollmentId), eq(outreachMessages.stepNumber, stepNumber)))
    .get();
}

function priorBodies(db: Db, enrollmentId: string, beforeStep: number): string[] {
  return db
    .select({ content: drafts.content, step: outreachMessages.stepNumber })
    .from(outreachMessages)
    .innerJoin(drafts, eq(outreachMessages.draftId, drafts.id))
    .where(eq(outreachMessages.enrollmentId, enrollmentId))
    .all()
    .filter((r) => r.step < beforeStep && r.content.trim().length > 0)
    .map((r) => r.content);
}

function updateEnrollment(db: Db, id: string, set: Partial<OutreachEnrollmentRow>): void {
  db.update(outreachEnrollments).set({ ...set, updatedAt: Date.now() }).where(eq(outreachEnrollments.id, id)).run();
}

interface GenResult {
  ok: boolean;
  draft?: Draft;
  messageId?: string;
}

/** Resolve → generate → gate → durable message row for one outreach step. */
async function generateOutreachStep(
  ctx: RunCtx,
  seq: OutreachSequenceRow,
  enrollment: OutreachEnrollmentRow,
  step: OutreachSequenceStepRow,
  prior: string[],
  nowMs: number,
): Promise<GenResult> {
  const workspace = getWorkspace(ctx.db, seq.workspaceId)!;
  const { docs } = getBrain(ctx.db, seq.workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  const campaign = getCampaign(ctx.db, seq.workspaceId, seq.campaignId);
  const persona = getPersona(ctx.db, seq.workspaceId, seq.personaId);
  const person = ctx.pool.get(`${enrollment.recipientType}:${enrollment.recipientId}`);

  const useFollowup = step.stepNumber > 1 || step.instruction.trim().length > 0;
  const taskInstruction = useFollowup
    ? composeFollowupInstruction({
        channel: "email",
        stepNumber: step.stepNumber,
        instruction: step.instruction,
        priorBodies: prior,
      })
    : undefined;

  const evidenceResolution = await retrieveEvidence(
    ctx.db,
    ctx.evidence,
    seq.workspaceId,
    { taskType: "outbound_email", channel: "email", campaignObjective: campaign?.objective },
    true,
  );

  const insertFailed = (message: string): void => {
    ctx.db.insert(outreachMessages).values({
      id: randomUUID(),
      workspaceId: seq.workspaceId,
      enrollmentId: enrollment.id,
      stepNumber: step.stepNumber,
      draftId: null,
      externalActionId: null,
      providerThreadId: null,
      status: "failed",
      sentAt: null,
      lastError: message.slice(0, 500),
      createdAt: nowMs,
      updatedAt: nowMs,
    }).run();
  };

  try {
    const channelGuidance = resolveChannelGuidance(ctx.db, seq.workspaceId, "email", {
      personaId: seq.personaId,
      campaignId: seq.campaignId,
    });
    const resolved = resolveContext({
      workspaceName: workspace.name,
      docs: contents,
      taskType: "outbound_email",
      channel: "email",
      channelGuidance: {
        content: channelGuidance.content,
        source: channelGuidance.source,
        scope: channelGuidance.scopeLabel,
      },
      persona: persona ? toResolvePersona(persona) : undefined,
      campaign: campaign ? composeResolveCampaign(campaign) : undefined,
      account: resolveDraftAccount(ctx.db, seq.workspaceId, { personaId: seq.personaId, channel: "email" }),
      lead: {
        name: person?.name ?? enrollment.recipientEmail,
        company: person?.company ?? "",
        role: person?.role ?? "",
        notes: "",
      },
      ...selectiveContextInputs(ctx.db, seq.workspaceId),
      evidence: evidenceResolution.evidence,
      evidenceExclusionReason: evidenceResolution.exclusionReason,
      taskInstruction,
    });
    const result = await ctx.llm.generate({ prompt: resolved.prompt });
    const generation = storeGeneration(ctx.db, {
      workspaceId: seq.workspaceId,
      taskType: "outbound_email",
      channel: "email",
      personaId: seq.personaId,
      campaignId: seq.campaignId,
      leadId: enrollment.recipientType === "lead" ? enrollment.recipientId : null,
      resolved,
      output: result.text,
      model: result.model,
      provider: result.provider,
      durationMs: result.durationMs,
    });
    const draft = submitDraft(
      ctx.db,
      {
        workspaceId: seq.workspaceId,
        sourceGenerationId: generation.id,
        campaignId: seq.campaignId,
        leadId: enrollment.recipientType === "lead" ? enrollment.recipientId : null,
        taskType: "outbound_email",
        channel: "email",
        personaId: seq.personaId,
        content: result.text,
      },
      SYSTEM_ACTOR,
    );
    const messageId = randomUUID();
    ctx.db.insert(outreachMessages).values({
      id: messageId,
      workspaceId: seq.workspaceId,
      enrollmentId: enrollment.id,
      stepNumber: step.stepNumber,
      draftId: draft.id,
      externalActionId: null,
      providerThreadId: null,
      status: "pending",
      sentAt: null,
      lastError: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    }).run();
    return { ok: true, draft, messageId };
  } catch (err) {
    insertFailed(err instanceof GatewayError ? err.message : err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

interface DispatchResult {
  sent: boolean;
  sentAt?: number;
  threadId?: string;
}

/** Propose one outreach step's send as a governed `outreach_step` email action. */
async function proposeOutreachSend(
  ctx: RunCtx,
  seq: OutreachSequenceRow,
  enrollment: OutreachEnrollmentRow,
  messageId: string,
  nowMs: number,
): Promise<DispatchResult> {
  if (!enrollment.mailboxId) return { sent: false };
  const message = messageRow(ctx.db, messageId);
  const draft = message?.draftId ? draftRow(ctx.db, message.draftId) : undefined;
  if (!message || !draft) return { sent: false };
  const baseKey = deriveEmailSendIdempotencyKey(message.id, {
    draftId: draft.id,
    content: draft.content,
    stepNumber: message.stepNumber,
  });

  let submission;
  const existing = message.externalActionId
    ? getExternalAction(ctx.db, seq.workspaceId, message.externalActionId)
    : undefined;
  if (existing) {
    const retryable = existing.status === "blocked" && RETRYABLE_BLOCKERS.has(existing.blocker?.code ?? "");
    if (!retryable) {
      return {
        sent: message.status === "sent",
        sentAt: message.sentAt ?? undefined,
        threadId: message.providerThreadId ?? undefined,
      };
    }
    submission = await ctx.runtime.repropose(
      existing.id,
      seq.workspaceId,
      `${baseKey}:retry:${existing.id}`,
      SYSTEM_ACTOR,
    );
  } else {
    submission = await ctx.runtime.propose(
      prepareEmailAction(ctx.db, seq.workspaceId, {
        origin: "outreach_step",
        originId: message.id,
        idempotencyKey: baseKey,
        mailboxId: enrollment.mailboxId,
      }),
      SYSTEM_ACTOR,
    );
  }
  ctx.db.update(outreachMessages)
    .set({ externalActionId: submission.action.id, updatedAt: Date.now() })
    .where(eq(outreachMessages.id, message.id))
    .run();
  const after = messageRow(ctx.db, message.id);
  return {
    sent: submission.action.status === "succeeded" && after?.status === "sent",
    sentAt: after?.sentAt ?? nowMs,
    threadId: after?.providerThreadId ?? undefined,
  };
}

/** Try to dispatch an approved-but-unsent step; respects the mailbox window/cap. */
async function tryDispatch(
  ctx: RunCtx,
  seq: OutreachSequenceRow,
  enrollment: OutreachEnrollmentRow,
  messageId: string,
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  if (!enrollment.mailboxId || !mailboxSendableNow(ctx.db, seq.workspaceId, enrollment.mailboxId, nowMs)) {
    return; // deferred — the message stays pending, retried next tick
  }
  const d = await proposeOutreachSend(ctx, seq, enrollment, messageId, nowMs);
  if (d.sent) {
    acc.dispatched += 1;
    updateEnrollment(ctx.db, enrollment.id, {
      lastSentAt: d.sentAt ?? nowMs,
      ...(d.threadId ? { lastThreadId: d.threadId } : {}),
    });
  }
}

async function startStep(
  ctx: RunCtx,
  seq: OutreachSequenceRow,
  enrollment: OutreachEnrollmentRow,
  step: OutreachSequenceStepRow,
  prior: string[],
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  const res = await generateOutreachStep(ctx, seq, enrollment, step, prior, nowMs);
  updateEnrollment(ctx.db, enrollment.id, { currentStep: step.stepNumber, nextDueAt: null });
  if (!res.ok || !res.messageId || !res.draft) return;
  acc.generated += 1;
  if (seq.automationMode === "scheduled_auto") {
    applyDraftAction(ctx.db, res.draft, "approve", SYSTEM_ACTOR);
    await tryDispatch(ctx, seq, enrollment, res.messageId, nowMs, acc);
  }
}

async function advanceEnrollment(
  ctx: RunCtx,
  seq: OutreachSequenceRow,
  steps: OutreachSequenceStepRow[],
  enrollment: OutreachEnrollmentRow,
  nowMs: number,
  acc: RunAcc,
): Promise<void> {
  if (enrollment.status !== "active") return;
  const total = steps.length;
  if (total === 0) return;

  // Stop-on-reply — re-checked here and again pre-dispatch (poll-window guard).
  if (seq.stopOnReply === 1) {
    const since = enrollment.lastSentAt ?? enrollment.enrolledAt;
    if (hasInboundEmailReply(ctx.db, seq.workspaceId, enrollment.recipientEmail, since)) {
      updateEnrollment(ctx.db, enrollment.id, { status: "replied", stoppedReason: "replied", nextDueAt: null });
      acc.stopped += 1;
      return;
    }
  }

  const k = enrollment.currentStep;
  if (k === 0) {
    await startStep(ctx, seq, enrollment, steps[0]!, [], nowMs, acc);
    return;
  }

  let cur = currentMessage(ctx.db, enrollment.id, k);
  if (!cur) return;

  if (cur.draftId && draftRow(ctx.db, cur.draftId)?.state === "approved" && cur.status === "pending") {
    await tryDispatch(ctx, seq, enrollment, cur.id, nowMs, acc);
    cur = currentMessage(ctx.db, enrollment.id, k)!;
  }

  if (cur.status === "sent") {
    if (enrollment.lastSentAt !== cur.sentAt) {
      updateEnrollment(ctx.db, enrollment.id, {
        lastSentAt: cur.sentAt,
        ...(cur.providerThreadId ? { lastThreadId: cur.providerThreadId } : {}),
      });
    }
    if (k >= total) {
      updateEnrollment(ctx.db, enrollment.id, { status: "completed", nextDueAt: null });
      acc.completed += 1;
      return;
    }
    const next = steps[k]!; // index k → step number k+1
    const due = (cur.sentAt ?? nowMs) + next.delayHours * HOUR_MS;
    if (nowMs >= due) {
      await startStep(ctx, seq, enrollment, next, priorBodies(ctx.db, enrollment.id, next.stepNumber), nowMs, acc);
    } else if (enrollment.nextDueAt !== due) {
      updateEnrollment(ctx.db, enrollment.id, { nextDueAt: due });
    }
  }
}

function audienceRow(db: Db, workspaceId: string, audienceId: string): AudienceRow | undefined {
  return db.select().from(audiences).where(and(eq(audiences.workspaceId, workspaceId), eq(audiences.id, audienceId))).get();
}

function enrolledKeysFor(db: Db, sequenceId: string): Set<string> {
  return new Set(
    db
      .select({ t: outreachEnrollments.recipientType, id: outreachEnrollments.recipientId })
      .from(outreachEnrollments)
      .where(eq(outreachEnrollments.sequenceId, sequenceId))
      .all()
      .map((r) => `${r.t}:${r.id}`),
  );
}

function activeKeys(db: Db, workspaceId: string): Set<string> {
  return new Set(
    db
      .select({ t: outreachEnrollments.recipientType, id: outreachEnrollments.recipientId })
      .from(outreachEnrollments)
      .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.status, "active")))
      .all()
      .map((r) => `${r.t}:${r.id}`),
  );
}

function enrolledTodayCount(db: Db, sequenceId: string, nowMs: number): number {
  return db
    .select({ at: outreachEnrollments.enrolledAt })
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.sequenceId, sequenceId))
    .all()
    .filter((r) => r.at >= utcDayStart(nowMs)).length;
}

/** Auto-enroll new segment members that clear the guardrails. */
function enrollSequence(ctx: RunCtx, seq: OutreachSequenceRow, nowMs: number, acc: RunAcc): void {
  const row = audienceRow(ctx.db, seq.workspaceId, seq.audienceId);
  if (!row) return;
  const members = resolveAudienceMembers(ctx.db, seq.workspaceId, row);
  const enrolledHere = enrolledKeysFor(ctx.db, seq.id);
  const active = activeKeys(ctx.db, seq.workspaceId);
  let remaining = seq.dailyEnrollmentCap - enrolledTodayCount(ctx.db, seq.id, nowMs);

  for (const member of members) {
    if (remaining <= 0) break;
    const key = `${member.type}:${member.id}`;
    if (enrolledHere.has(key)) continue; // already in this sequence
    if (!member.email) continue;
    if (active.has(key)) continue; // one active sequence per person (workspace-wide)
    if (isSuppressed(ctx.db, seq.workspaceId, member.email)) continue;
    const mailboxId = leastLoadedMailbox(ctx.db, seq.workspaceId, seq.id, nowMs);
    if (!mailboxId) break; // no usable mailbox → nothing to enroll onto

    try {
      ctx.db.insert(outreachEnrollments).values({
        id: randomUUID(),
        workspaceId: seq.workspaceId,
        sequenceId: seq.id,
        recipientType: member.type,
        recipientId: member.id,
        recipientEmail: normalize(member.email),
        mailboxId,
        lastThreadId: null,
        currentStep: 0,
        status: "active",
        nextDueAt: nowMs,
        lastSentAt: null,
        stoppedReason: null,
        enrolledAt: nowMs,
        createdAt: nowMs,
        updatedAt: nowMs,
      }).run();
      acc.enrolled += 1;
      remaining -= 1;
      active.add(key);
      enrolledHere.add(key);
    } catch {
      // The partial-unique active lock rejected a race — skip this person.
      active.add(key);
    }
  }
}

/**
 * One outreach tick for a workspace: auto-enroll new segment members, then
 * advance every active enrollment. Manual-mode sequences enroll but do not
 * generate/send (the founder-hold, mirroring S30). Per-enrollment errors are
 * caught and counted; a bad one never aborts the run.
 */
export async function runOutreach(
  db: Db,
  deps: OutreachDeps,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<OutreachRunResult> {
  const ctx: RunCtx = {
    db,
    ...deps,
    pool: new Map(loadPeople(db, workspaceId).map((p) => [`${p.type}:${p.id}`, p])),
  };
  const acc: RunAcc = { enrolled: 0, generated: 0, dispatched: 0, stopped: 0, completed: 0 };

  const activeSequences = db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.status, "active")))
    .all();

  for (const seq of activeSequences) {
    enrollSequence(ctx, seq, nowMs, acc);
    if (seq.automationMode === "manual") continue; // enroll only; founder holds

    const steps = listSteps(db, seq.id);
    if (steps.length === 0) continue;
    const active = db
      .select()
      .from(outreachEnrollments)
      .where(and(eq(outreachEnrollments.sequenceId, seq.id), eq(outreachEnrollments.status, "active")))
      .all();
    for (const enrollment of active) {
      try {
        await advanceEnrollment(ctx, seq, steps, enrollment, nowMs, acc);
      } catch {
        // Never let one enrollment abort the workspace run.
      }
    }
    maybeComplete(db, workspaceId, seq.id);
  }

  return { ...acc, ranAt: nowMs };
}

/** Flip a sequence to completed once it has enrollments and none are active. */
function maybeComplete(db: Db, workspaceId: string, sequenceId: string): void {
  const active = db
    .select({ id: outreachEnrollments.id })
    .from(outreachEnrollments)
    .where(and(eq(outreachEnrollments.sequenceId, sequenceId), eq(outreachEnrollments.status, "active")))
    .get();
  if (active) return;
  const any = db
    .select({ id: outreachEnrollments.id })
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.sequenceId, sequenceId))
    .get();
  const seq = getSequenceRow(db, workspaceId, sequenceId);
  // Only auto-complete a running sequence that has drained; a live segment can
  // still auto-enroll into an active sequence, so leave `active` alone unless
  // it was explicitly paused-then-drained. We keep it active so new members
  // continue to enroll; completion is a manual/segment-exhausted concern.
  if (any && seq && seq.status === "paused") setStatus(db, workspaceId, sequenceId, "completed");
}
