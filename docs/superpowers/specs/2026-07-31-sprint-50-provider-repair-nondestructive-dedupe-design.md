# Sprint 50 Provider Repair and Non-Destructive Dedupe Design

> **Plane epic:** TAP-9
>
> **Plane cards:** TAP-51 through TAP-57
>
> **Branch:** `sprint-50-provider-repair-dedupe`
>
> **Base:** merged `origin/main` at `1a657c7`

## 1. Goal

Repair the discovery features that currently claim to work but either call
expired/dead provider surfaces or can return the wrong account's data. At the
same time, make source deletion preserve every story that still has a surviving
occurrence.

The founder-visible result is:

- a plain LinkedIn company handle resolves to that company's URN before posts
  are fetched;
- an unresolvable LinkedIn handle is a visible error and never becomes the
  connected member's own feed;
- Google Trends and other unimplemented source vocabulary are visibly reserved,
  not presented as operational;
- Instagram uses direct Instagram Login and no longer requests the rejected
  Facebook Login permission set;
- deleting a source cannot strand surviving cross-source duplicates; and
- founders no longer paste provider-side IDs into tracked accounts.

## 2. Scope and sequencing

The work is delivered in Plane-card order:

1. TAP-51 — current LinkedIn API version and organization-read scope.
2. TAP-52 — LinkedIn handle-to-URN resolution with no self fallback.
3. TAP-53 — reserve Google Trends until its official API is generally
   available.
4. TAP-54 — migrate Instagram to the approved direct-login architecture.
5. TAP-55 — promote surviving duplicates during source deletion and repair
   already-dangling duplicate groups.
6. TAP-56 — resolve and cache tracked-account provider IDs.
7. TAP-57 — label inert contract vocabulary with truthful activation
   milestones.

Each card gets focused tests, relevant regression tests, typecheck, a commit,
and a Plane completion comment before it moves to Done. TAP-9 stays In Progress
until every child and the full-suite verification pass.

## 3. Chosen architecture

Sprint 50 is a focused compatibility and data-safety repair. It does not pull
Sprint 60's canonical-story/source-occurrence schema into this branch.

Provider-specific resolution is isolated behind small resolver functions.
Connected discovery supplies the connection, target, and proxy seam; the
resolver returns a durable provider ID or a typed error. Successful IDs are
cached on `tracked_social_accounts.external_id`.

Source deletion remains a deletion from the founder's perspective. Before the
source row is deleted, one transaction promotes a surviving duplicate whenever
the deleted source owns its canonical row. The promoted row inherits the
canonical product state, while every other surviving duplicate is repointed to
it.

The alternative full canonical-story rewrite is deferred to Sprint 60. A
provider-only patch is rejected because it would leave the known source-deletion
data-loss path open.

## 4. LinkedIn repair

### 4.1 Version policy

All versioned LinkedIn REST calls use one centrally resolved version:

- `LINKEDIN_API_VERSION`, when set to exactly six digits (`YYYYMM`);
- otherwise the shipped default `202607`, LinkedIn's current version when this
  design was approved.

Invalid configured values fail fast during application setup rather than
silently sending a malformed header. Tests assert the resolved header, not a
copy of the value in each adapter.

Reference:
[LinkedIn July 2026 API changes](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/recent-changes?view=li-lms-2026-07).

### 4.2 Approval-gated scopes

The default OAuth grant remains connectable before Community Management
approval. `LINKEDIN_COMMUNITY_APPROVED` is parsed as a real boolean:

- only `true`, `1`, `yes`, or `on` enables restricted read scopes;
- missing, empty, `false`, `0`, `no`, and `off` do not.

When enabled, the LinkedIn OAuth scope set adds:

- `r_member_social`; and
- `r_organization_social`.

This uses the already-approved operator-level environment flag rather than a
founder-facing product toggle. Existing LinkedIn connections must reconnect to
receive the added scopes.

Reference:
[LinkedIn Posts API permissions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04).

