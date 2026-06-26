# Sprint 36 — Google Auth login

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U6 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 36"
- **Branch:** `sprint-36-google-auth`, cut from `main`
- **Merge order:** none. "Builds on: Sprint 19 (auth: scrypt + opaque session tokens)" — already on `main` (`apps/api/src/services/auth.ts` with `registerAccount`/`login`/`createSession`/`sessionUser`, the `users`/`sessions` tables, and the global auth guard `apps/api/src/auth/guard.ts`). No unmerged 21+ predecessor is required.
- **Size:** S–M.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

> **For agentic workers:** self-contained spec. Strict TDD — failing test first, run red, implement minimally, run green, commit. Checkboxes track steps. REQUIRED SUB-SKILL: superpowers:executing-plans (or superpowers:subagent-driven-development).

---

## Goal

Add **"Continue with Google"** sign-in alongside the existing email/password auth. A user can sign in with Google and land in their workspaces; a user who already has an email/password account with the **same verified Google email** is linked cleanly to the same account (no duplicate user).

Founder acceptance (from the roadmap):

> Sign in with Google → land in workspaces; an existing email account links cleanly.

---

## Decisions locked (recommended defaults)

1. **Direct Google OIDC (authorization-code flow), NOT Nango.** The roadmap says "via Nango or direct." We choose **direct**: Nango is the per-workspace **connector/integration** broker (CLAUDE.md: "OAuth/connectors → Nango … deploy as a separate service") — it brokers third-party API access *on behalf of a workspace*, not application **login**. App authentication is a **native** concern that Sprint 19 already owns. Routing user login through Nango would mix those boundaries and couple sign-in to the connector service being up. Direct OIDC reuses `createSession` exactly as the scope asks ("reuse existing session issuance").
2. **No SDK.** Talk to Google over plain REST with the injected `fetch` (same pattern as `GeminiGateway`, the Nango client). Two endpoints: token exchange (`https://oauth2.googleapis.com/token`) and userinfo (`https://openidconnect.googleapis.com/v1/userinfo`).
3. **The API owns the redirect URI and the client secret.** The web never supplies a `redirect_uri` (prevents an open-redirect / token-theft vector). The API builds the authorization URL and performs the token exchange against its own configured `GOOGLE_REDIRECT_URI`. The client **id** is public (embedded in the URL the API returns); the client **secret** never leaves the API.
4. **CSRF via `state`, validated on the web.** The web generates a random `state`, stores it in `sessionStorage`, and verifies it on the callback before sending the code to the API. (PKCE is omitted — confidential client with a server-side secret; noted as optional hardening.)
5. **Link by verified email.** `email_verified === true` is **required**; an unverified Google email is rejected. If a user with that email exists, attach `googleSub` to it (idempotent link) and issue a session. Otherwise create a new password-less user. Either way return `{ user, token }` — the exact shape `/auth/login` returns.
6. **Schema: extend `users`, no new table.** Make `password_hash` **nullable** (Google-only users have no password) and add a nullable, unique `google_sub`. A dedicated `oauth_identities` table is YAGNI until a second provider lands.
7. **Graceful when unconfigured.** With the Google env unset, `GET /auth/google/url` returns `503 google_not_configured` and the login page surfaces a friendly message — email/password is unaffected.

---

## Out of scope (YAGNI)
- Any second OIDC provider; single `oauth_identities` table deferred.
- PKCE, JWKS signature verification of the `id_token` (we trust the userinfo response fetched server-to-server directly from Google).
- Account unlinking UI, or merging two pre-existing accounts (different emails).
- Changing the session model/TTL/bearer scheme (Sprint 19, unchanged).
- Scopes beyond `openid email profile`.
- A web test runner (web verification = typecheck + build).

---

## Architecture & boundary

