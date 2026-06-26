# Spec: Sprint 30 — RAG Hardening for Scale

> Status: **planned** (spec for founder review — nothing built yet).
> Roadmap: `docs/plans/sprint-guide-21-onward.md` → **Sprint 30 (U7)**, "RAG hardening for scale."
> **Branch:** `sprint-30-rag-hardening`, cut from `main`.
> **Merge order:** none. Builds on Sprint 9 (RAG / R2R) and Sprint 10 (learning loop), both already on `main`; the "Builds on" line names no 21+ sprint, so this branches directly off `main` with no predecessor merge required.
> **Size:** M–L. Delivered as **two founder-accepted slices on one branch** (A then B); no new slice until the previous is accepted.

---

## Goal

Keep retrieved context **sharp and trustworthy** as the evidence corpus grows from a handful of pasted documents into a continuously-fed pool. Today's RAG (Sprint 9) is solid but minimal: evidence is only ever pasted by hand, retrieval is a fixed top-5 similarity search, workspace isolation is a document-id filter, and the evidence section is dropped whole when the token budget is tight. This sprint hardens all four of those for scale, behind the existing `EvidenceStore` boundary.

## Decisions locked with the founder (2026-06-23)

These reshape the roadmap line; they are the source of truth for this spec.

1. **Per-workspace isolation → real R2R collections.** Migrate off the `document_id $in [...]` filter (which Sprint 9 used as a deliberate stopgap) to one R2R collection per workspace.
2. **Ingest → founder-gated queue.** Accepted signals and published content are proposed as *candidates*; **nothing enters the corpus without founder approval.** The roadmap's "corpus grows from signals automatically" acceptance line is consciously reframed to **"candidates appear automatically; the founder accepts them into the corpus."**
3. **"Citations QA" → retrieval-quality inspection.** A per-generation view of the retrieval query, the candidate chunks, their scores (similarity / recency / source weight / final), and which were kept vs dropped. **Not** output `[n]`-marker verification.
4. **Candidate eligibility → every signal + every successfully published post.** Liberal producer; the gate does the curation.
5. **Structure → one branch, two slices.**
   - **Slice A — Feed & isolate:** R2R collections + backfill, founder-gated ingest queue, document provenance.
   - **Slice B — Sharpen & inspect:** retrieval re-ranking (recency + source weight + dedupe), budget-aware retrieval in the resolver, retrieval-quality inspection view.

## What this slice does

A worker sweep continuously proposes the workspace's signals and shipped posts as **evidence candidates**. The founder reviews them on the evidence page and accepts the good ones; accepting ingests the text into the workspace's own R2R **collection**, tagged with its origin and original date. When a task is resolved, Tuezday over-fetches candidate chunks from that collection, **re-ranks** them by similarity + recency + source weight, **dedupes**, and hands the resolver an ordered list; the resolver keeps **as many top chunks as fit the token budget** instead of dropping evidence wholesale. Every generation stores the full retrieval trace, and a new **Evidence retrieval** panel lets the founder inspect exactly what was retrieved, how it scored, and what was kept.

## Out of scope (YAGNI)

- Editable retrieval weights UI (weights are fixed, sensible defaults in `packages/contracts` this sprint; making them Sprint-21-style per-scope editable is a later slice).
- Output-citation verification (checking that `[n]` markers in generated text map to real sources) — the founder chose retrieval-quality inspection instead.
- Auto-accepting candidates / scheduled auto-ingest — ingestion stays founder-gated.
- URL / file scraping for evidence — sources are still text only (pasted, or signal/published text).
- Graphiti / Mem0, the app-DB Postgres swap, cross-workspace or shared corpora — all remain deferred.
- Re-proposing an already-decided candidate when its underlying source changes (a candidate is proposed once per source; see "Known limitations").

---

## Architecture & boundary

Unchanged top-level contract: **R2R owns parsing, chunking, embedding, and similarity search; Tuezday owns the evidence vocabulary, ingest policy, retrieval policy (now including re-ranking + budget), and the inspection UI.** Everything new lives on the Tuezday side of the `EvidenceStore` interface (`apps/api/src/evidence/store.ts`) or in `packages/brain` / `packages/contracts`. The worker continues to touch HTTP only; the API owns all DB access.

