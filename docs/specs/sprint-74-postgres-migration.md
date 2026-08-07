# Sprint 74 — Postgres migration

*PRD §9, Phase N · Size: XL · Risk: High · Depends on: — (see Base below)*

---

## 1. Problem

SQLite (WAL, via `better-sqlite3`) sits under every one of the 130 tables in
`apps/api/src/db/schema.ts`. `CLAUDE.md` has carried a "keep the schema
Postgres-portable" rule since Sprint 1 and `schema.ts` still opens with a
comment promising the swap. The swap has never been executed, so the rule has
never been *proven* — and each sprint that lands adds more tables under an
untested promise. Phase K (Sprints 60–63) added ~10 tables; Phase O (76–78)
added chat. The PRD's instruction is explicit: **do it before the domain model
grows further, not after.**

This is the sprint that proves the portability rule, or finds out where it was
never true.

---

## 2. Base

`CLAUDE.md` rule 1 says branch from `main`. Rule 2 says branch from a
predecessor when the sprint depends on unmerged 21+ work. Sprint 74's PRD
dependency list is empty, but a **dialect swap rewrites every migration and
every schema block**, so it collides with any unmerged sprint that touches the
schema.

At the time of writing, `origin/main` = `5dbb444` (PR #33) already contains
Sprints 71, 73, 75, 76, 77 and 78. There is no unmerged schema work left to
collide with, so **rule 1 applies cleanly**: this branch is cut from
`origin/main`.

    git checkout -b sprint-74-postgres-migration origin/main

---

## 3. Founder decisions

Asked and answered before implementation (2026-08-08):

| # | Question | Decision |
|---|---|---|
| **D-74.1** | Branch base | **`main`** — confirmed after verifying 71/73/75/76/77/78 are merged (PR #33). |
| **D-74.2** | What drives the DB in tests and local dev | **Real Postgres only**, via Docker. No PGlite, no WASM shim, no dual-dialect test path. The test suite must exercise the engine that runs in production — including real concurrency, which is exactly what the Sprint 49/73 lease and queue code depends on. Docker becomes a prerequisite for `npm test` and `npm run dev`. |
| **D-74.3** | The 82 checked-in SQLite migrations | **Fresh Postgres baseline + data-copy script.** One generated `0000_init.sql` for Postgres; the SQLite migration folder is retired, not translated. A `npm run db:migrate-to-postgres` script copies an existing `tuezday.db` across, following the `evidence:migrate` precedent from Sprint 47. |
| **D-74.4** | Live data to preserve | **None.** Dev databases only. The copy script is a convenience tool, not a production cutover instrument, and is scoped/tested accordingly. |

---

## 4. What is actually hard here (measured, not estimated)

The dialect swap is the *easy* part. Measurements taken on `origin/main@5dbb444`:

| Surface | Count | Difficulty |
|---|---|---|
| `sqliteTable` → `pgTable` | 130 | Mechanical |
| Column types in use (`text`/`integer`/`real`/`blob`) | 4 distinct | Mechanical — the portability rule held |
| `apps/worker` DB access | **0** (HTTP-only) | No work |
| `apps/web` DB access | **0** | No work |
| Genuinely SQLite-only code sites | 3 kinds | Small, contained |
| **Non-awaited query call sites** | **1,142** | **The sprint** |
| **Exported *sync* service functions** | **706** across 142 files | **The sprint** |
| Sync `db.transaction(tx => …)` callbacks | 67 | Cutover-only, cannot be pre-staged |
| Test files to convert | 212 (`apps/api/test`) | Bulk mechanical |
| Blast radius | 74K LOC src + 67K LOC test | — |

`better-sqlite3` is a **synchronous** driver; `node-postgres` is asynchronous.
Every query site must be awaited, which makes its enclosing function `async`,
which makes *its* callers `async` — a viral cascade through 142 service files,
67 route files and 212 test files. That cascade, not the DDL, is why this
sprint is XL and High risk.

### 4.1 The probe that shapes the plan

Run against the real installed `drizzle-orm@0.44.7` + `better-sqlite3@12`:

```
1. await builder (no .all()):      []            → WORKS
2. await .all():                   []            → WORKS
3. after awaited .run() insert:    [{"id":"x"}]  → WORKS
4. ASYNC transaction callback:     REJECTED — "Transaction function cannot return a promise"
5. final rows:                     [{"id":"x"},{"id":"y"}]
```

Three findings, each load-bearing:

- **Drizzle query builders are `PromiseLike` on every dialect.** `await`ing a
  builder works today on SQLite. `await` over an already-returned sync value is
  a no-op.
- **Therefore the entire async cascade can be performed while still on SQLite,
  with the full existing test suite green at every step.** This converts the
  riskiest, largest, most mechanical part of the sprint from "big-bang, unverifiable
  until the end" into "incremental, continuously verified".
- **Transactions are the one exception.** The `better-sqlite3` driver rejects an
  async callback. Note line 5: row `y` **was still written** even though the
  wrapper threw — a silently non-atomic write. So the 67 transaction callbacks
  must not be touched until the driver flips, and must all flip together.

---

## 5. Strategy — two-stage cutover

### Stage A — async-ify, still on SQLite (suite stays green)

Add `await` to the 1,142 call sites, promote the 706 sync service functions to
`async`, and propagate through routes and tests. `npm test` and
`npm run typecheck` must pass on SQLite at the end of Stage A, proving the
cascade is correct *before* any dialect risk is introduced. Transactions are
explicitly out of scope for Stage A.

### Stage B — flip the dialect (one commit, atomic)

Schema → `pg-core`, driver → `node-postgres`, the 67 transactions → async, the
evidence store → `tsvector`/`pgvector`, the test harness → per-test Postgres
databases, migrations → one generated baseline. Nothing in Stage B is safe to
half-do; it lands together.

---

## 6. Type mapping

| SQLite (`sqlite-core`) | Postgres (`pg-core`) | Sites | Note |
|---|---|---|---|
| `sqliteTable` | `pgTable` | 130 | |
| `text(...)` | `text(...)` | 1,088 | Text PKs stay text — no serial/UUID conversion |
| `integer(...)` | `bigint(..., { mode: "number" })` | 438 | **Uniformly.** Epoch-ms values (~1.7e12) overflow PG `integer` (int4, max 2.1e9). Applying `bigint` to every integer column costs 4 bytes and removes any chance of missing a timestamp column in a 438-site audit. `mode: "number"` keeps the TypeScript type identical, so no call site changes. |
| `integer(..., { mode: "boolean" })` | `boolean(...)` | 13 | |
| `real(...)` | `doublePrecision(...)` | 10 | SQLite REAL is already 8-byte |
| `blob(..., { mode: "buffer" })` | `vector(..., { dimensions: 768 })` | 1 | `evidence_chunks.embedding`; drizzle `pg-core` has native pgvector support |
| `index` / `uniqueIndex` / `primaryKey` / `check` | same | — | All exist in `pg-core`; partial indexes (`.where(sql…)`) are supported |

Both existing `check()` constraints were audited and are already valid
Postgres: `campaign_opportunities_trigger_xor` (`IS NULL <> IS NULL`) and
`email_delivery_events_payload_bounded` (`length(text)`).

The 13 `sql\`\`` partial-index predicates in `schema.ts` are plain
`IS NULL` / `IN (…)` / `=` comparisons — all portable.

---

## 7. The three SQLite-only code sites

### 7.1 `DATABASE_NOW_MS` (`services/task-leases.ts`)

```
CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
→ (EXTRACT(EPOCH FROM now()) * 1000)::bigint
```

Server-side clock for lease expiry. Must stay server-side — the whole point is
that leases are timed by the database, not by a worker's local clock.

### 7.2 `rowid` tie-breakers (6 sites, 5 tables)

Postgres has no `rowid`, and `ctid` is not stable across updates. The affected
tables order by `createdAt` with `rowid` breaking millisecond ties:

| Table | Site |
|---|---|
| `chat_messages` | `services/chat.ts:251` |
| `approval_decisions` | `services/drafts.ts:383` |
| `pipeline_shadow_pairs` | `services/pipeline-shadow.ts:134` |
| `pipeline_rollout_decisions` | `services/pipeline-shadow.ts:412` |
| `pipeline_run_steps` | `services/pipeline-engine.ts:165, :996` |

Fix: add a `seq bigserial` column to each of the five and order on it. This is
strictly better than the `rowid` it replaces (explicit, indexed, not an
implementation detail). The comment at `drafts.ts:381` anticipated this sprint
and suggested simply dropping the term — rejected: ordering of same-millisecond
approval decisions is user-visible in the decision log.

### 7.3 The evidence store (`evidence/db-store.ts`)

The only file that reaches *through* Drizzle to the raw driver handle
(`db.$client`) and issues hand-written SQL — 38 `rowid` references, an FTS5
virtual table, and a `sqlite-vec` `vec0` virtual table. It is the single
largest rewrite in the sprint.

| Concern | SQLite today | Postgres |
|---|---|---|
| Lexical | `evidence_chunks_fts` FTS5 external-content virtual table, `MATCH`, bm25 | `tsvector` generated column + GIN index, `websearch_to_tsquery`, `ts_rank_cd` |
| Vector | `evidence_vec` `vec0` virtual table, `sqlite-vec` extension loaded via `createRequire` | `vector(768)` column + HNSW index, cosine distance `<=>` |
| Fusion key | `rowid` | `evidence_chunks.id` (text PK, already present) |
| Degradation | Lazy-load failure → FTS-only | pgvector is an extension of the image, not an optional runtime load — the degradation path disappears |

**The score contract is load-bearing and must be preserved exactly.**
`rankEvidenceChunks` (`services/evidence.ts`) floors at 0.2 and blends
similarity/recency/source. Per the header comment in `db-store.ts`: vector hits
report raw cosine similarity clamped to [0,1]; FTS-only hits are min–max scaled
into [0.35, 0.9]; hits below `MIN_VECTOR_SCORE` (0.05) are dropped as KNN
noise; RRF with `k=60` over 24 candidates per leg. All of this survives
unchanged — only the source of the two candidate lists changes.

`sqlite-vec` and `better-sqlite3` leave `package.json` at the end of Stage B.

---

## 8. Test harness (D-74.2)

Sprint 73 already introduced the right shape: build the schema **once per
worker process**, then clone it per test (`test/helpers.ts` — a
`Buffer` template, ~15ms per DB instead of ~700ms of migrations). That pattern
maps directly onto Postgres:

- Once per worker: create `tuezday_test_template_<workerId>` and run the
  baseline migration into it.
- Per test: `CREATE DATABASE tuezday_test_<n> TEMPLATE tuezday_test_template_<workerId>`
  — a file-level copy, comparable in cost to the Buffer clone.
- `createTestDb()` becomes `async` and returns a pooled connection plus a
  disposer; 212 test files gain `await`.

Vitest runs workers in parallel, so template and per-test database names must be
namespaced by worker id to avoid cross-talk.

`infra/postgres/docker-compose.yml` on `pgvector/pgvector:pg17` (pgvector
preinstalled), alongside the existing `infra/nango` and `infra/open-design`
compose files, with `npm run postgres:up` / `postgres:down` matching the
existing convention.

CI (`.github/workflows/ci.yml`) gains a `postgres` service container on **both**
the `test` and `eval` jobs — `eval` builds a DB too (`eval/golden.ts` calls
`createDb(":memory:")`).

The ~12 `sprintNN-migrations.test.ts` files assert against the SQLite migration
*history* by replaying files up to a prefix. With the history retired (D-74.3)
they are rewritten to assert the properties they actually care about against the
baseline schema — tables, columns, constraints, backfill invariants — not the
sequence of files that produced it.

---

## 9. Task plan

1. **Spec** — this document; founder questions answered first.
2. **Stage A — async cascade on SQLite.** Codemod the 1,142 call sites and 706
   sync service functions; propagate through routes and 212 test files.
   Transactions untouched. `npm test` + `npm run typecheck` green on SQLite.
3. **Schema → `pg-core`.** 130 tables per the §6 mapping; add the five
   `seq bigserial` columns; delete the 82 SQLite migrations; generate
   `0000_init.sql`; `drizzle.config.ts` → `dialect: "postgresql"`.
4. **Driver swap.** `db/index.ts` → async `createDb` over a `pg` Pool with the
   `node-postgres` migrator; update `Db`/`DbExecutor` types and the five
   `createDb` call sites; convert the 67 transaction callbacks to async.
5. **Evidence store → Postgres** per §7.3.
6. **SQLite-isms** per §7.1–7.2.
7. **Test harness + infra + CI** per §8.
8. **`db:migrate-to-postgres` + docs.** FK-safe ordered copy, embedding blobs
   re-encoded to pgvector, per-table row counts. Update `CLAUDE.md` (stack line,
   commands, environment) and `.env.example` (`DATABASE_URL`).

---

## 10. Acceptance

- `npm run typecheck` and `npm test` pass against a real Postgres — every one of
  the 332 test files, with no SQLite anywhere in the dependency tree.
- `better-sqlite3`, `sqlite-vec` and `@types/better-sqlite3` are gone from
  `apps/api/package.json`.
- `npm run dev` boots the API against Postgres and the app is usable end to end.
- Evidence retrieval returns the same *shape* of results with the score contract
  in §7.3 intact; the Sprint 47 evidence tests pass unmodified in intent.
- Lease/queue concurrency tests (Sprints 49, 73) pass against a real server —
  the fidelity that D-74.2 was chosen to buy.
- `npm run db:migrate-to-postgres` copies a dev `tuezday.db` into Postgres and
  reports matching per-table row counts.
- CI is green on both jobs with the Postgres service container.

---

## 11. Progress log

- **2026-08-08** — Branch cut from `origin/main@5dbb444` (contains 71/73/75/76/77/78).
  Surveyed the migration surface; measured the async cascade (1,142 call sites,
  706 sync functions, 67 transactions). Ran the drizzle awaitability probe —
  builders are `PromiseLike` on SQLite, async transaction callbacks are rejected
  — which established the two-stage strategy in §5. Founder decisions D-74.1–4
  recorded. Spec written.
