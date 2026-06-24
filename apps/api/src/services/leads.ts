import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  createLeadInputSchema,
  type CreateLeadInput,
  type Lead,
  type UpdateLeadInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { leads, type LeadRow } from "../db/schema";
import { removeLeadFromAudiences } from "./audiences";

export function createLead(db: Db, workspaceId: string, input: CreateLeadInput): Lead {
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
  db.insert(leads).values(row).run();
  return row;
}

/** Partial edit of a lead (e.g. setting an X handle). Email is re-lowercased. */
export function updateLead(
  db: Db,
  workspaceId: string,
  leadId: string,
  input: UpdateLeadInput,
): Lead | undefined {
  if (!getLead(db, workspaceId, leadId)) return undefined;
  const patch: Partial<LeadRow> = { ...input };
  if (input.email !== undefined) patch.email = input.email.toLowerCase();
  if (Object.keys(patch).length > 0) {
    db.update(leads).set(patch).where(eq(leads.id, leadId)).run();
  }
  return getLead(db, workspaceId, leadId);
}

export function listLeads(db: Db, workspaceId: string): Lead[] {
  return db
    .select()
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))
    .orderBy(desc(leads.createdAt))
    .all();
}

export function getLead(db: Db, workspaceId: string, leadId: string): Lead | undefined {
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .get();
}

export function deleteLead(db: Db, workspaceId: string, leadId: string): boolean {
  if (!getLead(db, workspaceId, leadId)) return false;
  removeLeadFromAudiences(db, workspaceId, leadId);
  db.delete(leads).where(eq(leads.id, leadId)).run();
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

export function importLeadsCsv(db: Db, workspaceId: string, csv: string): ImportResult {
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

  const existingEmails = new Set(listLeads(db, workspaceId).map((l) => l.email.toLowerCase()));
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
    createLead(db, workspaceId, parsed.data);
    existingEmails.add(parsed.data.email.toLowerCase());
    result.imported += 1;
  }
  return result;
}

/** CSV field escaping for export. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
