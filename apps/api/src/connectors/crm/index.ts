import type { Connection, ConnectorProvider } from "@tuezday/contracts";
import type { ConnectorFabric } from "../fabric";
import { FreshsalesAdapter } from "./freshsales";

/**
 * Provider-agnostic CRM boundary. Every CRM call from services goes through
 * this interface so HubSpot/Pipedrive/Twenty adapters slot in without
 * touching the CRM domain.
 */
export interface CrmContactRecord {
  externalId: string;
  name: string;
  email: string;
  company: string;
  role: string;
}

export interface CrmAdapter {
  listContacts(): Promise<{ contacts: CrmContactRecord[]; truncated: boolean }>;
  /** Create a contact in the CRM; returns its external id. */
  createContact(input: { name: string; email: string; role?: string }): Promise<string>;
  createNote(externalContactId: string, body: string): Promise<void>;
}

export function crmAdapterFor(
  fabric: ConnectorFabric,
  provider: ConnectorProvider,
  connection: Connection,
): CrmAdapter | undefined {
  if (!provider.categories?.includes("crm")) return undefined;
  if (provider.key === "freshsales") {
    return new FreshsalesAdapter(fabric, {
      nangoConnectionId: connection.nangoConnectionId,
      integrationKey: `tuezday-${provider.key}`,
      baseUrl: connection.config.baseUrl ?? "",
    });
  }
  // OAuth CRMs (HubSpot/Pipedrive) get adapters once their OAuth apps exist.
  return undefined;
}
