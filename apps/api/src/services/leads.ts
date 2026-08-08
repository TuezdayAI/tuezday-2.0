import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  createLeadInputSchema,
  type CreateLeadInput,
  type Lead,
  type UpdateLeadInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { drafts, leads, type LeadRow } from "../db/schema";
import { removeLeadFromAudiences } from "./audiences";
import {
  deriveEmailSendIdempotencyKey,
  prepareEmailAction,
} from "./external-action-email";
import type { ExternalActionCommand } from "./external-action-coordinator";
import { getMailbox } from "./mailboxes";

export class OutboundDraftEmailError extends Error {
  constructor(
    readonly code:
      | "draft_not_found"
      | "draft_not_approved"
      | "draft_not_email"
      | "lead_not_found"
      | "mailbox_not_found"
      | "mailbox_not_connected",
    message: string,
  ) {
    super(message);
    this.name = "OutboundDraftEmailError";
  }
}

export async function prepareOutboundDraftEmailAction(
  db: Db,
  workspaceId: string,
  draftId: string,
  mailboxId?: string,
): Promise<ExternalActionCommand> {
  const draft = (await db.select().from(drafts).where(
    and(eq(drafts.workspaceId, workspaceId), eq(drafts.id, draftId)),
  ))[0];
  if (!draft) throw new OutboundDraftEmailError("draft_not_found", "Outbound draft not found.");
  if (draft.state !== "approved") {
    throw new OutboundDraftEmailError("draft_not_approved", "Approve this draft before sending it.");
  }
  if (draft.channel !== "email" || draft.taskType !== "outbound_email") {
    throw new OutboundDraftEmailError("draft_not_email", "This draft is not an outbound email.");
  }
  if (!draft.leadId || !await getLead(db, workspaceId, draft.leadId)) {
    throw new OutboundDraftEmailError("lead_not_found", "This draft is not linked to a current lead.");
  }
  if (mailboxId !== undefined) {
    const mailbox = await getMailbox(db, workspaceId, mailboxId);
    if (!mailbox) {
      throw new OutboundDraftEmailError("mailbox_not_found", "Mailbox not found.");
    }
    if (mailbox.status !== "connected") {
      throw new OutboundDraftEmailError(
        "mailbox_not_connected",
        "Reconnect the Gmail mailbox before sending from it.",
      );
    }
  }
  return await prepareEmailAction(db, workspaceId, {
    origin: "outbound_draft",
    originId: draft.id,
    idempotencyKey: deriveEmailSendIdempotencyKey(draft.id, {
      draftId: draft.id,
      content: draft.content,
      stepNumber: null,
    }),
    ...(mailboxId !== undefined ? { mailboxId } : {}),
  });
}

export async function createLead(db: Db, workspaceId: string, input: CreateLeadInput): Promise<Lead> {
  const row: LeadRow = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    email: input.email.toLowerCase(),
    company: input.company,
    role: input.role,
    notes: input.notes,
    xHandle: input.xHandle,
    createdAt: Date.now(),
  };
  await db.insert(leads).values(row);
  return row;
}

/** Partial edit of a lead (e.g. setting an X handle). Email is re-lowercased. */
export async function updateLead(
  db: Db,
  workspaceId: string,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Lead | undefined> {
  if (!await getLead(db, workspaceId, leadId)) return undefined;
  const patch: Partial<LeadRow> = { ...input };
  if (input.email !== undefined) patch.email = input.email.toLowerCase();
  if (Object.keys(patch).length > 0) {
    await db.update(leads).set(patch).where(eq(leads.id, leadId));
  }
  return await getLead(db, workspaceId, leadId);
}

export async function listLeads(db: Db, workspaceId: string): Promise<Lead[]> {
  return await db
    .select()
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))
    .orderBy(desc(leads.createdAt));
}

export async function getLead(db: Db, workspaceId: string, leadId: string): Promise<Lead | undefined> {
  return (await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId))))[0];
}

export async function deleteLead(db: Db, workspaceId: string, leadId: string): Promise<boolean> {
  if (!await getLead(db, workspaceId, leadId)) return false;
  await removeLeadFromAudiences(db, workspaceId, leadId);
  await db.delete(leads).where(eq(leads.id, leadId));
  return true;
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

/** Minimal RFC-4180-ish line parser: handles quoted fields and "" escapes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  "full name": "name",
  email: "email",
  "email address": "email",
  company: "company",
  organisation: "company",
  organization: "company",
  role: "role",
  title: "role",
  "job title": "role",
  notes: "notes",
  note: "notes",
  x: "xHandle",
  "x handle": "xHandle",
  twitter: "xHandle",
  "twitter handle": "xHandle",
  handle: "xHandle",
};

export async function importLeadsCsv(db: Db, workspaceId: string, csv: string): Promise<ImportResult> {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { imported: 0, skipped: 0, errors: ["CSV needs a header row and at least one lead row."] };
  }

  const headers = parseCsvLine(lines[0]!).map((h) => HEADER_ALIASES[h.toLowerCase()] ?? h.toLowerCase());
  if (!headers.includes("email")) {
    return { imported: 0, skipped: 0, errors: ['CSV needs an "email" column.'] };
  }

  const existingEmails = new Set((await listLeads(db, workspaceId)).map((l) => l.email.toLowerCase()));
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = fields[i] ?? "";
    });

    const parsed = createLeadInputSchema.safeParse({
      name: record.name || record.email,
      email: record.email,
      company: record.company ?? "",
      role: record.role ?? "",
      notes: record.notes ?? "",
      xHandle: record.xHandle ?? "",
    });
    if (!parsed.success) {
      result.skipped += 1;
      result.errors.push(`Skipped "${(record.email || line).slice(0, 50)}": invalid row.`);
      continue;
    }
    if (existingEmails.has(parsed.data.email.toLowerCase())) {
      result.skipped += 1;
      continue;
    }
    await createLead(db, workspaceId, parsed.data);
    existingEmails.add(parsed.data.email.toLowerCase());
    result.imported += 1;
  }
  return result;
}

/** CSV field escaping for export. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