### 4.3 Company-handle resolution

A target is resolved in this order:

1. A cached `urn:li:organization:<id>` is accepted.
2. An explicitly supplied organization URN is accepted.
3. A plain handle or LinkedIn company URL is normalized to its company vanity
   slug.
4. The adapter calls the organization vanity-name finder.
5. An exact case-insensitive match with a valid numeric `id` becomes
   `urn:li:organization:<id>`.

The supported plain-handle product is a LinkedIn Company or School page.
LinkedIn does not expose a general public person-handle-to-person-URN lookup for
this use case. A personal-profile slug therefore returns
`target_unresolvable`; it never falls back to `/v2/userinfo`.

Zero results, multiple non-exact results, malformed results, insufficient
permissions, and unsupported person handles are errors. The adapter does not
fetch `/rest/posts` unless target resolution succeeds.

Reference:
[LinkedIn organization lookup by vanity name](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api?view=li-lms-2026-03).

### 4.4 Product behavior

- Source creation accepts a plain company handle.
- A discovery run resolves and caches its organization URN on first use.
- The tracked-account card shows the last successful resolution time or the
  latest resolution error.
- "Retry resolution" repeats the lookup through a selected connected LinkedIn
  account.
- A permissions failure says that LinkedIn Community Management access and a
  reconnect are required.

## 5. Reserved discovery vocabulary

### 5.1 Google Trends

The existing RSS URL is removed from the live-source set. Google's official
Trends API is still a limited alpha, so Sprint 50 does not replace one
unsupported endpoint with another unofficial scraper.

`google_trends` remains a contract value for stored-data compatibility but is
included in `RESERVED_DISCOVERY_SOURCE_TYPES`. The behavior is:

- existing rows remain listable and show `reserved`;
- the scheduler never enqueues them;
- the API rejects creation/activation with `source_reserved`; and
- the UI shows "Google Trends — reserved" without an operational add flow.

