# Sprint 46 Part 2 - Connected Adapters & Competitor Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tracked competitor/source accounts and connected discovery adapters for X, Reddit, LinkedIn, and Instagram through the existing Nango connector fabric.

**Architecture:** This part builds on Part 1. Connected sources still produce normal `RawDiscoveredItem[]`; they then reuse the existing dedup, scoring, accept, and automation routing pipeline. X and Reddit get fixture-backed happy paths; LinkedIn and Instagram get explicit permission-gated behavior with clear source errors when platform access is missing.

**Tech Stack:** TypeScript, Fastify, Drizzle SQLite, Nango `ConnectorFabric.proxyJson`, Vitest with fake fabric.

---

## Branch And Context

- Branch: `sprint-46b-connected-discovery-adapters`
- Base: Part 1 branch after it passes verification.
- Read first:
  - `docs/specs/sprint-46-connected-account-competitor-sourcing.md`
  - `docs/superpowers/plans/2026-07-04-sprint-46-part-1-foundation-jobs.md`
  - `apps/api/src/connectors/fabric.ts`
  - `apps/api/src/services/connections.ts`
  - `apps/api/src/discovery/adapters.ts`

## File Map

- Create: `apps/api/src/services/tracked-social-accounts.ts`
  - CRUD and handle normalization.
- Create: `apps/api/src/discovery/connected-adapters.ts`
  - provider dispatch for connected source fetching.
- Modify: `apps/api/src/services/discovery.ts`
  - validate connected source connection/provider;
  - call connected adapters for sources with `connectionId`.
- Modify: `apps/api/src/routes/discovery.ts`
  - tracked account routes;
  - source create/update connection validation.
- Modify: `packages/contracts/src/index.ts`
  - tracked account schemas;
  - add `instagram` to discovery source types if not done in Part 1;
  - update provider OAuth scopes.
- Modify: `packages/contracts/test/contracts.test.ts`
- Test: `apps/api/test/connected-discovery.test.ts`
- Test: `apps/api/test/discovery.test.ts`

---

## Tasks

### Task 1: Tracked Social Account Contracts And Service

- [x] Add `TRACKED_SOCIAL_PLATFORMS = ["x", "linkedin", "instagram", "reddit"]`.
- [x] Add `trackedSocialAccountSchema`, `createTrackedSocialAccountInputSchema`, and `updateTrackedSocialAccountInputSchema`.
- [x] Create `tracked-social-accounts.ts` with:
  - `normalizeTrackedHandle(platform, handle)`;
  - `createTrackedSocialAccount`;
  - `listTrackedSocialAccounts`;
  - `updateTrackedSocialAccount`;
  - `deleteTrackedSocialAccount`.
- [x] Normalize X/Instagram handles by stripping leading `@`; normalize Reddit by stripping `r/` for subreddit-style account tracking.
- [x] Tests:
  - duplicate `(workspaceId, platform, handle)` is rejected or returns `409`;
  - `@competitor` and `competitor` normalize to the same row;
  - list is workspace-scoped.
- [x] Commit: `feat(api): tracked social accounts for discovery`.

### Task 2: Source Connection Validation

- [x] Add a helper in `services/discovery.ts` or a focused helper file:
  - `providerForDiscoverySourceType("x") -> "twitter"`;
  - `providerForDiscoverySourceType("linkedin") -> "linkedin"`;
  - `providerForDiscoverySourceType("instagram") -> "instagram"`;
  - `providerForDiscoverySourceType("reddit") -> "reddit"`.
- [x] On create/update, if a connected source has `connectionId`, load the connection and require:
  - same workspace;
  - `status === "connected"`;
  - matching provider key.
- [x] Errors:
  - missing connection for connected-only modes -> `400 connection_required`;
  - wrong provider -> `400 wrong_provider`;
  - disconnected -> `400 connection_disconnected`.
- [x] Tests for each error.
- [x] Commit: `feat(api): validate discovery source connections`.

### Task 3: Connected Adapter Seam

- [x] Create `connected-adapters.ts`.
- [x] Export:
  - `ConnectedDiscoveryInput`;
  - `fetchConnectedSourceItems(input): Promise<RawDiscoveredItem[]>`;
  - `PermissionRequiredError`;
  - `RateLimitedError`.
