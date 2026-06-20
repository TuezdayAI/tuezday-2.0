# Sprint 25 — Connect LinkedIn / X / Instagram

> Phase B in `docs/plans/sprint-guide-21-onward.md` (inserted 2026-06-21 under the founder's
> **no-compromise sequencing** rule: build the social-account connection flow as its own slice
> *before* launching campaigns at a segment, instead of assuming connections exist).
> Branch: `sprint-25-connect-social`, off **`main`**. **No dependency on an unmerged 21+ sprint** —
> it builds only on already-merged slices (Sprint 12 connector fabric, Sprint 17 OAuth popup +
> social adapter), so it merges into `main` independently of Sprints 21/22/23/24.
> **Sprint 26 (targeted campaign launch)** is the consumer of these connections and will branch off
> *both* this branch and `sprint-24-lead-lists-segments`.
> This spec stands alone: the founder resets the session between sprints.

## Goal

Get **real, authenticated connections to LinkedIn, X (Twitter), and Instagram** through the existing
Nango OAuth popup flow, with a verified identity and a connection-health check — so the next sprint
can publish posts and send DMs through them without any "assume we're connected" shortcut. **Connect
and verify only; no posting/DM logic in this sprint** (that is Sprint 26).

Reddit (the only social provider wired so far, Sprint 17) is **parked**: its OAuth app key hasn't been
issued yet, so it stays in the registry but remains un-connectable (no `.env` creds → `oauthConfigured:
false`) and drops out of the near-term path. We do **not** remove it.

## Why this is small (and what already exists)

Sprint 17 built the entire generic OAuth machinery for Reddit; adding three more OAuth social
providers reuses all of it. What already works for *any* `authMode: "oauth"` provider:

- **Registry-driven UI.** `GET /workspaces/:id/connectors` returns `CONNECTOR_PROVIDERS`, decorating
  each oauth provider with `oauthConfigured` (true once its `.env` creds exist). The Integrations page
  renders the registry, so a new provider **appears and becomes connectable automatically**.
- **The popup flow** (routes in `apps/api/src/routes/connectors.ts`, all generic over `:providerKey`):
  `POST /connectors/:key/oauth/session` (409 `needs_oauth_app` until creds exist; else
  `ensureIntegration` + `createConnectSession` → returns a Nango session token) → browser popup via
  `@nangohq/frontend` → `POST /connectors/:key/oauth/complete` (`registerOAuthConnection` +
  `testConnection`) → `POST /connections/:id/test` → `DELETE /connections/:id` (disconnect).
- **Health check.** `testConnection` proxies `GET {baseUrl}{testPath}` through Nango and flips the row
  to `connected` / `error`.

