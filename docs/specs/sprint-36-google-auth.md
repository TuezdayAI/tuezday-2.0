# Sprint 36 — Google Auth login

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U6 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 36"
- **Branch:** `sprint-36-google-auth`, cut from `main`
- **Merge order:** none. "Builds on: Sprint 19 (auth: scrypt + opaque session tokens)" — already on `main` (verified: `apps/api/src/services/auth.ts` with `registerAccount`/`login`/`createSession`/`sessionUser`, the `users`/`sessions` tables, and the global auth guard `apps/api/src/auth/guard.ts` are present). No unmerged 21+ predecessor is required. (Independent of the unmerged `sprint-30-rag-hardening` / `sprint-31-discovery-expansion` branches.)
- **Size:** S–M.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

> **For agentic workers:** this spec is self-contained (the founder resets the session between sprints). Implement task-by-task with strict TDD — failing test first, run red, implement minimally, run green, commit. Steps use checkbox (`- [ ]`) syntax. REQUIRED SUB-SKILL: superpowers:executing-plans (or superpowers:subagent-driven-development).

---

## Goal

Add **"Continue with Google"** sign-in alongside the existing email/password auth. A user can sign in with Google and land in their workspaces; a user who already has an email/password account with the **same verified Google email** is linked cleanly to the same account (no duplicate user).

Founder acceptance (from the roadmap):

> Sign in with Google → land in workspaces; an existing email account links cleanly.

---

## Decisions locked (recommended defaults)

1. **Direct Google OIDC (authorization-code flow), NOT Nango.** The roadmap says "via Nango or direct." We choose **direct**: Nango is the per-workspace **connector/integration** broker (CLAUDE.md: "OAuth/connectors → Nango … deploy as a separate service") — it brokers third-party API access *on behalf of a workspace*, not application **login**. App authentication is a **native** concern that Sprint 19 already owns. Routing user login through Nango would mix those boundaries and couple sign-in to the connector service being up. Direct OIDC reuses `createSession` exactly as the scope asks ("reuse existing session issuance").
2. **No SDK.** Talk to Google over plain REST with the injected `fetch` (same pattern as `GeminiGateway`, `PostHogSink`, and the Nango client). Two endpoints: token exchange (`https://oauth2.googleapis.com/token`) and userinfo (`https://openidconnect.googleapis.com/v1/userinfo`).
3. **The API owns the redirect URI and the client secret.** The web never supplies a `redirect_uri` (prevents an open-redirect / token-theft vector). The API builds the authorization URL and performs the token exchange against its own configured `GOOGLE_REDIRECT_URI`. The client **id** is public (lives on the API and is embedded in the URL it returns); the client **secret** never leaves the API.
4. **CSRF via `state`, validated on the web.** The web generates a random `state`, stores it in `sessionStorage`, and verifies it on the callback before sending the code to the API. (PKCE is omitted — we are a confidential client with a server-side secret; noted as optional hardening in Known limitations.)
5. **Link by verified email.** `email_verified === true` is **required**; an unverified Google email is rejected. If a user row with that email exists, attach `googleSub` to it (idempotent link) and issue a session. Otherwise create a new password-less user. Either way return `{ user, token }` — the exact shape `/auth/login` already returns.
6. **Schema: extend `users`, no new table.** Make `password_hash` **nullable** (Google-only users have no password) and add a nullable, unique `google_sub`. Only Google is in scope, so a dedicated `oauth_identities` table is YAGNI; revisit it if a second provider lands (noted in Known limitations).
7. **Graceful when unconfigured.** With `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset, `GET /auth/google/url` returns `503 google_not_configured` and the login page surfaces a friendly message — email/password is unaffected.

---

## Out of scope (YAGNI)

- Any second OIDC provider (GitHub, Microsoft) — single `oauth_identities` table deferred until then.
- PKCE, JWKS signature verification of the `id_token` (we trust the userinfo response fetched server-to-server directly from Google).
- Account **unlinking** UI, or merging two pre-existing accounts (different emails) into one.
- Changing the session model, TTL, or the bearer-token scheme (Sprint 19, unchanged).
- Google scopes beyond `openid email profile` (no Gmail/Calendar/Drive access — those are separate connector concerns).
- A web test runner (the web workspace has none; web verification is `typecheck` + `build`).

---

## Architecture & boundary

```
Web (Next.js)                                  API (Fastify)
─────────────                                  ─────────────
login page                                     GET /auth/google/url?state=…   (public)
  state→sessionStorage                            └─ builds Google authorize URL
  GET {API}/auth/google/url ───────────────────►     (client_id + GOOGLE_REDIRECT_URI
  window.location = url                                + scope=openid email profile + state)
        │
   Google consent
        │  redirect → GOOGLE_REDIRECT_URI (= web /login/google/callback)?code&state
        ▼
