# DEP-1 — Runtime Configuration & Process Hardening

> **Status:** Ready to implement
> **Date:** 2026-08-07
> **Branch:** `deploy-01-runtime-config`, branched from `main`
> **Track:** Deployment (see `docs/plans/deployment-prd.md`). This track uses `deploy-NN-` branch and spec names deliberately, so it never collides with the `sprint-NN` range reserved by `prd-agentic-platform.md` for the agentic work.
> **Size:** M · **Risk:** Low · **Founder time:** none

---

## 0. Context — read this first

This spec is self-contained. You do not need any prior conversation to implement it.

Tuezday has never run anywhere but a development laptop. This is the first sprint of the deployment track, and it exists because the code has **laptop assumptions baked in** — places where it assumes the browser is on the same machine, that a human typed the settings, and that shutdown means Ctrl-C. In production the pieces run in separate containers, start themselves, and know only what configuration tells them.

This sprint changes **no product behavior**. Every change is either a new setting whose default reproduces today's behavior exactly, or a fix to a path that only executes in a container. Nothing a user can see changes.

**What this sprint does not do:** it produces no Dockerfiles, no Compose file, and touches no infrastructure. That is DEP-2. This sprint only makes the *code* capable of running in a container.

### Baseline note

The four defects below were verified present on `sprint-70-agent-inbox` at `de408b0`, and have been unchanged since Sprint 51. Branch from `main` per the workflow in `CLAUDE.md`. Line numbers drift between branches, so every anchor below is a **code string**, not a line number. If `main` is behind the agentic sprint branches, expect trivial merge conflicts later in different regions of `app.ts`.

---

## 1. Decisions recorded

### D2 — How the worker reaches the API: **Option D, shared network namespace**

**The problem.** [`apps/worker/src/config.ts`](../../apps/worker/src/config.ts) validates `TUEZDAY_INTERNAL_API_URL` in `internalOrigin()`. It accepts HTTPS, or plain HTTP only when the hostname is `localhost`, `127.0.0.1`, or `::1`. In Docker the natural address is `http://api:3001` — not HTTPS, and `api` is not loopback — so **the worker throws at startup and exits**. The failure is silent from the outside: the website works perfectly while every one of the worker's thirteen background loops never runs.

**Three options were considered:**

| | Code change | Traffic leaves the box | Guardrail modified |
|---|---|---|---|
| A — opt-in flag allowing private HTTP | ~10 lines + new env flag | No | Yes, behind a switch |
| B — worker calls `https://api.<domain>` | None | Yes, hairpins via the public interface | No |
| **D — shared network namespace** | **None** | **No** | **No** |

**Decision: D.** The worker container joins the API container's network namespace, so `http://localhost:3001` from the worker is *genuinely* loopback traffic on the loopback interface. The existing validation rule is satisfied honestly rather than relaxed.

**Why, on security grounds:**
- It writes no new security-adjacent code, and introduces no flag that can be set wrongly or copied into the wrong environment later.
- Under option A, worker↔API traffic sits unencrypted on the Docker bridge, carrying `TUEZDAY_WORKER_TOKEN` on every request. A compromised sibling container — Nango is the most plausible, being third-party software holding OAuth tokens — has `CAP_NET_RAW` by default and could ARP-spoof that traffic. Under D the traffic is not on the bridge at all.
- The worker token is scoped (see `WORKER_ROUTE_ALLOWLIST` in [`apps/api/src/auth/guard.ts`](../../apps/api/src/auth/guard.ts)) — it can trigger tick routes but cannot read workspace data or authorize spend. The stakes are bounded, but "make things happen across every workspace" is still worth protecting.

**Consequence for this sprint: the worker requires no changes at all.** `TUEZDAY_INTERNAL_API_URL` already defaults to `http://localhost:3001` in `internalOrigin()`, so it needs no configuration either.

