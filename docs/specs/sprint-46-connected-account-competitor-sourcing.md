# Spec + Implementation Plan: Sprint 46 - Connected-account & competitor sourcing

- **Status:** built (all three parts complete; Part 3 on `sprint-46c-connected-discovery-ui`; founder acceptance pending).
- **Roadmap entry:** `docs/plans/sprint-guide-21-onward.md` -> Phase G -> Sprint 46, "Connected-account & competitor sourcing" ("Sprint D" in `docs/plans/context-discovery-gap-assessment.md`).
- **Branch:** `sprint-46-connected-account-competitor-sourcing`, cut from `main` **after Sprint 45 is merged**. If working before the 43/44/45 stack is on `main`, cut from `sprint-45-discovery-routing` and preserve merge order: `main <- 43 <- 44 <- 45 <- 46`.
- **Builds on:** Sprint 25 (social OAuth), Sprint 31 (expanded discovery source framework), Sprint 45 (multi-candidate routing + cross-source dedup).
- **Size:** M-L.
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges.

> **For agentic workers:** self-contained spec. Strict TDD. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Goal

Make discovery read through the workspace's own connected social accounts instead of only keyless feeds. A founder should be able to connect X, Reddit, LinkedIn, or Instagram, add competitor/account/keyword sources, run discovery, and see authenticated social signals route through Sprint 45's existing match engine into the right persona x campaign pipelines.

Founder-facing outcome:

> Add competitor handles and connected-account sources -> discovery pulls real social posts via OAuth -> duplicate/corroborated stories collapse into one triage item -> accepting the item routes automation only to matched campaigns/personas.

---

## Decisions locked

1. **Connected sourcing gets its own adapter seam; do not overload `SocialAdapter`.** `SocialAdapter` is for publishing, engagement on our own posts, and replies. Sprint 46 adds `ConnectedDiscoveryAdapter` under `apps/api/src/discovery/connected-adapters.ts`, because "search/listen for external posts" is a different provider contract.
2. **Use official APIs through Nango only. No scraping.** X uses API v2 search/timeline/list endpoints; Reddit uses OAuth listing/search endpoints; LinkedIn uses supported Posts API author retrieval where scopes and roles permit it; Instagram uses Graph API professional-account business discovery / hashtag APIs where the app has access.
3. **Source rows can optionally bind to a connection.** `discovery_sources.connection_id` is nullable. Existing keyless sources keep `connectionId = null`. Connected sources require a connected social account whose provider matches the source type (`x` -> `twitter`, `linkedin` -> `linkedin`, `instagram` -> `instagram`, `reddit` -> `reddit`).
4. **Competitors are first-class tracked accounts, not loose text pasted into every source.** Add a reusable `tracked_social_accounts` table. A discovery source can point at one tracked account, many tracked accounts, or a keyword/query depending on provider capability.
5. **Source modes are explicit and provider-limited.** We do not pretend every platform supports every kind of listening:
   - X: recent search, user timeline, optional list timeline.
   - Reddit: subreddit new/search via OAuth, replacing the current RSS workaround when a connection is attached.
   - LinkedIn: known author/person/org posts where the app has `r_member_social` or `r_organization_social`; no broad public keyword search.
   - Instagram: professional-account business discovery and hashtag discovery where Meta access is approved; no private account or arbitrary feed scraping.
6. **Back-pressure is a small DB job ledger, not a new queue system.** `/discovery/run` enqueues due source jobs and processes a bounded batch synchronously. This gives retries, backoff, per-source progress, and prevents one slow connected platform from serializing the whole workspace forever, without introducing Redis/BullMQ.
7. **Sprint 45 scoring/routing remains the truth.** Connected items become normal `discovered_items`; dedup, multi-candidate scoring, accept -> `signal_matches`, and `runAutomation` all stay reused.

---

## API grounding