/login/google/callback page                    POST /auth/google/callback {code}  (public)
  verify state == sessionStorage                  └─ auth/google.ts: exchange code → access_token
  POST {API}/auth/google/callback {code} ──────►     userinfo → {sub,email,email_verified,name}
  setToken(body.token)                            └─ services/auth.ts: upsertGoogleUser
  router → next ?? "/"                                (link by verified email | create) → createSession
                                                 returns { user, token }   (same shape as /auth/login)
```

- **Native boundary owned:** authentication, user/session model, account linking. **Integrated behind it:** Google's OIDC endpoints, reached only from `apps/api/src/auth/google.ts` via the injected fetcher.
- The two new endpoints are added to the auth guard's `PUBLIC_ROUTES` allowlist (no session required to sign in).

### New files (API)
- `apps/api/src/auth/google.ts` — Google I/O only: `googleAuthUrl(state)`, `exchangeCodeForProfile(fetcher, code)` → `{ sub, email, emailVerified, name }`. Reads `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`. Throws `GoogleAuthError` (with a `code`) on misconfig / Google failure / unverified email.
- `apps/api/test/google-auth.test.ts` — Google client (fixture fetcher) + route behavior (link + create + unverified + unconfigured).

### Modified files (API)
- `packages/contracts/src/index.ts` — `googleCallbackInputSchema` + `GoogleProfile` type (internal).
- `apps/api/src/db/schema.ts` — `users.passwordHash` → nullable; add `users.googleSub` (nullable) + unique index (currently `apps/api/src/db/schema.ts:15`).
- `apps/api/drizzle/0023_*.sql` — generated migration (next after `0022_rich_bloodstorm.sql`).
- `apps/api/src/services/auth.ts` — guard `login()` against null `passwordHash`; set `googleSub: null` in `registerAccount`'s row literal; add `upsertGoogleUser(db, profile)` → `{ user, token }`.
- `apps/api/src/routes/auth.ts` — add `fetcher` param; add `GET /auth/google/url` + `POST /auth/google/callback`.
- `apps/api/src/auth/guard.ts` — add the two routes to `PUBLIC_ROUTES` (currently `apps/api/src/auth/guard.ts:35`).
- `apps/api/src/app.ts` — pass `fetcher` into `registerAuthRoutes` (currently `registerAuthRoutes(app, db)` at `apps/api/src/app.ts`).

### New/modified files (Web)
- `apps/web/app/login/google/callback/page.tsx` — handle the redirect: verify `state`, POST `code`, `setToken`, redirect.
- `apps/web/app/login/page.tsx` — a "Continue with Google" button that fetches the URL, stores `state`, and navigates.

### Config / docs
- `.env.example` — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/login/google/callback`), with setup notes.

---

## Data model

Two additive changes to `users`, no new table:

```ts
// apps/api/src/db/schema.ts — users table
passwordHash: text("password_hash"),                 // was .notNull(); now nullable (Google-only users)
googleSub: text("google_sub"),                        // Google subject id; null for password-only users
// + add to the table's index list:
uniqueIndex("users_google_sub").on(t.googleSub),
```

`google_sub` is unique so two accounts can't claim the same Google identity. Linking is by **verified email** (the lookup key); `google_sub` is the stored proof of the link.

