import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  OUTREACH_DEFAULT_ENROLLMENT_CAP,
  type CreateOutreachSequenceInput,
  type OutreachEnrollment,
  type OutreachSequence,
  type OutreachSequenceDetail,
  type OutreachSequenceStatus,
  type OutreachSequenceStep,
  type SetOutreachStepsInput,
  type UpdateOutreachSequenceInput,
  type AutomationMode,
  type OutreachEnrollmentStatus,
  type OutreachEnrollmentOutcome,
  type AudienceMemberType,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  audiences,
  campaigns,
  outreachEnrollments,
  outreachSequenceMailboxes,
  outreachSequenceSteps,
  outreachSequences,
  personas,
  type OutreachEnrollmentRow,
  type OutreachSequenceRow,
  type OutreachSequenceStepRow,
} from "../db/schema";
import { listConnectedMailboxes } from "./mailboxes";
import { getPostalAddress } from "./compliance";

export class OutreachSequenceError extends Error {
  constructor(
    readonly code:
      | "campaign_not_found"
      | "persona_not_found"
      | "audience_not_found"
      | "sequence_not_found"
      | "mailbox_not_connected"
      | "not_activatable"
      | "compliance_address_missing",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OutreachSequenceError";
  }
}

function rowToSequence(row: OutreachSequenceRow): OutreachSequence {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    name: row.name,
    goal: row.goal,
    personaId: row.personaId,
    audienceId: row.audienceId,
    automationMode: row.automationMode as AutomationMode,
    status: row.status as OutreachSequenceStatus,
    dailyEnrollmentCap: row.dailyEnrollmentCap,
    stopOnReply: row.stopOnReply === 1,
    trackOpens: row.trackOpens === 1,
    trackClicks: row.trackClicks === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToStep(row: OutreachSequenceStepRow): OutreachSequenceStep {
  return {
    id: row.id,
    sequenceId: row.sequenceId,
    stepNumber: row.stepNumber,
    instruction: row.instruction,
    delayHours: row.delayHours,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToEnrollment(row: OutreachEnrollmentRow): OutreachEnrollment {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sequenceId: row.sequenceId,
    recipientType: row.recipientType as AudienceMemberType,
    recipientId: row.recipientId,
    recipientEmail: row.recipientEmail,
    mailboxId: row.mailboxId,
    lastThreadId: row.lastThreadId,
    currentStep: row.currentStep,
    status: row.status as OutreachEnrollmentStatus,
    nextDueAt: row.nextDueAt,
    lastSentAt: row.lastSentAt,
    stoppedReason: row.stoppedReason,
    outcome: row.outcome as OutreachEnrollmentOutcome,
    enrolledAt: row.enrolledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getSequenceRow(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): Promise<OutreachSequenceRow | undefined> {
  return (await db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId))))[0];
}

async function assertRefs(db: Db, workspaceId: string, input: {
  campaignId?: string;
  personaId?: string;
  audienceId?: string;
}): Promise<void> {
  if (input.campaignId !== undefined) {
    const found = (await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, input.campaignId))))[0];
    if (!found) throw new OutreachSequenceError("campaign_not_found", "Campaign not found.", 404);
  }
  if (input.personaId !== undefined) {
    const found = (await db.select({ id: personas.id }).from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, input.personaId))))[0];
    if (!found) throw new OutreachSequenceError("persona_not_found", "Persona not found.", 404);
  }
  if (input.audienceId !== undefined) {
    const found = (await db.select({ id: audiences.id }).from(audiences)
      .where(and(eq(audiences.workspaceId, workspaceId), eq(audiences.id, input.audienceId))))[0];
    if (!found) throw new OutreachSequenceError("audience_not_found", "Audience not found.", 404);
  }
}

export async function createOutreachSequence(
  db: Db,
  workspaceId: string,
  input: CreateOutreachSequenceInput,
): Promise<OutreachSequence> {
  await assertRefs(db, workspaceId, input);
  const now = Date.now();
  const id = randomUUID();
  await db.insert(outreachSequences).values({
    id,
    workspaceId,
    campaignId: input.campaignId,
    name: input.name,
    goal: input.goal ?? "",
    personaId: input.personaId,
    audienceId: input.audienceId,
    automationMode: input.automationMode ?? "manual",
    status: "draft",
    dailyEnrollmentCap: input.dailyEnrollmentCap ?? OUTREACH_DEFAULT_ENROLLMENT_CAP,
    stopOnReply: input.stopOnReply === false ? 0 : 1,
    trackOpens: input.trackOpens ? 1 : 0,
    trackClicks: input.trackClicks ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  });
  return rowToSequence((await getSequenceRow(db, workspaceId, id))!);
}

