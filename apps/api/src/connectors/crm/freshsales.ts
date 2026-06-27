import type { CrmSyncFilter, CrmView } from "@tuezday/contracts";
import { ConnectorFabricError, type ConnectorFabric, type ProxyJsonResult } from "../fabric";
import type { CrmAdapter, CrmContactRecord } from "./index";

/**
 * Freshsales (Freshworks CRM) over the Nango proxy. Listing is view-based:
 * /api/contacts/filters yields the view ids, then /api/contacts/view/{id}
 * pages through the contacts. Writes use the documented `emails` array shape
 * (the flat `email` attribute is deprecated upstream).
 */

const PAGE_CAP = 25;
const PER_PAGE = 100;

interface FreshsalesOpts {
  nangoConnectionId: string;
  integrationKey: string;
  baseUrl: string;
}

interface RawContact {
  id: number | string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  emails?: Array<{ value?: string; is_primary?: boolean }>;
  job_title?: string;
  sales_accounts?: Array<{ name?: string; is_primary?: boolean }>;
  updated_at?: string;
}

function primaryEmail(contact: RawContact): string {
  if (contact.email) return contact.email;
  const emails = contact.emails ?? [];
  return emails.find((e) => e.is_primary)?.value ?? emails[0]?.value ?? "";
}

function contactName(contact: RawContact): string {
  if (contact.display_name) return contact.display_name;
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ");
}

function primaryCompany(contact: RawContact): string {
  const accounts = contact.sales_accounts ?? [];
  return accounts.find((a) => a.is_primary)?.name ?? accounts[0]?.name ?? "";
}

function splitName(name: string): { first_name: string; last_name?: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0]! };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}

export class FreshsalesAdapter implements CrmAdapter {
  constructor(
    private readonly fabric: ConnectorFabric,
    private readonly opts: FreshsalesOpts,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const result: ProxyJsonResult = await this.fabric.proxyJson(
      method,
      path,
      this.opts.nangoConnectionId,
      this.opts.integrationKey,
      {
        ...(body !== undefined ? { body } : {}),
        ...(this.opts.baseUrl ? { baseUrlOverride: this.opts.baseUrl } : {}),
      },
    );
    if (result.status < 200 || result.status >= 300) {
      const detail = result.json !== undefined ? JSON.stringify(result.json).slice(0, 200) : "";
      throw new ConnectorFabricError(
        `Freshsales returned ${result.status} for ${method} ${path}${detail ? `: ${detail}` : ""}`,
      );
    }
    return result.json;
  }

  async listViews(): Promise<CrmView[]> {
    const body = (await this.request("GET", "/api/contacts/filters")) as {
      filters?: Array<{ id: number | string; name?: string }>;
    };
    return (body.filters ?? []).map((f) => ({ id: String(f.id), name: f.name ?? `View ${f.id}` }));
  }

  /** The chosen view, or the "All Contacts" default. */
  private async resolveViewId(filter?: CrmSyncFilter): Promise<string> {
    if (filter?.viewId) return filter.viewId;
    const views = await this.listViews();
    const all = views.find((v) => v.name.toLowerCase() === "all contacts") ?? views[0];
    if (!all) throw new ConnectorFabricError("Freshsales returned no contact views to sync from.");
    return all.id;
  }

  async listContacts(
    filter?: CrmSyncFilter,
  ): Promise<{ contacts: CrmContactRecord[]; truncated: boolean }> {
    const viewId = await this.resolveViewId(filter);
    const cutoff = filter?.updatedSince;
    const contacts: CrmContactRecord[] = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, PAGE_CAP); page++) {
      const body = (await this.request(
        "GET",
        `/api/contacts/view/${viewId}?page=${page}&per_page=${PER_PAGE}&include=sales_accounts`,
      )) as { contacts?: RawContact[]; meta?: { total_pages?: number } };
      totalPages = body.meta?.total_pages ?? 1;
      for (const raw of body.contacts ?? []) {
        // Drop contacts updated before the cutoff; keep ones we can't date.
        if (cutoff !== undefined) {
          const updated = raw.updated_at ? Date.parse(raw.updated_at) : NaN;
          if (!Number.isNaN(updated) && updated < cutoff) continue;
        }
        contacts.push({
          externalId: String(raw.id),
          name: contactName(raw),
          email: primaryEmail(raw),
          company: primaryCompany(raw),
          role: raw.job_title ?? "",
        });
      }
    }
    return { contacts, truncated: totalPages > PAGE_CAP };
  }

  async createContact(input: { name: string; email: string; role?: string }): Promise<string> {
    const body = (await this.request("POST", "/api/contacts", {
      contact: {
        ...splitName(input.name),
        emails: [{ value: input.email, is_primary: true }],
        ...(input.role ? { job_title: input.role } : {}),
      },
    })) as { contact?: { id?: number | string } };
    const id = body.contact?.id;
    if (id === undefined || id === null) {
      throw new ConnectorFabricError("Freshsales created the contact but returned no id.");
    }
    return String(id);
  }

  async createNote(externalContactId: string, body: string): Promise<void> {
    const numericId = Number(externalContactId);
    await this.request("POST", "/api/notes", {
      note: {
        description: body,
        targetable_type: "Contact",
        targetable_id: Number.isFinite(numericId) ? numericId : externalContactId,
      },
    });
  }
}