### Code seam recap (current state)

- All six generating routes — `generations`, `pr`, `outbound`, `personas`, `signals`, `ad-creatives` — call `retrieveEvidence(...)` (fixed limit 5, `services/evidence.ts`) **before** `resolveContext(...)` (`packages/brain/src/resolver.ts`), then pass the evidence into the resolver.
- `resolveContext` already owns the **token budget** (`DEFAULT_TOKEN_BUDGET` from contracts) and drops the *whole* `evidence` section when over budget. `estimateTokens` is exported from `packages/brain`.
- This sprint changes the *internals* of `retrieveEvidence` and `resolveContext`; the six call sites are unchanged (Slice B keeps them compiling by extending types, not call shapes).

---

## Data model changes

All via `npm run db:generate -w apps/api` after editing `apps/api/src/db/schema.ts`. Keep Postgres-portable (no SQLite-only types).

### New table — `evidence_collections` (Slice A)

One row per workspace, mapping it to its R2R collection. Kept out of the core `workspaces` table to keep evidence concerns isolated.

| column | type | notes |
|---|---|---|
| `workspaceId` | text, PK, FK→workspaces (cascade) | one collection per workspace |
| `r2rCollectionId` | text, not null | the R2R collection id |
| `createdAt` | integer, not null | |

### New table — `evidence_candidates` (Slice A)

| column | type | notes |
|---|---|---|
| `id` | text, PK | |
| `workspaceId` | text, FK→workspaces (cascade) | |
| `kind` | text, not null | `signal` \| `published` |
| `sourceRef` | text, not null | originating `signals.id` or `publications.id` |
| `title` | text, not null | derived (see producer) |
| `content` | text, not null | the text that will be ingested if accepted |
| `sourceCreatedAt` | integer, not null | original signal/publication time (for recency) |
| `status` | text, not null, default `pending` | `pending` \| `accepted` \| `dismissed` |
| `evidenceDocumentId` | text, nullable | set on accept (links to the created doc) |
| `createdAt` | integer, not null | |
| `decidedAt` | integer, nullable | |

- **Unique index** on `(workspaceId, kind, sourceRef)` — the sweep is idempotent and never re-proposes a source.

### Altered table — `evidence_documents` (Slice A)

Add provenance:

| column | type | notes |
|---|---|---|
| `kind` | text, not null, default `manual` | `manual` \| `signal` \| `published` |
| `sourceRef` | text, nullable | originating signal/publication id for non-manual docs |
| `sourceCreatedAt` | integer, nullable | original source time; manual docs fall back to `createdAt` for recency |

### Contracts (`packages/contracts`)

- `EVIDENCE_KINDS = ['manual','signal','published']` + `EvidenceKind` (enum vocabulary lives only here, per the repo rule).
- `evidenceCandidateSchema`, `createEvidenceCandidate` derivation types, candidate-decision response.
- Extend the evidence/trace types (Slice B). The resolver's `EvidenceChunk` (currently `{ text, score, documentId, title }`) is **widened in place** to `{ text, title, documentId, kind, score, recencyScore, sourceWeight, finalScore, kept, exclusionReason? }`. Keep the existing `score` field as the R2R similarity (no rename, lowest churn) and add the new fields; existing call sites that read `text`/`title`/`score` keep working.

---

## Behavior — Slice A (Feed & isolate)

### A1. R2R collections on the `EvidenceStore` boundary

Extend the interface (`apps/api/src/evidence/store.ts`):

```ts
export interface EvidenceStore {
  health(): Promise<EvidenceStoreHealth>;
  ensureCollection(workspaceId: string): Promise<string>;        // idempotent → r2rCollectionId
  addDocument(input: AddDocumentInput & { collectionId: string }): Promise<string>;
  deleteDocument(documentId: string): Promise<void>;
  search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]>;
}
```

R2R v3 REST wiring (`apps/api/src/evidence/r2r.ts`) — **confirm exact request bodies against R2R v3 docs at build time** (`https://r2r-docs.sciphi.ai/documentation/collections`; `/v3/collections` is confirmed to exist):

