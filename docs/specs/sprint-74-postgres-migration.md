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
- `sqlite-vec` is gone, and `better-sqlite3` / `@types/better-sqlite3` are gone
  from **runtime** dependencies. *Amended:* they stay as devDependencies,
  because `db:migrate-to-postgres` (D-74.3) has to read a SQLite file. Nothing
  under `src/` imports them.
- `npm run dev` boots the API against Postgres and the app is usable end to end.
- Evidence retrieval returns the same *shape* of results with the score contract
  in §7.3 intact; the Sprint 47 evidence tests pass unmodified in intent.
- Lease/queue concurrency tests (Sprints 49, 73) pass against a real server —
  the fidelity that D-74.2 was chosen to buy.
- `npm run db:migrate-to-postgres` copies a dev `tuezday.db` into Postgres and
  reports matching per-table row counts.
- CI is green on both jobs with the Postgres service container.

---

## 10a. Strategy correction — Stage A ends at the transaction boundary

The §5 plan assumed Stage A could finish with the SQLite suite green. It cannot,
and the reason is worth recording.

Keeping transactions synchronous requires that **no function reachable from a
transaction callback** becomes async. That set is not closed: helpers like
`getDraft`, `getConnection` and `databaseNowMs` are called *both* from inside
transactions and from ordinary request paths. A helper cannot be sync and async
at once, so the taint boundary leaks by construction. Holding the line would
have meant un-promoting most of what Stage A converted, leaving Stage A worth
almost nothing.

**Correction:** transactions were converted in Stage A as well
(`stage-a.ts --no-taint`), and the verification checkpoint moved from "green on
SQLite" to "green on Postgres" — which is the actual acceptance bar in §10
regardless. The intermediate checkpoint is instead **`npm run typecheck` clean
with the suite failing only on transactions**, which is exactly what was
observed: 3,296 tests collect, and all 1,453 failures are the single error
`Transaction function cannot return a promise`, with **zero** failures of any
other kind. That is the designed state — the code is now Postgres-shaped and
SQLite can no longer host it.

---

## 11. Progress log

- **2026-08-08** — Branch cut from `origin/main@5dbb444` (contains 71/73/75/76/77/78).
  Surveyed the migration surface; measured the async cascade (1,142 call sites,
  706 sync functions, 67 transactions). Ran the drizzle awaitability probe —
  builders are `PromiseLike` on SQLite, async transaction callbacks are rejected
  — which established the two-stage strategy in §5. Founder decisions D-74.1–4
  recorded. Spec written.
- **2026-08-08** — **Stage A complete.** Baseline captured first (332 files /
  3,295 tests green in 158s). Codemods under `apps/api/scripts/codemods/`
  promoted **1,504 functions** to `async` and inserted **~6,700 awaits**,
  converging to a fixpoint (`0 promoted, 0 wrapped`). `npm run typecheck` is
  **clean (0 errors)**, down from 2,638 at the first pass.

  Five bug classes were found and fixed along the way — the reason the cascade
  needed a typed codemod rather than a regex:
  1. `await` in a **parameter default** (3 sites) — a syntax error that broke
     the import chain for 160 suites.
  2. **Import aliases** — a call's symbol for an imported function is the import
     specifier, so propagation stopped at every module boundary until
     `getAliasedSymbol()` was used. Fixing it took the error count 489 → 83.
  3. **Array methods do not await** — 14 sites where `.map/.forEach/.every/
     .flatMap(async …)` silently produced promises. Two sat *inside*
     transactions (`signals.ts`, `discovery.ts`) where fire-and-forget inserts
     raced the read that followed; one (`discovery-matching.ts`) made a lease
     heartbeat always report success, so a lost lease would never be detected.
  4. **Deliberately-held promises** — the Sprint 49 crash/restart test assigns a
     tick and awaits it later on purpose; awaiting at assignment destroyed what
     the test exists to prove.
  5. `ReturnType<typeof f>` becoming `Promise<…>` once `f` is async (5 sites,
     now `Awaited<…>`).

  A read-only detector (`detect-silent.ts`) then swept for promises in positions
  the typechecker accepts silently — `expect(p)`, `if (p)`, `!p`, `p && x`,
  templates, ternaries — and found **zero** remaining.

  Per §10a the suite now fails only on transactions: 1,453 failures, every one
  `Transaction function cannot return a promise`, zero of any other kind.
  Next: schema → `pg-core`, driver swap, evidence store, test harness.

