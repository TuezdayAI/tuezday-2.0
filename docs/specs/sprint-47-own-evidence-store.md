# Sprint 47 — Own the evidence store (R2R exit)

**Status:** built 2026-07-11 — all suites green; awaiting founder acceptance (migration + parity
run on the real corpus)
**Branch:** `sprint-47-own-evidence-store` (off `main` — builds on Sprints 9 and 32, both merged)
**Roadmap:** Phase G, `docs/plans/sprint-guide-21-onward.md` §Sprint 47; decision path locked in
`docs/plans/context-discovery-gap-assessment.md` ("Decision path" + "Sprint E").

> Merge note: the unmerged `sprint-41-design-layer-carousel-pipeline` branch adds new files under
> `apps/api/src/llm/` (openrouter, fallback, index) but does not modify `gateway.ts`. This sprint
> adds `embed()` to `gateway.ts` and `gemini.ts`; conflicts with 41 should be trivial or absent.
> Either merge order works.

## Goal

Replace the R2R Docker stack with a native evidence store behind the existing `EvidenceStore` seam
(`apps/api/src/evidence/store.ts`): SQLite FTS5 for lexical search, sqlite-vec for vector search,
reciprocal-rank fusion to combine them, embeddings via a new `embed()` on the LLM gateway. Then
migrate the existing corpus, cut over, and retire the Docker dependency (no more `npm run r2r:up`,
no more "R2R is not reachable" dev papercuts — evidence works wherever the SQLite file works).

## Decisions locked (gap assessment, founder-approved 2026-07-02)

1. R2R is frozen — `EvidenceStore` is the contract; nothing new is built against R2R.
2. Native store = better-sqlite3: FTS5 + sqlite-vec, RRF fusion.
3. Embeddings: new `embed()` on the LLM gateway; Gemini `gemini-embedding-001`.
4. Parity-check against R2R with a golden-query set before cutover.
5. Cut over via the `buildApp` evidence option; retire the R2R compose stack.
6. pgvector port happens at the Postgres swap (out of scope here); reranker seam only if quality
   demands (out of scope).

## What exists today (read before touching anything)

- `apps/api/src/evidence/store.ts` — the seam: `health / createCollection / addDocument /
  attachDocument / deleteDocument / search`. `search` returns `{ text, score, documentId }` where
  **score is a 0–1 similarity** — `rankEvidenceChunks` (`services/evidence.ts`) applies a 0.2
  similarity floor and blends similarity/recency/source 0.6/0.25/0.15. Whatever the native store
  returns MUST stay in that 0–1 scale or retrieval silently breaks.
- `apps/api/src/evidence/r2r.ts` — the only implementation (R2R v3 REST).
- DB (`apps/api/src/db/schema.ts`): `evidence_documents` (metadata only — **content is NOT stored
  locally**; `r2r_document_id` links to the store), `evidence_collections` (workspace →
  `r2r_collection_id`, bootstrap in `ensureWorkspaceCollection`), `evidence_candidates` (ingest
  queue — these DO hold `content` locally).
- `buildApp({ evidence })` injects the store; `server.ts` constructs `R2REvidenceStore`. Tests
  build in-file fakes (`apps/api/test/evidence.test.ts`).
- The Gemini gateway (`apps/api/src/llm/gemini.ts`) is generate-only; `LlmGateway` has no `embed`.
- Chunking/embedding/similarity are R2R's job today — owning the store means owning those too.

## Design

### 1. Gateway `embed()` (`apps/api/src/llm/gateway.ts`, `gemini.ts`)

```ts
export interface EmbedParams {
  texts: string[];               // batch; callers keep batches ≤ 100
}
export interface EmbedResult {
  embeddings: number[][];        // one vector per input text, same order
  model: string;
  provider: string;
  dimensions: number;
}
export interface LlmGateway {
  generate(params: GenerateParams): Promise<GenerateResult>;
  embed(params: EmbedParams): Promise<EmbedResult>;
}
```

- Gemini impl: `POST models/gemini-embedding-001:batchEmbedContents` with
  `outputDimensionality: 768` (768 is plenty at this corpus scale and 4× cheaper to store than
  3072; the dimension is a constant exported from the store so the vec table and the gateway
  agree). `GEMINI_EMBED_MODEL` env override, same blank-line-tolerant pattern as `GEMINI_MODEL`.