So this sprint is almost entirely **declarative**: three entries in the provider registry, three
`OAUTH_ENV` mappings, `.env.example` additions, the Nango integration config, and tests. **No new
routes. No new tables. No migration** (the `connections` table is already provider-agnostic — which
also sidesteps a `0018` migration-number collision with Sprint 24's branch).

## Founder decisions captured (2026-06-21)

1. **Platforms = LinkedIn, X, Instagram** (the keys already collected), **not Reddit** (no key yet).
2. **Connection flow is its own sprint**, before the targeted-launch sprint — no assumed connections.
3. Social action split lands in **Sprint 26**, but the OAuth **scopes provisioned here must already
   cover it**, so a connection made now is launch-ready without a reconnect:
   - LinkedIn + Instagram → **broadcast post** (their APIs forbid cold per-person DMs) → need posting
     scopes.
   - X → **per-recipient DM** + posts → need tweet + DM scopes.

## Open decisions for the founder (please confirm at review)

These are the only genuine forks; everything else follows the Reddit pattern mechanically.

- **D1 — Auth style: OAuth popup vs access-token paste.** *Recommended: OAuth popup* (`authMode:
  "oauth"`, this spec's default). It supports multiple workspaces/accounts and is what the Sprint 28
  automation layer will need; it requires each platform's **OAuth app client id + secret** in `.env`
  plus the Nango callback URL registered on the app. If instead you only have **long-lived access
  tokens** (like the Meta Ads `access_token` paste), we can mirror `meta_ads` (`authMode:
  "access_token"`) for a faster single-account path — say so and I'll switch the affected providers.
- **D2 — Instagram is the high-risk one.** Instagram **content publishing** requires an Instagram
  **Business/Creator** account linked to a Facebook Page, via the Instagram Graph API (Facebook
  Login), with App Review for `instagram_content_publish`. Confirm your collected key is a **Facebook
  app** with that product enabled (not Instagram Basic Display, which can't publish). If publishing
  isn't approvable yet, Sprint 25 still *connects + verifies identity*, and Sprint 26 treats IG
  publishing as gated/pending — but I want this flagged now, not discovered in Sprint 26.
- **D3 — Exact Nango template + scope list per platform** (table below) — confirm against the API
  products your apps actually have. I'll finalize these at build start against the deployed Nango
  `providers.yaml`.

## Providers to add (`packages/contracts/src/index.ts` → `CONNECTOR_PROVIDERS`)

Append three entries, same shape as the existing `reddit` entry. Values to confirm under D3:

| key | label | nangoProvider | authMode | categories | baseUrl | testPath (identity) | oauthScopes (provisioned now, used in S26) |
|---|---|---|---|---|---|---|---|
| `linkedin` | LinkedIn | `linkedin` | `oauth` | `["social"]` | `https://api.linkedin.com` | `/v2/userinfo` | `openid,profile,email,w_member_social` |
| `twitter` | X (Twitter) | `twitter-v2` | `oauth` | `["social"]` | `https://api.twitter.com` | `/2/users/me` | `tweet.read,tweet.write,users.read,dm.read,dm.write,offline.access` |
| `instagram` | Instagram | `instagram` *(or `facebook`)* | `oauth` | `["social"]` | `https://graph.facebook.com` | `/v23.0/me` | `instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management` |

Notes:
- **Label "X (Twitter)"** but keep **key `twitter`** to match Nango's template family and avoid a
  rename later; the UI shows the label.
- **Scope separator.** `oauthScopes` is stored comma-separated (like Reddit's `"identity,submit"`) and
  passed to `fabric.ensureIntegration(..., { scopes })`. X expects **space-separated** scopes in the
  authorize URL; verify Nango emits the right separator for `twitter-v2`. If Nango passes the string
  verbatim, adjust how scopes are handed to `ensureIntegration` for X (split/rejoin) — a one-line
  provider-specific tweak, called out so it isn't a surprise. Add a contracts/connector test that the
  provisioned scope string is non-empty and well-formed per platform.
- **No `requiresBaseUrl`/`baseUrlConfigKey`** — these are fixed-host APIs, unlike Freshsales.

## OAuth app credentials (`apps/api/src/services/connections.ts` → `OAUTH_ENV`)

Add three mappings (the pattern reddit uses today):

```ts
const OAUTH_ENV: Record<string, { id: string; secret: string }> = {
  reddit:    { id: "REDDIT_CLIENT_ID",    secret: "REDDIT_CLIENT_SECRET" },
  linkedin:  { id: "LINKEDIN_CLIENT_ID",  secret: "LINKEDIN_CLIENT_SECRET" },
  twitter:   { id: "TWITTER_CLIENT_ID",   secret: "TWITTER_CLIENT_SECRET" },
  instagram: { id: "INSTAGRAM_CLIENT_ID", secret: "INSTAGRAM_CLIENT_SECRET" }, // Facebook app id/secret
};
```

`oauthAppCredentials(key)` then makes each connectable only when both vars are set — so a provider with
no creds stays `needs_oauth_app` / `oauthConfigured: false`, exactly like parked Reddit. Add the six
new vars to **`.env.example`** with comments (incl. the Nango callback `http://localhost:3050/oauth/callback`
the founder registers on each OAuth app).

## Infra / Nango

The Nango templates `linkedin`, `twitter-v2`, and `instagram`/`facebook` ship with Nango's
`providers.yaml`; `ensureIntegration(integrationKey, nangoProvider, { clientId, clientSecret, scopes })`
provisions the integration at connect time (already proven for Reddit). No compose changes expected.
Document in the spec/README the per-platform setup the founder does once: create the OAuth app, enable
the right product (esp. Instagram), add the Nango callback URL, paste id/secret into `.env`. No code
beyond the registry + env.

## Routes / services

- **No new routes** — the generic connector routes already cover session/complete/test/disconnect for
  any oauth provider.
- **`services/connections.ts`** — only the `OAUTH_ENV` additions above. `connectProvider`,
  `registerOAuthConnection`, `testConnection`, `disconnectConnection` are untouched and already
  generic.

## Web (`apps/web`)

Mostly free — the Integrations page renders the registry and already has the OAuth Connect button +
the `@nangohq/frontend` popup (Sprint 17). Light polish only:
- Confirm LinkedIn / X / Instagram render with a Connect button, a connected/identity state, Test, and
  Disconnect, grouped under social alongside (parked) Reddit.
- Optional: per-platform label/icon and a one-line "needs OAuth app in .env" hint when
  `oauthConfigured` is false (the hint pattern already exists for Reddit).
- No new pages.

## Boundary

- **Connect + identity-verify only.** No `publishPost` / `sendDm` adapters, no recipient social-handle
  field, no automation modes — those are Sprint 26 (launch) and Sprint 28 (automation).
- Official **OAuth via Nango only**; no scraping. Client secrets and tokens live in `.env` / Nango,
  **never** in Tuezday's DB and **never** logged.
- Reddit stays registered but parked; do not delete it.
- No new tables, **no migration**, no new event types.

## Tests (`apps/api/test/connect-social.test.ts`, + a contracts assertion)

Follow the one-file-per-slice convention; `buildAuthedApp` + `createTestDb`; reuse the existing
**fake `ConnectorFabric`** used by the connector/publish tests (stub `health`, `ensureIntegration`,
`createConnectSession`, `connectionExists`, `proxyGet`, `deleteConnection`). Set the relevant
`*_CLIENT_ID/SECRET` env vars within the test for the "configured" cases.

1. **Registry shape (contracts unit):** `linkedin`, `twitter`, `instagram` exist in
   `CONNECTOR_PROVIDERS`, each `authMode: "oauth"`, `categories: ["social"]`, non-empty `oauthScopes`,
   and a `baseUrl` + `testPath`. Update any existing test that pins the provider list/count.
2. **`GET /connectors`:** the three appear; `oauthConfigured` is `false` with no env and `true` once
   their `*_CLIENT_ID/SECRET` are set; Reddit shows `oauthConfigured: false` (parked).
3. **`oauth/session`:** 409 `needs_oauth_app` without creds; with creds (+ healthy fake fabric) returns
   `{ token, nangoBaseUrl, integrationKey }` and called `ensureIntegration` with the provider's scopes.
4. **`oauth/complete`:** with a fake fabric where `connectionExists` is true, registers a `connected`
   connection and runs `testConnection` (identity `testPath` proxied → `connected`); `connectionExists`
   false → 400 `connection_unknown`.
5. **Health + disconnect:** `POST /connections/:id/test` flips `connected`/`error` from the proxied
   status; `DELETE /connections/:id` → 204 and status `disconnected`; reconnect revives the same row.
6. **Negative:** unknown provider → 404; a non-oauth provider through the oauth routes → 400 `not_oauth`.

`npm test` and `npm run typecheck` must pass green across all workspaces.

## Founder acceptance (added to `docs/founder-acceptance-tests.md`)

With each platform's OAuth app creds in `.env` and Nango running: open Integrations → **Connect
LinkedIn** → OAuth popup → returns **connected** showing the LinkedIn identity; repeat for **X** and
**Instagram**; click **Test** on each (green); **Disconnect** then reconnect one; confirm **Reddit**
shows as parked/needs-setup. (No posting yet — that's Sprint 26.)

## Step plan

1. Spec (this file) — founder reviewed. ✅
2. Confirm D1–D3 with the founder; finalize the provider table. ✅ (defaults approved)
3. Contracts: add `linkedin` / `twitter` / `instagram` to `CONNECTOR_PROVIDERS`; verify no enum/list
   test breaks. ✅
4. `services/connections.ts`: add the three `OAUTH_ENV` mappings. `.env.example`: six new vars + notes. ✅
5. Tests: `apps/api/test/connect-social.test.ts` + the contracts registry assertion; handle the X
   scope-separator detail. ✅ (Nango handles the separator per template — no code tweak)
6. Web: verify the three render + connect/test/disconnect; light per-platform polish + the
   `oauthConfigured: false` hint. ✅ (per-provider `OAUTH_APP_HINTS`)
7. `npm test` + `npm run typecheck` green. ✅ (531 passed; typecheck clean)
8. Add the Sprint 25 section to `docs/founder-acceptance-tests.md`; note the per-platform OAuth-app
   setup steps (Instagram Business-account caveat). ✅
9. Commit to `sprint-25-connect-social`, push; founder reviews/merges. **Do not merge into `main`.** ⏳

## Progress log

- 2026-06-21 — Spec written. Roadmap reorganized (this sprint inserted at 25; targeted-launch → 26;
  multi-step sequences → 30). `docs/deferred-improvements.md` created (entry #1 = email CSV→API).
  Awaiting founder review of this spec before implementation.
- 2026-06-21 — Founder approved ("follow the spec … build it out") with this spec's recommended
  defaults: **D1 = OAuth popup** for all three (`authMode: "oauth"`); **D2 = connect + verify
  identity now**, IG publishing flagged as gated until Sprint 26 (Facebook app + Business account +
  `instagram_content_publish` App Review); **D3 = scope table as written**. Built:
  - **Contracts** — added `linkedin`, `twitter` (label "X (Twitter)", nangoProvider `twitter-v2`),
    `instagram` (nangoProvider `facebook`) to `CONNECTOR_PROVIDERS`, each `oauth` / `["social"]` with
    a verifiable `testPath` and the Sprint-26 scopes. Reddit left registered + parked.
  - **D3 / X scope separator resolved:** `oauthScopes` stays comma-separated for every provider
    (matching Reddit). `NangoFabric.ensureIntegration` passes the string to Nango as the integration's
    `credentials.scopes`; Nango's per-provider template (`twitter-v2`) emits the space separator X
    wants — so **no provider-specific split/rejoin was needed** in our code. A contracts test pins each
    scope string as non-empty and whitespace-free.
  - **`services/connections.ts`** — three `OAUTH_ENV` mappings; no other change (flow already generic).
  - **`.env.example`** — six new vars with per-platform setup notes + the Nango callback URL.
  - **Web** — generalized the Reddit-only "needs OAuth app" hint into a per-provider `OAUTH_APP_HINTS`
    map (reddit/linkedin/twitter/instagram); everything else was already registry-driven.
  - **Tests** — `apps/api/test/connect-social.test.ts` (13 tests): registry shape, `oauthConfigured`
    false→true on env, `oauth/session` 409→200 provisioning scopes, `oauth/complete` connect +
    identity verify + `connection_unknown`, health flip, disconnect/reconnect revival, and the two
    negatives (unknown provider 404, non-oauth-through-oauth 400 `not_oauth`).
  - **Verified green:** full suite **531 passed (30 files)**, `npm run typecheck` clean across all six
    workspaces. No existing provider-count/list test broke. Sprint 25 acceptance section added to
    `docs/founder-acceptance-tests.md`.
  - **No new routes, no new tables, no migration** — as designed. **Not merged into `main`** (founder
    merges the branch himself).