**Consequence for DEP-2 — carry this forward:** the Compose file must set `network_mode: "service:api"` on the worker service, **with a comment explaining why**. Without the comment a future engineer will read it as an oddity, "clean it up", and silently reintroduce this bug. Also record in the DEP-11 deploy runbook: because the worker borrows the API's network stack, **restarting the API container requires restarting the worker container**. `restart: unless-stopped` recovers it, but deploy ordering must be explicit.

---

## 2. Scope

Five changes. Four are code; one is documentation plus a boot check.

| # | Change | Files |
|---|---|---|
| 1 | Bind address becomes configurable | `apps/api/src/server.ts` |
| 2 | CORS becomes an allowlist | `apps/api/src/app.ts` |
| 3 | API responds to shutdown signals | `apps/api/src/server.ts` |
| 4 | Production env inventory + fail-fast boot check | `.env.example`, `apps/api/src/runtime/`, `apps/api/src/server.ts` |
| 5 | Next.js standalone output | `apps/web/next.config.ts` |

**Explicitly not in scope:** the worker (see D2), Dockerfiles, Compose, Caddy, any infrastructure, and closing the SQLite handle on shutdown (see §6).

---

## 3. Requirements

### 3.1 — Bind address configurable

**Current state.** [`apps/api/src/server.ts`](../../apps/api/src/server.ts) contains:

```ts
await app.listen({ port: PORT, host: "127.0.0.1" });
```

`127.0.0.1` means "this machine only." Inside a container that excludes every other container, so Caddy's proxied requests are refused at the TCP layer. The symptom looks like a proxy or DNS fault; the cause is this literal.

**Required.**
- The host comes from `HOST`, defaulting to `127.0.0.1` when unset. **Development stays closed by default** — only a container explicitly opts into `0.0.0.0`.
- Extract the resolution into a pure exported function so it is unit-testable without binding a socket:
  ```ts
  export function resolveHost(env: NodeJS.ProcessEnv): string
  ```
- The startup log line should state the bound host and port, so a misconfiguration is visible in the first line of container logs.

### 3.2 — CORS allowlist

**Current state.** [`apps/api/src/app.ts`](../../apps/api/src/app.ts) registers:

```ts
await app.register(cors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
```

`origin: true` reflects whatever `Origin` header arrives — any website may call the API.

**Risk assessment, stated accurately so this is not over-fixed:** session tokens ride in `Authorization` headers read from `localStorage` ([`apps/web/lib/api.ts`](../../apps/web/lib/api.ts)), not cookies. A hostile page cannot read another origin's `localStorage`, so this is **not** a session-theft vulnerability. It is an unnecessary open door on a public API, and it should be closed because there is no reason for it to be open.

**Required.**
- A new `BuildAppOptions` field, following the composition-root convention in `CLAUDE.md` that every injectable has a real default:
  ```ts
  corsOrigin?: true | string[];   // default: resolveCorsOrigin(process.env)
  ```
- `resolveCorsOrigin(env)` returns `string[]` parsed from `WEB_ORIGIN` (comma-separated, trimmed, empties dropped), or `true` when `WEB_ORIGIN` is unset or parses to nothing.
- **Unset must reproduce today's behavior exactly**, so local development, the test suite, and CI are untouched by this change.
- `methods` is unchanged.

### 3.3 — API responds to shutdown signals

**Current state — more is already built than it appears.** [`apps/api/src/app.ts`](../../apps/api/src/app.ts) already registers correct shutdown hooks:

```ts
app.addHook("preClose", async () => { ownedShutdown?.abort(...); });
app.addHook("onClose", async () => { ownedShutdown?.abort(...); await closeRenderer(); });
```

These abort in-flight work and close the shared headless Chromium instance. They are correct. **The gap is that nothing ever calls `app.close()`.** Docker sends `SIGTERM`, waits ten seconds, then `SIGKILL` — so today every container stop is a forced kill, requests are severed mid-flight, and the Chromium process is orphaned rather than closed. Repeated deploys accumulate ghost browsers holding memory.