---

## Implementation plan (TDD, bite-sized)

> Baseline first: `git checkout main && git pull`, `npm install`, `npm test` (record the green count), then `git checkout -b sprint-36-google-auth`.

### Task 1: Schema — nullable password, google_sub

**Files:** Modify `apps/api/src/db/schema.ts`; generated migration; Modify `apps/api/src/services/auth.ts`.

- [ ] **Step 1 — schema.** In the `users` table (`apps/api/src/db/schema.ts:15`): drop `.notNull()` from `passwordHash`, add `googleSub: text("google_sub")`, and add `uniqueIndex("users_google_sub").on(t.googleSub)` to the index list alongside `users_email`.
- [ ] **Step 2 — migration:** `npm run db:generate -w apps/api` → creates `apps/api/drizzle/0023_*.sql` (nullable `password_hash` + `google_sub` column + unique index). Keep drizzle's `meta/_journal.json` entry. Do not rename the file.

  > SQLite note: making an existing NOT NULL column nullable can require a table rebuild. Inspect the generated SQL; if drizzle didn't produce a working migration for the nullability change, hand-write the standard SQLite 12-step table rebuild in the same migration file (create new table with the nullable column + `google_sub`, `INSERT … SELECT`, drop old, rename, recreate indexes). The fresh `:memory:` test DB will apply it from scratch, so verify via Step 4.