Reference:
[Google Trends API alpha](https://developers.google.com/search/apis/trends).

### 5.2 G2, Capterra, and intent

`g2`, `capterra`, and `intent` join the same reserved source set. They have no
selected production provider, so "needs API key" is misleading: supplying a key
would not activate an adapter.

The injected `IntentProvider` seam remains available to tests and future
implementation, but the default product does not advertise it as live.

The current roadmap names no provider-activation sprint for these three values.
Their comments therefore say:

> Reserved. Activation sprint is not scheduled; a provider-specific sprint
> must be created before this value becomes available.

This is deliberately more truthful than inventing a Sprint 60 dependency;
Sprint 60 changes story storage and does not select or implement paid providers.
TAP-57 receives a Plane note recording this PRD scheduling gap.

### 5.3 Other reserved contract values

- `PACKAGE_SOURCE_ROLES` is reserved until Sprint 62.
- `DELIVERABLE_PRODUCTION_STATUSES` is reserved until Sprint 63.

The comments sit next to the exported constants so contract readers see the
truth without finding a planning document.

## 6. Instagram direct-login migration

### 6.1 Connection architecture

The Instagram connector changes from Nango's `facebook` provider to its
`instagram` provider:

- OAuth credentials remain `INSTAGRAM_CLIENT_ID` and
  `INSTAGRAM_CLIENT_SECRET`, now referring to the Instagram app credentials;
- the base API host becomes `https://graph.instagram.com`;
- scopes become `instagram_business_basic` and
  `instagram_business_content_publish`; and
- OAuth completion fetches `/me` and binds the connection row to exactly one
  Instagram professional account ID and username.

Legacy Instagram rows created through Facebook Login remain listable but are
marked `reconnect_required`. They are never silently treated as direct-login
connections.

Reference:
[Meta's direct Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login).

### 6.2 Honest discovery capability

Meta documents competitor Business Discovery and hashtag discovery under the
Facebook Login architecture, not as direct Instagram Login capabilities.
Sprint 50 therefore does not pretend those modes survived the migration.

After reconnect:

- an Instagram source may read only the connected account's own media;
- the requested target must match the connection's bound username;
- competitor-account targets return `unsupported_target`;
- hashtag mode returns `unsupported_mode`; and
- the source form explains the limitation before submission.

Existing competitor or hashtag sources remain visible but become
`reconnect_required` or `unsupported_mode` after the provider migration. No
provider call substitutes different data.

This limitation is an inference from Meta's official API collections:
[direct Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
and
[Facebook Login capabilities](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

### 6.3 Non-goal

Threads is not part of TAP-54 or Sprint 50. The earlier design remains useful,
but adding a Threads provider, scopes, routes, and UI card would be a separate
feature.

## 7. Tracked-account provider ID resolution

### 7.1 Resolver boundary

The resolver accepts:

- workspace ID;
- tracked-account ID;
- a compatible connected-account ID; and
- the connector proxy.

It returns the updated tracked account or a typed resolution error.

Supported resolution:

- X: username lookup to the provider user ID;
- LinkedIn: company vanity slug to organization URN;
- Reddit: the normalized subreddit/user handle is already the durable target
  identity and needs no network lookup;
- Instagram: only the direct connection's own bound username can resolve.
  Arbitrary competitor resolution is unsupported after direct-login migration.

### 7.2 Cache lifecycle

- Successful resolution writes `externalId`, clears `lastError`, and stamps
  `lastResolvedAt`.
- Failed resolution preserves the previous successful ID, when one exists, and
  writes `lastError`; it does not stamp a false success time.
- Changing a handle clears the cached ID and resolution fields.
- Disabling or changing an account still invalidates dependent source jobs
  through the existing execution-version fence.
- The public create/update inputs no longer invite founders to paste
  `externalId` manually.

### 7.3 Invocation

Resolution happens:

1. on first use by a connected discovery source when no cached ID exists; and
2. through `POST
   /workspaces/:id/discovery/tracked-accounts/:accountId/resolve` for explicit
   retry.

The retry body contains `connectionId`, so multiple connected accounts are not
resolved through an arbitrary token.

## 8. Non-destructive duplicate promotion

### 8.1 New source deletion transaction

Before deleting a source, the service finds canonical items owned by that
source that have duplicates on other sources. For each group it chooses the
oldest surviving duplicate and promotes it.

The promoted row keeps its own occurrence provenance:

- source ID;
- external provider ID;
- URL/content hashes; and
- occurrence timestamps.

It inherits the canonical product state:

- title, URL, summary, and published time;
- score, score reason, suggested persona, and suggested campaign;
- status (`new`, `accepted`, or `skipped`);
- signal link;
- scoring/matching state and error; and
- discovered-item matches, repointed to the promoted row.

All other surviving duplicates are repointed to the promoted row. Their own
source and external IDs remain unchanged. Only after promotion and repointing
does the transaction delete the source.

If a source owns only a duplicate, that occurrence is removed and its canonical
group remains valid. If a canonical has no surviving occurrence, normal source
deletion removes it.

### 8.2 Repair of existing dangling groups

Already-dangling duplicates have lost the deleted canonical state, so that state
cannot be reconstructed. A deterministic repair runs before normal discovery:

1. group rows whose `duplicateOfId` references no item in the workspace;
2. promote the oldest row in each group;
3. clear its duplicate link;
4. reset it to `new` with matching `pending`;
5. repoint the rest of the group to it; and
6. clear stale lease/error fields.

This makes every surviving occurrence reachable again without fabricating an
accepted/skipped decision that no longer exists.

### 8.3 Sprint 60 boundary

Sprint 50 does not add canonical-story, source-occurrence, or cluster tables.
Sprint 60 owns that durable domain model, immutable provenance snapshots, and
reversible cluster membership. Sprint 50 provides a safe bridge so current data
survives until that migration.

## 9. Error model and UI

Provider failures use stable machine codes and founder-readable messages:

- `source_reserved` — registered vocabulary with no live adapter;
- `target_unresolvable` — the requested handle could not become a provider ID;
- `permission_required` — provider approval/scope/reconnect is required;
- `reconnect_required` — a stored connection uses the retired provider
  architecture;
- `unsupported_target` — the provider cannot read that account through the
  selected connection; and
- `unsupported_mode` — the provider architecture does not support that source
  mode.

The UI never collapses these into a generic "active" badge or treats them as an
empty successful result.

## 10. Testing

### 10.1 LinkedIn

- current/default version and valid operator override;
- invalid version fails setup;
- strict boolean parsing for the Community Management flag, including the
  literal string `false`;
- organization-read scopes are approval-gated;
- plain company handle and company URL resolve to the correct organization URN;
- cached URN skips lookup;
- zero/malformed results fail;
- the adapter never calls `/v2/userinfo`; and
- posts are not fetched after resolution failure.

### 10.2 Reserved sources

- Google Trends, G2, Capterra, and default intent cannot be created/activated;
- existing rows serialize as reserved and are skipped by the scheduler;
- the dead Google Trends URL is absent from production code; and
- UI labels and contract comments name the truthful activation state.

### 10.3 Instagram

- connector registry uses Nango `instagram`, direct scopes, and the Instagram
  graph host;
- OAuth completion binds one explicit account;
- legacy rows require reconnect;
- own-account media reads through direct login;
- competitor and hashtag modes fail before provider work; and
- LinkedIn, X, Reddit, Gmail, and Meta Ads registry behavior is unchanged.

### 10.4 Tracked-account resolution

- X and LinkedIn success cache IDs;
- failure records an error without a false success timestamp;
- handle changes clear the cache;
- foreign, missing, disabled, or wrong-platform connections fail without
  leaking cross-workspace existence;
- retry uses the selected connection; and
- first source use resolves once, then uses the cache.

### 10.5 Dedupe

- deleting the canonical source promotes the oldest surviving occurrence;
- all remaining duplicates point at the promoted item;
- accepted/skipped/new state, signal link, and matches survive promotion;
- deleting only a duplicate does not alter the canonical item;
- deleting the sole occurrence removes it normally;
- the whole operation rolls back on an injected mid-transaction failure; and
- legacy dangling groups become reachable and idempotently remain repaired.

### 10.6 Verification

Before TAP-9 is complete:

```sh
npm run typecheck
npm test -- --maxWorkers=4
```

Focused tests run after every card. The full suite runs after all seven cards
and again before publication.

## 11. Founder acceptance

Founder acceptance is evidence-driven and does not require hand-checking every
internal edge:

1. Connect an approved LinkedIn account, add a tracked company by plain handle,
   run discovery, and confirm only that company's posts appear.
2. Enter an invalid LinkedIn handle and confirm the source shows a resolution
   error with no posts from the connected member.
3. Confirm Google Trends appears reserved and cannot be run.
4. Connect Instagram through direct Instagram Login and confirm the connection
   is bound to the selected professional account; confirm competitor/hashtag
   discovery is explicitly unavailable.
5. In a fixture workspace, ingest the same story from two sources, delete the
   canonical source, and confirm the surviving story, triage state, matches, and
   provenance remain reachable.
6. Add an X or LinkedIn tracked account without a provider ID and confirm the
   platform resolves it automatically or shows a retryable error.

Automated acceptance coverage supplies the destructive/race/error-path
evidence that is impractical to verify manually.

## 12. Non-goals

- Threads support.
- Unofficial scraping for Google Trends, Instagram, G2, or Capterra.
- Selecting or purchasing a paid intent-data provider.
- Public LinkedIn person-profile handle resolution.
- Sprint 60's canonical story/source occurrence schema.
- A founder-facing switch for restricted LinkedIn scopes.
- Refactoring unrelated connector, discovery, or worker architecture.