- X API v2 supports recent search for posts from the last 7 days and user/list timeline lookups with `tweet.read` and `users.read`; list endpoints also need `list.read`. Existing `twitter` OAuth scopes already include `tweet.read` and `users.read`.
- Reddit OAuth exposes read-content endpoints under the `read` scope. Existing Reddit OAuth scopes must add `read` to the current `identity,submit`.
- LinkedIn's current Posts API supports retrieving posts by author URN, but read scopes are restricted: `r_member_social` for member-authored posts and `r_organization_social` for organization posts. Existing LinkedIn scopes are write-oriented, so this sprint must add read scopes and show clear permission errors when LinkedIn refuses them.
- Instagram Graph Business Discovery and Hashtag Search are allowed only for professional accounts and approved app access. Treat missing approval as a source error, not as fake empty results.

Reference docs:

- X auth mapping and search/timeline scopes: https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping
- X user search: https://docs.x.com/x-api/users/search-users
- LinkedIn Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-06
- LinkedIn Community Management overview: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-06
- Reddit OAuth API: https://www.reddit.com/dev/api/oauth/
- Instagram Business Discovery: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery
- Instagram Hashtag Search: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search

---

## Out of scope

- Scraping LinkedIn, Instagram, X, Reddit, or browser automation.
- Full social-listening firehose or streaming subscriptions.
- LinkedIn broad keyword search across public posts. The API does not expose a general public search surface.
- Instagram private/personal account monitoring.
- External queue infrastructure.
- Closing deferred #27 or #28 from Sprint 45 (incremental re-score and duplicate merge view).
- Posting or replying behavior changes.

---

## Architecture

```
worker tick
  -> POST /workspaces/:id/discovery/run
       -> enqueue due source jobs
       -> claim up to DISCOVERY_JOB_BATCH_SIZE queued jobs
       -> per job:
            source has connectionId?
              yes -> connected adapter via Nango proxy
              no  -> existing keyless adapter / intent provider
            normalize RawDiscoveredItem[]
            existing cross-source dedup
            insert new/duplicate discovered_items
            record source cursor/backoff/status
       -> scoreUnscoredItems(...)
       -> response includes queued/processed/source job summaries

Discovery Settings UI
  -> tracked social accounts
  -> connected source creation
  -> job/status/error visibility
```

### New files

- `apps/api/src/discovery/connected-adapters.ts` - provider-specific connected fetchers behind one interface.
- `apps/api/src/services/tracked-social-accounts.ts` - CRUD for competitor/source accounts.
- `apps/api/src/services/discovery-jobs.ts` - enqueue/claim/complete/fail helper functions.
- Tests:
  - `apps/api/test/connected-discovery.test.ts`
  - `apps/api/test/discovery-jobs.test.ts`

### Modified files

- `packages/contracts/src/index.ts`
  - add `instagram` to `DISCOVERY_SOURCE_TYPES`;
  - add source config fields: `mode`, `handle`, `handles`, `listId`, `hashtag`, `trackedAccountId`;
  - add `connectionId` to `DiscoverySource`;
  - add tracked social account schemas;
  - add discovery job schemas.
- `apps/api/src/db/schema.ts`
  - `discovery_sources.connection_id`, `cursor_json`, `backoff_until`, `last_attempted_at`;
  - new `tracked_social_accounts`;
  - new `discovery_jobs`.
- `apps/api/src/services/discovery.ts`
  - create/update/list sources with `connectionId`;
  - run via job helpers;
  - keep item insertion/dedup/scoring behavior reused.
- `apps/api/src/routes/discovery.ts`
  - source create/update validation for connections;
  - tracked account CRUD routes;
  - run response includes queued/processed job data.
- `packages/contracts` provider registry
  - Reddit OAuth scopes add `read`;
  - LinkedIn scopes add read scopes, with notes that app approval may be required;
  - X scopes add `list.read` if `list_timeline` mode ships in this sprint; existing X connections may need reconnect to gain it;
  - Instagram remains Graph/Facebook Login with access errors surfaced per source.
- `apps/web/app/workspaces/[id]/discovery/page.tsx`
  - create connected sources, manage tracked accounts, show source/job status.
- `.env.example`
  - note required provider-side approvals/scopes for connected discovery.

---

## Data model

