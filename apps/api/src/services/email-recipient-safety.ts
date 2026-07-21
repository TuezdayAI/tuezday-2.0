import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  normalizedEmailAddressSchema,
  type EmailRecipientPermission,
  type EmailSafetySettings,
  type UpdateEmailPermissionInput,
  type UpdateEmailSafetyInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  emailDeliveries,
  emailRecipientPermissions,
  emailSuppressions,
  workspaceEmailSenders,
} from "../db/schema";
import { listConnectedMailboxes } from "./mailboxes";

export type EmailRecipientSafetyResult =
  | { ok: true; normalizedEmail: string }
  | {
      ok: false;
      code:
        | "kill_switch_on"
        | "daily_cap_reached"
        | "invalid_email"
        | "suppressed"
        | "permission_unknown";
      message: string;
      count?: number;
      cap?: number;
    };

function normalizeEmail(email: string): string | null {
  const parsed = normalizedEmailAddressSchema.safeParse(email);
  return parsed.success ? parsed.data : null;
}

export function getEmailPermission(
  db: Db,
  workspaceId: string,
  email: string,
): EmailRecipientPermission | null {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const row = db
    .select()
    .from(emailRecipientPermissions)
    .where(
      and(
        eq(emailRecipientPermissions.workspaceId, workspaceId),
        eq(emailRecipientPermissions.normalizedEmail, normalizedEmail),
      ),
    )
    .get();
  return row
    ? {
        workspaceId: row.workspaceId,
        normalizedEmail: row.normalizedEmail,
        status: row.status as EmailRecipientPermission["status"],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

export function updateEmailPermission(
  db: Db,
  workspaceId: string,
  email: string,
  input: UpdateEmailPermissionInput,
): EmailRecipientPermission {
  const normalizedEmail = normalizedEmailAddressSchema.parse(email);
  const existing = getEmailPermission(db, workspaceId, normalizedEmail);
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(emailRecipientPermissions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail,
        status: input.status,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [emailRecipientPermissions.workspaceId, emailRecipientPermissions.normalizedEmail],
        set: { status: input.status, updatedAt: now },
      })
      .run();

    if (input.status === "suppressed") {
      tx.insert(emailSuppressions)
        .values({
          id: randomUUID(),
          workspaceId,
          normalizedEmail,
          reason: "founder",
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [emailSuppressions.workspaceId, emailSuppressions.normalizedEmail],
        })
        .run();
    } else {
      tx.delete(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, workspaceId),
            eq(emailSuppressions.normalizedEmail, normalizedEmail),
            eq(emailSuppressions.reason, "founder"),
          ),
        )
        .run();
    }
  });
  return getEmailPermission(db, workspaceId, normalizedEmail)!;
}

export function unsubscribeEmailRecipient(db: Db, workspaceId: string, email: string): void {
  const normalizedEmail = normalizedEmailAddressSchema.parse(email);
  const now = Date.now();
  const existing = getEmailPermission(db, workspaceId, normalizedEmail);
  db.transaction((tx) => {
    tx.insert(emailRecipientPermissions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail,
        status: "suppressed",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [emailRecipientPermissions.workspaceId, emailRecipientPermissions.normalizedEmail],
        set: { status: "suppressed", updatedAt: now },
      })
      .run();
    tx.insert(emailSuppressions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail,
        reason: "unsubscribe",
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [emailSuppressions.workspaceId, emailSuppressions.normalizedEmail],
        set: { reason: "unsubscribe" },
      })
      .run();
  });
}

export function getEmailSafetySettings(db: Db, workspaceId: string): EmailSafetySettings {
  const row = db
    .select({ killSwitch: workspaceEmailSenders.killSwitch, dailyCap: workspaceEmailSenders.dailyCap })
    .from(workspaceEmailSenders)
    .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
    .get();
  if (row) return row;
  // No Resend sender row: a Gmail-only workspace (Sprint 48) is still email-
  // enabled if it has a connected mailbox — connecting one is the explicit
  // opt-in. With neither, the kill switch stays on (the prior default).
  return {
    killSwitch: listConnectedMailboxes(db, workspaceId).length === 0,
    dailyCap: 100,
  };
}

export function updateEmailSafetySettings(
  db: Db,
  workspaceId: string,
  input: UpdateEmailSafetyInput,
): EmailSafetySettings {
  const existing = db
    .select({ workspaceId: workspaceEmailSenders.workspaceId })
    .from(workspaceEmailSenders)
    .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
    .get();
  if (!existing) throw new EmailSafetyConfigurationError();
  db.update(workspaceEmailSenders)
    .set({ killSwitch: input.killSwitch, dailyCap: input.dailyCap, updatedAt: Date.now() })
    .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
    .run();
  return getEmailSafetySettings(db, workspaceId);
}

function utcDayStart(now = Date.now()): number {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

export function checkEmailRecipientSafety(
  db: Db,
  workspaceId: string,
  email: string,
): EmailRecipientSafetyResult {
  const settings = getEmailSafetySettings(db, workspaceId);
  if (settings.killSwitch) {
    return { ok: false, code: "kill_switch_on", message: "Workspace email sending is paused." };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { ok: false, code: "invalid_email", message: "A valid recipient email is required." };
  }

  const sentToday = Number(
    db
      .select({ count: sql<number>`count(*)` })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.workspaceId, workspaceId),
          inArray(emailDeliveries.status, ["accepted", "delivered"]),
          gte(emailDeliveries.acceptedAt, utcDayStart()),
        ),
      )
      .get()?.count ?? 0,
  );
  if (sentToday >= settings.dailyCap) {
    return {
      ok: false,
      code: "daily_cap_reached",
      message: `Workspace daily email cap of ${settings.dailyCap} has been reached.`,
      count: sentToday,
      cap: settings.dailyCap,
    };
  }

  const suppression = db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.normalizedEmail, normalizedEmail),
      ),
    )
    .get();
  if (suppression) {
    return { ok: false, code: "suppressed", message: "This recipient is suppressed." };
  }

  const permission = getEmailPermission(db, workspaceId, normalizedEmail);
  if (permission?.status !== "allowed") {
    return {
      ok: false,
      code: permission?.status === "suppressed" ? "suppressed" : "permission_unknown",
      message:
        permission?.status === "suppressed"
          ? "This recipient is suppressed."
          : "Explicit recipient send permission is required.",
    };
  }
  return { ok: true, normalizedEmail };
}

export class EmailSafetyConfigurationError extends Error {
  readonly code = "sender_not_configured";

  constructor() {
    super("Configure an email sender before changing email safety settings.");
    this.name = "EmailSafetyConfigurationError";
  }
}
