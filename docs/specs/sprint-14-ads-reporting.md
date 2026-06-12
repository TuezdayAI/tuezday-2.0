# Spec: Sprint 14 — Ads Reporting (read-only)

> Status: built, awaiting founder acceptance
> Tuezday shows what paid spend is doing, in its own metric model. Read-only — no campaign mutation, no budget changes, no creative upload (those are later slices). First platform is **Meta Ads** (founder decision 2026-06-12 — live account), connected through the Sprint 12 connector fabric. The metric model is provider-agnostic behind an `AdsAdapter` boundary so Google Ads and others plug in later without schema changes. A CSV import fallback makes the reporting surface work with no connected account at all (mirrors Sprint 10's manual-first pattern).

## What this slice does

1. **Native metric model.** Three tables Tuezday owns regardless of source: `ad_accounts` → `ad_campaigns` → `ad_campaign_metrics` (daily grain: spend, impressions, clicks, conversions). External ad campaigns can be **linked to a Tuezday campaign**, which is what puts paid numbers on the Sprint 8 campaign view.
2. **Meta Ads through the fabric.** Founder pastes a Meta access token (system-user token recommended — non-expiring); it is imported into Nango as OAuth2 credentials and never touches Tuezday's DB. All Graph API calls go through the Nango proxy. A `MetaAdsAdapter` implements the `AdsAdapter` boundary: list ad accounts, pull daily per-campaign insights.
3. **Sync on a schedule + on demand.** A worker job re-pulls a 28-day window every few hours (Meta restates conversions retroactively — re-pulling a window keeps numbers converging). Every account has a manual **Sync now**.
4. **Reporting view.** Per-ad-campaign spend/impressions/clicks/CTR/CPC/conversions over a date range, daily breakdown, link-to-campaign control, CSV import panel. Linked metrics appear on the campaign detail page as a "Paid performance" section.

Founder-visible chain: connect Meta Ads with a token → import ad accounts → Sync → per-campaign spend matches Ads Manager → link an ad campaign to a Tuezday campaign → paid numbers show on that campaign's page. Or, with no account: paste a CSV → same reporting.

## Out of scope

Campaign mutation of any kind (pause/budget/launch — Sprint "Ads execution" later), Google Ads (lands behind the same `AdsAdapter` under integration expansion), the full Nango OAuth popup flow (token paste through the fabric now; the popup flow arrives with the first OAuth-only provider), ad-set/ad-level grain (campaign level only), creative-level metrics (Sprint 15 hooks into this model), configurable conversion definitions (fixed default action list, documented below), currency conversion and account-timezone alignment (dates are taken as Meta reports them), automatic token refresh (system-user tokens don't expire; the connection Test surfaces an expired token as an error), Airbyte (per the sprint plan note: one provider = worker poll through the Nango proxy; revisit at provider #2/#3).

## Deployment

No new services — the existing Nango deployment (`npm run nango:up`) carries the connection. Founder needs a Meta access token with the **`ads_read`** scope:

- Recommended: Business Manager → Business settings → Users → System users → generate token (select the ad account, `ads_read`). System-user tokens do not expire.
- Quick alternative: an app's Marketing API "Get token" tool, or Graph API Explorer + long-lived exchange (~60 days, reconnect when it dies).

## Behavior

### Registry + auth (contracts)

- `CONNECTOR_CATEGORIES` gains `"ads"`.
- `CONNECTOR_AUTH_MODES` gains `"access_token"` — credential is a pasted OAuth access token. `oauth` keeps meaning "needs an OAuth app + popup flow" (still 409 `needs_oauth_app`).
- New provider: `{ key: "meta_ads", label: "Meta Ads", nangoProvider: "facebook", authMode: "access_token", categories: ["ads"], baseUrl: "https://graph.facebook.com", testPath: "/v23.0/me?fields=id,name" }`. The Graph version is pinned in one adapter constant.
- `connectInputSchema` gains optional `accessToken`; the connect route requires it for `access_token` providers (400 otherwise).
- New contracts: `adAccountSchema` (id, workspaceId, connectionId nullable, externalId, name, currency, lastSyncedAt nullable, lastError nullable, createdAt), `adCampaignSchema` (id, workspaceId, adAccountId, externalId, name, campaignId nullable, lastSyncedAt, createdAt), `adDailyMetricSchema` (id, adCampaignId, date `YYYY-MM-DD`, spendCents, impressions, clicks, conversions, source `"sync" | "csv"`). Inputs: `importAdAccountsInputSchema` ({connectionId}), `adsSyncInputSchema` ({since?, until?} as `YYYY-MM-DD`), `linkAdCampaignInputSchema` ({campaignId: uuid | null}), `adsCsvImportInputSchema` ({accountName?, currency?, rows: [{date, campaignName, spend (currency units, e.g. 12.34), impressions, clicks, conversions}]}, rows max 5000).
- `EVENT_TYPES` gains `ads.synced` — emitted after a sync **that changed rows** (skipped when nothing changed, so the 6-hourly worker doesn't spam webhooks).

Money is stored as **integer cents** (`spendCents`) in the account currency — no floats in the DB; the UI formats with the account currency.

### Fabric extension (`apps/api/src/connectors/`)

`ImportCredentials` gains `{ type: "OAUTH2"; accessToken: string }`. `NangoFabric.importConnection` maps it to Nango's wire shape `{ type: "OAUTH2", access_token, accessToken }` (both casings — Nango's import endpoint and proxy template interpolation have used either across versions; extra keys are harmless). Nothing else in the fabric changes — `proxyJson` already covers the adapter's needs; every Meta call passes `baseUrlOverride: "https://graph.facebook.com"` so nothing depends on the `facebook` template's proxy config.

### AdsAdapter boundary (`apps/api/src/connectors/ads/`)

```ts
interface AdAccountRecord { externalId: string; name: string; currency: string }
interface AdDailyMetricRecord {
  externalCampaignId: string; campaignName: string;
  date: string; // YYYY-MM-DD
  spendCents: number; impressions: number; clicks: number; conversions: number;
}
interface AdsAdapter {
  listAdAccounts(): Promise<{ accounts: AdAccountRecord[] }>;
  listDailyMetrics(externalAccountId: string, since: string, until: string):
    Promise<{ metrics: AdDailyMetricRecord[]; truncated: boolean }>;
}
```

`adsAdapterFor(fabric, provider, connection)` selects by `categories` containing `"ads"` + provider key (same pattern as `crmAdapterFor`). `MetaAdsAdapter` over `proxyJson`:

- `listAdAccounts`: `GET /v23.0/me/adaccounts?fields=name,currency&limit=50`, follows `paging.cursors.after`, capped at 4 pages. `externalId` = Graph `id` (already `act_<n>`).
- `listDailyMetrics`: `GET /v23.0/{externalAccountId}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_increment=1&time_range={"since":...,"until":...}&limit=500`, follows the `after` cursor, capped at 25 pages → `truncated` (reported, never silent).
- **Conversions** = sum of `actions[]` values whose `action_type` is in `DEFAULT_CONVERSION_ACTIONS = ["lead", "purchase", "complete_registration"]` (exported constant). These are Meta's cross-channel aggregates — summing pixel/onsite sub-types as well would double-count, so sub-types are deliberately excluded.
- Spend `"12.34"` → `1234` cents (`Math.round(Number(spend) * 100)`); missing numeric fields → 0.
- Non-2xx → `ConnectorFabricError` with status + body snippet; services surface 502 with the detail.

### Metric model (Tuezday-side)

- `ad_accounts`: id, workspaceId (fk cascade), connectionId (fk connections, **set null**; null = CSV-only account), externalId, name, currency (default "USD"), lastSyncedAt (nullable), lastError (nullable), createdAt. Unique `(workspace_id, external_id)`.
- `ad_campaigns`: id, workspaceId (fk cascade), adAccountId (fk ad_accounts cascade), externalId, name, campaignId (fk campaigns, **set null** — the Tuezday link), lastSyncedAt, createdAt. Unique `(ad_account_id, external_id)`.
- `ad_campaign_metrics`: id, workspaceId (fk cascade), adCampaignId (fk ad_campaigns cascade), date (text `YYYY-MM-DD` — portable, sortable), spendCents, impressions, clicks, conversions (integers, default 0), source (`sync`/`csv`), createdAt, updatedAt. Unique `(ad_campaign_id, date)`.

CSV imports land in a lazily-created per-workspace account (`externalId: "csv"`, name "CSV import" or the given `accountName`, given `currency`, `connectionId: null`); CSV campaign identity is the campaign name (`externalId` = name). Re-importing the same rows is idempotent (upsert by campaign + date).

### Endpoints (`apps/api/src/routes/ads.ts`)

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/ads/accounts/import` | body `{connectionId}` → must be `connected` + ads-category (400 otherwise). `listAdAccounts` → upsert by `(workspace, externalId)` → `{accounts, created, updated}`. 502 + detail on adapter failure. |
| `GET /workspaces/:id/ads/accounts` | all ad accounts (incl. the CSV account), with provider label + connection status. |
| `POST /workspaces/:id/ads/accounts/:accountId/sync` | body `{since?, until?}` (default until = today, since = 27 days earlier → 28-day window). 400 when the account has no connection (CSV account) or it isn't `connected`. Pulls daily metrics, upserts campaigns + metric rows, stamps `lastSyncedAt`, clears/sets `lastError` → `{campaigns, rows, created, updated, truncated}`. Emits `ads.synced` only when `created + updated > 0`. Adapter failure → 502, `lastError` set, no partial mystery: rows already upserted before the failure stay (idempotent re-sync repairs). |
| `POST /workspaces/:id/ads/sync` | sync every account that has a connection, same default window; per-account result list `{accountId, name, ok, error?, ...counts}` — one bad account never blocks the rest. Worker calls this. |
| `POST /workspaces/:id/ads/import-csv` | parsed rows (client parses the file) → CSV account upsert → `{accounts? created campaigns, rows, created, updated}`. Validation per row (date format, non-negative numbers) → 400 with row numbers. |
| `GET /workspaces/:id/ads/report?since&until` | per-ad-campaign `{adCampaign (name, account, currency, source, linkedCampaign), totals {spendCents, impressions, clicks, conversions}, days[]}` for the range (default 28 days), sorted by spend desc. |
| `POST /workspaces/:id/ads/campaigns/:adCampaignId/link` | body `{campaignId | null}` → set/clear the Tuezday campaign link (404 unknown campaign/ad campaign). |
| `GET /workspaces/:id/campaigns/:campaignId` (existing) | gains `adMetrics: { totals, adCampaigns: [{id, name, accountName, currency, totals}] } | null` — all-time totals across linked ad campaigns; `null` when none are linked. |

### Worker

A second interval alongside discovery: every `ADS_SYNC_HOURS` (default 6) → `POST /workspaces/:id/ads/sync` for every workspace, log per-account results. Accounts with no connection are skipped by the endpoint itself.

### Web

- **`/workspaces/[id]/ads`** (new page + nav link):
  - Accounts bar: ads-capable connection picker + **Import ad accounts** (pointer to connectors page when none); account cards (name, currency, last synced, last error) with **Sync now**.
  - Report: date-range picker (default last 28 days); table per ad campaign — spend, impressions, clicks, CTR, CPC, conversions, cost/conversion, account, source badge (csv), **Link** select listing Tuezday campaigns; expandable daily rows.
  - CSV import panel: file/paste with header `date,campaign,spend,impressions,clicks,conversions`, client-side parse + preview, optional account name/currency, import result summary.
- **Connectors page**: Meta Ads card with the access-token connect form + short "how to get a token" help text.
- **Campaign detail** (campaigns page): "Paid performance" section when `adMetrics` is non-null — totals + per-ad-campaign rows.

## Automated verification

- Contracts: ads category + access_token auth mode + meta_ads registry entry shape; ad account/campaign/metric schemas; input schemas (date format, row caps, non-negative); `ads.synced` event type.
- Nango client: OAUTH2 import credentials include `access_token` (snake) in the wire body.
- MetaAdsAdapter (fixture fabric): account listing + cursor pagination; insights walk — daily grain mapping, spend→cents, conversions from the default action list only (sub-types ignored), page cap → truncated, non-2xx → `ConnectorFabricError`.
- API (fake fabric): connect meta_ads requires accessToken (400 without), imports OAUTH2 creds; import accounts upserts + is idempotent / 400 non-ads connection; sync upserts campaigns + metrics, second sync idempotent, restated values update rows, `ads.synced` emitted only on change, 400 CSV account or disconnected, 502 + lastError on adapter failure; CSV import creates the csv account + rows, re-import idempotent, bad rows → 400 with row numbers; report aggregates totals + respects range; link/unlink validates ids; campaign detail includes adMetrics for linked, null otherwise.
- Worker: not unit-tested (matches existing worker); behavior covered by the sync-all endpoint tests.

## Founder acceptance checklist

1. Get a Meta token (`ads_read`); connectors page → connect **Meta Ads** → `connected`, Test passes (Graph `/me` through the proxy).
2. Ads page → **Import ad accounts** → your account appears with its currency.
3. **Sync now** → per-campaign spend/impressions/clicks/conversions for the last 28 days appear.
4. Numbers match Ads Manager for the same date range (same-day data may lag — compare a closed day).
5. **Link** an ad campaign to a Tuezday campaign → campaign page shows the "Paid performance" section.
6. CSV path: import the provided format → rows appear under the "CSV import" account in the same report.
7. Leave the worker running → metrics refresh on the schedule without touching anything; event log shows `ads.synced` after a changing sync.