```ts
export const discoverySources = sqliteTable("discovery_sources", {
  // existing columns...
  connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
  cursorJson: text("cursor_json").notNull().default("{}"),
  backoffUntil: integer("backoff_until"),
  lastAttemptedAt: integer("last_attempted_at"),
});

export const trackedSocialAccounts = sqliteTable(
  "tracked_social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // "x" | "linkedin" | "instagram" | "reddit"
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    externalId: text("external_id"),
    url: text("url"),
    notes: text("notes").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastResolvedAt: integer("last_resolved_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("tracked_social_account_unique").on(t.workspaceId, t.platform, t.handle)],
);

export const discoveryJobs = sqliteTable(
  "discovery_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().references(() => discoverySources.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // queued | running | succeeded | failed | skipped
    attempt: integer("attempt").notNull().default(0),
    lockedAt: integer("locked_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    fetchedCount: integer("fetched_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("discovery_jobs_workspace_status").on(t.workspaceId, t.status, t.createdAt),
    index("discovery_jobs_source_status").on(t.sourceId, t.status),
  ],
);
```

SQLite `ON DELETE set null` may require service-level cleanup if drizzle-kit cannot express it in an `ALTER TABLE`; follow the Sprint 44/45 pattern and log a deferred item only if the migration cannot enforce it.

---

## Source config contract

Keep `DiscoverySourceConfig` flexible but validated by type/mode:

```ts
export const DISCOVERY_SOURCE_MODES = [
  "query",
  "account_timeline",
  "list_timeline",
  "subreddit",
  "hashtag",
] as const;

export const discoverySourceConfigSchema = z.object({
  // existing fields
  mode: z.enum(DISCOVERY_SOURCE_MODES).optional(),
  query: z.string().trim().max(300).optional(),
  handle: z.string().trim().max(100).optional(),
  handles: z.array(z.string().trim().max(100)).max(25).optional(),
  listId: z.string().trim().max(100).optional(),
  hashtag: z.string().trim().max(100).optional(),
  trackedAccountId: z.string().uuid().optional(),
  trackedAccountIds: z.array(z.string().uuid()).max(25).optional(),
  subreddit: z.string().trim().max(100).optional(),
});
```

Validation rules:

- `x` connected source requires `connectionId` and one of:
  - `mode=query` + `query`;
  - `mode=account_timeline` + `handle`, `handles`, `trackedAccountId`, or `trackedAccountIds`;
  - `mode=list_timeline` + `listId`.
- `reddit` with `connectionId` uses OAuth and requires `subreddit` or `query`; without `connectionId`, current keyless RSS behavior remains valid.
- `linkedin` requires `connectionId` and `mode=account_timeline` with `handle`, `trackedAccountId`, or explicit author URN stored in `externalId`.
- `instagram` requires `connectionId` and one of:
  - `mode=account_timeline` + `handle` / `trackedAccountId` for Business Discovery;
  - `mode=hashtag` + `hashtag`.

---

## Connected adapter behavior

### X

- Query mode: `GET /2/tweets/search/recent` with `query`, `tweet.fields=created_at,author_id,public_metrics`, `expansions=author_id`, and user fields for username/name.
- Account mode: resolve handle via `GET /2/users/by/username/:username`, then `GET /2/users/:id/tweets`.
- List mode: `GET /2/lists/:id/tweets` if `list.read` is granted.
- External id: `x:{tweet.id}`.
- URL: `https://x.com/{username}/status/{tweet.id}` when username is known.
- Cursor: store `next_token` by source mode in `cursorJson`; on the next run, fetch newest-first and stop once existing ids are encountered. Do not rely only on cursor because search/timelines can expire windows.

### Reddit

- If no connection: keep current RSS adapter unchanged.
- With connection: call `https://oauth.reddit.com` through Nango.
- Subreddit mode: `/r/{subreddit}/new?limit=25` or `/r/{subreddit}/search?q=...&sort=new&restrict_sr=1&limit=25`.
- External id: Reddit fullname (`t3_...`) when available.
- OAuth scopes: add `read`; keep `identity,submit` for existing publishing.

### LinkedIn

- No broad keyword search. Connected LinkedIn sources are known-author sources.
- Resolve and store an author URN:
  - member source: current member from `/v2/userinfo` or author URN entered/resolved where `r_member_social` permits;
  - organization source: organization URN entered/resolved only where the connected member has the needed org role and `r_organization_social`.