- `ensureCollection`: look up our `evidence_collections` row first; if present, return it. Otherwise `POST /v3/collections` `{ name: workspaceId, description }` → store + return the new collection id. Treat "already exists" as success.
- `addDocument`: ingest as today (`POST /v3/documents`, raw_text, `ingestion_mode: fast`), then `POST /v3/collections/{collectionId}/documents/{documentId}` to attach. Treat duplicate-attach as success.
- `search`: `POST /v3/retrieval/search` scoped by collection via `search_settings.filters` (`{ collection_ids: { $overlap: [collectionId] } }`) **replacing** the `document_id $in` filter. (Confirm the exact filter key; fall back to `collection_ids` in `search_settings` if filters differ.)
- `deleteDocument`: unchanged (`DELETE /v3/documents/{id}`).

The fake store used in tests implements `ensureCollection` (returns a stable fake id per workspace) and collection-scoped `search`.

### A2. Backfill (idempotent)

On API boot (and re-runnable as a tiny internal routine), for every workspace that has `ready` evidence documents: `ensureCollection`, then attach each existing `r2rDocumentId` to the collection (duplicate-attach = success). Degrade gracefully if R2R is down — log and let the next boot retry; never crash boot. No new migration data needed beyond the `evidence_collections` rows it creates.

### A3. Ingest candidate producer (the sweep)

New endpoint `POST /workspaces/:id/evidence/candidates/sweep` (worker-invoked). For the workspace, insert a `pending` candidate for every eligible source **not already present** in `evidence_candidates` (the unique index makes this a safe upsert/ignore):

- **Signals** (`kind='signal'`): every row in `signals`. `content` = `signals.content`; `title` = `"Signal — {source} — {YYYY-MM-DD}"` (from `signals.source` + `createdAt`); `sourceCreatedAt` = `signals.createdAt`; `sourceRef` = `signals.id`.
- **Published posts** (`kind='published'`): every `publications` row with `status='published'`. `content` = the published draft's `drafts.content` (join `publications.draftId`); `title` = `publications.title`; `sourceCreatedAt` = `publications.publishedAt ?? scheduledFor`; `sourceRef` = `publications.id`.

Returns a small summary `{ signal: { proposed }, published: { proposed } }`. Pure DB work; never calls R2R (ingestion happens only on accept).

### A4. Ingest candidate consumer + provenance

- `GET /workspaces/:id/evidence/candidates?status=pending` — newest first; default `pending`.
- `POST /workspaces/:id/evidence/candidates/:cid/accept` — ingest the candidate's `content` into the workspace collection via the existing `addEvidence` service path, **stamping** `kind`, `sourceRef`, `sourceCreatedAt`; mark the candidate `accepted` and set `evidenceDocumentId`. `503 evidence_store_unavailable` if R2R is down (candidate stays `pending`, nothing lost). Decide-twice → `409`.
- `POST /workspaces/:id/evidence/candidates/:cid/dismiss` — mark `dismissed`. Decide-twice → `409`.
- `addEvidence` (`services/evidence.ts`) gains optional `{ kind, sourceRef, sourceCreatedAt, collectionId }`; manual uploads keep defaulting to `kind='manual'`. It now `ensureCollection`s and passes `collectionId` to `store.addDocument`.

### A5. Worker

Add an evidence-candidate sweep to the worker tick (`apps/worker/src/index.ts`), mirroring discovery/synthesis: for each workspace, `POST .../evidence/candidates/sweep`; log `proposed` counts; failures log and retry next tick. New env `EVIDENCE_SWEEP_MIN` (default 30). Fold into the existing `tick()` or add a parallel interval — match the file's existing style.

### A6. Web (`/workspaces/[id]/evidence`)

- A **Candidates** tab/section: pending candidates (kind badge, title, source date, content preview) with **Accept** / **Dismiss**. Empty state explains the sweep proposes signals + published posts.
- The existing documents list shows an **origin tag** per row (`Manual` / `From signal` / `From published`).

### Slice A founder acceptance gate