- **2026-08-08** — **Stage B complete: the code is on Postgres.**

  *Schema and driver.* `schema.ts` moved to `drizzle-orm/pg-core` (130 tables).
  The type mapping was forced rather than chosen: Postgres `integer` is int4 and
  epoch-ms overflows it, so all 425 integer columns became
  `bigint({mode:"number"})`; SQLite's implicit `rowid` disappeared, so the five
  tables that used it as a same-millisecond tie-breaker gained an explicit
  `seq bigserial`; the evidence embedding blob became `vector(768)`. The 82
  SQLite migrations were replaced by one generated baseline. `createDb` is now
  async and sets an INT8 type parser — node-postgres returns bigint as a string,
  which is harmless for an id and silently wrong for a `createdAt` the whole
  codebase treats as a number.

  *Terminal methods.* pg-core builders have no `.all()`/`.get()`/`.run()`;
  awaiting the builder runs the query. A codemod stripped 1,994 of them, turning
  `.get()` into an indexed read at the enclosing await so `T | undefined`
  survives under `noUncheckedIndexedAccess`. The 39 `.changes` reads route
  through one `rowsAffected` helper, because node-postgres types `rowCount` as
  nullable and the two arithmetic call sites would otherwise start doing
  `number | null` arithmetic.

  *Test harness (D-74.2).* Fixtures are real databases cloned from a template
  the global setup migrates once. `STRATEGY = FILE_COPY` is what makes this
  affordable: PG15 defaults to WAL_LOG, which writes the whole 14MB template
  through WAL at ~250ms a clone, and with ten workers cloning concurrently the
  queueing showed up as 30s hook timeouts. A directory copy is ~35ms. One suite
  went from 42.9s to 6.4s.

  *Bug classes Postgres exposed.* Beyond Stage A's five, the first real runs
  found six more — all of them invisible to the type checker, because awaiting
  an already-settled value is legal:

  6. `expect(await p).rejects` (138 sites) — awaiting first makes the rejection
     escape as a thrown error, so the test fails reporting the exact message it
     was asserting on.
  7. `const pending = await f()` where the test awaits it again later (18
     sites). One was production code: `FallbackGateway` awaited the primary
     provider outside its own try/catch, so a failing primary threw instead of
     falling through to the secondary — the entire purpose of that class.
  8. `expect(async () => …).toThrow()` (48 sites) — an async function returns a
     rejected promise rather than throwing.
  9. `.filter(async …)` in the launch dispatch path — the predicate returns a
     Promise, which is always truthy, so **every** message passed the
     "content has been approved by a human" check.
  10. Scripted LLM gateways doing `JSON.stringify(responder(prompt))` on a
      responder the cascade made async: a Promise stringifies to `{}`, which the
      structured-output schema rejected as "malformed response".
  11. The per-file setup hook imported `./helpers`, which imports `src/app`. A
      setup file runs *before* the test file's own imports, so every service it
      pulled in was already in the module registry when `vi.mock()` tried to
      replace it — mocks silently did nothing.

  Each has a detector next to its fix in `apps/api/scripts/codemods/`, because
  "awaiting something already resolved" is the failure mode this migration keeps
  producing and it never announces itself.

  *Portability fixes.* SQLite's two-argument `MIN`/`MAX` are scalar functions;
  in Postgres those names are aggregates only, so the story-merge path needs
  `LEAST`/`GREATEST`. Duplicate-run detection matched `"UNIQUE"` in the error
  message — SQLite's wording — and now reads SQLSTATE 23505 through
  `isUniqueViolation`, unwrapping drizzle's `Failed query: …` envelope. And
  node-postgres emits `error` on idle clients: with no listener that is an
  unhandled event that kills the process.

  *Schema tests.* The 14 `sprintNN-migrations` tests replayed historical
  migrations file-by-file, which the squashed baseline leaves without a subject.
  They are replaced by five schema-invariant suites (42 tests) asserting against
  the baseline: defaults, partial-unique indexes, check constraints, and which
  links are `ON DELETE SET NULL` rather than `CASCADE` — the Sprint 67 freeze
  rule, whose reversal destroys provenance silently. Assertions read SQLSTATE
  rather than message text, since drizzle's wrapper message would have matched
  the wrong constraint. **Dropped deliberately:** the
  backfill-of-pre-existing-rows and drizzle-journal assertions, which describe a
  history that no longer exists.

  *Two real defects surfaced by the swap, both pre-existing:*
  - `discovery-matching`'s claim loop spread `undefined` into a malformed claim
    when its compare-and-swap lost the race. SQLite's `.returning().get()` typed
    a miss as a row, so a lost race looked like a win.
  - `launches`' dispatch filter (bug class 9 above) proposed sends for drafts no
    human had approved.

  *Copy script verified.* A pre-Sprint-74 SQLite database was rebuilt from the
  retired migrations at `5dbb444`, seeded, and copied. Epoch-ms survives as a
  number (not the string node-postgres returns for int8), `enabled: 1` becomes
  `true`, and the embedding blob round-trips to pgvector at cosine distance 0
  from its original vector. The first attempt caught a real bug: the script
  skipped every column named `seq`, but `evidence_chunks.seq` is an ordinary
  integer holding a chunk's position in its document — only *serial* columns
  may be skipped, so the filter keys on the column type.