export async function listOutreachSequences(db: Db, workspaceId: string): Promise<OutreachSequence[]> {
  return (await db
    .select()
    .from(outreachSequences)
    .where(eq(outreachSequences.workspaceId, workspaceId))
    .orderBy(asc(outreachSequences.createdAt)))
    .map(rowToSequence);
}

export async function getOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): Promise<OutreachSequence | undefined> {
  const row = await getSequenceRow(db, workspaceId, sequenceId);
  return row ? rowToSequence(row) : undefined;
}

export async function updateOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: UpdateOutreachSequenceInput,
): Promise<OutreachSequence | undefined> {
  if (!await getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  await assertRefs(db, workspaceId, input);
  await db.update(outreachSequences).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
    ...(input.audienceId !== undefined ? { audienceId: input.audienceId } : {}),
    ...(input.automationMode !== undefined ? { automationMode: input.automationMode } : {}),
    ...(input.dailyEnrollmentCap !== undefined ? { dailyEnrollmentCap: input.dailyEnrollmentCap } : {}),
    ...(input.stopOnReply !== undefined ? { stopOnReply: input.stopOnReply ? 1 : 0 } : {}),
    ...(input.trackOpens !== undefined ? { trackOpens: input.trackOpens ? 1 : 0 } : {}),
    ...(input.trackClicks !== undefined ? { trackClicks: input.trackClicks ? 1 : 0 } : {}),
    updatedAt: Date.now(),
  }).where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)));
  return rowToSequence((await getSequenceRow(db, workspaceId, sequenceId))!);
}

export async function deleteOutreachSequence(db: Db, workspaceId: string, sequenceId: string): Promise<boolean> {
  if (!await getSequenceRow(db, workspaceId, sequenceId)) return false;
  await db.delete(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)));
  return true;
}

export async function listSteps(db: Db, sequenceId: string): Promise<OutreachSequenceStepRow[]> {
  return await db
    .select()
    .from(outreachSequenceSteps)
    .where(eq(outreachSequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(outreachSequenceSteps.stepNumber));
}

export async function setSteps(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: SetOutreachStepsInput,
): Promise<OutreachSequenceStep[] | undefined> {
  if (!await getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  const now = Date.now();
  await db.delete(outreachSequenceSteps).where(eq(outreachSequenceSteps.sequenceId, sequenceId));
  for (const step of input.steps) {
    await db.insert(outreachSequenceSteps).values({
      id: randomUUID(),
      workspaceId,
      sequenceId,
      stepNumber: step.stepNumber,
      // Step 1 never has a delay regardless of what's posted.
      instruction: step.instruction,
      delayHours: step.stepNumber === 1 ? 0 : step.delayHours,
      createdAt: now,
      updatedAt: now,
    });
  }
  return (await listSteps(db, sequenceId)).map(rowToStep);
}

export async function listPoolMailboxIds(db: Db, sequenceId: string): Promise<string[]> {
  return (await db
    .select({ mailboxId: outreachSequenceMailboxes.mailboxId })
    .from(outreachSequenceMailboxes)
    .where(eq(outreachSequenceMailboxes.sequenceId, sequenceId)))
    .map((r) => r.mailboxId);
}

export async function setMailboxes(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  mailboxIds: string[],
): Promise<string[] | undefined> {
  if (!await getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  const connected = new Set((await listConnectedMailboxes(db, workspaceId)).map((m) => m.id));
  for (const id of mailboxIds) {
    if (!connected.has(id)) {
      throw new OutreachSequenceError(
        "mailbox_not_connected",
        "Every mailbox in the pool must be a connected mailbox.",
        409,
      );
    }
  }
  await db.delete(outreachSequenceMailboxes).where(eq(outreachSequenceMailboxes.sequenceId, sequenceId));
  for (const mailboxId of new Set(mailboxIds)) {
    await db.insert(outreachSequenceMailboxes).values({ sequenceId, mailboxId });
  }
  return await listPoolMailboxIds(db, sequenceId);
}

/** The pooled mailboxes that are still connected (the engine's usable pool). */
export async function connectedPoolMailboxIds(db: Db, workspaceId: string, sequenceId: string): Promise<string[]> {
  const connected = new Set((await listConnectedMailboxes(db, workspaceId)).map((m) => m.id));
  return (await listPoolMailboxIds(db, sequenceId)).filter((id) => connected.has(id));
}

export async function listEnrollments(db: Db, sequenceId: string): Promise<OutreachEnrollmentRow[]> {
  return await db
    .select()
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.sequenceId, sequenceId))
    .orderBy(asc(outreachEnrollments.enrolledAt));
}

export async function setStatus(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  status: OutreachSequenceStatus,
): Promise<void> {
  await db.update(outreachSequences)
    .set({ status, updatedAt: Date.now() })
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)));
}