1. Have at least one signal and one published post. Run the worker (or `POST …/candidates/sweep`) → both appear as **pending candidates**, each only once even after repeated sweeps.
2. Accept one → it appears in the evidence documents list tagged by origin and is retrievable; the R2R collection for the workspace now contains it. Dismiss one → it leaves the queue and is never re-proposed.
3. Stop R2R, try to accept → candidate stays pending with a clear "store unavailable" message; nothing is lost. Restart R2R, accept succeeds.
4. Existing (pre-sprint) pasted documents still retrieve correctly (backfill attached them to the collection).

---

## Behavior — Slice B (Sharpen & inspect)

### B1. Retrieval re-ranking (`services/evidence.ts`)

Replace the fixed top-5 with **over-fetch → re-rank → dedupe → top-N**:

1. **Over-fetch:** ask the store for `OVER_FETCH = 15` candidates (collection-scoped).
2. **Pre-filter:** keep raw similarity ≥ `SCORE_FLOOR` (0.35, unchanged).
3. **Score each chunk:** `finalScore = w_sim·similarity + w_rec·recencyScore + w_src·sourceWeight(kind)`, with
   - `w_sim = 0.60`, `w_rec = 0.25`, `w_src = 0.15` (sum to 1).
   - `similarity` = the chunk's R2R `score` ∈ [0,1].
   - `recencyScore = 0.5 ^ (ageDays / HALF_LIFE_DAYS)`, `HALF_LIFE_DAYS = 90`, `ageDays = max(0, (now − sourceCreatedAt)/day)`. The doc's `sourceCreatedAt` (or `createdAt` for manual) is looked up by joining the returned `documentId` back to `evidence_documents`.
   - `sourceWeight(kind)`: `manual = 1.0`, `published = 0.8`, `signal = 0.6`.
4. **Dedupe:** sort by `finalScore` desc, greedily select while skipping a chunk if (a) we already hold `PER_DOC_CAP = 2` chunks from its `documentId`, or (b) its normalized token-set Jaccard ≥ `0.9` against an already-selected chunk. Stop at `KEEP_MAX = 8`.
5. Return the ordered, scored chunk list (best first) — **not** truncated to a render budget here; the resolver applies the token budget (B2).

All constants live in `packages/contracts` (with the weights), so they're inspectable and one step from being made editable later. `composeRetrievalQuery` is unchanged.

### B2. Budget-aware retrieval in the resolver (`packages/brain/src/resolver.ts`)

Replace the **all-or-nothing** evidence drop with **per-chunk trimming**:

- The resolver receives the ordered chunk list. After laying out the protected sections, it adds evidence chunks **one at a time, in rank order, while the included bundle stays ≤ token budget.** Chunks that don't fit are marked excluded with reason `"dropped to fit the token budget"`; chunks kept are rendered with their `[n]` citation as today.
- Evidence remains the lowest-priority layer (still sacrificed before protected sections), but now degrades **chunk-by-chunk** instead of vanishing entirely. If zero chunks fit, the section reads as excluded for budget (distinct from "no evidence retrieved").
- The stored section trace records, per chunk, `{ score, recencyScore, sourceWeight, finalScore, kept, exclusionReason? }` (where `score` is the R2R similarity) so the inspection view (B3) is purely a render of stored data.
- `estimateTokens` (already exported) is reused; no new budget machinery.

### B3. Retrieval-quality inspection view

- Generations already persist their full section trace in `generations.sectionsJson`. With B1/B2, the evidence section now carries the composed query and per-chunk scoring + kept/dropped. **No new endpoint** — the data rides the existing stored trace.
- **Web:** on a generation's trace (sandbox output and the approval/draft view), an **"Evidence retrieval"** panel:
  - the composed retrieval query,
  - a row per candidate chunk: source title + origin badge, `similarity / recency / source / final` scores, **Kept** or **Dropped (budget)**, and the chunk text (collapsible).
  - Sorted by `finalScore` desc (i.e., the order the resolver considered them).
- The same render works anywhere a stored evidence trace exists (outbound/pr/etc.) since it reads the section JSON.

### Slice B founder acceptance gate

