import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { CrmContact, Lead } from "@tuezday/contracts";
import type { Db } from "../db";
import { crmContacts, type CrmContactRow } from "../db/schema";
import type { CrmAdapter } from "../connectors/crm";
import { createLead, listLeads } from "./leads";

function rowToCrmContact(row: CrmContactRow): CrmContact {
  return { ...row };
}

export interface CrmContactWithLead extends CrmContact {
  lead: { id: string; name: string } | null;
}

export function listCrmContacts(db: Db, workspaceId: string): CrmContactWithLead[] {
  const rows = db
    .select()
    .from(crmContacts)
    .where(eq(crmContacts.workspaceId, workspaceId))
    .orderBy(desc(crmContacts.lastSyncedAt), desc(crmContacts.createdAt))
    .all();
  const leadById = new Map(listLeads(db, workspaceId).map((l) => [l.id, l]));
  return rows.map((row) => {
    const lead = row.leadId ? leadById.get(row.leadId) : undefined;
    return { ...rowToCrmContact(row), lead: lead ? { id: lead.id, name: lead.name } : null };
  });
}

export function getCrmContact(
  db: Db,
  workspaceId: string,
  crmContactId: string,
): CrmContact | undefined {
  const row = db
    .select()
    .from(crmContacts)
    .where(and(eq(crmContacts.workspaceId, workspaceId), eq(crmContacts.id, crmContactId)))
    .get();
  return row ? rowToCrmContact(row) : undefined;
}

export function getCrmContactByLead(
  db: Db,
  workspaceId: string,
  leadId: string,
  connectionId?: string,
): CrmContact | undefined {
  const row = db
    .select()
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.workspaceId, workspaceId),
        eq(crmContacts.leadId, leadId),
        ...(connectionId ? [eq(crmContacts.connectionId, connectionId)] : []),
      ),
    )
    .get();
  return row ? rowToCrmContact(row) : undefined;
}

export interface CrmSyncResult {
  fetched: number;
  created: number;
  updated: number;
  truncated: boolean;
}

/**
 * Pull contacts from the CRM into the mirror. Upserts by (connection,
 * externalId); `updated` counts only rows whose mapped fields changed.
 * Throws ConnectorFabricError before any write when the CRM call fails.
 */
export async function syncCrmContacts(
  db: Db,
  adapter: CrmAdapter,
  workspaceId: string,
  connectionId: string,
): Promise<CrmSyncResult> {
  const { contacts, truncated } = await adapter.listContacts();
  const existing = db
    .select()
    .from(crmContacts)
    .where(and(eq(crmContacts.workspaceId, workspaceId), eq(crmContacts.connectionId, connectionId)))
    .all();
  const byExternalId = new Map(existing.map((row) => [row.externalId, row]));

  const now = Date.now();
  let created = 0;
  let updated = 0;
  for (const contact of contacts) {
    const row = byExternalId.get(contact.externalId);
    if (!row) {
      db.insert(crmContacts)
        .values({
          id: randomUUID(),
          workspaceId,
          connectionId,
          externalId: contact.externalId,
          name: contact.name,
          email: contact.email,
          company: contact.company,
          role: contact.role,
          leadId: null,
          lastSyncedAt: now,
          createdAt: now,
        })
        .run();
      created++;
      continue;
    }
    const changed =
      row.name !== contact.name ||
      row.email !== contact.email ||
      row.company !== contact.company ||
      row.role !== contact.role;
    db.update(crmContacts)
      .set({
        name: contact.name,
        email: contact.email,
        company: contact.company,
        role: contact.role,
        lastSyncedAt: now,
      })
      .where(eq(crmContacts.id, row.id))
      .run();
    if (changed) updated++;
  }
  return { fetched: contacts.length, created, updated, truncated };
}

export type ImportContactResult =
  | { ok: true; lead: Lead; linkedExisting: boolean }
  | { ok: false; error: "contact_has_no_email" | "already_linked" };

/**
 * Turn a synced CRM contact into a Tuezday lead. An existing lead with the
 * same email (case-insensitive) is linked instead of duplicated.
 */
export function importCrmContactAsLead(
  db: Db,
  workspaceId: string,
  contact: CrmContact,
  providerLabel: string,
): ImportContactResult {
  if (contact.leadId) return { ok: false, error: "already_linked" };
  if (!contact.email) return { ok: false, error: "contact_has_no_email" };

  const existing = listLeads(db, workspaceId).find(
    (l) => l.email.toLowerCase() === contact.email.toLowerCase(),
  );
  const lead =
    existing ??
    createLead(db, workspaceId, {
      name: contact.name || contact.email,
      email: contact.email,
      company: contact.company,
      role: contact.role,
      notes: `Imported from ${providerLabel}`,
      xHandle: "",
    });

  db.update(crmContacts).set({ leadId: lead.id }).where(eq(crmContacts.id, contact.id)).run();
  return { ok: true, lead, linkedExisting: Boolean(existing) };
}

/**
 * Create a contact in the CRM from a lead and store the linked mirror row.
 * The CRM call happens first — nothing is written when it fails.
 */
export async function pushLeadToCrm(
  db: Db,
  adapter: CrmAdapter,
  workspaceId: string,
  connectionId: string,
  lead: Lead,
): Promise<CrmContact> {
  const externalId = await adapter.createContact({
    name: lead.name,
    email: lead.email,
    ...(lead.role ? { role: lead.role } : {}),
  });
  const now = Date.now();
  const row: CrmContactRow = {
    id: randomUUID(),
    workspaceId,
    connectionId,
    externalId,
    name: lead.name,
    email: lead.email,
    company: lead.company,
    role: lead.role,
    leadId: lead.id,
    lastSyncedAt: now,
    createdAt: now,
  };
  db.insert(crmContacts).values(row).run();
  return rowToCrmContact(row);
}
