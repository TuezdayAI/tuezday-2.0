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

export class OutreachSequenceError extends Error {
  constructor(
    readonly code:
      | "campaign_not_found"
      | "persona_not_found"
      | "audience_not_found"
      | "sequence_not_found"
      | "mailbox_not_connected"
      | "not_activatable",
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
    enrolledAt: row.enrolledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getSequenceRow(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachSequenceRow | undefined {
  return db
    .select()
    .from(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)))
    .get();
}

function assertRefs(db: Db, workspaceId: string, input: {
  campaignId?: string;
  personaId?: string;
  audienceId?: string;
}): void {
  if (input.campaignId !== undefined) {
    const found = db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, input.campaignId))).get();
    if (!found) throw new OutreachSequenceError("campaign_not_found", "Campaign not found.", 404);
  }
  if (input.personaId !== undefined) {
    const found = db.select({ id: personas.id }).from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, input.personaId))).get();
    if (!found) throw new OutreachSequenceError("persona_not_found", "Persona not found.", 404);
  }
  if (input.audienceId !== undefined) {
    const found = db.select({ id: audiences.id }).from(audiences)
      .where(and(eq(audiences.workspaceId, workspaceId), eq(audiences.id, input.audienceId))).get();
    if (!found) throw new OutreachSequenceError("audience_not_found", "Audience not found.", 404);
  }
}

export function createOutreachSequence(
  db: Db,
  workspaceId: string,
  input: CreateOutreachSequenceInput,
): OutreachSequence {
  assertRefs(db, workspaceId, input);
  const now = Date.now();
  const id = randomUUID();
  db.insert(outreachSequences).values({
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
    createdAt: now,
    updatedAt: now,
  }).run();
  return rowToSequence(getSequenceRow(db, workspaceId, id)!);
}

export function listOutreachSequences(db: Db, workspaceId: string): OutreachSequence[] {
  return db
    .select()
    .from(outreachSequences)
    .where(eq(outreachSequences.workspaceId, workspaceId))
    .orderBy(asc(outreachSequences.createdAt))
    .all()
    .map(rowToSequence);
}

export function getOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachSequence | undefined {
  const row = getSequenceRow(db, workspaceId, sequenceId);
  return row ? rowToSequence(row) : undefined;
}

export function updateOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: UpdateOutreachSequenceInput,
): OutreachSequence | undefined {
  if (!getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  assertRefs(db, workspaceId, input);
  db.update(outreachSequences).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
    ...(input.audienceId !== undefined ? { audienceId: input.audienceId } : {}),
    ...(input.automationMode !== undefined ? { automationMode: input.automationMode } : {}),
    ...(input.dailyEnrollmentCap !== undefined ? { dailyEnrollmentCap: input.dailyEnrollmentCap } : {}),
    ...(input.stopOnReply !== undefined ? { stopOnReply: input.stopOnReply ? 1 : 0 } : {}),
    updatedAt: Date.now(),
  }).where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId))).run();
  return rowToSequence(getSequenceRow(db, workspaceId, sequenceId)!);
}

export function deleteOutreachSequence(db: Db, workspaceId: string, sequenceId: string): boolean {
  if (!getSequenceRow(db, workspaceId, sequenceId)) return false;
  db.delete(outreachSequences)
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)))
    .run();
  return true;
}

export function listSteps(db: Db, sequenceId: string): OutreachSequenceStepRow[] {
  return db
    .select()
    .from(outreachSequenceSteps)
    .where(eq(outreachSequenceSteps.sequenceId, sequenceId))
    .orderBy(asc(outreachSequenceSteps.stepNumber))
    .all();
}

