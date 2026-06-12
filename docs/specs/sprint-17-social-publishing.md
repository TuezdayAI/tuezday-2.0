# Spec: Sprint 17 (slice 1) — Social Publishing: Reddit

> Status: in build
> Closes the Sprint 6 loop: an **approved** content draft posts to the actual platform instead of copy/export. Platform order is by API friction (sprint plan): **Reddit first** (free tier, native `reddit` template in Nango's providers.yaml). This slice also introduces the first real **OAuth popup flow** through the connector fabric — every earlier connection was key/token-paste. The publish domain is provider-agnostic behind a `SocialAdapter` boundary so X/LinkedIn/Instagram plug in later without schema changes. Scheduling is native and thin (a worker tick over a `publications` table); Postiz stays reference-only (AGPL).

## What this slice does

1. **Connect.** Reddit account connection per workspace via Nango OAuth (connect-session popup), with the same health/test/disconnect lifecycle as every other connection in the registry.
2. **Publish.** A publish action on an approved draft: pick a connected social account, a target (subreddit), a title — post **now** or **schedule** for later. The worker fires due scheduled posts every minute.
3. **Track.** Published URL + status (`scheduled` / `published` / `failed`) stored on a `publications` row linked to the draft and visible in Tuezday; failures keep the error and can be retried; scheduled posts can be canceled.
4. **Validate.** Per-platform constraints (Reddit: title required ≤ 300 chars, body ≤ 40,000) are checked **before** anything leaves Tuezday — same hard-gate pattern as ad-creative format validation.

Founder-visible chain: connect Reddit (OAuth popup) → approve a draft → Publish to r/test → the post is live on Reddit → published status + link visible in Tuezday. Disconnect/reconnect works.

## Out of scope (this slice)

X / LinkedIn / Instagram adapters (X is slice 2 — **confirm API plan/cost with founder before building**; LinkedIn application should be filed when slice work starts), media uploads (text/self posts only — Reddit link posts and image posts later), comment/engagement readback, publish metrics, editing or deleting a live post from Tuezday, recurring schedules, per-channel best-time suggestions, a dedicated calendar UI, new task types or channels (publishing distributes existing approved content; a `reddit` generation channel can come via the continuous track if wanted), approval-state machine changes (publishing hangs off `approved`; it is **not** a sixth state).

## Deployment

No new services — the existing Nango deployment carries OAuth. Two founder steps:

1. Create a Reddit app at <https://www.reddit.com/prefs/apps> → type **web app**, redirect uri **`http://localhost:3050/oauth/callback`** (the Nango server's callback).
2. Put `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` in the root `.env` and restart the API. The Reddit card on the connectors page flips from "needs an OAuth app" to a **Connect** button.

Tuezday provisions the Nango integration (client id/secret/scopes `identity,submit`) on first connect; tokens live only in Nango (refresh handled there — Reddit access tokens expire hourly, the template requests `duration=permanent`). Verified against the deployed image: `POST /integrations` accepts OAuth2 credentials and `POST /connect/sessions` exists.

## Behavior

### Registry + contracts

- `ConnectorProvider.categories` gains `"social"`. New entry: `{ key: "reddit", label: "Reddit", nangoProvider: "reddit", authMode: "oauth", categories: ["social"], baseUrl: "https://oauth.reddit.com", testPath: "/api/v1/me", oauthScopes: "identity,submit" }` (`oauthScopes` is a new optional field — only meaningful for `authMode: "oauth"`).
- OAuth env mapping lives server-side (reddit → `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`); `GET /workspaces/:id/connectors` reports `oauthConfigured: boolean` per OAuth provider so the web can render Connect vs. the needs-oauth-app explainer.
- `SOCIAL_POST_CONSTRAINTS: Record<"reddit", SocialPostConstraints>` — `{ targetLabel: "Subreddit", titleMaxChars: 300, bodyMaxChars: 40000 }` — plus `validateSocialPost(providerKey, { target, title, body })` returning `{ ok, violations[] }` (same shape as `validateAdCreative`).
- `PUBLICATION_STATUSES = ["scheduled", "published", "failed"]`; `publicationSchema` (id, workspaceId, draftId, connectionId, providerKey, target, title, status, scheduledFor, publishedAt nullable, externalId nullable, externalUrl nullable, lastError nullable, createdAt, updatedAt); `publishDraftInputSchema` (`{ connectionId, target, title, scheduledFor? }` — `scheduledFor` epoch ms, must be in the future when present).
- `EVENT_TYPES` gains `post.published` (payload: publicationId, draftId, providerKey, target, url) — delivered to webhooks signed, like every other event.

### Fabric extension (`apps/api/src/connectors/`)

Three additions to `ConnectorFabric`, implemented in `NangoFabric`, faked in tests:

- `ensureIntegration(uniqueKey, provider, oauth?: { clientId, clientSecret, scopes })` — when `oauth` is given and the integration is missing, it is created with `credentials: { type: "OAUTH2", client_id, client_secret, scopes }`; if it already exists, credentials are refreshed via `PATCH /integrations/{key}` (best-effort — a 4xx/5xx on PATCH is tolerated so older Nango builds still work).
- `createConnectSession(integrationKey, endUserId)` → `POST /connect/sessions` with `{ end_user: { id }, allowed_integrations: [integrationKey] }` → `{ token }`. The web opens the popup with this token via `@nangohq/frontend`; Nango generates the connection id and the popup result reports it back.
- `proxyJson(..., opts)` gains `form?: Record<string, string>` (body sent `application/x-www-form-urlencoded` — Reddit's submit endpoint is form-only) and `headers?: Record<string, string>` (Reddit wants a descriptive `User-Agent`).

### OAuth connect flow (routes on `connectors.ts`)

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/connectors/:key/oauth/session` | provider must be `authMode: "oauth"` (400) and env-configured (409 `needs_oauth_app`); fabric healthy (503); ensures the integration with OAuth creds, creates a connect session → `{ token, nangoBaseUrl, integrationKey }` |
| `POST /workspaces/:id/connectors/:key/oauth/complete` | body `{ connectionId }` (the id the popup reported); verifies it exists in Nango (400 if not), upserts the connections row (revives a disconnected one, like key-paste connect), runs the standard connection test → returns the connection |

The existing key-paste connect route keeps rejecting OAuth providers with 409 — the popup path is the only way in. `nangoBaseUrl` comes from `NANGO_PUBLIC_URL` (fallback `NANGO_BASE_URL`, then `http://localhost:3050`) because the **browser** must reach it. Disconnect/reconnect reuses the existing lifecycle unchanged (a reconnect just runs the popup again; Nango issues a fresh connection id and the row is updated).

### SocialAdapter boundary (`apps/api/src/connectors/social/`)

```
interface SocialAdapter {
  publishPost(input: { target, title, body }): Promise<{ externalId, url }>;
}
```

`RedditAdapter` implements it over `proxyJson` (base URL override `https://oauth.reddit.com`): `POST /api/submit` form `{ api_type: "json", kind: "self", sr, title, text, resubmit: "true" }` with a `web:tuezday:v0.1` User-Agent. Reddit reports business errors inside a 200 (`json.errors` — e.g. `SUBREDDIT_NOEXIST`, `RATELIMIT`); those raise `ConnectorFabricError` with the joined messages. Success maps `json.data.name` → externalId (`t3_…`) and `json.data.url` → url. Adapter selection by `categories` containing `"social"` + provider key, mirroring `crmAdapterFor`/`adsAdapterFor`.

### Publications (Tuezday-side)

`publications` table (migration 0015): id, workspaceId (fk, cascade), draftId (fk drafts, cascade), connectionId (fk connections, cascade), providerKey, target, title, status (default `scheduled`), scheduledFor (the requested time; "now" publishes stamp the request time), publishedAt, externalId, externalUrl, lastError, createdAt, updatedAt.

| Endpoint | Behavior |
|---|---|
| `POST /workspaces/:id/drafts/:draftId/publish` | draft must be state `approved` (409 `draft_not_approved`); connection must be `connected` + social-capable (400); `validateSocialPost` gate (400 `publish_validation` with violations); a live (`scheduled`/`published`) publication for the same draft+connection+target → 409 `already_published` (a `failed` one does not block). Future `scheduledFor` → row stored `scheduled` (201). Otherwise publish **synchronously**: success → `published` with url, emits `post.published`; adapter failure → row `failed` with `lastError` (201 — the row is the receipt either way). |
| `GET /workspaces/:id/publications` | newest first, each with its draft (taskType, channel, content) for display |
| `POST /workspaces/:id/publications/:pubId/retry` | only `failed` (409 otherwise) → re-attempts immediately |
| `DELETE /workspaces/:id/publications/:pubId` | only `scheduled` (409 otherwise) → removes the row (cancel) |
| `POST /workspaces/:id/publish/run` | fires every `scheduled` row with `scheduledFor <= now` → `{ results: [{ id, ok, error? }] }`; per-row failures are recorded on the row, never abort the run |

`post.published` is emitted **after** the platform call succeeds; webhook delivery failures never fail the request (existing `emitEvent` semantics). All platform traffic goes through the fabric — nothing talks to Reddit directly.

### Worker

`publishTick` every `PUBLISH_INTERVAL_MIN` (default 1) → `POST /workspaces/{id}/publish/run` for all workspaces; logs published/failed per workspace, stays quiet when nothing is due. Same resilience pattern as the ads tick.

### Web

- **Connectors page**: Reddit card. Env not set → explainer with the two setup steps. Env set → **Connect** opens the Nango popup (`@nangohq/frontend`, new web dependency), then completes registration and runs the test. Health/test/disconnect render exactly like other connections.
- **Content page** (`/workspaces/[id]/content`): every approved draft gains **Publish…** next to copy/download → modal: account picker (connected social connections, with a pointer to Integrations when none), subreddit, title (prefilled with the draft's first line, live counter vs 300), body preview, optional schedule time. Below the signal inbox, a **Published** panel lists publications: status chip, target, link when live, error + **Retry** when failed, **Cancel** when scheduled.

## Automated verification

- Contracts: reddit registry entry (categories, scopes), `validateSocialPost` boundaries (300/40k, empty target/title), publication + publish-input schemas (future-only `scheduledFor`), new event type.
- Nango client: `ensureIntegration` sends OAuth credentials on create and PATCHes on exists; `createConnectSession` body + token parse; `proxyJson` form mode sends url-encoded body + custom headers.
- RedditAdapter (fixture fabric): submit body shape (form fields incl. `api_type=json`), success mapping (name/url), Reddit in-band errors → `ConnectorFabricError`, non-2xx → error.
- API (fake fabric): OAuth session route (400 non-oauth / 409 unconfigured / happy path), complete route (400 unknown connection / creates row / revives disconnected row); publish now happy path (row `published`, url stored, `post.published` emitted + webhook-delivered); publish gates (409 not-approved, 400 non-social connection, 400 validation violations, 409 duplicate live publication, failed row does not block); schedule future → `scheduled`, `publish/run` before due is a no-op and after due publishes; adapter failure → row `failed` + error kept, then retry succeeds; cancel scheduled / 409 cancel non-scheduled.

## Founder acceptance checklist

1. Create the Reddit app (web app, redirect `http://localhost:3050/oauth/callback`), set `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` in `.env`, restart; `npm run nango:up` if Nango is down.
2. Integrations → Reddit → **Connect** → Reddit OAuth popup → approve → card shows `connected`, Test passes (`/api/v1/me` through the proxy).
3. Approve a content draft → **Publish…** → pick the Reddit account, subreddit `r/test` (or your own), keep the suggested title → **Post now** → the post is live on Reddit; Tuezday shows `published` + working link; event log shows `post.published`.
4. Publish another approved draft **scheduled 2 minutes out** → it sits `scheduled`, the worker posts it on time, status flips to `published`.
5. Publish to a nonexistent subreddit → row shows `failed` with Reddit's error; **Retry** after fixing the target works.
6. **Disconnect** Reddit → reconnect via the popup → publishing works again.
