# Sprint 74 codemods — the sync → async cascade

One-off scripts that performed the Postgres migration's largest mechanical step:
`better-sqlite3` is a **synchronous** driver, `node-postgres` is not, so every
query site had to be awaited and every function that reaches one had to become
`async`. That was 2,009 drizzle terminals across 142 service files, 67 route
files and 212 test files — not a hand edit.

They are checked in as the record of *how* the conversion was made, and because
they are idempotent: re-running one on the converted tree reports `0/0`.

## Running them

`ts-morph` is intentionally **not** a dependency of the repo — install it only
when you need to re-run a codemod, and run from the repo root:

```bash
npm install --no-save --no-package-lock ts-morph
npx tsx apps/api/scripts/codemods/<script>.ts
npm ci                      # restore the tree afterwards
```

> `--no-package-lock` resolves fresh versions and *will* drift other packages
> (it silently bumped `stripe` 22.3.0 → 22.4.0 during this sprint, producing an
> unrelated type error). Always `npm ci` when you are done.

## The scripts

| Script | What it does |
|---|---|
| `analyze.ts` | Read-only. Counts drizzle terminals and reports which calls are reachable from a `db.transaction()` callback. Run this first to understand the surface. |
| `stage-a.ts` | The main codemod. **PROMOTE** marks every function that transitively performs a query `async` and widens its return annotation to `Promise<T>`; **WRAP** then awaits every drizzle terminal and every now-Promise-typed call, parenthesising as `(await …)` where the parent binds tighter than `await`. Pass `--no-taint` to include transaction callbacks (Stage B); without it they are left synchronous. |
| `widen-returns.ts` | Widens `: T` to `: Promise<T>` on non-async functions that pass a promise straight through (`return db.transaction(…)`). |
| `fix-async-map.ts` | Wraps `xs.map(async …)` in `Promise.all(…)`. Promoting a callback to async silently turns `map` into `Promise<T>[]`. |
| `detect-silent.ts` | Read-only safety net. Finds promises in positions the typechecker accepts without complaint — `expect(p)`, `if (p)`, `!p`, `p && x`, `` `${p}` ``, `p ? a : b`. These are the residual bugs `tsc` cannot see. |

### Stage B — the dialect swap

| Script | What it does |
|---|---|
| `strip-terminals.ts` | Removes `.all()`/`.run()`, which pg-core does not have (awaiting the builder runs the query), and rewrites `.get()` to an indexed read at the enclosing `await` so `T \| undefined` survives. Detection is by the *receiver's* type: after the swap `.all` resolves to nothing, so there is no symbol to inspect. |
| `rows-affected.ts` | Routes the 39 `result.changes` reads through one `rowsAffected` helper. node-postgres types `rowCount` as nullable, and two call sites do arithmetic on it. |
| `await-test-db.ts` | Awaits the 273 `createTestDb()` calls the async harness made necessary, marking enclosing hooks `async`. |

### Repairs — the bugs a blanket `await` creates

Every one of these type-checks. Awaiting an already-settled value is legal, so
`tsc` has nothing to say about any of them; each has a read-only detector next
to its fix.

| Script | What it finds |
|---|---|
| `fix-rejects-await.ts` | `expect(await p).rejects` — awaiting first makes the rejection escape as a thrown error, so the test fails reporting the message it was asserting on. 138 sites. |
| `detect-settled-rejects.ts` | The indirect shape: a helper awaits and hands back the settled value, and the caller asserts `.rejects` on it. Flags any identifier passed to `expect()` before `.rejects`/`.resolves` that is no longer promise-typed. |
| `detect-double-await.ts` / `fix-double-await.ts` | `const p = await f()` where `p` is awaited again later — the later await is the real one, and the first serialises work the caller meant to overlap. One was production code: `FallbackGateway` awaited the primary provider outside its own try/catch. |
| `detect-sync-throw.ts` / `fix-sync-throw.ts` | `expect(async () => …).toThrow()`. An async function returns a rejected promise; it does not throw. 48 sites. |
| `detect-async-callback.ts` | `filter`/`some`/`every`/`find`/`forEach`/`map`/`flatMap` given an async callback. A Promise is always truthy, so `filter(async …)` keeps everything — which is how unapproved drafts reached the launch dispatch path. |
| `detect-awaited-array.ts` | `await` on a `Promise<T>[]` — resolves to the array itself, unchanged. |

## Things learned the hard way

- **Resolve import aliases.** A call's symbol for an imported function is the
  *import specifier*, not the function. Without `getAliasedSymbol()` the
  propagation stops at every module boundary — that one fix took the error count
  from 489 to 83.
- **`await` is illegal in a parameter default.** `now = await databaseNowMs(db)`
  is a syntax error that breaks the whole import chain. Three sites had to be
  restructured to resolve the default in the body.
- **Array methods do not await.** `forEach(async …)` is fire-and-forget,
  `every(async …)` is always true, `flatMap(async …)` returns promises. The
  cascade introduced 14 of these; `map` was fixed mechanically, the rest by hand.
- **Some promises are held deliberately.** The Sprint 49 crash/restart test
  starts a tick and awaits it later on purpose; awaiting at the assignment
  destroys what the test exists to prove. `Promise.all`, `.then` chains and
  pass-through returns are excluded for the same reason.
- **`ReturnType<typeof f>` becomes `Promise<…>`** once `f` is async — wrap in
  `Awaited<…>`.
- **Awaiting something already settled type-checks.** That is the whole reason
  this directory has more detectors than fixers. `tsc` was clean and green for
  three of the six repair classes above while 200 tests failed.
- **A vitest setup file runs before the test file's imports.** Anything it
  pulls in is already in the module registry when `vi.mock()` tries to replace
  it. The fixture registry deliberately lives in `test/postgres.ts`, which
  reaches `src/db` and no further — routing it through `test/helpers.ts` (which
  imports `src/app`) silently disarmed every service mock in the suite.
- **Tests can depend on synchrony without saying so.** Three scheduler tests
  asserted a call count immediately after starting a tick, which only worked
  because the database work before it was synchronous. They now wait for the
  call rather than assume it already happened.
