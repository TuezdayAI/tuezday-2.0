# Sprint 48 Tenant-Invariant Audit

## Rule

Every caller-supplied or copied related-object ID is resolved with the target
`workspaceId` before a write. Missing and foreign IDs have the same public
result. Multi-ID inputs are all-or-nothing, and multi-row state transitions
use one synchronous SQLite transaction.

## Reference audit

| Path | Supplied/reference ID | Workspace predicate | Pre-write validation | Negative test | Database constraint decision |
| --- | --- | --- | --- | --- | --- |
| Authenticated `POST /workspaces/:id/signals` and API-key `POST /api/v1/ideas` | `suggestedPersonaId`, `suggestedCampaignId` | `getPersona(db, workspaceId, id)` and `getCampaign(db, workspaceId, id)` | `resolveSignalReferences()` runs before the signal insert; unknown and foreign IDs share `related_object_not_found` | `signals.test.ts` and `public-api.test.ts`: persona-only, campaign-only, and combined foreign/unknown references persist no signal or match | Signal suggestion columns have no FK. Service validation is authoritative; adding composite FKs would require composite unique keys and table rebuilds. |
| LLM-matched signal creation | Match persona/campaign IDs | Prompt context is workspace-scoped; `revalidateSignalMatches(tx, workspaceId, matches)` reloads current workspace state | Revalidation occurs inside the transaction before signal or match insertion and enforces active campaign membership | `signals.test.ts`: deferred LLM with concurrent persona deletion and campaign reassignment | Existing match FKs guarantee object existence, not tenant pairing. The transaction-scoped service check supplies the tenant invariant. |
| Discovery source create/update | `connectionId` | `getConnection(db, workspaceId, connectionId)` | `validateSourceConnection()` verifies workspace, provider, and connected state before persistence | `connected-discovery.test.ts`: unknown, wrong-provider, disconnected, and detach cases | `discovery_sources.connection_id` intentionally has no FK because of the legacy SQLite ALTER limitation. Workspace-qualified service validation remains authoritative. |
| Discovery source create/update/fetch | `trackedAccountId`, `trackedAccountIds[]` | `resolveTrackedAccounts()` filters by `workspaceId`, enabled state, and the complete unique ID set | `requireTrackedAccounts()` rejects when any ID is missing, foreign, or disabled; `requireSourceTrackedAccounts()` also requires the source platform and runs before every connected, intent, or keyless adapter dispatch | `connected-discovery.test.ts`: foreign, unknown, mixed-validity, wrong-platform, update-no-mutation, and disabled-before-fetch cases on both connected and keyless sources | IDs live in JSON, so no FK is available. Strict service resolution is required on create, update, and every use. |
| Discovery item listing/get/duplicate expansion | `itemId`, `sourceId`, `duplicateOfId` | Item and duplicate reads include `discovered_items.workspace_id`; source joins originate from workspace-scoped items | Routes resolve the workspace and item before returning or mutating; duplicate counts are workspace-qualified | `discovery.test.ts`: unknown item and cross-workspace acceptance return 404 | `source_id` has a single-column FK and `duplicateOfId` intentionally has none. They do not prove tenant pairing; scoped reads and writes do. |
| Discovery scoring and item matches | Item ID plus copied persona/campaign IDs | Items are selected by workspace; replacement deletes by `(workspaceId, itemId)`; inserts carry the same workspace; response joins require persona and campaign parents from that workspace | LLM output is constrained to workspace context. Reads drop legacy rows with a foreign parent; acceptance re-reads match rows by `(workspaceId, itemId)` and rejects any foreign-tenant row or stale related ID | `discovery.test.ts`: a local match row with a foreign copied persona is hidden and rejected without accepting or creating a signal | Item/persona/campaign FKs guarantee existence only. Composite tenant FKs would require new composite unique keys on all parent tables and SQLite table rebuilds, so Sprint 48 keeps the invariant in services and safely hides historical invalid rows. |
| Signal matches | `signalId`, persona ID, campaign ID | Signal and match reads use `workspaceId`; response joins require same-workspace persona/campaign parents; match inserts use the validated workspace and transaction-scoped signal ID | Explicit references are resolved before entry; judged references are revalidated in the transaction; discovery copies are validated at acceptance; automation verifies the signal, campaign, and optional persona parents before routing | `signals.test.ts`: reference isolation, foreign match-row and foreign-parent hiding, rollback hooks, and concurrent-config races; `automation.test.ts`: a local match row cannot route through a foreign persona; `discovery.test.ts`: copied foreign match | Existing single-column FKs remain useful for existence/cascade behavior but cannot enforce equal workspace IDs across the row. Historical invalid rows are not destructively backfilled in Sprint 48; reads and routing drop them, while acceptance rejects them. |
| Discovery acceptance | `itemId`, item `sourceId`, item suggestions, item-match IDs, resulting `signalId` | The transaction re-reads item and source with `workspaceId`; match reads and item update include `workspaceId` | Status, source, suggested references, and every copied match are checked before insert; signal, matches, item status, and response read share one transaction | `discovery.test.ts`: cross-workspace item 404, stale/foreign references, and injected failure after signal insert leave item `new` with no signal/matches | Existing FKs do not cover the whole transition or tenant pairing. A service transaction is the correct boundary; no migration is added. |
| Tracked-account update/delete | `accountId` | Read and write predicates both include `(workspaceId, accountId)` | The service resolves the account in the workspace before changing it | `connected-discovery.test.ts`: scoped list plus update/delete behavior | The row already owns `workspaceId`; a new composite FK is unnecessary because no child relational column references the pair. |

## Remaining globally unique ID lookups

The remaining globally unique ID components occur only where the ID came from
a workspace-scoped row in the same service flow:

- discovery job history is read by a source ID from a workspace-scoped claimed
  source;
- run-pipeline rows use globally unique IDs already selected or inserted under
  the current workspace.

Writes for source updates, item scoring, item skipping, match replacement, and
acceptance now include `workspaceId` directly. No clean existing composite
parent key can support tenant-pairing foreign keys without rebuilding several
legacy SQLite tables, so no migration is justified for Sprint 48.
