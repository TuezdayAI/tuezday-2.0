import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  MAILBOX_DEFAULT_DAILY_CAP,
  mailboxSendingWindowSchema,
  type Mailbox,
  type MailboxProvider as MailboxProviderKind,
  type MailboxStatus,
  type MailboxWithUsage,
  type UpdateMailboxInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { emailDeliveries, mailboxes, type MailboxRow } from "../db/schema";
import type { GmailMailboxProvider } from "../outbound-email/gmail";
import { getConnection } from "./connections";

export class MailboxError extends Error {
  constructor(
    readonly code:
      | "connection_not_found"
      | "connection_not_gmail"
      | "connection_not_connected"
      | "mailbox_profile_failed"
      | "mailbox_not_found",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "MailboxError";
  }
}

function rowToMailbox(row: MailboxRow): Mailbox {
  let sendingWindow: Mailbox["sendingWindow"] = {};
  try {
    const parsed = mailboxSendingWindowSchema.safeParse(JSON.parse(row.sendingWindowJson));
    if (parsed.success) sendingWindow = parsed.data;
  } catch {
    // A malformed stored window degrades to "always" rather than breaking reads.
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    provider: row.provider as MailboxProviderKind,
    address: row.address,
    displayName: row.displayName,
    replyTo: row.replyTo,
    signature: row.signature,
    dailyCap: row.dailyCap,
    sendingWindow,
    defaultPersonaId: row.defaultPersonaId,
    status: row.status as MailboxStatus,
    lastPolledAt: row.lastPolledAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function utcDayStart(nowMs: number): number {
  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

/** Accepted gmail sends from this mailbox since UTC midnight — the per-mailbox cap basis. */
export function mailboxDailySendCount(
  db: Db,
  workspaceId: string,
  mailboxId: string,
  nowMs: number = Date.now(),
): number {
  return Number(
    db
      .select({ count: sql<number>`count(*)` })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.workspaceId, workspaceId),
          eq(emailDeliveries.mailboxId, mailboxId),
          eq(emailDeliveries.provider, "gmail"),
          inArray(emailDeliveries.status, ["accepted", "delivered"]),
          gte(emailDeliveries.acceptedAt, utcDayStart(nowMs)),
        ),
      )
      .get()?.count ?? 0,
  );
}

function withUsage(db: Db, mailbox: Mailbox): MailboxWithUsage {
  return {
    ...mailbox,
    sentToday: mailboxDailySendCount(db, mailbox.workspaceId, mailbox.id),
  };
}

export function getMailboxRow(
  db: Db,
  workspaceId: string,
  mailboxId: string,
): MailboxRow | undefined {
  return db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)))
    .get();
}

export function getMailbox(db: Db, workspaceId: string, mailboxId: string): Mailbox | undefined {
  const row = getMailboxRow(db, workspaceId, mailboxId);
  return row ? rowToMailbox(row) : undefined;
}

export function listMailboxes(db: Db, workspaceId: string): MailboxWithUsage[] {
  return db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId))
    .orderBy(mailboxes.createdAt)
    .all()
    .map((row) => withUsage(db, rowToMailbox(row)));
}

/** Connected mailboxes only — what the poller and send guard operate on. */
export function listConnectedMailboxes(db: Db, workspaceId: string): Mailbox[] {
  return db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.status, "connected")))
    .orderBy(mailboxes.createdAt)
    .all()
    .map(rowToMailbox);
}

/**
 * Register the mailbox behind a connected `gmail` connection. The address is
 * pulled from the Gmail profile — never hand-typed. Upsert-safe on
 * (workspaceId, address): reconnecting the same account revives the row.
 */
export async function createMailbox(
  db: Db,
  gmail: GmailMailboxProvider,
  workspaceId: string,
  input: { connectionId: string },
): Promise<MailboxWithUsage> {
  const connection = getConnection(db, workspaceId, input.connectionId);
  if (!connection) {
    throw new MailboxError("connection_not_found", "Connection not found.", 404);
  }
  if (connection.providerKey !== "gmail") {
    throw new MailboxError(
      "connection_not_gmail",
      "Mailboxes ride a Gmail connection — connect Gmail first.",
      409,
    );
  }
  if (connection.status !== "connected") {
    throw new MailboxError(
      "connection_not_connected",
      "Reconnect the Gmail connection before adding it as a mailbox.",
      409,
    );
  }

  let address: string;
  try {
    const profile = await gmail.getProfile(connection.nangoConnectionId);
    address = profile.emailAddress.trim().toLowerCase();
  } catch (err) {
    throw new MailboxError(
      "mailbox_profile_failed",
      `Could not read the Gmail profile: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  const now = Date.now();
  const existing = db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.address, address)))
    .get();
  if (existing) {
    db.update(mailboxes)
      .set({
        connectionId: connection.id,
        status: "connected",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(mailboxes.id, existing.id))
      .run();
    return withUsage(db, getMailbox(db, workspaceId, existing.id)!);
  }

  const id = randomUUID();
  db.insert(mailboxes)
    .values({
      id,
      workspaceId,
      connectionId: connection.id,
      provider: "gmail",
      address,
      displayName: "",
      replyTo: null,
      signature: "",
      dailyCap: MAILBOX_DEFAULT_DAILY_CAP,
      sendingWindowJson: "{}",
      defaultPersonaId: null,
      status: "connected",
      lastPolledAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return withUsage(db, getMailbox(db, workspaceId, id)!);
}

export function updateMailbox(
  db: Db,
  workspaceId: string,
  mailboxId: string,
  input: UpdateMailboxInput,
): MailboxWithUsage | undefined {
  const existing = getMailboxRow(db, workspaceId, mailboxId);
  if (!existing) return undefined;
  db.update(mailboxes)
    .set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.signature !== undefined ? { signature: input.signature } : {}),
      ...(input.dailyCap !== undefined ? { dailyCap: input.dailyCap } : {}),
      ...(input.sendingWindow !== undefined
        ? { sendingWindowJson: JSON.stringify(input.sendingWindow) }
        : {}),
      ...(input.defaultPersonaId !== undefined ? { defaultPersonaId: input.defaultPersonaId } : {}),
      updatedAt: Date.now(),
    })
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)))
    .run();
  return withUsage(db, getMailbox(db, workspaceId, mailboxId)!);
}

/** Soft delete: the mailbox stops sending/polling but its send history stays attributable. */
export function deleteMailbox(db: Db, workspaceId: string, mailboxId: string): boolean {
  const existing = getMailboxRow(db, workspaceId, mailboxId);
  if (!existing) return false;
  db.update(mailboxes)
    .set({ status: "disconnected", updatedAt: Date.now() })
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)))
    .run();
  return true;
}
