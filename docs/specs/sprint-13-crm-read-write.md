# Spec: Sprint 13 (slice 1) — CRM Read/Write

> Status: in build
> First slice of Integration Expansion (sprint plan "Sprint 13+", item 1). Proves the connector fabric carries a real CRM both directions. Provider for the first end-to-end is **Freshsales** (founder's CRM; API-key auth, native `freshsales` template in Nango's providers.yaml — no OAuth app needed). The CRM domain is provider-agnostic behind a `CrmAdapter` boundary so HubSpot/Pipedrive/Salesforce/Twenty plug in later without schema changes. Tuezday remains **not a CRM**: the CRM stays the system of record; Tuezday holds a synced mirror only as working state for lead generation.

## What this slice does

Read and write through the same fabric, closing a full loop:

1. **Read.** Sync contacts from a connected CRM into a `crm_contacts` mirror (id, name, email, company, role, externalId). A synced contact can be **imported as a lead** (reuses the Sprint 11 lead model — dedupes by email; if a lead with that email exists it links instead of duplicating).
2. **Write — contacts.** Push an existing Tuezday lead to the CRM as a new contact; the created contact's external id is stored so the lead and CRM contact stay linked.
3. **Write — activity.** Log an **approved** outbound draft (Sprint 11) back to the CRM as a note on the linked contact. This is the payoff loop: CRM contact → import as lead → brain-personalized draft → approve → the approved email lands in the CRM where the rest of the team sees it.

Founder-visible chain: connect Freshsales → Sync → contacts appear → import one as a lead → generate + approve an outbound draft for it → Log to CRM → the note is on the contact in Freshsales.

## Out of scope

Automatic/scheduled sync (manual Sync button only; the worker can poll later), two-way field updates (no editing CRM fields from Tuezday, no conflict resolution), accounts/companies/deals as objects (contacts only; `company` is read as a display field, never written), delete propagation in either direction, HubSpot/Pipedrive/Salesforce adapters (registry entries stay `needs_oauth_app`), Twenty demo deployment, CRM-triggered inbound webhooks, syncing more than 25 pages of contacts (capped and reported, not silently truncated).

## Deployment

No new services. Freshsales connects through the existing Nango deployment (`npm run nango:up`). Connect form needs two founder inputs: the account **base URL** (the Freshworks "bundle alias", e.g. `https://acme.myfreshworks.com/crm/sales`) and the **API key** (Freshsales → Settings → API). Nango's `freshsales` template applies `Authorization: Token token=<apiKey>` and resolves the API host from a `bundleAlias` connection config; Tuezday passes that config at import time and stores only the base URL (never the key).

## Behavior

### Registry (contracts)

- `ConnectorProvider` gains `categories?: readonly ("crm" | "outbound")[]` so capability checks aren't keyed on provider names. Smartlead/Instantly → `["outbound"]`; Pipedrive/HubSpot → `["crm"]`.
- New entry: `{ key: "freshsales", label: "Freshsales", nangoProvider: "freshsales", authMode: "api_key", categories: ["crm"], testPath: "/api/settings/contacts/fields", requiresBaseUrl: true }`. `requiresBaseUrl` (new optional flag) makes the connect route reject a missing `baseUrl` with 400 before touching Nango.
- New contract: `crmContactSchema` — id, workspaceId, connectionId, externalId, name, email (may be empty — CRMs allow contacts without email), company, role, leadId (nullable), lastSyncedAt, createdAt. Plus input schemas `crmSyncInputSchema` ({connectionId}), `pushLeadInputSchema` ({leadId, connectionId}), `logDraftInputSchema` ({draftId}).
- `EVENT_TYPES` gains `crm.contact.created` and `crm.note.logged` (emitted on the two write paths, delivered to webhooks like every other event).

### Fabric extension (`apps/api/src/connectors/`)

Two additions to `ConnectorFabric`, implemented in `NangoFabric`, faked in tests:

- `importConnection(..., connectionConfig?: Record<string, string>)` — optional fourth arg, sent to Nango as `connection_config` (the freshsales template requires `bundleAlias`, derived from the founder's base URL by stripping the protocol).
- `proxyJson(method: "GET" | "POST", path, connectionId, providerConfigKey, opts?: { body?: unknown; baseUrlOverride?: string })` → `{ status, json: unknown | undefined }` — full-body JSON proxy for adapter calls. `proxyGet` (300-char snippet) stays as-is for connection tests.

### CrmAdapter boundary (`apps/api/src/connectors/crm/`)

```
interface CrmAdapter {
  listContacts(): Promise<CrmContactRecord[]>;   // externalId, name, email, company, role
  createContact(input: { name, email, role? }): Promise<string>;  // returns externalId
  createNote(externalContactId: string, body: string): Promise<void>;
}
```

`FreshsalesAdapter` implements it over `proxyJson` (per-connection: nango connection id, integration key, base URL):

- `listContacts`: `GET /api/contacts/filters` → find the "All Contacts" view id → `GET /api/contacts/view/{id}?page=N` until `meta.total_pages`, capped at 25 pages; maps `display_name`/first+last, primary email, `job_title`. Sync result reports if the cap truncated.
- `createContact`: `POST /api/contacts` with `{ contact: { first_name, last_name, emails: [{ value, is_primary: true }], job_title } }` (the `email` attribute is deprecated upstream; `emails` array is the supported shape). Name split: last word → last_name, rest → first_name (single-word names go to first_name).
- `createNote`: `POST /api/notes` with `{ note: { description, targetable_type: "Contact", targetable_id } }`.

Adapter selection is by provider `categories` containing `"crm"` + provider key → adapter constructor; an unknown CRM key fails with a clear error. Non-2xx proxy responses raise `ConnectorFabricError` with the status + body snippet; services surface them as 502 with the detail.

### CRM mirror (Tuezday-side)

`crm_contacts` table: id, workspaceId (fk, cascade), connectionId (fk connections, cascade), externalId, name, email (default ""), company (default ""), role (default ""), leadId (fk leads, **set null** on lead delete), lastSyncedAt, createdAt. Unique `(connection_id, external_id)`.

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/crm/sync` | body `{connectionId}` → must be a `connected` connection whose provider has the `crm` category (400 otherwise). Pulls via adapter, upserts by `(connectionId, externalId)` → `{fetched, created, updated, truncated}`. Adapter failure marks nothing; returns 502 with detail. |
| `GET /workspaces/:id/crm/contacts` | mirror rows, newest sync first, each with its linked lead (id+name) when `leadId` is set |
| `POST /workspaces/:id/crm/contacts/:crmContactId/import-lead` | creates a lead from the contact (name, email, company, role; notes = "Imported from <provider>"); if a lead with the same email exists (case-insensitive) it **links** to it instead. Contact without an email → 400. Already linked → 409. Returns the lead. |
| `POST /workspaces/:id/crm/push-lead` | body `{leadId, connectionId}` → adapter `createContact`, insert mirror row with returned externalId + `leadId` link, emit `crm.contact.created`. Lead already linked to a contact on this connection → 409. |
| `POST /workspaces/:id/crm/log-draft` | body `{draftId}` → draft must be state `approved` and have a `leadId` (400 otherwise); the lead must be linked to a CRM contact (400 with "push the lead first" detail). Note body = draft content + "— approved in Tuezday". Emits `crm.note.logged`. Repeat calls allowed (re-logging is the CRM's dedup problem, not ours). |

All CRM writes go through the fabric; nothing in this slice talks to Freshsales directly. Events are emitted **after** the CRM call succeeds; webhook delivery failures never fail the request (existing `emitEvent` semantics).

### Web (`/workspaces/[id]/crm`)

One page so the acceptance loop is visible in one place:

- **Connection bar**: pick a CRM-capable connection (or a pointer to the connectors page if none), Sync button, last sync result (`fetched/created/updated`, truncation warning).
- **Contacts table**: name, email, company, role, lead link badge; per-row **Import as lead** (disabled when linked or email missing).
- **Leads panel**: Tuezday leads with link status; per-row **Push to CRM** for unlinked leads.
- **Approved outbound drafts panel**: approved drafts that have a lead; per-row **Log to CRM** (disabled until the lead is linked, with the reason shown); success shows when it was logged.
- Connectors page: Freshsales card appears with the api_key connect form + required base-URL field.

## Automated verification

- Contracts: freshsales registry entry (categories, requiresBaseUrl), crm contact + input schemas, new event types.
- Nango client: `connection_config` included in the import body when given; `proxyJson` sends method/body/headers (Connection-Id, Provider-Config-Key, Base-Url-Override) and parses JSON, returns `json: undefined` on non-JSON.
- FreshsalesAdapter (fixture fabric): filters→view→pagination walk incl. cap; contact field mapping (display_name fallback, primary email, missing email); createContact body shape incl. name splitting; createNote body shape; non-2xx → ConnectorFabricError.
- API (fake fabric + fake adapter wiring): sync upserts new + updates changed rows, second sync is idempotent; sync on a non-CRM or disconnected connection → 400; import-lead creates and links / links existing email match / 400 no email / 409 already linked; push-lead creates mirror row + emits `crm.contact.created` / 409 already pushed; log-draft happy path emits `crm.note.logged` / 400 not approved / 400 no lead / 400 lead not linked; adapter failure → 502 and no partial DB writes.
- Events: both new types deliver to subscribed webhooks signed (existing fixture).

## Founder acceptance checklist

1. `npm run nango:up`; connectors page → connect **Freshsales** with your bundle URL + API key → `connected`, Test passes (real request through the proxy).
2. CRM page → **Sync** → your Freshsales contacts appear with name/email/company/role.
3. **Import as lead** on one contact → it shows in leads (and on the outbound page) linked to the contact.
4. Outbound: generate a draft for that lead → approve it.
5. CRM page → **Log to CRM** on the approved draft → the note (email text) is visible on the contact in Freshsales.
6. **Push to CRM** on a lead that came from CSV → the contact appears in Freshsales; event log shows `crm.contact.created` and `crm.note.logged`.