- [ ] **Step 3 — guard `login()` + fix the row literal.** In `apps/api/src/services/auth.ts`:
  - In `login()`, before `verifyPassword`, add: `if (!row.passwordHash) return null;` (Google-only users can't log in with a password).
  - In `registerAccount()`'s `row` literal, add `googleSub: null,`.

- [ ] **Step 4 — verify migration applies + nothing regressed:** `npm test -w @tuezday/api` → full API suite green against the rebuilt `users` table (the existing `apps/api/test/auth.test.ts` exercises register/login/session).
- [ ] **Step 5 — commit:** `feat(api): users.password_hash nullable + google_sub for Google login`.

### Task 2: Google callback contract

**Files:** Modify `packages/contracts/src/index.ts` (after the auth schemas ~`packages/contracts/src/index.ts:160`); Test `packages/contracts/test/google-auth.test.ts`.

- [ ] **Step 1 — failing test**

```typescript
// packages/contracts/test/google-auth.test.ts
import { describe, expect, it } from "vitest";
import { googleCallbackInputSchema } from "../src/index";

describe("googleCallbackInputSchema", () => {
  it("requires a non-empty code", () => {
    expect(googleCallbackInputSchema.parse({ code: "abc" })).toEqual({ code: "abc" });
    expect(googleCallbackInputSchema.safeParse({ code: "" }).success).toBe(false);
    expect(googleCallbackInputSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2 — run red:** `npm test -w @tuezday/contracts -- google-auth` → FAIL.
- [ ] **Step 3 — implement.** Append to `packages/contracts/src/index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Google OAuth login (Sprint 36)
// ---------------------------------------------------------------------------

export const googleCallbackInputSchema = z.object({
  code: z.string().min(1, "Missing authorization code"),
});
export type GoogleCallbackInput = z.infer<typeof googleCallbackInputSchema>;

/** Internal: the verified identity we extract from Google's userinfo. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}
```

- [ ] **Step 4 — run green:** `npm test -w @tuezday/contracts -- google-auth` → PASS.
- [ ] **Step 5 — commit:** `feat(contracts): Google OAuth callback input`.

### Task 3: Google client (URL builder + code exchange)

**Files:** Create `apps/api/src/auth/google.ts`; Test `apps/api/test/google-auth.test.ts`.

- [ ] **Step 1 — failing test** (Google-client portion)

```typescript
// apps/api/test/google-auth.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoogleAuthError, exchangeCodeForProfile, googleAuthUrl } from "../src/auth/google";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/login/google/callback";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("googleAuthUrl", () => {
  it("builds a Google authorize URL with our params", () => {
    const url = new URL(googleAuthUrl("xyz-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/login/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("xyz-state");
  });
  it("throws when unconfigured", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => googleAuthUrl("s")).toThrow(GoogleAuthError);
  });
});

describe("exchangeCodeForProfile", () => {
  function fetcherFor(token: object, userinfo: object) {
    return (async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify(token), { status: 200 });
      if (url.includes("userinfo")) return new Response(JSON.stringify(userinfo), { status: 200 });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  }

  it("returns the verified profile", async () => {
    const fetcher = fetcherFor(
      { access_token: "at" },
      { sub: "g-123", email: "Founder@Acme.com", email_verified: true, name: "Founder" },
    );
    const profile = await exchangeCodeForProfile(fetcher, "the-code");
    expect(profile).toEqual({ sub: "g-123", email: "founder@acme.com", emailVerified: true, name: "Founder" });
  });

  it("rejects an unverified email", async () => {
    const fetcher = fetcherFor({ access_token: "at" }, { sub: "g", email: "x@y.com", email_verified: false, name: "" });
    await expect(exchangeCodeForProfile(fetcher, "c")).rejects.toMatchObject({ code: "email_unverified" });
  });
});
```

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- google-auth` → FAIL (`../src/auth/google` missing).
- [ ] **Step 3 — implement**

```typescript
// apps/api/src/auth/google.ts
// Google OIDC I/O only (no DB). Direct REST, injected fetcher — same no-SDK
// pattern as the LLM gateway and Nango client.
import type { GoogleProfile } from "@tuezday/contracts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

export type GoogleAuthErrorCode =
  | "not_configured"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "email_unverified";

export class GoogleAuthError extends Error {
  constructor(public readonly code: GoogleAuthErrorCode, message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() || "http://localhost:3000/login/google/callback";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

export function googleAuthUrl(state: string): string {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleAuthError("not_configured", "Google login is not configured.");
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCodeForProfile(
  fetcher: typeof fetch,
  code: string,
): Promise<GoogleProfile> {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleAuthError("not_configured", "Google login is not configured.");

  const tokenRes = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new GoogleAuthError("token_exchange_failed", `Google token exchange failed (${tokenRes.status}).`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new GoogleAuthError("token_exchange_failed", "Google returned no access token.");
  }

  const infoRes = await fetcher(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) {
    throw new GoogleAuthError("userinfo_failed", `Google userinfo failed (${infoRes.status}).`);
  }
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (!info.email_verified || !info.email || !info.sub) {
    throw new GoogleAuthError("email_unverified", "Google account email is not verified.");
  }
  return {
    sub: info.sub,
    email: info.email.toLowerCase(),
    emailVerified: true,
    name: info.name ?? "",
  };
}
```

- [ ] **Step 4 — run green:** `npm test -w @tuezday/api -- google-auth` (the client cases) → PASS.
- [ ] **Step 5 — commit:** `feat(api): Google OIDC client (auth URL + code exchange)`.

### Task 4: upsertGoogleUser — link by verified email / create

**Files:** Modify `apps/api/src/services/auth.ts`; extend `apps/api/test/google-auth.test.ts`.

- [ ] **Step 1 — failing test** (append to `apps/api/test/google-auth.test.ts`)

```typescript
import { registerAccount, sessionUser, upsertGoogleUser } from "../src/services/auth";
import { createTestDb } from "./helpers";

describe("upsertGoogleUser", () => {
  const profile = { sub: "g-1", email: "founder@acme.com", emailVerified: true as const, name: "Founder" };

  it("creates a password-less user and a usable session for a new email", () => {
    const db = createTestDb();
    const { user, token } = upsertGoogleUser(db, profile);
    expect(user.email).toBe("founder@acme.com");
    expect(sessionUser(db, token)?.id).toBe(user.id); // session works
  });

  it("links to an existing email/password account (no duplicate)", () => {
    const db = createTestDb();
    const existing = registerAccount(db, { email: "founder@acme.com", password: "pw-12345", name: "Founder" });
    const { user } = upsertGoogleUser(db, profile);
    expect(user.id).toBe(existing.user.id); // same account
  });

  it("is idempotent across repeat Google logins", () => {
    const db = createTestDb();
    const first = upsertGoogleUser(db, profile);
    const second = upsertGoogleUser(db, profile);
    expect(second.user.id).toBe(first.user.id);
  });
});
```

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- google-auth` → FAIL (`upsertGoogleUser` missing).
- [ ] **Step 3 — implement.** Add to `apps/api/src/services/auth.ts` (imports `GoogleProfile` from `@tuezday/contracts`):

```typescript
/**
 * Sign a user in with Google. Link by verified email: reuse the existing
 * account if one has this email (attaching the google_sub once), else create a
 * password-less user. Always returns a fresh session — same shape as login().
 */
export function upsertGoogleUser(db: Db, profile: GoogleProfile): { user: User; token: string } {
  const existing = getUserByEmail(db, profile.email);
  if (existing) {
    if (!existing.googleSub) {
      db.update(users)
        .set({ googleSub: profile.sub, updatedAt: Date.now() })
        .where(eq(users.id, existing.id))
        .run();
    }
    return { user: rowToUser(existing), token: createSession(db, existing.id) };
  }
  const now = Date.now();
  const row: UserRow = {
    id: randomUUID(),
    email: profile.email,
    name: profile.name,
    passwordHash: null,
    googleSub: profile.sub,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(users).values(row).run();
  return { user: rowToUser(row), token: createSession(db, row.id) };
}
```

- [ ] **Step 4 — run green:** `npm test -w @tuezday/api -- google-auth` → PASS.
- [ ] **Step 5 — commit:** `feat(api): upsertGoogleUser — link by verified email or create`.

### Task 5: Auth routes + public allowlist + app wiring

**Files:** Modify `apps/api/src/routes/auth.ts`, `apps/api/src/auth/guard.ts`, `apps/api/src/app.ts`; extend `apps/api/test/google-auth.test.ts`.

- [ ] **Step 1 — failing test** (append; uses the real `buildApp` with an injected fetcher)

```typescript
import { buildApp } from "../src/app";

function googleFetcher(userinfo: object): typeof fetch {
  return (async (url: string) => {
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    if (url.includes("userinfo")) return new Response(JSON.stringify(userinfo), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Google auth routes", () => {
  it("GET /auth/google/url returns an authorize URL (public, no token)", async () => {
    const app = await buildApp({ db: createTestDb() });
    const res = await app.inject({ method: "GET", url: "/auth/google/url?state=abc" });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("accounts.google.com");
  });

  it("503s when Google is unconfigured", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const app = await buildApp({ db: createTestDb() });
    const res = await app.inject({ method: "GET", url: "/auth/google/url?state=abc" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("google_not_configured");
  });

  it("POST /auth/google/callback exchanges the code and returns a session", async () => {
    const app = await buildApp({
      db: createTestDb(),
      fetcher: googleFetcher({ sub: "g-9", email: "new@acme.com", email_verified: true, name: "New" }),
    });
    const res = await app.inject({ method: "POST", url: "/auth/google/callback", payload: { code: "c" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("new@acme.com");
    expect(typeof res.json().token).toBe("string");
  });

  it("401s an unverified Google email", async () => {
    const app = await buildApp({
      db: createTestDb(),
      fetcher: googleFetcher({ sub: "g", email: "x@y.com", email_verified: false, name: "" }),
    });
    const res = await app.inject({ method: "POST", url: "/auth/google/callback", payload: { code: "c" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("email_unverified");
  });
});
```

> The `GOOGLE_*` env defaults set in this file's `beforeEach` make the configured cases pass; the 503 case deletes the id explicitly.

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- google-auth` → FAIL (routes 404 / not public).
- [ ] **Step 3 — public allowlist.** In `apps/api/src/auth/guard.ts`, add the two routes to `PUBLIC_ROUTES`:

```typescript
const PUBLIC_ROUTES = new Set([
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/google/url",
  "POST /auth/google/callback",
  "GET /health",
]);
```

- [ ] **Step 4 — app wiring.** In `apps/api/src/app.ts`, pass the fetcher: `registerAuthRoutes(app, db, fetcher);`.
- [ ] **Step 5 — routes.** In `apps/api/src/routes/auth.ts`, add the `fetcher` param and the two handlers:

```typescript
import type { Fetcher } from "../discovery/adapters";
import { googleCallbackInputSchema } from "@tuezday/contracts";
import { GoogleAuthError, exchangeCodeForProfile, googleAuthUrl } from "../auth/google";
import { upsertGoogleUser } from "../services/auth";
// ...
export function registerAuthRoutes(app: FastifyInstance, db: Db, fetcher: Fetcher): void {
  // ... existing register / login / logout / me ...

  app.get<{ Querystring: { state?: string } }>("/auth/google/url", async (request, reply) => {
    try {
      return { url: googleAuthUrl(request.query.state ?? "") };
    } catch (err) {
      if (err instanceof GoogleAuthError && err.code === "not_configured") {
        return reply.status(503).send({ error: "google_not_configured", message: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/google/callback", async (request, reply) => {
    const parsed = googleCallbackInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input" });
    }
    try {
      const profile = await exchangeCodeForProfile(fetcher, parsed.data.code);
      return upsertGoogleUser(db, profile);
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        const status = err.code === "not_configured" ? 503 : 401;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
```

> `Fetcher` is `typeof fetch` (see `apps/api/src/discovery/adapters.ts`); import it from there to match the codebase, or alias `type Fetcher = typeof fetch` locally if preferred.

- [ ] **Step 6 — run green:** `npm test -w @tuezday/api -- google-auth` → PASS; then `npm test -w @tuezday/api && npm run typecheck` → all green.
- [ ] **Step 7 — commit:** `feat(api): Google login routes (/auth/google/url + /callback)`.

### Task 6: Web — "Continue with Google" + callback page

**Files:** Modify `apps/web/app/login/page.tsx`; Create `apps/web/app/login/google/callback/page.tsx`. Verification = typecheck + build.

- [ ] **Step 1 — login button.** In `apps/web/app/login/page.tsx`, add a handler and a button under the form:

```tsx
  async function continueWithGoogle() {
    setError(null);
    const state = crypto.randomUUID();
    sessionStorage.setItem("google_oauth_state", state);
    try {
      const res = await fetch(`${API_URL}/auth/google/url?state=${encodeURIComponent(state)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error === "google_not_configured" ? "Google sign-in isn't set up yet." : "Couldn't start Google sign-in.");
      }
      // Remember where to land after the round-trip.
      sessionStorage.setItem("google_oauth_next", searchParams.get("next") ?? "/");
      window.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start Google sign-in.");
    }
  }
```

```tsx
        <button type="button" className="link-button" onClick={continueWithGoogle}>
          Continue with Google
        </button>
```

- [ ] **Step 2 — callback page**

```tsx
// apps/web/app/login/google/callback/page.tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, setToken } from "@/lib/api";

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const expected = sessionStorage.getItem("google_oauth_state");
    sessionStorage.removeItem("google_oauth_state");
    if (!code || !state || state !== expected) {
      setError("Google sign-in could not be verified. Please try again.");
      return;
    }
    (async () => {
      const res = await fetch(`${API_URL}/auth/google/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error === "email_unverified" ? "Your Google email isn't verified." : "Google sign-in failed.");
        return;
      }
      setToken(body.token);
      const next = sessionStorage.getItem("google_oauth_next") ?? "/";
      sessionStorage.removeItem("google_oauth_next");
      router.replace(next);
    })();
  }, [params, router]);

  return (
    <main className="site-main">
      {error ? (
        <>
          <p className="error">{error}</p>
          <a className="link-button" href="/login">Back to login</a>
        </>
      ) : (
        <p>Signing you in with Google…</p>
      )}
    </main>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
```

- [ ] **Step 3 — verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web` → PASS.
- [ ] **Step 4 — commit:** `feat(web): Continue with Google button + OAuth callback page`.

### Task 7: Env config + whole-repo verification

**Files:** Modify `.env.example`.

- [ ] **Step 1 — env.** Append to `.env.example`:

```bash
# Google login (Sprint 36): create an OAuth 2.0 "Web application" client at
# https://console.cloud.google.com/apis/credentials. Authorized redirect URI
# must be GOOGLE_REDIRECT_URI below. Leave the id/secret blank to disable Google
# sign-in (email/password still works; the button shows a friendly message).
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/login/google/callback
```

- [ ] **Step 2 — whole-repo verify:** `npm test && npm run typecheck` → all green.
- [ ] **Step 3 — commit:** `docs: Google login env vars`.
- [ ] **Step 4 — push the branch (do NOT merge):** `git push -u origin sprint-36-google-auth`.

---

## Automated verification

- **Contracts:** `googleCallbackInputSchema` requires a non-empty `code`.
- **Google client (fixture fetcher):** `googleAuthUrl` embeds client_id/redirect_uri/scope/state and throws unconfigured; `exchangeCodeForProfile` returns a lowercased verified profile and rejects unverified email / token & userinfo failures.
- **Service:** `upsertGoogleUser` creates a password-less user with a working session, links to an existing email account (no duplicate), and is idempotent.
- **Routes (real `buildApp`, injected fetcher):** `GET /auth/google/url` is public and returns a URL (503 when unconfigured); `POST /auth/google/callback` exchanges and returns `{user, token}`, and 401s an unverified email.
- **Regression:** existing `auth.test.ts` (register/login/session) stays green against the rebuilt `users` table; `login()` returns null for a password-less (Google-only) user.
- **Web:** `typecheck` + `build` green.

## Founder acceptance checklist

- [ ] With `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` set, `npm run dev`, open `/login`, click **Continue with Google** → Google consent → land in workspaces (`/`).
- [ ] Register `you@company.com` with email/password, log out, then **Continue with Google** using the same Google email → you land in the **same** account (no duplicate; same workspaces).
- [ ] A Google account whose email is unverified is rejected with a clear message.
- [ ] With the Google env vars unset, email/password login is unaffected and the Google button shows "isn't set up yet."

## Known limitations

- Single provider (Google). A second OIDC provider should introduce an `oauth_identities` table rather than more columns on `users`.
- No PKCE and no `id_token` signature verification — we trust the userinfo response fetched server-to-server directly from Google over TLS (the code never transits the browser to us un-exchanged). PKCE is a reasonable later hardening.
- Linking is by verified email only; there is no UI to unlink Google or to merge two pre-existing accounts with different emails.
- `state` CSRF protection lives in the browser (`sessionStorage`); it is not additionally bound server-side.

## Progress log

- 2026-06-26 — Spec + step-by-step plan drafted. Verified against the working tree at `/Users/aditya/Downloads/tuezday-2.0.1` (HEAD `e99d951` "Sprint 34 GTM Insights Dashboard"): confirmed Sprint 19 auth primitives present and reused — `registerAccount`/`login`/`createSession`/`sessionUser`/`getUserByEmail`/`rowToUser` (`apps/api/src/services/auth.ts`), the `users` (NOT NULL `password_hash`, unique `users_email`) and `sessions` tables (`apps/api/src/db/schema.ts:15`), the global auth guard + `PUBLIC_ROUTES` allowlist (`apps/api/src/auth/guard.ts:35`), and `registerAuthRoutes(app, db)` (`apps/api/src/app.ts`). Confirmed the OAuth-app env convention `<PROVIDER>_CLIENT_ID`/`_CLIENT_SECRET` (`apps/api/src/services/connections.ts:55`) — Google login uses the same shape but is **direct OIDC, not Nango** (rationale in Decisions §1). Confirmed `buildApp({ fetcher })` injection and the web auth utils (`apps/web/lib/api.ts`, login page `setToken`). Highest existing migration `0022_rich_bloodstorm.sql` → new one will be `0023`. Branch not yet cut (awaiting founder go-ahead, per one-sprint-at-a-time).