export function setSteps(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: SetOutreachStepsInput,
): OutreachSequenceStep[] | undefined {
  if (!getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  const now = Date.now();
  db.delete(outreachSequenceSteps).where(eq(outreachSequenceSteps.sequenceId, sequenceId)).run();
  for (const step of input.steps) {
    db.insert(outreachSequenceSteps).values({
      id: randomUUID(),
      workspaceId,
      sequenceId,
      stepNumber: step.stepNumber,
      // Step 1 never has a delay regardless of what's posted.
      instruction: step.instruction,
      delayHours: step.stepNumber === 1 ? 0 : step.delayHours,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  return listSteps(db, sequenceId).map(rowToStep);
}

export function listPoolMailboxIds(db: Db, sequenceId: string): string[] {
  return db
    .select({ mailboxId: outreachSequenceMailboxes.mailboxId })
    .from(outreachSequenceMailboxes)
    .where(eq(outreachSequenceMailboxes.sequenceId, sequenceId))
    .all()
    .map((r) => r.mailboxId);
}

export function setMailboxes(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  mailboxIds: string[],
): string[] | undefined {
  if (!getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  const connected = new Set(listConnectedMailboxes(db, workspaceId).map((m) => m.id));
  for (const id of mailboxIds) {
    if (!connected.has(id)) {
      throw new OutreachSequenceError(
        "mailbox_not_connected",
        "Every mailbox in the pool must be a connected mailbox.",
        409,
      );
    }
  }
  db.delete(outreachSequenceMailboxes).where(eq(outreachSequenceMailboxes.sequenceId, sequenceId)).run();
  for (const mailboxId of new Set(mailboxIds)) {
    db.insert(outreachSequenceMailboxes).values({ sequenceId, mailboxId }).run();
  }
  return listPoolMailboxIds(db, sequenceId);
}

/** The pooled mailboxes that are still connected (the engine's usable pool). */
export function connectedPoolMailboxIds(db: Db, workspaceId: string, sequenceId: string): string[] {
  const connected = new Set(listConnectedMailboxes(db, workspaceId).map((m) => m.id));
  return listPoolMailboxIds(db, sequenceId).filter((id) => connected.has(id));
}

export function listEnrollments(db: Db, sequenceId: string): OutreachEnrollmentRow[] {
  return db
    .select()
    .from(outreachEnrollments)
    .where(eq(outreachEnrollments.sequenceId, sequenceId))
    .orderBy(asc(outreachEnrollments.enrolledAt))
    .all();
}

export function setStatus(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  status: OutreachSequenceStatus,
): void {
  db.update(outreachSequences)
    .set({ status, updatedAt: Date.now() })
    .where(and(eq(outreachSequences.workspaceId, workspaceId), eq(outreachSequences.id, sequenceId)))
    .run();
}

/** Activation needs ≥1 step, ≥1 connected pooled mailbox, and its refs intact. */
export function activateOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachSequence {
  const row = getSequenceRow(db, workspaceId, sequenceId);
  if (!row) throw new OutreachSequenceError("sequence_not_found", "Sequence not found.", 404);
  if (listSteps(db, sequenceId).length === 0) {
    throw new OutreachSequenceError("not_activatable", "Add at least one step before activating.", 409);
  }
  if (connectedPoolMailboxIds(db, workspaceId, sequenceId).length === 0) {
    throw new OutreachSequenceError("not_activatable", "Add at least one connected mailbox before activating.", 409);
  }
  setStatus(db, workspaceId, sequenceId, "active");
  return rowToSequence(getSequenceRow(db, workspaceId, sequenceId)!);
}

export function pauseOutreachSequence(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachSequence | undefined {
  if (!getSequenceRow(db, workspaceId, sequenceId)) return undefined;
  setStatus(db, workspaceId, sequenceId, "paused");
  return rowToSequence(getSequenceRow(db, workspaceId, sequenceId)!);
}

export function getOutreachSequenceDetail(
  db: Db,
  workspaceId: string,
  sequenceId: string,
): OutreachSequenceDetail | undefined {
  const row = getSequenceRow(db, workspaceId, sequenceId);
  if (!row) return undefined;
  return {
    ...rowToSequence(row),
    steps: listSteps(db, sequenceId).map(rowToStep),
    mailboxIds: listPoolMailboxIds(db, sequenceId),
    enrollments: listEnrollments(db, sequenceId).map(rowToEnrollment),
  };
}

/** Active enrollments in the workspace whose person matches (recipientType,recipientId). */
export function activeEnrollmentKeys(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .select({ t: outreachEnrollments.recipientType, id: outreachEnrollments.recipientId })
    .from(outreachEnrollments)
    .where(and(eq(outreachEnrollments.workspaceId, workspaceId), eq(outreachEnrollments.status, "active")))
    .all();
  return new Set(rows.map((r) => `${r.t}:${r.id}`));
}

export function stopEnrollments(
  db: Db,
  ids: string[],
  reason: "manual" | "replied",
): number {
  if (ids.length === 0) return 0;
  const now = Date.now();
  db.update(outreachEnrollments)
    .set({
      status: reason === "replied" ? "replied" : "stopped",
      stoppedReason: reason,
      nextDueAt: null,
      updatedAt: now,
    })
    .where(and(inArray(outreachEnrollments.id, ids), eq(outreachEnrollments.status, "active")))
    .run();
  return ids.length;
}

/** Manual stop over selectors (enrollmentIds / emails / all active in the sequence). */
export function stopOutreach(
  db: Db,
  workspaceId: string,
  sequenceId: string,
  input: {
    enrollmentIds?: string[];
    emails?: string[];
    all?: boolean;
    reason: "manual" | "replied";
  },
): number {
  const active = listEnrollments(db, sequenceId).filter((e) => e.status === "active");
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
  return stopEnrollments(db, scoped, input.reason);
}
