import { eq } from "drizzle-orm";
import {
  EMAIL_SENDER_STATUSES,
  emailDnsRecordSchema,
  type EmailDnsRecord,
  type EmailSender,
  type EmailSenderStatus,
  type UpdateEmailSenderInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaceEmailSenders, type WorkspaceEmailSenderRow } from "../db/schema";
import type { OutboundEmailDomain, OutboundEmailProvider } from "../outbound-email/provider";

function dnsRecordsFromJson(value: string): EmailDnsRecord[] {
  try {
    const parsed = emailDnsRecordSchema.array().max(20).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function senderStatus(value: string): EmailSenderStatus {
  return EMAIL_SENDER_STATUSES.includes(value as EmailSenderStatus)
    ? (value as EmailSenderStatus)
    : "failed";
}

function rowToSender(row: WorkspaceEmailSenderRow): EmailSender {
  return {
    workspaceId: row.workspaceId,
    domain: row.domain,
    fromLocalPart: row.fromLocalPart,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    status: senderStatus(row.status),
    provider: "resend",
    providerDomainId: row.providerDomainId,
    dnsRecords: dnsRecordsFromJson(row.dnsRecordsJson),
    killSwitch: row.killSwitch,
    dailyCap: row.dailyCap,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function statusFromDomain(domain: OutboundEmailDomain): EmailSenderStatus {
  if (domain.status === "verified" && domain.sendingEnabled) return "verified";
  if (["failed", "failure", "temporary_failure"].includes(domain.status)) return "failed";
  return "pending";
}

export function getEmailSender(db: Db, workspaceId: string): EmailSender | null {
  const row = db
    .select()
    .from(workspaceEmailSenders)
    .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
    .get();
  return row ? rowToSender(row) : null;
}

function persistProviderFailure(db: Db, workspaceId: string, error: unknown): void {
  db.update(workspaceEmailSenders)
    .set({
      status: "failed",
      lastError: errorMessage(error),
      lastCheckedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
    .run();
}

export async function updateEmailSender(
  db: Db,
  provider: OutboundEmailProvider,
  workspaceId: string,
  input: UpdateEmailSenderInput,
): Promise<EmailSender> {
  const existing = getEmailSender(db, workspaceId);
  const domainChanged = existing?.domain !== input.domain;
  const needsProviderDomain = domainChanged || !existing?.providerDomainId;
  const now = Date.now();
  let providerDomain: OutboundEmailDomain | null = null;

  if (needsProviderDomain) {
    try {
      providerDomain = await provider.createDomain(input.domain);
    } catch (error) {
      db.insert(workspaceEmailSenders)
        .values({
          workspaceId,
          domain: input.domain,
          fromLocalPart: input.fromLocalPart,
          fromName: input.fromName,
          fromAddress: `${input.fromLocalPart}@${input.domain}`.toLowerCase(),
          replyTo: input.replyTo,
          status: "failed",
          provider: "resend",
          providerDomainId: null,
          dnsRecordsJson: "[]",
          killSwitch: existing?.killSwitch ?? true,
          dailyCap: existing?.dailyCap ?? 100,
          lastCheckedAt: now,
          lastError: errorMessage(error),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: workspaceEmailSenders.workspaceId,
          set: {
            domain: input.domain,
            fromLocalPart: input.fromLocalPart,
            fromName: input.fromName,
            fromAddress: `${input.fromLocalPart}@${input.domain}`.toLowerCase(),
            replyTo: input.replyTo,
            status: "failed",
            providerDomainId: null,
            dnsRecordsJson: "[]",
            lastCheckedAt: now,
            lastError: errorMessage(error),
            updatedAt: now,
          },
        })
        .run();
      throw error;
    }
  }

  const values = {
    workspaceId,
    domain: input.domain,
    fromLocalPart: input.fromLocalPart,
    fromName: input.fromName,
    fromAddress: `${input.fromLocalPart}@${input.domain}`.toLowerCase(),
    replyTo: input.replyTo,
    status: providerDomain ? "pending" : (existing?.status ?? "pending"),
    provider: "resend",
    providerDomainId: providerDomain?.id ?? existing?.providerDomainId ?? null,
    dnsRecordsJson: providerDomain
      ? JSON.stringify(providerDomain.dnsRecords)
      : JSON.stringify(existing?.dnsRecords ?? []),
    killSwitch: existing?.killSwitch ?? true,
    dailyCap: existing?.dailyCap ?? 100,
    lastCheckedAt: providerDomain ? now : (existing?.lastCheckedAt ?? null),
    lastError: providerDomain ? null : (existing?.lastError ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  db.insert(workspaceEmailSenders)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceEmailSenders.workspaceId,
      set: {
        domain: values.domain,
        fromLocalPart: values.fromLocalPart,
        fromName: values.fromName,
        fromAddress: values.fromAddress,
        replyTo: values.replyTo,
        status: values.status,
        providerDomainId: values.providerDomainId,
        dnsRecordsJson: values.dnsRecordsJson,
        lastCheckedAt: values.lastCheckedAt,
        lastError: values.lastError,
        updatedAt: values.updatedAt,
      },
    })
    .run();
  return getEmailSender(db, workspaceId)!;
}

export async function verifyEmailSender(
  db: Db,
  provider: OutboundEmailProvider,
  workspaceId: string,
): Promise<EmailSender> {
  const sender = getEmailSender(db, workspaceId);
  if (!sender?.providerDomainId) {
    throw new EmailSenderLifecycleError("Configure an email sender before verification", {
      code: "sender_not_configured",
      status: 409,
    });
  }
  try {
    await provider.verifyDomain(sender.providerDomainId);
    const now = Date.now();
    db.update(workspaceEmailSenders)
      .set({ status: "pending", lastError: null, lastCheckedAt: now, updatedAt: now })
      .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
      .run();
  } catch (error) {
    persistProviderFailure(db, workspaceId, error);
    throw error;
  }
  return getEmailSender(db, workspaceId)!;
}

export async function refreshEmailSender(
  db: Db,
  provider: OutboundEmailProvider,
  workspaceId: string,
): Promise<EmailSender> {
  const sender = getEmailSender(db, workspaceId);
  if (!sender?.providerDomainId) {
    throw new EmailSenderLifecycleError("Configure an email sender before checking verification", {
      code: "sender_not_configured",
      status: 409,
    });
  }
  try {
    const domain = await provider.getDomain(sender.providerDomainId);
    const now = Date.now();
    db.update(workspaceEmailSenders)
      .set({
        status: statusFromDomain(domain),
        dnsRecordsJson: JSON.stringify(domain.dnsRecords),
        lastError: null,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(workspaceEmailSenders.workspaceId, workspaceId))
      .run();
  } catch (error) {
    persistProviderFailure(db, workspaceId, error);
    throw error;
  }
  return getEmailSender(db, workspaceId)!;
}

export class EmailSenderLifecycleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status: number }) {
    super(message);
    this.name = "EmailSenderLifecycleError";
    this.code = options.code;
    this.status = options.status;
  }
}