- Missing `GEMINI_API_KEY` → `GatewayError("missing_api_key")`, exactly like `generate`.
- Every existing fake gateway in tests gains a deterministic `embed` (hash of text → vector), via
  one shared helper in the test file that needs it.

### 2. `DbEvidenceStore` (`apps/api/src/evidence/db-store.ts`)

Implements `EvidenceStore` against the app's own better-sqlite3 handle (constructor takes the raw
`Database` plus an optional `LlmGateway` for embeddings).

**Drizzle tables** (edit `schema.ts`, then `npm run db:generate -w apps/api`):

```
evidence_chunks
  id            text pk
  collection_id text notnull          -- store-side scoping, matches evidence_collections.r2r_collection_id
  document_id   text notnull          -- the store's document id (returned by addDocument)
  seq           integer notnull       -- chunk order within the document
  text          text notnull
  embedding     blob                  -- Float32Array(768) | null when embeddings unavailable
  created_at    integer notnull
  index (collection_id), index (document_id)
```

`evidence_documents.r2r_document_id` keeps its column name (renaming is churn we take at the
Postgres swap); code-side the drizzle field is already generically used as "the store's id".

**Index artifacts (runtime-owned, NOT drizzle migrations):** FTS5 and vec0 are virtual tables that
drizzle cannot model. `DbEvidenceStore` creates them idempotently at construction:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_chunks_fts USING fts5(
  text, content='evidence_chunks', content_rowid='rowid'
);
-- kept in sync by the store's own insert/delete code (no triggers: all writes
-- go through DbEvidenceStore, and trigger DDL in migrations is what we're avoiding)
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vec USING vec0(
  chunk_rowid integer primary key,
  embedding float[768]
);
```

They are rebuildable indexes over `evidence_chunks` — a `reindex()` method drops and rebuilds both
(used by the migration script and available for recovery). If the `sqlite-vec` extension fails to
load on some platform, the store logs once and runs **FTS-only** (see scoring) — search still
works, nothing crashes. New dependency: `sqlite-vec` (prebuilt loadable extension, MIT).

**Chunking (ours now):** deterministic, dependency-free — split on blank lines, pack paragraphs
into ~1,200-char chunks with 150-char overlap between adjacent chunks, never split mid-sentence
when a sentence boundary exists in the window. Exported as `chunkText(content)` and unit-tested;
determinism matters because re-ingesting the same document must produce identical chunks.

**Interface mapping:**
- `createCollection(name)` → `randomUUID()` (no store-side row needed; chunks carry
  `collection_id`; `evidence_collections` keeps owning workspace → collection).
- `addDocument({ title, content, collectionId })` → docId = `randomUUID()`; chunk; embed all
  chunks in one `embed()` batch (on `GatewayError` or absent gateway: `embedding = null` for all —
  ingestion NEVER fails because embeddings are down; a later `reindex()` can backfill); insert
  chunks + FTS rows + vec rows in one transaction. Title is prepended to the first chunk's FTS
  text (titles carry retrieval signal; R2R did the same via metadata).
- `attachDocument` → no-op (documents are born in their collection; kept for interface compat and
  exercised by the backfill test).
- `deleteDocument(docId)` → delete chunks + FTS + vec rows in one transaction.
- `health()` → `{ healthy: true }` always (plus `detail: "fts-only"` when vec/extension is
  unavailable) — the whole point of the sprint: no external service to be down. The Integrations
  page health chip and `view.fabric`-style errors for evidence disappear naturally.
- `search(query, collectionId, limit)` → hybrid retrieval below.

**Hybrid retrieval + scoring (the 0–1 contract):**
1. FTS5: `SELECT rowid, bm25(evidence_chunks_fts) ...  WHERE text MATCH ?` over the collection,
   top 24 (query sanitized to bare terms OR-joined — user queries are prose, not FTS syntax).
2. Vector: embed the query (skip on gateway error → FTS-only this call), KNN over `evidence_vec`
   restricted to the collection's rowids, top 24, cosine distance.
3. Fuse with RRF (k = 60) to get the ordering.
4. **Score normalization:** the returned `score` is the chunk's **cosine similarity** mapped to
   0–1 (`(1 + cos) / 2`) when a vector was available; for FTS-only results, min–max-scale the
   BM25 scores of this result set into [0.35, 0.9] — above the 0.2 floor (a lexical match on your
   own curated corpus is meaningful) but never claiming perfect similarity. RRF only orders; the
   normalized similarity is what feeds `rankEvidenceChunks`. Both paths unit-tested against the
   floor.

### 3. Migration (`apps/api/scripts/migrate-evidence.ts`, `npm run evidence:migrate`)

One-time, run while R2R is still up (needs `R2R_BASE_URL` reachable):
1. For every `evidence_documents` row with `status = 'ready'`:
   - If an accepted `evidence_candidates` row links to it (`evidence_document_id`), re-ingest from
     the candidate's local `content` (no R2R needed).
   - Else fetch the document's chunks from R2R (`GET /v3/documents/{id}/chunks`), join them back
     into content, re-ingest natively.
2. Write the new store document id back to `r2r_document_id`; ensure the workspace's
   `evidence_collections` row points at the native collection id (create one, update the row).
3. Failures (R2R unreachable, document gone) mark the row `status = 'failed'` with a clear error —
   the founder re-adds those documents from the Evidence page; the script prints a summary table.
4. Idempotent: rows whose document id already exists in `evidence_chunks` are skipped.

### 4. Cutover + retirement

- `server.ts`: construct `DbEvidenceStore(rawDb, llm)` instead of `R2REvidenceStore`. No env
  escape hatch — the parity gate (below) is the safety, not a dual-run mode (no-compromise rule).
- `infra/r2r/compose.yaml`, `r2r:up` / `r2r:down` npm scripts, and `R2R_BASE_URL` from
  `.env.example` are deleted in the final commit, AFTER the founder has run the migration on his
  real DB. `r2r.ts` is deleted too — its only remaining consumer (the migration script) carries a
  minimal inline v3 chunk-fetch (one endpoint, ~20 lines) so the store implementation dies clean.
- `README`/docs mentions of r2r:up updated (grep sweep).

### 5. Golden-query parity gate (pre-cutover, manual, `npm run evidence:parity`)

`apps/api/scripts/evidence-parity.ts`: takes a workspace id, runs a fixed set of 12 golden queries
(committed in the script: pricing, ICP, churn, competitor, voice, launch, objection-handling, and
5 drawn from real usage) against BOTH stores on the live corpus, prints overlap@5, and flags
queries where the native store misses an R2R top-3 result. Acceptance bar: overlap@5 ≥ 0.6 average
and no query with zero overlap — below that, tune (chunk size, RRF k, FTS query building) before
cutover. This is a manual gate because it needs Docker + a real corpus; CI covers behavior with
fakes.

## Out of scope (logged, not lost)

- Hybrid zoom ranking (deferred #22) — this sprint builds the `embed()` + vec index it needs, but
  the zoom scorer swap stays behind its own trigger (docs grow past ~50 sections / trace misses).
- pgvector port — at the Postgres swap, per the decision path.
- Reranker seam — only if parity/quality demands it.
- Embedding backfill worker for docs ingested while the API key was missing — `reindex()` exists;
  scheduled backfill is a follow-up if it ever matters.

## Tests (write BEFORE the implementation they cover; all suites green before push)

`apps/api/test/db-evidence-store.test.ts` (new):
1. `chunkText`: deterministic; respects max size + overlap; single-paragraph and giant-paragraph
   edge cases; identical input → identical chunks.
2. Ingest + search round-trip on `:memory:` with a deterministic fake `embed` — a query lexically
   AND semantically near chunk A ranks it first; scores all within (0, 1].
3. Collection scoping: two collections, same text — search never leaks across.
4. Delete: document's chunks/FTS/vec rows gone; other documents unaffected.
5. FTS-only degradation: gateway throws `missing_api_key` → ingestion succeeds with null
   embeddings; search still returns scaled scores ≥ 0.35 and ≤ 0.9; `health()` reports fts-only
   detail only when vec is unavailable (not merely key-missing).
6. Score contract: every returned score survives `rankEvidenceChunks`' floor when it should
   (similarity ≥ 0.35 fixtures) — regression net for the 0–1 scale.
7. Query sanitization: quotes/AND/OR/parens in prose queries don't throw FTS syntax errors.

`apps/api/test/gateway-embed.test.ts` (new): Gemini `embed()` against a fake fetcher — request
shape (model, outputDimensionality 768, batching), response parsing, missing-key GatewayError,
provider_error on non-200.

`apps/api/test/evidence.test.ts` (existing): keep the fake-store suites (they pin the seam) and
add one wire-through suite building the app with a real `DbEvidenceStore` on `:memory:` — add
evidence via the API, search via `/resolve` with `useEvidence`, assert citations come back.

`apps/api/test/evidence-migrate.test.ts` (new): migration against a fake R2R fetcher — candidate-
backed doc re-ingests without touching R2R; manual doc pulls chunks; unreachable R2R marks failed
with summary; second run skips already-migrated rows.

## Founder acceptance

1. `docker compose down` everything / never run `r2r:up` — add an evidence document on the
   Evidence page → status `ready`, no connector-offline banner anywhere.
2. Generate with "Use evidence" on → citations appear, context trace shows evidence section with
   sensible scores.
3. `npm run evidence:migrate` on your real DB (R2R up one last time) → summary shows your existing
   documents migrated; searches still find pre-migration content.
4. `npm run evidence:parity` (before you accept the cutover) → overlap report meets the bar.
5. `infra/r2r/` and the r2r npm scripts are gone from the repo.

## Build order (checklist)

- [x] 1. Spec committed on `sprint-47-own-evidence-store`.
- [x] 2. Schema: `evidence_chunks` in `schema.ts` + generated migration committed
       (`0037_complex_ma_gnuci.sql`).
- [x] 3. Tests: `chunkText` + `DbEvidenceStore` suite (failing first).
- [x] 4. Gateway `embed()` (tests first in `gateway-embed.test.ts`), Gemini impl.
- [x] 5. `DbEvidenceStore` implementation until suite is green (FTS, vec, RRF, normalization,
       degradation paths).
- [x] 6. Wire-through suite in `evidence.test.ts` green with the real store on `:memory:`.
- [x] 7. Migration script + `evidence-migrate.test.ts`; CLI smoke-tested on a copy of the dev DB
       (R2R down → both manual docs fail cleanly with the re-add message, exit 1).
- [x] 8. Parity script (manual gate; not in CI).
- [x] 9. Cutover: `server.ts` + `buildApp` default store; retired `infra/r2r`, npm scripts,
       `r2r.ts`, `r2r-client.test.ts`; swept CLAUDE.md, evidence-page copy, resolver comment,
       founder-acceptance historical notes.
- [x] 10. Full `npm test` + `npm run typecheck` green; docs updated (sprint guide status,
       founder-acceptance-tests §47, deferred #22 cross-ref, this log).

## Progress log

- 2026-07-11 — Spec written; branch created off main (63bc999). Investigation notes: content lives
  only in R2R for manual docs (candidates hold content locally); `rankEvidenceChunks` requires 0–1
  similarity scores (floor 0.2); FTS5 confirmed available in bundled SQLite 3.53.1; sprint-41's
  unmerged gateway files are additive-only (no `gateway.ts` conflict).
- 2026-07-11 — Built. Design refinements vs the spec draft, found during TDD:
  - `LlmGateway.embed` is **optional** (`embed?:`) rather than required — 34 test files carry fake
    gateways, and the store must handle embeddings-unavailable anyway; an absent method is the
    same degradation path.
  - Vector scores are **raw cosine clamped to [0,1]**, not `(1+cos)/2` — matches the similarity
    semantics R2R reported, keeps the 0.2 floor meaningful.
  - When a chunk is hit by BOTH legs, the reported score is the **max** of the cosine score and
    the scaled lexical score — a strong exact-vocabulary match must not be undersold by a weak
    embedding (found via the wire-through test).
  - KNN noise control: results below similarity 0.05 are dropped in the store; zero query vectors
    skip the vector leg.
  - vec0 uses a **partition key** on `collection_id` (verified: scoping enforced by sqlite-vec
    itself) and `distance_metric=cosine` (distance = 1 − cos).
  - Founder migration note: the compose file is deleted on this branch; the one-time migration run
    uses your still-existing Docker containers (`docker start …`) or
    `git show main:infra/r2r/compose.yaml` if they're gone.
- Suite count after sprint: 1089 tests / 94 files (was 1072/92): +13 store, +4 embed, +5 migrate,
  +1 wire-through, −6 retired r2r-client tests, +2 elsewhere.