- [x] Implement dispatch by source type:
  - `x` -> `fetchXItems`;
  - `reddit` -> `fetchAuthenticatedRedditItems`;
  - `linkedin` -> `fetchLinkedInItems`;
  - `instagram` -> `fetchInstagramItems`.
- [x] Keep adapter output identical to existing `RawDiscoveredItem`.
- [x] Tests use a fake `ConnectorFabric` with captured `proxyJson` calls.
- [x] Commit: `feat(api): connected discovery adapter seam`.

### Task 4: X Connected Sources

- [x] Implement X query mode with `/2/tweets/search/recent`.
- [x] Implement X account timeline mode by resolving `/2/users/by/username/:username`, then fetching `/2/users/:id/tweets`.
- [x] Implement optional list mode via `/2/lists/:id/tweets`; if `list.read` is missing and X returns 403, convert to `PermissionRequiredError`.
- [x] Normalize:
  - `externalId = "x:" + tweet.id`;
  - `title = first 90 chars of tweet text`;
  - `url = https://x.com/{username}/status/{tweet.id}`;
  - `summary = tweet text + compact metrics when present`;
  - `publishedAt = Date.parse(created_at)`.
- [x] Tests:
  - query mode fixture inserts X items;
  - account mode resolves handle before timeline;
  - 429 becomes rate-limited/backoff through the discovery run.
- [x] Commit: `feat(api): connected X discovery sources`.

### Task 5: Authenticated Reddit Sources

- [x] Add `read` to Reddit provider OAuth scopes in `CONNECTOR_PROVIDERS`.
- [x] Implement connected Reddit:
  - subreddit new: `/r/{subreddit}/new?limit=25`;
  - subreddit search: `/r/{subreddit}/search?q=...&restrict_sr=1&sort=new&limit=25`;
  - global search when only `query` is present: `/search?q=...&sort=new&limit=25`.
- [x] Normalize:
  - external id: `kind + "_" + data.id` or `data.name`;
  - url: `https://www.reddit.com${permalink}`;
  - title: `data.title`;
  - summary: `data.selftext` or `data.url`;
  - publishedAt: `created_utc * 1000`.
- [x] Tests:
  - connected source uses OAuth endpoint, not RSS;
  - keyless Reddit source still uses RSS.
- [x] Commit: `feat(api): authenticated Reddit discovery`.

### Task 6: LinkedIn And Instagram Permission-Gated Sources

- [x] LinkedIn:
  - require `mode=account_timeline`;
  - accept `externalId`/author URN from tracked account when present;
  - fetch posts by author with LinkedIn version headers;
  - convert 403 to `PermissionRequiredError("LinkedIn read scope or author role required")`.
- [x] Instagram:
  - require `mode=account_timeline` or `mode=hashtag`;
  - use Graph API through the existing Instagram connection;
  - convert 403/400 permission responses to `PermissionRequiredError("Instagram professional account or app review required")`.
- [x] Tests:
  - LinkedIn 403 marks only that source as failed/permission-required;
  - Instagram 403 marks only that source as failed/permission-required;
  - another source in the same run still succeeds.
- [x] Commit: `feat(api): LinkedIn and Instagram connected discovery guards`.

### Task 7: Run Integration And Backoff

- [x] In `runDiscovery`, when `source.connectionId` is present, call `fetchConnectedSourceItems`.
- [x] On `PermissionRequiredError`, mark source `error`, job failed, no `backoffUntil`.
- [x] On `RateLimitedError` or provider 429/5xx, set exponential `backoffUntil`.
- [x] On other errors, mark source `error` and job failed.
- [x] Tests:
  - connected + keyless sources in one run both return source summaries;
  - duplicate URL/content across connected X and keyless Google News links to one canonical item;
  - connected accepted item copies Sprint 45 matches to a signal.
- [x] Run `npm test -- connected-discovery discovery`.
- [x] Run `npm run typecheck`.
- [x] Commit: `feat(api): run connected discovery through job ledger`.

## Completion Gate

Part 2 is complete when:

- tracked competitors/accounts can be created and referenced by connected sources;
- X and Reddit connected sources have fixture-backed happy paths;
- LinkedIn and Instagram fail clearly when permissions are missing;
- keyless discovery still works;
- `npm test -- connected-discovery discovery` and `npm run typecheck` pass.
