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
