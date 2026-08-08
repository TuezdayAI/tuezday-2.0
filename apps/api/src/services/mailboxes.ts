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
export async function mailboxDailySendCount(
  db: Db,
  workspaceId: string,
  mailboxId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  return Number(
    ((await db
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
      ))[0])?.count ?? 0,
  );
}

async function withUsage(db: Db, mailbox: Mailbox): Promise<MailboxWithUsage> {
  return {
    ...mailbox,
    sentToday: await mailboxDailySendCount(db, mailbox.workspaceId, mailbox.id),
  };
}

export async function getMailboxRow(
  db: Db,
  workspaceId: string,
  mailboxId: string,
): Promise<MailboxRow | undefined> {
  return (await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId))))[0];
}

export async function getMailbox(db: Db, workspaceId: string, mailboxId: string): Promise<Mailbox | undefined> {
  const row = await getMailboxRow(db, workspaceId, mailboxId);
  return row ? rowToMailbox(row) : undefined;
}

export async function listMailboxes(db: Db, workspaceId: string): Promise<MailboxWithUsage[]> {
  return await Promise.all((await await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
      .orderBy(mailboxes.createdAt))
      .map(async (row) => await withUsage(db, rowToMailbox(row))));
}

/** Connected mailboxes only — what the poller and send guard operate on. */
export async function listConnectedMailboxes(db: Db, workspaceId: string): Promise<Mailbox[]> {
  return (await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.status, "connected")))
    .orderBy(mailboxes.createdAt))
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
  const connection = await getConnection(db, workspaceId, input.connectionId);
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
  const existing = (await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.address, address))))[0];
  if (existing) {
    await db.update(mailboxes)
      .set({
        connectionId: connection.id,
        status: "connected",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(mailboxes.id, existing.id));
    return await withUsage(db, (await getMailbox(db, workspaceId, existing.id))!);
  }

  const id = randomUUID();
  await db.insert(mailboxes)
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
    });
  return await withUsage(db, (await getMailbox(db, workspaceId, id))!);
}

export async function updateMailbox(
  db: Db,
  workspaceId: string,
  mailboxId: string,
  input: UpdateMailboxInput,
): Promise<MailboxWithUsage | undefined> {
  const existing = await getMailboxRow(db, workspaceId, mailboxId);
  if (!existing) return undefined;
  await db.update(mailboxes)
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
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)));
  return await withUsage(db, (await getMailbox(db, workspaceId, mailboxId))!);
}

/** Soft delete: the mailbox stops sending/polling but its send history stays attributable. */
export async function deleteMailbox(db: Db, workspaceId: string, mailboxId: string): Promise<boolean> {
  const existing = await getMailboxRow(db, workspaceId, mailboxId);
  if (!existing) return false;
  await db.update(mailboxes)
    .set({ status: "disconnected", updatedAt: Date.now() })
    .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, mailboxId)));
  return true;
}