1. Generate with a corpus containing both old and fresh evidence → the **Evidence retrieval** panel shows the query, every candidate chunk with its four scores, and which were kept; fresher / higher-source-weight evidence ranks above stale low-weight matches.
2. Two chunks from the same long document → at most two appear (per-doc cap); a near-duplicate paste is deduped.
3. Force a tight token budget (long brain docs / large signal) → evidence degrades **chunk-by-chunk** (some kept, rest "Dropped (budget)") rather than the whole section disappearing; the trace explains each drop.
4. The generation's stored trace reproduces the panel exactly (inspectable after the fact).

---

## Step-by-step implementation plan

Tests are written **before/with** each behavioral change; `npm test` and `npm run typecheck` stay green at every commit. Order is bottom-up (contracts/db → store → services → resolver → routes → worker → web).

### Slice A — Feed & isolate

1. **Contracts:** add `EvidenceKind` + `EVIDENCE_KINDS`, `evidenceCandidateSchema`, candidate decision/response types. Unit-test schema validation.
2. **Schema + migration:** add `evidence_collections`, `evidence_candidates` (+ unique index), and the three `evidence_documents` columns. `npm run db:generate`. Confirm migration applies in the in-memory test DB.
3. **`EvidenceStore` interface + fake:** add `ensureCollection`, collection-aware `addDocument`/`search`. Update the in-test fake first; write store-contract tests (idempotent ensure, collection-scoped search filter shape).
4. **R2R client:** implement `ensureCollection`, collection attach in `addDocument`, collection-scoped `search`. Request-shape tests against the fixture fetcher (collection create body, attach path, search filter); duplicate-create/attach treated as success.
5. **`addEvidence` provenance + collection:** thread `{ kind, sourceRef, sourceCreatedAt }`, `ensureCollection` + pass `collectionId`. Tests: manual upload defaults to `kind='manual'` and lands in the collection.
6. **Candidate producer service + sweep endpoint:** eligibility (every signal + every `published` publication), idempotent insert, title/content/`sourceCreatedAt` derivation. Tests: producer proposes each source once across repeated sweeps; published pulls draft content; correct `sourceCreatedAt`.
7. **Candidate consumer endpoints:** list (pending first), accept (ingest + stamp + link + 409 on re-decide + 503 when store down), dismiss (+409). Tests with fake store for each path.
8. **Backfill routine:** idempotent ensure-collection + attach existing docs on boot; graceful when store down. Test the routine directly (fake store).
9. **Worker:** evidence-candidate sweep on tick + `EVIDENCE_SWEEP_MIN`. Verify via the API surface (sweep endpoint) as the worker is HTTP-only.
10. **Web:** Candidates tab (accept/dismiss, empty state) + origin tags on the documents list. Component/render test.
11. **Slice A verification:** full `npm test` + `npm run typecheck`; walk the Slice A founder gate; pause for founder acceptance.

### Slice B — Sharpen & inspect

12. **Contracts:** widen the retrieved-chunk/trace type (`similarity/recencyScore/sourceWeight/finalScore/kept/exclusionReason`); add the re-rank constants + weights. Schema/exports tests.
13. **Re-ranking in `retrieveEvidence`:** over-fetch, score (recency decay + source weight), dedupe (per-doc cap + Jaccard), top-N. Pure-function unit tests: recency breaks ties, source weight ordering, per-doc cap, near-dup removal, score floor.
14. **Budget-aware resolver:** per-chunk trim in `resolveContext`; per-chunk kept/dropped trace; protected sections untouched. Resolver unit tests: keeps top chunks to fit, partial-keep vs whole-drop, "no chunks fit" reason, ordering preserved.
15. **Route glue:** ensure the six call sites still compile/behave (type widening only; no call-shape change). Existing route tests stay green; add an assertion that the enriched trace is persisted on generations.
16. **Web inspection panel:** render the stored evidence trace (query + per-chunk scores + kept/dropped) on the generation trace / approval view. Render test from a fixture trace.
17. **Slice B verification:** full `npm test` + `npm run typecheck`; walk the Slice B founder gate; pause for founder acceptance.

---

## Automated verification (test inventory)