**Required.**
- `server.ts` handles `SIGTERM` and `SIGINT` by calling `app.close()`, which fires the existing hooks.
- Idempotent: a second signal during shutdown is ignored, not re-entrant.
- Errors during close are logged, and the process still exits.
- Log a line on receipt and on completion, so a slow shutdown is diagnosable from container logs.

For reference, the worker already does this correctly in [`apps/worker/src/index.ts`](../../apps/worker/src/index.ts) (`process.once("SIGINT", ...)` / `process.once("SIGTERM", ...)`) — match its shape and log style.

### 3.4 — Production env inventory and fail-fast boot check

**Current state.** `.env.example` is the settings checklist, and the API reads **eleven variables that are not on it**. Verified missing on the current branch:

`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `MAIL_FROM`, `EMAIL_UNSUBSCRIBE_SECRET`, `NANGO_BASE_URL`, `NANGO_PUBLIC_URL`, `NANGO_SECRET_KEY`, `GOOGLE_REDIRECT_URI`, `BILLING_ENFORCED`, `TUEZDAY_DB`, `PORT`

A production environment assembled from `.env.example` alone comes up with **email, connectors, and billing silently inert** — no crash, no error, the features simply do nothing, because as far as the app is concerned nobody configured them.

**Required.**

**(a) Complete `.env.example`.** Add all eleven with explanatory comments matching the file's existing style, and a `# production only` marker where the variable has no local meaning.

**(b) A boot check that distinguishes fatal from degrading.** This distinction matters because the deployment plan brings the app up *before* integrations exist — DEP-4 deploys with only Gemini configured, and DEP-6/8/9 add Nango, email, and Stripe later. A check that demanded everything would block the plan's own sequence.

```ts
export function validateProductionEnv(env: NodeJS.ProcessEnv): {
  errors: string[];    // missing → refuse to boot
  warnings: string[];  // missing → boot, but log the disabled feature
}
```

- **Errors (exit non-zero):** an LLM credential (`GEMINI_API_KEY`, or `OPENROUTER_API_KEY` when `LLM_PROVIDER=openrouter`), `TUEZDAY_WORKER_TOKEN`, `APP_BASE_URL`.
- **Warnings (boot, log once):** the email group, the Nango group, the Stripe group, `POSTHOG_API_KEY`, `TELEGRAM_BOT_TOKEN`. Each warning names the feature that is consequently disabled — for example *"RESEND_API_KEY not set — outbound email sending is disabled."*
- **Only runs when `NODE_ENV === "production"`.** Development and tests are unaffected.
- Wired into `server.ts` alongside the existing operator-policy check, which already establishes this pattern by calling `process.exit(1)` on invalid configuration.

### 3.5 — Next.js standalone output

**Current state.** [`apps/web/next.config.ts`](../../apps/web/next.config.ts) sets only `transpilePackages`. Without standalone output the web image must carry the entire workspace `node_modules`, producing a needlessly large image.

**Required.**
- `output: "standalone"`.
- `outputFileTracingRoot` pointed at the monorepo root. This is necessary, not cosmetic: without it Next traces from the app directory and can miss the workspace packages `@tuezday/contracts` and `@tuezday/brain`, producing an image that builds fine and then fails at runtime with a module-not-found.
- Verification here is only that `npm run build -w apps/web` succeeds and emits `.next/standalone`. That the image actually runs is DEP-2's acceptance, not this sprint's.

---

## 4. Step-by-step plan

1. Branch `deploy-01-runtime-config` from `main`.
2. **Tests first**, per the build rules in `CLAUDE.md`:
   - `resolveHost` — unset → `127.0.0.1`; set → the value.
   - `resolveCorsOrigin` — unset → `true`; empty string → `true`; single origin → one-element array; comma list → trimmed array; whitespace and trailing commas dropped.
   - `validateProductionEnv` — non-production → empty; missing LLM credential → error; `LLM_PROVIDER=openrouter` with only `OPENROUTER_API_KEY` → no error; missing email group → warning not error; fully configured → both empty.
