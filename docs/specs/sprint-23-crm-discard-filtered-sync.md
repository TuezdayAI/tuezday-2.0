# Spec: Sprint 23 — CRM contact management: discard + filtered sync

> Status: in build
> Branch: `sprint-23-crm-discard-filtered-sync` (off `main`).
> Roadmap: `docs/plans/sprint-guide-21-onward.md` → Phase A, Sprint 23 (founder list C1 + C2).
> Builds on: Sprint 13 (CRM read/write) — merged to `main`. No dependency on Sprints 21/22.

## Why

The founder hit two CRM friction points in the Sprint 13 slice:

- **C1 — no way to get rid of synced contacts.** A `crm_contacts` mirror row can't be removed, and even if it could, the next **Sync** upserts by `(connection, externalId)` and would resurrect it. The founder wants to control which CRM contacts live in Tuezday.
- **C2 — sync is all-or-nothing.** Sync always pulls the Freshsales "All Contacts" view in full (capped at 2,500). The founder wants to scope what comes in — by CRM list/segment or by recency.

Both are **local working-state controls**. The CRM stays the system of record; nothing here writes to or deletes from Freshsales.

## What this slice does

### 1. Discard (local soft-delete + tombstone + restore)  — C1

- **Discard** a synced `crm_contacts` row: it disappears from the working set and a re-sync **will not bring it back**. Implemented as a soft-delete — the row stays as its own tombstone (`discardedAt` timestamp set), so the unique `(connection, externalId)` key keeps blocking re-insertion and Sync skips it.
- **Restore** un-discards a contact (clears `discardedAt`). The next sync refreshes it again.
- Discard is **strictly local** (founder decision 2026-06-17): it never deletes the contact in Freshsales, and it never deletes a lead that was imported from the contact. A discarded contact drops out of all lead-linking logic (`getCrmContactByLead`), so it stops participating in push/log flows while discarded.

### 2. Filtered sync per connection  — C2

- A **sync filter** is configured per CRM connection and applied every Sync:
  - **View / list** — pick which Freshsales view (list/segment) to pull from instead of auto-selecting "All Contacts". This is the CRM-native list/segment filter.
  - **Updated since** — only sync contacts whose CRM `updated_at` is on/after a chosen date.
- The filter is stored on the connection (a `crm_sync_settings` row) and read at resolve time, so changing it needs no redeploy. Empty filter = today's behavior (All Contacts, all dates).
- A **views** endpoint lists the connection's Freshsales views so the UI can offer a dropdown.

Founder-visible chain: Sync → contacts appear → **Discard** a few → re-Sync → discarded ones stay gone → **Restore** one → it's back. Then set a **filter** (a specific view and/or an updated-since date) → Sync → only matching contacts come in.

## Out of scope

- **CRM-side delete** (deleting the contact in Freshsales). Deferred — discard is local-only this slice. (`deleteContact` on the adapter is intentionally not added yet.)
- Retroactive purge: narrowing a filter does **not** delete already-synced contacts that no longer match; the filter controls inflow only. The founder discards those manually.
- Owner / arbitrary-property filters (view + updated-since only this slice).
- Auto/scheduled sync (still the manual Sync button), two-way field updates, accounts/deals, delete propagation, non-Freshsales CRM adapters (HubSpot/Pipedrive stay `needs_oauth_app`).
- No change to the Sprint 13 sync result shape (`{ fetched, created, updated, truncated }`) — discarded skips are silent; `fetched` already reflects the post-filter count.

## Behavior

### Contracts (`packages/contracts`)

- `crmContactSchema` gains `discardedAt: z.number().int().nullable()`.
- New `crmSyncFilterSchema`:
  ```ts
  z.object({
    viewId: z.string().optional(),       // CRM view/list/segment id to pull from
    viewName: z.string().optional(),     // human label, stored for display
    updatedSince: z.number().int().optional(), // epoch ms; only contacts updated at/after
  })
  ```
  Empty object is valid ("no filter").