- Fetch posts with the Posts API `author={PersonURN|OrganizationURN}` endpoint and required LinkedIn version headers.
- If LinkedIn returns 403 because read scopes or org roles are missing, mark only that source `error` with `permission_required`; the rest of discovery continues.

### Instagram

- Use the existing Facebook/Instagram connection and `igUserId()` pattern from `InstagramAdapter`.
- Business Discovery mode fetches basic media metadata for a professional competitor handle where Meta permits it.
- Hashtag mode uses hashtag search/recent media where the app has Instagram Public Content Access approval.
- If Meta access is missing, mark the source `error` with `permission_required`; do not silently return zero items.

---

## Discovery job flow

`POST /workspaces/:id/discovery/run` becomes:

1. Release stale `running` jobs whose `lockedAt` is older than `DISCOVERY_JOB_LOCK_TIMEOUT_MS` (default 10 minutes): mark failed with `stale_lock` and make the source eligible again.
2. Enqueue a job for each enabled source whose `backoffUntil` is null/past and that has no queued/running job.
3. Claim up to `DISCOVERY_JOB_BATCH_SIZE` jobs, default 5.
4. For each claimed job:
   - set `running`, `attempt += 1`, `startedAt`;
   - fetch through connected or keyless adapter;
   - insert new/duplicate items using existing dedup logic;
   - update source `lastAttemptedAt`, `lastFetchedAt`, `cursorJson`, `status`;
   - mark job `succeeded` or `failed`.
5. On provider 429/5xx, set exponential `backoffUntil` on the source.
6. Score unscored, non-duplicate items using the existing Sprint 45 batch.
7. Return:

```ts
{
  queued: number,
  processed: number,
  sources: [{ sourceId, name, fetched, new, error? }],
  scored: number
}
```

The worker keeps calling the same endpoint. The ledger makes the run observable and bounded; no new worker process is required.

---

## UI changes

- Discovery page source form:
  - source type selector includes Instagram;
  - for connected types, show a connection dropdown filtered to matching social providers;
  - show mode-specific fields (`query`, `handle`, `subreddit`, `hashtag`, `listId`).
- Tracked accounts card:
  - add/edit/delete competitor handles by platform;
  - show last resolved state and errors;
  - let source creation pick a tracked account instead of retyping a handle.
- Source list:
  - badges for keyless vs connected;
  - connection display name;
  - status: active / needs connection / permission required / backoff / error.
- Triage list:
  - existing candidate chips and duplicate badge stay;
  - add source account/platform badges on each item.

---

## Error handling

- Missing required connection -> `400 connection_required` on create/update.
- Connection provider mismatch -> `400 wrong_provider`.
- Disconnected connection -> source status `error`, `lastError = "connection_disconnected"`.
- Provider permission refusal -> source status `error`, stable `permission_required` message with provider detail in `lastError`.
- Rate limit -> source status remains `active`, `backoffUntil` set, job failed with `rate_limited`.
- Adapter parse failure -> job failed, source `error`; no partial fake items.
- LLM scoring failure remains non-blocking as today: fetched items stay `new` with no score.

---

## Implementation checklist

1. [x] Branch from the right base and commit this spec.
2. [x] Contracts: source modes/config, `instagram` source type, `connectionId` on source schema, tracked account schemas, discovery job schemas. Contract tests.
3. [x] Schema/migration: add source connection/cursor/backoff columns; add `tracked_social_accounts`; add `discovery_jobs`; generate migration.
4. [x] Services: tracked account CRUD with per-workspace uniqueness and normalization (`@handle` stripped where appropriate).
5. [x] Connected adapter seam: implement fakeable `fetchConnectedSourceItems({ source, connection, fabric })`; X + Reddit first, then LinkedIn + Instagram with clear permission errors.
6. [x] Discovery service: validate source connection/provider, enqueue/claim/complete jobs, route connected vs keyless fetching, keep dedup/scoring reuse intact.
7. [x] API tests: source validation; job ledger; connected X/Reddit happy paths with fake fabric; LinkedIn/Instagram permission errors; rate-limit backoff; keyless RSS/Google News regression.
8. [x] Web: connected source form, tracked accounts card, source/job status, triage source badges.
9. [x] Docs: founder acceptance section in `docs/founder-acceptance-tests.md`; env/scope notes in `.env.example`; new deferred entries only for deliberate gaps discovered during implementation.
10. [x] Verify: `npm test`, `npm run typecheck`, web build/typecheck if UI touched. Commit with the sprint trailer and push branch.