- **Contracts:** evidence-kind enum; candidate schema; widened chunk/trace schema; re-rank constants present.
- **EvidenceStore / R2R client:** `ensureCollection` idempotency; collection-create & attach request shapes; collection-scoped search filter; duplicate-create/attach = success; health failure mapping (unchanged).
- **Retrieval policy (pure unit):** scoring formula; recency decay; source weighting; per-doc cap; near-duplicate dedupe; score-floor pre-filter; deterministic ordering.
- **Resolver:** budget-aware per-chunk trim (keeps top N to fit, drops rest with reason, never drops protected sections, "none fit" vs "no evidence" distinct); citation rendering unchanged for kept chunks.
- **API (fake store):** sweep idempotency + eligibility (signals + published only, draft content joined, correct `sourceCreatedAt`); accept ingests with provenance into the collection; accept 503 when store down (candidate preserved); dismiss; double-decide 409; candidate list ordering; backfill routine; manual upload still defaults `kind='manual'`.
- **Web:** candidates tab accept/dismiss + empty state; origin tags; evidence-retrieval inspection panel renders scores + kept/dropped from a fixture trace.

## Known limitations (intentional, documented)

- A candidate is proposed **once per source**; if the underlying signal/publication text later changes, it is not re-proposed (the unique index prevents duplicates). Acceptable for this sprint.
- Retrieval weights and the recency half-life are fixed defaults (not per-workspace editable) — a natural follow-on once Sprint-21-style scoped guidance is generalized.
- R2R collection semantics (exact filter key, duplicate-attach behavior) are confirmed at build time against R2R v3 docs; the boundary is designed so only `r2r.ts` changes if the payload differs.

## Founder acceptance checklist (sprint gate = both slices)

- **Slice A:** signals + published posts surface as pending candidates (once each); accept → tagged, retrievable, in the workspace collection; dismiss → gone for good; store-down accept is safe; pre-existing docs still retrieve.
- **Slice B:** the Evidence retrieval panel shows query + four scores + kept/dropped; fresher/higher-weight evidence ranks higher; per-doc cap + dedupe hold; tight budgets degrade evidence chunk-by-chunk, not all-or-nothing.

---

## Progress log

- 2026-06-23 — Spec drafted; founder locked the five decisions above.
- 2026-06-23 — Branch `sprint-30-rag-hardening` cut from `main`; `npm install` in the main repo; green baseline (518 tests).
- 2026-06-23 — **Slice A built & green.** Contracts (evidence kinds + candidate schema), migration `0018_lame_chameleon.sql` (evidence_collections, evidence_candidates, provenance columns), `EvidenceStore` collections (createCollection / attachDocument / collection-scoped search) + R2R client, founder-gated candidate producer/consumer, boot backfill, worker `EVIDENCE_SWEEP_MIN` tick, Evidence page (Candidates section + origin tags). `npm test` + `npm run typecheck` green (531 tests).
- 2026-06-23 — **Slice B built & green.** Widened `EvidenceChunk`; `RETRIEVAL` policy + pure `rankEvidenceChunks` (over-fetch → recency/source re-rank → per-doc cap + Jaccard dedupe → top-N); budget-aware per-chunk trimming in `resolveContext` with a per-chunk trace; sandbox **Evidence retrieval** inspection panel. `npm test` + `npm run typecheck` green (540 tests).
- 2026-06-23 — Founder-acceptance section appended to `docs/founder-acceptance-tests.md`.
- **Notes / minor deviations from the spec, by design:**
  1. Retrieval constants live in `apps/api/src/services/evidence.ts` beside the existing `SCORE_FLOOR` / `QUERY_EXCERPT_CHARS` (one consistent place) rather than in `packages/contracts` — still one step from per-workspace editable.
  2. Workspace→collection idempotency is owned in the service (`ensureWorkspaceCollection` + `evidence_collections`); the store only does the raw R2R create — faithful to the spec's intent, with a cleaner boundary.
  3. Web has no test project in this repo (suites are contracts/api/brain); the UI is covered by `typecheck` + the manual founder-acceptance script, as in every prior sprint (e.g. Sprint 18).
  4. R2R collection request/response shapes are coded to the v3 docs and exercised via the fake store + request-shape unit tests; confirm against a live R2R during acceptance (`npm run r2r:up`).
- **Pending:** founder review + manual acceptance of Slice A then Slice B; founder merges to `main`.
