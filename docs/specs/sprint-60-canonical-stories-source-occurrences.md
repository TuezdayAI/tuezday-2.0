# Sprint 60 — Canonical Stories & Source Occurrences

**Branch:** `sprint-60-canonical-stories` · **Plane epic:** TAP-19 · **Size:** XL

Implements §8.1–§8.4 of the approved design
`docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
(the design doc is the model authority — this spec is the delivery plan, not a
re-plan). PRD reference: `docs/plans/prd-agentic-platform.md` §6, Phase K.

## 0. Branch and merge order

Sprint 60 "Depends on: 49, 50". Both are on `main` (Sprint 49 bounded/leased
jobs via PR #19–20 lineage; Sprint 50 provider repair + non-destructive dedupe
merged at `7cf4e41`). `origin/main` additionally contains Sprint 53. This
branch therefore forks directly off `origin/main` (`67da934`) and has **no
dependency on the unmerged 56–59 branches** — nothing here touches the gateway,
tool registry, structured output, or routing/budget work. It can merge before
or after them without conflict beyond trivial schema-file adjacency.

## 1. Scope in one paragraph

Discovery today stores one mutable row per fetched item (`discovered_items`)
and hides cross-source copies behind a destructive-ish `duplicateOfId` status.
This sprint adds the durable intelligence layer **in shadow, alongside** that
flow: every fetched item is also recorded as an immutable
`discovery_source_occurrences` row inside the same ingest transaction;
occurrences resolve — by exact identity keys only — into workspace-owned
`canonical_external_stories` with reversible `story_occurrences` membership and
versioned, deterministic `story_enrichments`. Existing behavior does not
change: `discovered_items` remains the triage surface, `signals` remain the
manual-input and legacy-compatibility seam. A read-only **Stories** page
(child of Discover in the nav) makes the shadow layer visible to the founder.

### Invariants (from the design doc + TAP-19 epic)

1. Occurrences are immutable — no update path exists in any service.
2. Source deletion/archival never destroys occurrences, stories, or provenance.
3. JSON columns hold snapshots and provider payloads only — never fields
   required for joins, filtering, capacity enforcement, or uniqueness.
4. Membership is reversible: merge/split never deletes rows; manual changes
   carry actor and reason.
5. Exact dedupe only: identical identity keys always converge (100% recall on
   exact fixtures); nothing merges on fuzzy similarity — ambiguous stays
   separate rather than guessed (design §15 step 3).
6. All new tables are workspace-scoped and guarded by the same membership rule
   as every other `/workspaces/:id/...` route.

## 2. Founder decisions recorded

- **D-60.1 Shadow only.** No behavior change to discovered-items triage,
  accept→signal, matching, or automation. Cutover is Sprints 61+.
- **D-60.2 Exact identity only in this sprint.** The `similarity` relationship
  kind is used solely for exact content-fingerprint equality (the same
  `hashContent` rule Sprint 45 already treats as duplicate identity), recorded
  with confidence 90 so it is distinguishable from URL/provider identity.
  Embedding/LLM clustering is deferred (design: reversible cluster candidates
  come later; exact-first is Phase 3's exit-gate requirement).
- **D-60.3 `redirect` kind reserved.** The vocabulary includes it (design
  §8.3) but nothing emits it yet — adapters do not currently expose the
  post-redirect final URL. Emitting it becomes possible when safe-fetch
  surfaces final URLs; the enum ships now so the vocabulary is defined once.
- **D-60.4 Enricher v1 is deterministic** (no LLM): corroboration count,
  source spread, observation window, title variants. LLM enrichment (topics,
  entities, safety flags) arrives with the matcher work in Sprint 61+.
- **D-60.5 Backfill is founder-triggered** (`POST .../stories/backfill`),
  idempotent, and synchronous per workspace — not a worker loop. Current
  workspaces have at most thousands of items; a bounded in-transaction pass
  is simpler than a lease-managed job for a one-time shadow migration
  (design §15 step 3).

## 3. Domain model

All five tables are new; no existing table changes. Next migration index: 0063.

### 3.1 `discovery_source_occurrences` (§8.1)

Immutable record of what one source exposed at one time.

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `sourceId` | text NOT NULL, **no FK** | occurrences must survive source deletion; precedent: `duplicateOfId`, `connectionId` |
| `sourceType` | text NOT NULL | identity snapshot (`DISCOVERY_SOURCE_TYPES`) |
| `sourceName` | text NOT NULL | identity snapshot |
| `fetchRunId` | text, nullable, no FK | `discovery_jobs.id` of the fetch attempt; null for backfilled rows |
| `providerExternalId` | text NOT NULL | adapter `externalId` |
| `title` | text NOT NULL | |
| `url` | text NOT NULL | as observed |
| `excerpt` | text NOT NULL default `""` | adapter summary (≤600 chars already) |
| `author` | text, nullable | adapters don't emit it yet; column exists so future adapters need no migration |
| `providerPublishedAt` | integer, nullable | |
| `observedAt` | integer NOT NULL | ingest time (backfill: item `createdAt`) |
| `normalizedUrlKey` | text, nullable | `hashUrl(url)` — reuses the Sprint 45 normalizer verbatim |
| `contentFingerprint` | text NOT NULL | `hashContent(title, excerpt)` |
| `rawMetadataJson` | text NOT NULL default `"{}"` | bounded (≤4 KB, truncated marker beyond) — snapshot only, never joined/filtered |
| `createdAt` | integer NOT NULL | |

Unique: `(sourceId, providerExternalId)` — the same idempotency key as
`discovered_items`, so re-fetch and re-backfill are no-ops.
Index: `(workspaceId, observedAt)` for listing.

### 3.2 `canonical_external_stories` (§8.2)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `status` | text NOT NULL default `"active"` | `STORY_STATUSES = active \| archived` |
| `canonicalUrl` | text NOT NULL | from the founding occurrence |
| `title` | text NOT NULL | from the founding occurrence (stable; variants live in enrichment) |
| `contentFingerprint` | text NOT NULL | founding occurrence's fingerprint |
| `firstObservedAt` / `lastObservedAt` | integer NOT NULL | maintained on every attach |
| `currentEnrichmentVersion` | integer NOT NULL default 0 | bumps when a new enrichment row lands |
| `mergedIntoStoryId` | text, nullable, no FK (self-ref) | set when archived by a manual merge |
| `archivedAt` | integer, nullable | |
| `createdAt` / `updatedAt` | integer NOT NULL | |

"Watch" state (design "archive/watch") is deliberately **not** modeled here —
watch/dismiss is an opportunity-lifecycle concern and lands with
`campaign_opportunities` in Sprint 61.

Index: `(workspaceId, status, lastObservedAt)`.

### 3.3 `canonical_story_keys` (§8.2 child identity table)

Exact identity. One story may hold several keys; a key belongs to exactly one
story per workspace.

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `storyId` | text NOT NULL → stories cascade | |
| `keyKind` | text NOT NULL | `STORY_KEY_KINDS = provider_id \| normalized_url \| content_fingerprint` |
| `keyHash` | text NOT NULL | see derivations below |
| `createdAt` | integer NOT NULL | |

Unique: `(workspaceId, keyKind, keyHash)`. Index: `(storyId)`.

Key derivations from an occurrence:

- `provider_id` → `sha256(sourceType + "|" + providerExternalId)` — provider
  IDs are namespaced by provider type, not by source row, so the same HN story
  from two HN sources converges.
- `normalized_url` → `hashUrl(url)` (skipped when null).
- `content_fingerprint` → `hashContent(title, excerpt)`.

Resolution priority: `provider_id` > `normalized_url` > `content_fingerprint`.
First hit wins; remaining keys are inserted with `onConflictDoNothing` — if a
key already belongs to a *different* story we do not auto-merge stories
(ambiguity stays separate rather than guessed).

### 3.4 `story_occurrences` (§8.3)

Reversible membership. Never deleted; a detach closes the row.

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `storyId` | text NOT NULL → stories cascade | |
| `occurrenceId` | text NOT NULL → occurrences cascade | |
| `relationshipKind` | text NOT NULL | `STORY_OCCURRENCE_RELATIONSHIP_KINDS = exact \| redirect \| provider \| similarity \| manual` |
| `confidence` | integer NOT NULL | 0–100; founding/exact/provider = 100, similarity = 90, manual = 100 |
| `matcherVersion` | integer NOT NULL default 1 | `STORY_MATCHER_VERSION = 1` (exact-key resolver) |
| `attachedAt` | integer NOT NULL | |
| `attachedByUserId` | text, nullable | null = system resolver |
| `attachReason` | text, nullable | required for manual attaches |
| `detachedAt` | integer, nullable | set on merge-away/split; row retained |
| `detachedByUserId` | text, nullable | |
| `detachReason` | text, nullable | |

Partial unique: `(occurrenceId) WHERE detachedAt IS NULL` — exactly one active
membership per occurrence (same partial-unique technique as
`discovery_jobs_one_active_source`). Index: `(storyId, detachedAt)`.

Kind mapping in the resolver: matched via `provider_id` key → `provider`; via
`normalized_url` → `exact`; via `content_fingerprint` → `similarity`; founding
membership of a new story → `exact` @ 100; merge/split re-attaches → `manual`
with actor + reason.

### 3.5 `story_enrichments` (§8.4)

Immutable, versioned enrichment output.

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `storyId` | text NOT NULL → stories cascade | |
| `storyFingerprint` | text NOT NULL | sha256 over the sorted `contentFingerprint`s of active members — changes iff membership content changes |
| `enricherVersion` | integer NOT NULL | `STORY_ENRICHER_VERSION = 1` |
| `corroborationCount` | integer NOT NULL | distinct `sourceId`s among active members — real column (filtering/quality gates later), per the no-JSON-for-filterable-fields invariant |
| `payloadJson` | text NOT NULL default `"{}"` | `{ occurrenceCount, distinctSourceTypes, earliestObservedAt, latestObservedAt, titleVariants (≤5) }` |
| `createdAt` | integer NOT NULL | |

Unique: `(storyId, storyFingerprint, enricherVersion)` (§8.4 verbatim) —
re-running the enricher on unchanged membership is a no-op; membership change
produces a *new* row and bumps `stories.currentEnrichmentVersion`; old rows
are retained.

## 4. Service design — `apps/api/src/services/canonical-stories.ts`

All writes happen inside the caller's transaction (ingest) or one service
transaction (merge/split/backfill). `hashUrl`/`hashContent` are exported from
`services/discovery.ts` (already exported for tests) and reused, not copied.

- `recordOccurrenceAndResolve(tx, input)` — insert occurrence
  (`onConflictDoNothing` on `(sourceId, providerExternalId)`; conflict → stop,
  everything downstream already exists), derive keys, look up
  `canonical_story_keys` in priority order, attach membership with the mapped
  kind (or create story + keys + founding membership), maintain
  `first/lastObservedAt`, insert missing keys with `onConflictDoNothing`,
  refresh enrichment.
- `refreshEnrichment(tx, storyId)` — compute fingerprint over active members;
  insert v1 row (`onConflictDoNothing`); bump `currentEnrichmentVersion` and
  `updatedAt` only when a row was actually inserted.
- `mergeStories(db, wsId, { storyId, intoStoryId, actor, reason })` — one
  transaction: detach every active membership of `storyId` (actor/reason),
  re-attach each to `intoStoryId` as `manual` @ 100, repoint keys
  (delete-on-conflict: the target's existing key wins), archive the source
  story with `mergedIntoStoryId`, refresh both enrichments. Merging a story
  into itself or across workspaces is a 400/404.
- `splitOccurrence(db, wsId, { occurrenceId, actor, reason })` — one
  transaction: detach the active membership, create a new story founded on the
  occurrence, move only keys **derived from this occurrence and not shared
  with any remaining active member** (conflicting keys stay with the original
  story — the operator is asserting distinctness; future ingest of that key
  still lands on the original), refresh both enrichments. If the old story is
  left with no active members it is archived (not deleted). Splitting a
  story's only occurrence therefore archives the empty shell.
- `backfillCanonicalStories(db, wsId)` — for every `discovered_items` row
  (all statuses, including `duplicate` and rows whose `duplicateOfId` dangles):
  synthesize an occurrence (`fetchRunId` null, `observedAt` = `createdAt`,
  source snapshot from the live source row, or `sourceType/'unknown'`-style
  snapshot fallbacks if the source is gone) and run the same
  `recordOccurrenceAndResolve`. Ordered by `createdAt` so founding stories
  match the "oldest is canonical" convention. Idempotent by the occurrence
  unique key. Returns `{ scanned, occurrencesCreated, storiesCreated,
  membershipsCreated }`. Duplicate groups converge naturally via shared
  url/content keys — no reading of `duplicateOfId` needed.
- Reads: `listStories(db, wsId, { status?, limit, offset })` (with occurrence
  + corroboration counts, server-paginated, default 50 / max 200),
  `getStoryDetail(db, wsId, storyId)` (story + active occurrences with
  membership metadata + detached history + latest enrichment),
  `setStoryStatus` (archive/unarchive; unarchive clears `archivedAt` but not
  `mergedIntoStoryId` history).

### Shadow wiring in `persistDiscoveryPage` (services/discovery.ts)

Inside the existing per-item loop (after the `discovered_items` insert and the
Sprint 45 canonical-item step, same transaction): call
`recordOccurrenceAndResolve` with the already-computed `urlHash`/
`contentHash`, `claim.id` as `fetchRunId`, and the in-scope source row for the
snapshot. A new fault-injection hook `afterStoryResolution` joins the existing
`DiscoveryPersistHooks` so the idempotency suite proves the whole transaction
still rolls back atomically. The existing duplicate-marking logic is
untouched — an item marked `duplicate` still records its occurrence, which is
precisely the corroboration the old model destroyed (design §6.5).

## 5. API surface — `apps/api/src/routes/stories.ts`

`registerStoryRoutes(app, db)` (no LLM/fabric deps), workspace-guarded like
every sibling:

| Method | Path | Behavior |
|---|---|---|
| GET | `/workspaces/:id/stories?status=&limit=&offset=` | paginated list `{ stories, total }` |
| GET | `/workspaces/:id/stories/:storyId` | detail: story, active occurrences (+membership), history, latest enrichment |
| PATCH | `/workspaces/:id/stories/:storyId` | `{ status }` archive/unarchive |
| POST | `/workspaces/:id/stories/:storyId/merge` | `{ intoStoryId, reason }` → merged detail |
| POST | `/workspaces/:id/stories/occurrences/:occurrenceId/split` | `{ reason }` → new story detail |
| POST | `/workspaces/:id/stories/backfill` | idempotent backfill, returns counts |

Errors follow discovery conventions: 400 `invalid_input`, 404
`workspace_not_found` / `story_not_found` / `occurrence_not_found`, 409
`story_archived` (merge into an archived target), `merge_self`.
Writes attribute `actorOf(request)`.

## 6. Contracts additions (`packages/contracts/src/index.ts`)

- `STORY_STATUSES`, `STORY_OCCURRENCE_RELATIONSHIP_KINDS`, `STORY_KEY_KINDS`,
  `STORY_MATCHER_VERSION = 1`, `STORY_ENRICHER_VERSION = 1`.
- `canonicalStorySchema` (list projection incl. `occurrenceCount`,
  `corroborationCount`), `storyOccurrenceSchema` (occurrence + membership
  metadata), `storyEnrichmentSchema` (payload parsed, not raw JSON),
  `storyDetailSchema`, `listStoriesResponseSchema`,
  `mergeStoryInputSchema`, `splitOccurrenceInputSchema`,
  `storyBackfillResultSchema`.
- Nav: add child `{ label: "Stories", path: "/stories" }` under the existing
  **Discover** item (first child — Discover keeps its top-level path).

## 7. Web — read-only Stories page

`apps/web/app/workspaces/[id]/stories/page.tsx` + module CSS, mirroring the
evidence page pattern (client component, `apiFetch`, contracts types): list of
stories (title, canonical URL, status, corroboration count, first/last seen,
occurrence count) with an expandable detail showing each occurrence's source
snapshot, relationship kind + confidence, and the enrichment summary; a
"Backfill existing items" button drives the backfill route and re-loads.
No merge/split UI this sprint (API-only operations).

## 8. Out of scope (Sprint 61+)

Campaign routing profiles and opportunities (61); similarity clustering beyond
exact fingerprints; LLM enrichment; redirect-kind emission; retiring the
accept→signal path or `discovered_items`; opportunities UI; Postgres.

## 9. Implementation plan

- **Task 1 — Contracts.** Vocabularies + zod schemas + nav child. (§6)
- **Task 2 — Schema + migration 0066.** Five tables in `schema.ts`, `npm run
  db:generate -w apps/api`, renamed to `0066_sprint_60_canonical_stories.sql`
  + journal tag update, per repo convention.
- **Task 3 — Service.** `canonical-stories.ts`: record/resolve, enrichment,
  merge, split, backfill, reads. Pure-service tests seeded with drizzle
  (convention: `discovery-dedupe.test.ts`).
- **Task 4 — Shadow ingest wiring.** `persistDiscoveryPage` + hook; extend the
  idempotency suite's `it.each` with `afterStoryResolution`.
- **Task 5 — Routes + app wiring.** `registerStoryRoutes` in `app.ts`;
  route-level tests through `buildAuthedApp` + RSS fixtures (convention:
  `discovery.test.ts`).
- **Task 6 — Web page + nav.**
- **Task 7 — Verify + docs.** `npm test`, `npm run typecheck`, progress log,
  push, Plane sync.

## 10. Acceptance criteria

1. A `/discovery/run` over an RSS fixture records one occurrence per item in
   the same transaction as the item insert; a hook-injected fault after story
   resolution rolls back items, cursor, occurrences, stories atomically.
2. The same URL fetched from two different sources yields **one** story with
   **two** occurrences whose relationship kinds reflect how each matched;
   `corroborationCount = 2`. Distinct URLs/content never converge (no false
   merges); re-running the fetch creates nothing new (exact recall + idempotency).
3. Deleting a discovery source (existing Sprint 50 path) leaves every
   occurrence, story, membership, and enrichment intact, with the source
   snapshot still readable on the occurrence.
4. Manual merge moves memberships with kind `manual`, actor, and reason;
   nothing is deleted; the merged-away story is archived with
   `mergedIntoStoryId`; split reverses it, and the closed membership rows
   remain as history.
5. Enrichment rows are immutable and unique on
   `(storyId, storyFingerprint, enricherVersion)`; a membership change
   produces a new fingerprint + row and bumps `currentEnrichmentVersion`;
   prior rows survive.
6. Backfill over seeded items (including a `duplicateOfId` group and a
   dangling duplicate) produces converged stories and is idempotent on
   re-run.
7. All story routes 404 for non-members; identical keys in two workspaces
   produce two independent stories.
8. `npm test` and `npm run typecheck` green; existing discovery suites
   unmodified except the idempotency `it.each` extension.

## 11. Risks

- **Ingest-path regression.** The shadow write lives inside the hottest
  discovery transaction. Mitigation: pure inserts + indexed key lookups, the
  existing fault-injection suite extended to the new hook, and zero changes to
  existing branches of the loop.
- **False merges via provider IDs.** RSS `guid`s are only as unique as the
  publisher makes them. Mitigation: provider keys are namespaced by source
  *type*; url/content keys corroborate; a wrong merge is reversible by split
  (the point of the reversible model).
- **Migration-file adjacency with unmerged 56–59 branches** (they also add
  tables at index 0063+). Whoever merges second regenerates/renumbers — noted
  for the founder in the PR description.

## 12. Progress log

- 2026-08-03 — Spec written; branch forked off `origin/main` (`67da934`).
- 2026-08-03 — Tasks 1–6 implemented: contracts vocabularies + schemas + nav
  child; migration `0066_sprint_60_canonical_stories`; `canonical-stories.ts`
  service (record/resolve, enrichment v1, merge, split, backfill, reads);
  shadow wiring in `persistDiscoveryPage` with `afterStoryResolution` fault
  hook; `registerStoryRoutes`; read-only `/stories` web page. `hashUrl`/
  `hashContent` extracted to `discovery-hashing.ts` (re-exported from
  `discovery.ts`) to avoid a service-import cycle.
- 2026-08-03 — Two pre-existing tests updated for additive changes:
  `nav-entry.test.ts` (Discover now has children; same-path child beats group,
  matching the Campaigns convention) and `sprint53-migrations.test.ts` (its
  migration is found by tag instead of asserted to be the journal's last
  entry). Noted: the convergence test pins original-before-copies fetch order —
  copies seen first stay as separate stories by design (no auto-merge of
  ambiguous clusters).
- 2026-08-03 — Task 7: `npm test` 2197/2197 green, `npm run typecheck` clean.
  Committed and pushed `sprint-60-canonical-stories`; awaiting founder review.
  Merge note: unmerged sprint 56–59 branches also add migrations at index
  0063+ — whichever merges second renumbers its migration.
- 2026-08-03 — Continuation audit hardened story-list pagination: malformed
  or fractional `limit`/`offset` query values now return `400 invalid_input`
  instead of reaching SQLite. Added regression coverage and re-verified the
  Sprint 60, discovery checkpoint, migration-order, and navigation suites.
  Full verification: `npm test -- --reporter=dot` 2199/2199 green and
  `npm run typecheck` clean.