/** Activation needs ≥1 step, ≥1 connected pooled mailbox, and its refs intact. */
export async function activateOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): Promise<OutreachSequence> {
  const row = await getSequenceRow(db, workspaceId, sequenceId);
  if (!row) throw new OutreachSequenceError("sequence_not_found", "Sequence not found.", 404);
  if ((await listSteps(db, sequenceId)).length === 0) {
    throw new OutreachSequenceError("not_activatable", "Add at least one step before activating.", 409);
  }
  if ((await connectedPoolMailboxIds(db, workspaceId, sequenceId)).length === 0) {
    throw new OutreachSequenceError("not_activatable", "Add at least one connected mailbox before activating.", 409);
  }
  // CAN-SPAM: a postal address must exist before any cold email goes out.
  if (!(await getPostalAddress(db, workspaceId)).trim()) {
    throw new OutreachSequenceError(
      "compliance_address_missing",
      "Set your business mailing address before activating an outreach sequence.",
      409,
    );
  }
  await setStatus(db, workspaceId, sequenceId, "active");
  return rowToSequence((await getSequenceRow(db, workspaceId, sequenceId))!);
}

export async function pauseOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): Promise<OutreachSequence | undefined> {
  if (!await getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  await setStatus(db, workspaceId, sequenceId, "paused");
  return rowToSequence((await getSequenceRow(db, workspaceId, sequenceId))!);
}

export async function getOutreachSequenceDetail(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): Promise<OutreachSequenceDetail | undefined> {
  const row = await getSequenceRow(db, workspaceId, sequenceId);
  if (!row) return undefined;
  return {
    ...rowToSequence(row),
    steps: (await listSteps(db, sequenceId)).map(rowToStep),
    mailboxIds: await listPoolMailboxIds(db, sequenceId),
    enrollments: (await listEnrollments(db, sequenceId)).map(rowToEnrollment),
  };
}

/** Active enrollments in the workspace whose person matches (recipientType,recipientId). */
export async function activeEnrollmentKeys(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ t: outreachEnrollments.recipientType, id: outreachEnrollments.recipientId })
    .from(outreachEnrollments)
    .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.status, "active")));
  return new Set(rows.map((r) => `${r.t}:${r.id}`));
}

export async function stopEnrollments(
  db: Db,
  ids: string[],
  reason: "manual" | "replied",
): Promise<number> {
  if (ids.length === 0) return 0;
  const now = Date.now();
  await db.update(outreachEnrollments)
    .set({
      status: reason === "replied" ? "replied" : "stopped",
      stoppedReason: reason,
      nextDueAt: null,
      updatedAt: now,
    })
    .where(and(inArray(outreachEnrollments.id, ids), eq(outreachEnrollments.status, "active")));
  return ids.length;
}

/** Manual stop over selectors (enrollmentIds / emails / all active in the sequence). */
export async function stopOutreach(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: {
    enrollmentIds?: string[];
    emails?: string[];
    all?: boolean;
    reason: "manual" | "replied";
  },
): Promise<number> {
  const active = (await listEnrollments(db, sequenceId)).filter((e) => e.status === "active");
  const targetIds = new Set<string>();
  if (input.all) active.forEach((e) => targetIds.add(e.id));
  if (input.enrollmentIds?.length) {
    const allow = new Set(active.map((e) => e.id));
    input.enrollmentIds.filter((id) => allow.has(id)).forEach((id) => targetIds.add(id));
  }
  if (input.emails?.length) {
    const emails = new Set(input.emails.map((e) => e.trim().toLowerCase()));
    active.filter((e) => emails.has(e.recipientEmail.toLowerCase())).forEach((e) => targetIds.add(e.id));
  }
  // Guard against a stray workspace mismatch on the enrollment rows.
  const scoped = active.filter((e) => e.workspaceId === workspaceId && targetIds.has(e.id)).map((e) => e.id);
  return await stopEnrollments(db, scoped, input.reason);
}

/**
 * Mark an enrollment's manual funnel outcome (Sprint 50): none / meeting / won
 * / lost. Meeting/won/lost are human-set — no fabricated automation. Scoped to
 * the workspace; returns the updated enrollment, or undefined if not found.
 */
export async function setEnrollmentOutcome(
  db: Db,
  workspaceId: string,
  enrollmentId: string,
  outcome: OutreachEnrollmentOutcome,
): Promise<OutreachEnrollment | undefined> {
  const row = (await db
    .select()
    .from(outreachEnrollments)
    .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.id, enrollmentId))))[0];
  if (!row) return undefined;
  await db.update(outreachEnrollments)
    .set({ outcome, updatedAt: Date.now() })
    .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.id, enrollmentId)));
  return rowToEnrollment(
    ((await db
      .select()
      .from(outreachEnrollments)
      .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.id, enrollmentId))))[0])!,
  );
}