---

## Three-part build split

Sprint 46 is deliberately split into three sequential Claude sessions so each one can stay under a manageable context window:

1. **Part 1 - Foundation & discovery job ledger**
   - Plan: `docs/superpowers/plans/2026-07-04-sprint-46-part-1-foundation-jobs.md`
   - Branch: `sprint-46a-discovery-job-foundation`
   - Builds: contracts/schema for connected source fields, `discovery_jobs`, bounded `/discovery/run`, and keyless-source regression coverage.
   - Gate: existing RSS/Google News/keyless Reddit discovery still works through the new job ledger; no connected provider fetching yet.

2. **Part 2 - Connected adapters & competitor accounts**
   - Plan: `docs/superpowers/plans/2026-07-04-sprint-46-part-2-connected-adapters.md`
   - Branch: `sprint-46b-connected-discovery-adapters`
   - Builds: tracked social accounts, connection/provider validation, X and authenticated Reddit connected happy paths, and LinkedIn/Instagram permission-gated adapters.
   - Gate: connected social sources produce normal `discovered_items`; permission failures are source-local and do not break the run.

3. **Part 3 - UI, acceptance, and documentation**
   - Plan: `docs/superpowers/plans/2026-07-04-sprint-46-part-3-ui-acceptance.md`
   - Branch: `sprint-46c-connected-discovery-ui`
   - Builds: Discovery page controls for tracked accounts and connected sources, source/job status display, triage source badges, env notes, and founder acceptance tests.
   - Gate: founder can configure, run, inspect, and accept connected discovery from the UI; targeted tests, typecheck, and web build pass.

Each part should start from the previous part's verified branch. Do not combine Part 2 and Part 3 unless Part 2 is already fully green; the UI work depends on stable backend response shapes.

---

## Automated verification

- Contracts:
  - `DISCOVERY_SOURCE_TYPES` includes `instagram`;
  - connected-source inputs require the right mode/config;
  - tracked accounts normalize/validate handles;
  - job status schema accepts queued/running/succeeded/failed/skipped.
- API:
  - existing keyless sources still run without a connection;
  - connected sources reject missing/wrong/disconnected connections;
  - X fake fabric returns posts -> discovered items with stable external ids and X URLs;
  - Reddit fake fabric returns listings -> discovered items; keyless Reddit still uses RSS;
  - LinkedIn/Instagram 403 -> source error/job failed, no crash;
  - rate-limited source gets `backoffUntil` and is skipped until due;
  - duplicate URL/content from connected + keyless sources links to one canonical item;
  - scoring/routing output remains Sprint 45 compatible.
- Web:
  - create a connected source with a matching connection;
  - create a tracked account and select it in a source;
  - source status/errors render without layout breakage.

---

## Founder acceptance checklist

- [ ] Connect X, add an X recent-search source for a narrow topic, run discovery -> posts appear in triage with X source badges and candidate campaign/persona chips.
- [ ] Add a tracked competitor X handle, create an account-timeline source from it, run discovery -> competitor posts appear and dedupe against the search source if they are the same story.
- [ ] Connect Reddit, create an authenticated subreddit source -> discovery still works when Reddit RSS would have been keyless, and the source shows it is using the connected account.
- [ ] Add a LinkedIn or Instagram source without the needed API approval -> the source shows a clear permission error while other sources continue running.
- [ ] A connected social item accepted from triage creates a signal with the full Sprint 45 match list, and `Run automation now` drafts only for matched campaigns/personas.
- [ ] Add enough sources to exceed the per-run job batch -> one run processes a bounded batch, the rest remain queued, and the next run continues instead of blocking or duplicating.

---

## Known limitations