- New `crmSyncFilterInputSchema = z.object({ connectionId: z.string().uuid(), filter: crmSyncFilterSchema })` (body for setting the filter).
- New `crmViewSchema = z.object({ id: z.string(), name: z.string() })` + `CrmView` type (the views dropdown source).
- No new event types (discard/restore/filter are local config, not webhook-worthy).

### Schema + migration (`apps/api/src/db`)

- `crm_contacts`: add `discarded_at integer` (nullable). `rowToCrmContact` already spreads the row, so the field flows through once the column exists.
- New table `crm_sync_settings`:
  - `connection_id text PK` → fk `connections` (cascade)
  - `workspace_id text NOT NULL` → fk `workspaces` (cascade)
  - `filter_json text NOT NULL DEFAULT '{}'`
  - `updated_at integer NOT NULL`
- Generate migration `0018_*` via `npm run db:generate -w apps/api` (tests apply checked-in migrations to in-memory SQLite, so this must be committed).

### CrmAdapter boundary (`apps/api/src/connectors/crm`)

- `listContacts(filter?: CrmSyncFilter)` — optional filter argument.
- New `listViews(): Promise<CrmView[]>`.
- (No `deleteContact` — local-only discard.)

`FreshsalesAdapter`:
- `listViews()` → `GET /api/contacts/filters` mapped to `{ id, name }[]` (replaces the private `allContactsViewId` helper, which becomes `resolveViewId(filter)`).
- `resolveViewId(filter)` → `filter.viewId` if set, else the "All Contacts" view (existing default), else first view; throws `ConnectorFabricError` if none.
- `listContacts(filter)` → page the resolved view; if `filter.updatedSince` is set, drop contacts whose `updated_at` parses to a time **before** the cutoff (contacts with no/unparseable `updated_at` are kept — we don't drop what we can't evaluate). `RawContact` gains `updated_at?: string`.

### Services (`apps/api/src/services/crm.ts`)

- `listCrmContacts(db, workspaceId, opts?: { discarded?: boolean })` — default returns active (`discardedAt IS NULL`); `discarded: true` returns tombstoned rows (`discardedAt IS NOT NULL`). Both still attach the linked lead.
- `discardCrmContact(db, workspaceId, contactId)` / `restoreCrmContact(...)` — set/clear `discardedAt`; return whether a row matched.
- `getCrmContactByLead(...)` — excludes discarded rows (adds `discardedAt IS NULL`).
- `syncCrmContacts(db, adapter, workspaceId, connectionId, filter?)` — passes `filter` to `adapter.listContacts`; when an existing row for a fetched `externalId` is **discarded**, skip it entirely (no update, not counted) so the tombstone holds.
- `getCrmSyncFilter(db, connectionId): CrmSyncFilter` (parse `filter_json`, default `{}`) and `setCrmSyncFilter(db, workspaceId, connectionId, filter)` (upsert).

### Routes (`apps/api/src/routes/crm.ts`)

| Endpoint | Behavior |
|---|---|
| `GET /workspaces/:id/crm/contacts` | active contacts (unchanged default). `?discarded=true` → tombstoned contacts. |
| `POST /workspaces/:id/crm/contacts/:crmContactId/discard` | soft-delete the contact → `{ ok: true }`; 404 if not found. |
| `POST /workspaces/:id/crm/contacts/:crmContactId/restore` | clear the tombstone → `{ ok: true }`; 404 if not found. |
| `GET /workspaces/:id/crm/views?connectionId=` | resolve a CRM-capable connected connection → `adapter.listViews()`; 400 on non-CRM/disconnected, 502 on CRM failure. |
| `GET /workspaces/:id/crm/sync-filter?connectionId=` | stored filter for the connection (default `{}`). |
| `PUT /workspaces/:id/crm/sync-filter` | body `{connectionId, filter}` → connection must be CRM-capable (400 otherwise) → upsert → returns the saved filter. |
| `POST /workspaces/:id/crm/sync` | unchanged contract, now loads the stored filter and applies it. |