```
Web                                            API
login page                                     GET /auth/google/url?state=…   (public)
  state→sessionStorage                            └─ builds Google authorize URL
  GET {API}/auth/google/url ───────────────────►     (client_id + GOOGLE_REDIRECT_URI + scope + state)
  window.location = url
   Google consent → redirect → GOOGLE_REDIRECT_URI (web /login/google/callback)?code&state
/login/google/callback page                    POST /auth/google/callback {code}  (public)
  verify state == sessionStorage                  └─ auth/google.ts: exchange code → access_token
  POST {API}/auth/google/callback {code} ──────►     userinfo → {sub,email,email_verified,name}
  setToken(body.token) → router → next            └─ services/auth.ts: upsertGoogleUser → createSession
                                                 returns { user, token }
```

### New files (API)
- `apps/api/src/auth/google.ts` — Google I/O only: `googleAuthUrl(state)`, `exchangeCodeForProfile(fetcher, code)` → `{ sub, email, emailVerified, name }`; `googleConfig()`; `GoogleAuthError` with a `code`.
- `apps/api/test/google-auth.test.ts` — client (fixture fetcher) + service + route behavior.

### Modified files (API)
- `packages/contracts/src/index.ts` — `googleCallbackInputSchema` + `GoogleProfile`.
- `apps/api/src/db/schema.ts` — `users.passwordHash` → nullable; add `users.googleSub` + unique index.
- `apps/api/drizzle/0023_*.sql` — generated migration.
- `apps/api/src/services/auth.ts` — guard `login()` against null `passwordHash`; set `googleSub: null` in `registerAccount`; add `upsertGoogleUser(db, profile)` → `{ user, token }`.
- `apps/api/src/routes/auth.ts` — add `fetcher` param; `GET /auth/google/url` + `POST /auth/google/callback`.
- `apps/api/src/auth/guard.ts` — add the two routes to `PUBLIC_ROUTES`.
- `apps/api/src/app.ts` — pass `fetcher` into `registerAuthRoutes`.

### New/modified files (Web)
- `apps/web/app/login/google/callback/page.tsx` — verify `state`, POST `code`, `setToken`, redirect.
- `apps/web/app/login/page.tsx` — "Continue with Google" button.