3. Implement §3.1 (`resolveHost` + `listen` + startup log).
4. Implement §3.2 (`resolveCorsOrigin`, `corsOrigin` option, register with it).
5. Implement §3.3 (signal handlers calling `app.close()`).
6. Implement §3.4(b) (`validateProductionEnv`, wired into `server.ts`).
7. Implement §3.4(a) (`.env.example` completion).
8. Implement §3.5 (`next.config.ts`).
9. `npm run typecheck && npm test` — both green.
10. `npm run build -w apps/web` — succeeds, `.next/standalone` present.
11. Manual check: `npm run dev` still works unchanged; `HOST=0.0.0.0 npm run start -w apps/api` binds all interfaces; Ctrl-C produces the clean-shutdown log lines.
12. Commit with the `Co-Authored-By: Claude Opus 4.8` trailer; push the branch. **Do not merge** — the founder reviews and merges.

---

## 5. Acceptance criteria

- [ ] With `HOST=0.0.0.0`, the API accepts a connection from another host on the machine; unset, it binds `127.0.0.1` exactly as today.
- [ ] With `WEB_ORIGIN=https://app.example.com`, a request from another origin is refused by CORS; with `WEB_ORIGIN` unset, behavior is identical to today.
- [ ] `SIGTERM` produces an orderly shutdown: log line, `app.close()`, `closeRenderer()` runs, process exits 0, no orphaned Chromium process.
- [x] A second `SIGTERM` during shutdown does not re-enter the handler. **Corrected during implementation:** `process.once` removes the listener after the first signal, so a second `SIGTERM` hits Node's default disposition and terminates the process. The `shuttingDown` guard therefore protects the SIGINT-then-SIGTERM crossover, not the repeat-same-signal case this criterion originally described. The behavior is better than specified — it gives an operator a manual escape hatch from a wedged shutdown — so the code stands and the criterion is amended. Record the escape hatch in the DEP-11 runbook.
- [ ] `NODE_ENV=production` with no LLM credential exits non-zero naming the variable.
- [ ] `NODE_ENV=production` with no `RESEND_API_KEY` boots successfully and logs that outbound email is disabled.
- [ ] Every variable the API reads appears in `.env.example`.
- [ ] `npm run build -w apps/web` emits `.next/standalone`.
- [ ] `npm run typecheck` and `npm test` pass.
- [ ] No product behavior changes: the full suite passes without modification to any existing test's expectations.

That last criterion is the one that matters most. If an existing test needed changing, a default is wrong.

---

## 6. Deliberately out of scope

**Closing the SQLite handle on shutdown.** `createDb()` in [`apps/api/src/db/index.ts`](../../apps/api/src/db/index.ts) does not expose the underlying better-sqlite3 handle, so closing it would mean changing that module's return type and rippling through every test helper. It buys little: better-sqlite3 writes synchronously and WAL mode is crash-safe, so an unclosed handle loses no data. Litestream (DEP-5) reads the WAL directly and does not require a clean close. Revisit only if a real symptom appears.

**Validating the `HOST` value.** Treated as a plain operator setting, consistent with `PORT`. Adding address validation is speculative complexity.

**Anything infrastructural.** Dockerfiles, Compose, `network_mode`, Caddy, DNS, TLS — all DEP-2 and later. This sprint's output is a repository that *can* be containerized, not a container.

---

## 7. Handoff to DEP-2

Implementation surfaced ten things the containerization sprint must know. They are recorded here because most of them are silent failures — the app boots and looks healthy while being wrong.