Existing Sprint 13 endpoints (import-lead, push-lead, log-draft) are unchanged except that they now ignore discarded contacts via `getCrmContactByLead`.

### Web (`/workspaces/[id]/crm`)

- **Sync panel** gains a collapsible "Sync filter" for the active connection: a **View** dropdown (populated from `/crm/views`, default "All Contacts"), an **Updated since** date input, and **Save filter**. The saved filter is loaded when the connection changes and summarized inline.
- **Contacts table**: each active row gets a **Discard** button (with a "removes it locally; re-sync won't bring it back" tooltip) alongside Import/lead badge.
- New **Discarded** section (collapsible, only shown when non-empty): tombstoned contacts with a **Restore** button each, and a one-line note that a re-sync won't resurrect them.

## Automated verification

- **Contracts:** `crmContactSchema` requires `discardedAt`; `crmSyncFilterSchema` accepts empty + populated; `crmViewSchema` shape.
- **FreshsalesAdapter:** `listViews` maps `/api/contacts/filters`; `listContacts({viewId})` requests `/api/contacts/view/{viewId}`; `listContacts({updatedSince})` drops older contacts and keeps ones missing `updated_at`; default (no filter) still finds "All Contacts".
- **CRM API (fake fabric + fake Freshsales):**
  - discard: sync 3 → discard 1 → `GET contacts` returns 2, `?discarded=true` returns 1 → **re-sync → still 2 active, discarded not resurrected** → restore → back to 3.
  - discard never deletes an imported lead (lead remains in `/leads` after discard) and a discarded contact stops linking (`log-draft` for its lead → `lead_not_linked`).
  - filtered sync: `PUT sync-filter` with a `viewId` → `GET sync-filter` echoes it → sync pulls only that view's contacts; `updatedSince` filter narrows fetched count.
  - `GET /crm/views` lists the connection's views; sync-filter/views on a non-CRM connection → 400.
- **Regression:** the full Sprint 13 `crm.test.ts` suite stays green (sync result shape unchanged; default contact list unaffected).
- `npm test` and `npm run typecheck` green.

## Founder acceptance checklist

1. CRM page → **Sync** (Freshsales) → contacts appear.
2. **Discard** two contacts → they leave the list and appear under **Discarded**.
3. **Sync** again → the discarded two **do not** come back; everything else refreshes.
4. **Restore** one → it returns to the contacts list; next sync refreshes it.
5. Set a **Sync filter**: choose a specific Freshsales view (and/or an "updated since" date) → **Save** → **Sync** → only matching contacts come in; `fetched` reflects the smaller set.
6. Confirm nothing changed in Freshsales itself (no contact deleted there); a lead you'd imported from a now-discarded contact still exists on the outbound/leads page.

## Progress log

- 2026-06-17 — Spec written. Founder decisions: discard is **local-only** (no CRM-side delete); filter = **view + updated-since**. Branch created off `main`.
- 2026-06-17 — Implemented. Contracts (`discardedAt`, `crmSyncFilterSchema`, `crmSyncFilterInputSchema`, `crmViewSchema`); schema + migration `0018_clumsy_galactus` (`crm_contacts.discarded_at`, `crm_sync_settings` table); `CrmAdapter.listViews` + `listContacts(filter)` with Freshsales view selection + updated-since drop; service discard/restore + tombstone-aware sync + filter get/set + discarded excluded from lead-linking; routes (discard/restore, `?discarded=true`, `/crm/views`, GET/PUT `/crm/sync-filter`, sync applies stored filter); CRM page (filter controls, Discard buttons, Discarded/Restore section).
- 2026-06-17 — Verified green: `npm run typecheck` clean; `npm test` 530 passed (CRM suite 39, incl. 12 new Sprint 23 tests + contracts coverage). Sprint 13 regression suite still green (sync result shape unchanged).
</content>
</invoke>