### Config / docs
- `.env.example` — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/login/google/callback`).

---

## Data model

```ts
// apps/api/src/db/schema.ts — users table
passwordHash: text("password_hash"),                 // was .notNull(); now nullable
googleSub: text("google_sub"),                        // null for password-only users
// + add to the table's index list:
uniqueIndex("users_google_sub").on(t.googleSub),
```

Linking is by **verified email** (the lookup key); `google_sub` is the stored proof of the link (unique so two accounts can't claim the same Google identity).

---

## Implementation plan (TDD, bite-sized)

> Baseline: `git checkout main && git pull`, `npm install`, `npm test`, `git checkout -b sprint-36-google-auth`.

### Task 1: Schema — nullable password, google_sub
- [ ] Drop `.notNull()` from `passwordHash`; add `googleSub` + `uniqueIndex("users_google_sub")`. `npm run db:generate`.
  - **SQLite note:** making a NOT NULL column nullable may need a table rebuild. Inspect the generated SQL; if drizzle didn't handle the nullability change, hand-write the standard SQLite 12-step rebuild in the same migration. The fresh `:memory:` test DB applies it from scratch — verify via the suite.
- [ ] In `services/auth.ts`: `login()` → `if (!row.passwordHash) return null;` before `verifyPassword`; add `googleSub: null` to `registerAccount`'s row literal.
- [ ] **Run** `npm test -w @tuezday/api` (migration applies; existing `auth.test.ts` green). **Commit:** `feat(api): users.password_hash nullable + google_sub for Google login`.

### Task 2: Google callback contract
- [ ] **Failing test** (`packages/contracts/test/google-auth.test.ts`): `googleCallbackInputSchema` requires a non-empty `code`.
- [ ] Implement `googleCallbackInputSchema` + `GoogleProfile`. **Commit:** `feat(contracts): Google OAuth callback input`.

### Task 3: Google client (URL builder + code exchange)
- [ ] **Failing test** (`apps/api/test/google-auth.test.ts`): `googleAuthUrl` embeds client_id/redirect_uri/`response_type=code`/`scope=openid email profile`/state and throws unconfigured; `exchangeCodeForProfile` returns a lowercased verified profile and rejects unverified email.
- [ ] **Run red** → implement `apps/api/src/auth/google.ts` (token endpoint form POST + userinfo Bearer GET; `email_verified` required; `GoogleAuthError` codes `not_configured`/`token_exchange_failed`/`userinfo_failed`/`email_unverified`).
- [ ] **Run green. Commit:** `feat(api): Google OIDC client (auth URL + code exchange)`.

### Task 4: upsertGoogleUser — link by verified email / create
- [ ] **Failing test** (append): new email → password-less user + working session; existing email → same account (no duplicate); repeat login idempotent.
- [ ] **Run red** → add `upsertGoogleUser(db, profile)` to `services/auth.ts` (link by `getUserByEmail`, attach `googleSub` once, else insert password-less row; always `createSession`).
- [ ] **Run green. Commit:** `feat(api): upsertGoogleUser — link by verified email or create`.

### Task 5: Auth routes + public allowlist + app wiring
- [ ] **Failing test** (append, real `buildApp` + injected fetcher): `GET /auth/google/url` public returns a URL (503 unconfigured); `POST /auth/google/callback` returns `{user,token}`; 401 on unverified email.
- [ ] **Run red** → add the two routes to `PUBLIC_ROUTES`; `registerAuthRoutes(app, db, fetcher)` in `app.ts`; implement the two handlers (map `GoogleAuthError`: `not_configured`→503, else 401).
- [ ] **Run green** + `npm test -w @tuezday/api && npm run typecheck`. **Commit:** `feat(api): Google login routes (/auth/google/url + /callback)`.

### Task 6: Web — button + callback page
- [ ] Login page: `continueWithGoogle()` mints `state`→sessionStorage, fetches the URL, navigates; render a "Continue with Google" button.
- [ ] New `apps/web/app/login/google/callback/page.tsx`: verify `state`, POST `{code}`, `setToken`, redirect to `next`.
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): Continue with Google button + OAuth callback page`.

### Task 7: Env + whole-repo verify + push
- [ ] Append `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` to `.env.example`.
- [ ] `npm test && npm run typecheck` green. **Commit:** `docs: Google login env vars`. Then `git push -u origin sprint-36-google-auth` (**do not merge**).

---

## Automated verification
- Contracts: callback input.
- Google client (fixture fetcher): URL params + unconfigured throw; verified-profile + unverified/token/userinfo failures.
- Service: create / link / idempotent.
- Routes (real buildApp): url public (+503), callback returns session, 401 unverified.
- Regression: `auth.test.ts` green; `login()` null for password-less user.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] With Google env set, `/login` → Continue with Google → consent → land in workspaces.
- [ ] Register `you@company.com` with password, log out, Continue with Google (same email) → same account, no duplicate.
- [ ] Unverified Google email rejected with a clear message.
- [ ] With Google env unset, email/password unaffected; button shows "isn't set up yet."

## Known limitations
- Single provider; a second one should introduce `oauth_identities`.
- No PKCE / no id_token signature verification (trust userinfo fetched server-to-server).
- Linking by verified email only; no unlink/merge UI.
- `state` CSRF lives in the browser (sessionStorage), not additionally bound server-side.

## Progress log
- 2026-06-26 — Spec + step-by-step plan drafted. Verified Sprint 19 primitives present and reused; OAuth-app env convention confirmed (`<PROVIDER>_CLIENT_ID/_SECRET`) — Google login is **direct OIDC, not Nango** (rationale §1). Confirmed `buildApp({ fetcher })` injection and web auth utils. Highest migration `0022` → new `0023`. Branch not yet cut.
- 2026-06-27 — Re-saved after the untracked working-tree copy was lost during branch switches; content unchanged. (Note: this sprint has since been partially implemented on branch `sprint-36-google-auth`.)