- X recent search is recent-window discovery, not full archive.
- LinkedIn source coverage depends on approved read scopes and author/org access; no public LinkedIn keyword search.
- Instagram competitor/hashtag discovery depends on Meta app review and professional-account constraints.
- The job ledger is local DB back-pressure, not a distributed queue.
- Cursoring is best-effort per provider; dedup remains the final idempotency guarantee.

---

## Progress log

- 2026-07-04 - **Part 3 complete** on `sprint-46c-connected-discovery-ui` (cut from the Part 2 branch) — Sprint 46 is built end-to-end; founder acceptance pending. No backend changes were needed; the page consumes the Part 1/2 shapes as-is (plan Task 1's typed API helpers deliberately skipped — the web convention is generic `apiFetch`, so no `lib/api.ts` change). Discovery page: new **Tracked accounts** panel (platform/handle/display-name/notes form, normalized-handle list with resolved state + lastError, disable/delete, duplicate 409 surfaced inline); source form gains Instagram plus a **Read through** connection picker filtered to the matching provider with `connected` status only (x→twitter, linkedin/instagram/reddit 1:1; keyless option stays for x/linkedin "needs API key" and reddit "public RSS"), per-mode fields (X: recent search / account timeline / list timeline; LinkedIn: fixed account timeline; Instagram: account posts / hashtag, connected-only — submit disabled with an inline hint until an account is chosen), and a tracked-account dropdown as an alternative to typing a handle (resets on type/connection/mode change). Source rows: status badge extended to **needs connection** (lastError `connection_disconnected`), **permission required** (stable `permission_required` prefix), and **backing off** (`backoffUntil` in the future); a 🔗 badge with the connection display name vs a muted **keyless** badge; `checked`/`fetched` timestamps from `lastAttemptedAt`/`lastFetchedAt`. Run summary now reads `N queued · M processed (the rest run on the next poll)` + per-source new/fetched/error + scored. Triage cards get a truncating `🔗 X · <source name>` badge (new `.source-badge` rule in `globals.css`; long names ellipsize instead of overflowing). Docs: Sprint 46 section in `docs/founder-acceptance-tests.md` (3 slices + gate; reconnect-once-for-new-scopes called out as a prereq), connected-discovery scope/app-review notes on the Reddit/X/LinkedIn/Instagram blocks in `.env.example`. No new deferred entries (#29 cursor persistence and #30 tracked-account resolution stand from Part 2). Verified: full suite **945 green**, `npm run typecheck` clean across workspaces, `next build` clean.
- 2026-07-04 - **Part 2 complete** on `sprint-46b-connected-discovery-adapters` (cut from the Part 1 branch). Contracts: `instagram` added to `DISCOVERY_SOURCE_TYPES` and `SIGNAL_SOURCES`; `connectionId` on source create/update inputs; per-type/mode validation in `createDiscoverySourceInputSchema` (keyless x/linkedin keep the legacy query requirement, modes carry target requirements, instagram is connected-only); `TRACKED_SOCIAL_PLATFORMS` + tracked-account schemas; scopes: reddit `+read`, linkedin `+r_member_social` (approval-gated — note in registry comment), twitter `+list.read` (existing connections need reconnect). Schema/migration `0034_watery_zeigeist.sql`: `tracked_social_accounts` with the per-workspace `(platform, handle)` unique index. New `services/tracked-social-accounts.ts` (CRUD + `normalizeTrackedHandle`: @-strip/lowercase for x/instagram, r/-u/-strip for reddit, LinkedIn as-entered; duplicate → 409) and tracked-account routes under `/workspaces/:id/discovery/tracked-accounts`. New `discovery/connected-adapters.ts` (`fetchConnectedSourceItems` + `PermissionRequiredError`/`RateLimitedError`): X query/account_timeline/list_timeline (`x:{id}` external ids, x.com URLs, metrics in summary), Reddit OAuth listings/search via oauth.reddit.com (fullname external ids; keyless Reddit untouched on RSS), LinkedIn Posts-by-author with version headers (URN from tracked account/handle, else `/v2/userinfo`; 403 → permission_required), Instagram Business Discovery + hashtag via Graph (same `me/accounts` IG-id lookup as the publishing adapter; 400/401/403 → permission_required). `services/discovery.ts`: `providerForDiscoverySourceType` (x→twitter), `DiscoverySourceConnectionError` (`connection_required`/`wrong_provider`/`connection_disconnected` → 400s on create/update), connected sources created `active`; `runDiscovery` takes the `ConnectorFabric`, routes `connectionId` sources through the connected seam with tracked-account resolution, run-time disconnection fails only that source (`lastError: connection_disconnected`), 429 → exponential `backoffUntil` (5 min base doubling per consecutive `rate_limited` job, 60 min cap, source stays `active`), permission refusals → source `error` with stable `permission_required:` prefix. Dedup/scoring/accept reuse verified: connected X + keyless Google News same-story test links to one canonical item; accept carries the x signal source. Tests: contracts 153 (+4), new `connected-discovery.test.ts` (19), full suite 945 green, typecheck clean; scope assertions updated in `publish.test.ts`/`connect-social.test.ts`; web type-map labels added (real UI is Part 3). Deferred: #29 cursor persistence unused, #30 tracked-account id resolution manual. Next session: Part 3 from this branch (`docs/superpowers/plans/2026-07-04-sprint-46-part-3-ui-acceptance.md`) — UI, founder acceptance doc, `.env.example` scope notes.
- 2026-07-04 - **Part 1 complete** on `sprint-46a-discovery-job-foundation` (cut from `main`, Sprint 45 already merged). Contracts: `DISCOVERY_SOURCE_MODES`, `DISCOVERY_JOB_STATUSES`, `discoveryJobSchema`, connected config fields (`mode`/`handle`/`handles`/`listId`/`hashtag`/`trackedAccountId`/`trackedAccountIds`), and `connectionId`/`cursor`/`backoffUntil`/`lastAttemptedAt` on `discoverySourceSchema` (`query` max relaxed 200→300 per this spec). Schema/migration `0033_flawless_pepper_potts.sql`: four new `discovery_sources` columns plus the `discovery_jobs` table with both indexes. `connection_id` has **no declared FK** — same drizzle-kit SQLite `ALTER TABLE ADD` action gap as deferred #26; connections are only ever soft-disconnected (never hard-deleted), so no cleanup path is needed yet. New `services/discovery-jobs.ts` (batch size 5, lock timeout 10 min, release-stale/enqueue-due/claim/complete/fail; `enqueueDueDiscoveryJobs` takes the pre-filtered eligible source list so the needs_api_key/intent gating stays in `runDiscovery`). `runDiscovery` now releases stale locks, enqueues due sources, claims a bounded batch, and processes each job through the existing keyless adapters — dedup, scoring, and accept/routing untouched; response gains `queued`/`processed` (worker and web consumers are additive-compatible). Tests: contracts suite +4 (149 total green), new `apps/api/test/discovery-jobs.test.ts` (7 tests: enqueue dedupe, backoff skip, oldest-first bounded claim, stale-lock release, counts/error truncation, bounded run continuation via route, failed keyless fetch job). Full suite 922 green, typecheck clean. Part 1 gate met: no connected provider fetching exists; instagram source type and tracked accounts intentionally deferred to Part 2 per the three-part split. Next session: Part 2 from this branch (`docs/superpowers/plans/2026-07-04-sprint-46-part-2-connected-adapters.md`).
- 2026-07-04 - Spec drafted from Phase G Sprint D (`docs/plans/context-discovery-gap-assessment.md` and `docs/plans/sprint-guide-21-onward.md`), after auditing the current discovery stack (`services/discovery.ts`, `discovery/adapters.ts`, Sprint 45 matching/dedup), social connector seams (`connectors/social/*`, `ConnectorFabric`/Nango), worker discovery tick, and current source schemas. Confirmed Sprint 46 should use a separate connected discovery adapter seam, add `discovery_sources.connectionId`, model competitor handles as tracked accounts, and make queue/back-pressure a bounded DB job ledger rather than new infrastructure. External API constraints checked against official X, LinkedIn, Reddit, and Meta docs; LinkedIn and Instagram are intentionally permission-gated instead of faked.