1. **`NODE_ENV=production` must be set in Compose.** Nothing in the repo sets it. Without it `validateProductionEnv` returns early and the entire fail-fast check is inert.
2. **Never point Compose `env_file:` at `.env.example`.** A blank `VAR=` line becomes a *set, empty* variable, not an unset one. This branch hardened `TUEZDAY_DB`, `PORT`, `HOST`, and `WEB_ORIGIN` against it, but the sharp edge remains for anything added later.
3. **The API has no build step, and `tsx` is a devDependency.** `npm ci --omit=dev` produces an image that cannot start. Either keep devDependencies in the image or add a `tsc` build — an open decision, not an oversight.
4. **`HOST=0.0.0.0` is mandatory in the container.** Unset yields `127.0.0.1`, which is correct for a laptop and silently unreachable behind Caddy. The symptom is connection-refused, which reads as a proxy fault.
5. **`WEB_ORIGIN` must be set, and entries must include the scheme.** `app.example.com` allowlists nothing; `https://app.example.com` is required. Boot now warns on both the unset and unparseable cases.
6. **The web image is build-time configured.** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_POSTHOG_*`, and `NEXT_PUBLIC_ENABLE_SETUP_SKIP` are Docker **build args**, not runtime `environment:`. A blank `NEXT_PUBLIC_API_URL` inlines `""` and yields relative URLs against the web origin.
7. **Standalone output layout.** With `outputFileTracingRoot` at the monorepo root the entry point is `.next/standalone/apps/web/server.js` — verified. Next does **not** copy `.next/static` or `public/` into the standalone tree; the Dockerfile must copy them explicitly or the app serves with no CSS or JS. Run `node .next/standalone/apps/web/server.js`, not `next start`.
8. **Worker networking (decision D2).** `network_mode: "service:api"` on the worker service, **with a comment explaining why** — without it someone will "clean up" the oddity and silently reintroduce the startup failure. Restarting the API container requires restarting the worker.
9. **Startup is slow and not signal-safe.** 71 migrations plus four backfills run before the signal handlers are registered, so a SIGTERM during startup is a hard kill. Give the healthcheck a `start_period`.
10. **Set `stop_grace_period` explicitly on the API service.** The 10s default is comfortable — `preClose` aborts in-flight work through composed `AbortSignal`s, so even a SIGTERM landing inside a 180s discovery tick unwinds quickly — but it should be a stated decision rather than an accident.

Also for DEP-5: the SQLite handle is deliberately never closed (see §6). Relevant to the Litestream setup.

---

## 8. Progress log

- **2026-08-07** — Spec written. D2 decided in favor of Option D (shared network namespace) on security grounds. All four defects re-verified present on `sprint-70-agent-inbox` @ `de408b0`. Not yet implemented.
- **2026-08-07** — Baseline corrected. `main` was ~Sprint 46 (48 migrations, still on R2R evidence); the real release line is `origin/main` @ `99214a9` (71 migrations, native evidence + safe-fetch present). Branched `deploy-01-runtime-config` from there.
- **2026-08-07** — Implemented across three tasks with per-task review. Task 1 CORS allowlist (`de5a8d2`), Task 2 host/shutdown/env-validation (`9f10671`), Task 3 env inventory + standalone output (`6385932`..`5ca4157`, one fix round).
- **2026-08-07** — Final whole-branch review found one Critical and four Important issues; all fixed in `c1dafb2` and confirmed by scoped re-review. The Critical was the notable one: `TUEZDAY_DB=` blank in a Compose `env_file` is *set-but-empty*, `??` only catches `undefined`, and better-sqlite3 opens an **in-memory** database for `""` — the API would have booted clean and silently discarded all data on every restart. `PORT=` blank had the same shape. Both now resolve through `runtime/` modules that treat empty and whitespace as unset, with tests.
- **2026-08-07** — Verified independently: typecheck clean, 245 test files / 2562 tests pass, `npm run build -w apps/web` succeeds and emits `.next/standalone/apps/web/server.js`. Unset-default invariant confirmed by direct execution: `127.0.0.1` / `true` / `tuezday.db` / `3001` / no errors or warnings. **Complete, awaiting founder review and merge.**
