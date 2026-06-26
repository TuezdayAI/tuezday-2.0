# Sprint 40 — MCP server + scoped public API

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** A5 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 40"
- **Branch:** `sprint-40-mcp-public-api`, cut from `main`
- **Merge order:** **one caveat.** "Builds on: stable `packages/contracts`, Sprint 19 (auth)" — both on `main`. The four actions submit-idea / list+approve-drafts / **launch-campaign** all reuse services on `main` (`signals.ts`, `drafts.ts`, `launches.ts`). **`fetch-insights` depends on Sprint 34's insights service, which is NOT on `main`** (Sprint 34 is an unmerged branch). Per CLAUDE.md's dependency caveat: build the three main-only actions now; **gate `fetch-insights` behind Sprint 34** — either land it after Sprint 34 merges, or branch the insights tool off `sprint-34-gtm-insights-dashboard` and state that merge order. This spec implements the three now and stubs `fetch-insights` to return `503 insights_unavailable` until Sprint 34 is on `main` (no faking — the tool is advertised but reports unavailable).
- **Size:** M.
- **Do NOT merge into `main`.** Push the branch; founder reviews/accepts/merges. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

> **For agentic workers:** self-contained spec. Strict TDD. REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Goal

Let external agents/tools drive Tuezday through a **scoped public REST API** and an **MCP server**, and establish the **action surface** the future chat interface (Sprint 42) will reuse.

Founder acceptance (from the roadmap):

> An MCP client submits an idea and approves a draft using a scoped key.

---

## Decisions locked (recommended defaults)

1. **A dedicated `/api/v1` surface with its own API-key auth — do not entangle the human-session guard.** The existing global guard (sessions/worker token) stays untouched. A separate preHandler authenticates `/api/v1/*` via an API key and resolves an `ApiActor` carrying `workspaceId` + `scopes`. This keeps the public contract explicit and versioned, and avoids weakening the app's session model.
2. **Keys are workspace-scoped, hashed, shown once.** `api_keys` rows store `sha256(rawKey)` only; the raw `tzk_<random>` key is returned at creation and never again (same model as session tokens). Each key carries a `scopes` array.
3. **Scopes mirror the roadmap:** `ideas:write`, `drafts:read`, `drafts:write`, `analytics:read`, `campaigns:launch`. Each `/api/v1` route declares the scope it requires; a missing scope → `403 insufficient_scope`. (`drafts:write` covers approve/reject.)
4. **The public API is a thin shell over existing services — no new business logic.** `POST /api/v1/ideas` → `createSignal`; `GET /api/v1/drafts` → `listDrafts(state="pending_review")`; `POST /api/v1/drafts/:id/approve|reject` → `applyDraftAction`; `POST /api/v1/launches` → `createLaunch`; `GET /api/v1/insights/*` → insights service (Sprint 34, gated). This *is* the reusable action surface for Sprint 42.
5. **The MCP server is a separate app (`apps/mcp`) that calls the public REST API** with a key — it owns no DB access. Built on `@modelcontextprotocol/sdk` over stdio. One tool per action. This respects the boundary ("chat/MCP is a presentation/orchestration layer over existing services").
6. **`fetch-insights` is advertised but returns `insights_unavailable` until Sprint 34 merges** (no stub data). The merge-order note above governs enabling it.

---

## Out of scope (YAGNI)
- OAuth client credentials / per-user keys (workspace keys only).
- Rate limiting / quotas on the public API (note as hardening; entitlements/Sprint 37 can later meter it).
- Write actions beyond ideas/drafts/launches (e.g. editing brain docs) — additive later behind new scopes.
- Hosting/transport for MCP beyond stdio (HTTP/SSE transport is a later add).
- Web test runner.

---

## Architecture & boundary

```
External agent / MCP client
        │ Authorization: Bearer tzk_…   (scoped key)
        ▼
/api/v1/*  ──apiKeyAuth preHandler──►  ApiActor { workspaceId, scopes }  ──requireScope("…")──►
   POST /api/v1/ideas              ideas:write     → createSignal
   GET  /api/v1/drafts            drafts:read     → listDrafts(pending_review)
   POST /api/v1/drafts/:id/approve drafts:write    → applyDraftAction(approve)
   POST /api/v1/drafts/:id/reject  drafts:write    → applyDraftAction(reject)
   POST /api/v1/launches          campaigns:launch→ createLaunch
   GET  /api/v1/insights/*        analytics:read  → insights service (Sprint 34; 503 until merged)

apps/mcp (stdio, @modelcontextprotocol/sdk)
   tools: submit_idea, list_drafts, approve_draft, launch_campaign, fetch_insights
        └─ each → fetch {TUEZDAY_API_URL}/api/v1/… with TUEZDAY_API_KEY
```

### New files
- `apps/api/src/auth/api-key.ts` — `apiKeyAuth` preHandler + `requireScope(scope)` helper; `ApiActor`.
- `apps/api/src/services/api-keys.ts` — `createApiKey`, `verifyApiKey`, `listApiKeys`, `revokeApiKey`.
- `apps/api/src/routes/public-api.ts` — the `/api/v1/*` routes.
- `apps/api/src/routes/api-keys.ts` — session-guarded key management (`/workspaces/:id/api-keys`).
- `apps/mcp/` — new workspace: `package.json`, `src/index.ts` (MCP server), `tsconfig.json`.
- Tests: `apps/api/test/api-keys.test.ts`, `apps/api/test/public-api.test.ts`.

### Modified files
- `packages/contracts/src/index.ts` — `API_SCOPES`, api-key schemas, public-action input schemas (reuse existing where possible).
- `apps/api/src/db/schema.ts` — `api_keys` table.
- `apps/api/drizzle/00NN_api-keys.sql` — generated (next after `0022` on `main`; renumber on collision).
- `apps/api/src/app.ts` — register the public-API routes (with their own preHandler scope) **before** they’d be caught by the session guard's catch-all; register `api-keys` management routes; ensure the session guard's preHandler **skips `/api/v1/*`** (those authenticate via key).
- `apps/api/src/auth/guard.ts` — make the guard ignore `/api/v1/*` (delegated to `apiKeyAuth`); keep everything else unchanged.
- root `package.json` / workspaces — add `apps/mcp`.
- `.env.example` — `TUEZDAY_API_URL`, `TUEZDAY_API_KEY` (for the MCP server).

---

## Data model

```ts
// apps/api/src/db/schema.ts
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),         // sha256 of the raw key
  scopesJson: text("scopes_json").notNull(),   // JSON string[] of API_SCOPES
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("api_keys_hash").on(t.keyHash)]);
```

```ts
// packages/contracts/src/index.ts
export const API_SCOPES = ["ideas:write", "drafts:read", "drafts:write", "analytics:read", "campaigns:launch"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});
// Public-action inputs reuse existing schemas: createSignalInputSchema (ideas),
// createLaunchInputSchema (launches), and the approval action body for drafts.
```

---

## Implementation plan (TDD, bite-sized)

> Baseline: `git checkout main && git pull`, `npm install`, `npm test`, `git checkout -b sprint-40-mcp-public-api`.

### Task 1: Scope/key contracts + api_keys schema
- [ ] **Test** (`packages/contracts/test/api-scopes.test.ts`): `API_SCOPES` includes `ideas:write` + `drafts:write`; `createApiKeyInputSchema` requires ≥1 scope.
- [ ] **Implement** `API_SCOPES` + schemas; add the `api_keys` table; `npm run db:generate`; `npm test -w @tuezday/api`. **Commit:** `feat: API scopes + api_keys table`.

### Task 2: api-keys service + management routes
- [ ] **Test** (`apps/api/test/api-keys.test.ts`): `createApiKey` returns a `tzk_`-prefixed raw key once and stores only its hash; `verifyApiKey(raw)` resolves to `{ workspaceId, scopes }` for a live key, `null` for a revoked/unknown key, and updates `lastUsedAt`; management routes create/list(masked)/revoke under `/workspaces/:id/api-keys` (session-guarded; owner only).
- [ ] **Run red** → implement `services/api-keys.ts` + `routes/api-keys.ts` (+ register in `app.ts`). **Run green. Commit:** `feat(api): scoped API key service + management routes`.

### Task 3: API-key auth preHandler + scope guard
- [ ] **Test** (`apps/api/test/public-api.test.ts`, part 1): a request to `/api/v1/drafts` with no key → `401`; with a key lacking `drafts:read` → `403 insufficient_scope`; with the right scope → `200`. The **session** guard does not interfere with `/api/v1/*`.
- [ ] **Run red** → implement `auth/api-key.ts` (`apiKeyAuth` decorates `request.apiActor`; `requireScope(scope)` returns a preHandler). In `auth/guard.ts`, early-return for paths starting `/api/v1/`. In `app.ts`, register `public-api` routes with `apiKeyAuth` + per-route `requireScope`.
- [ ] **Run green. Commit:** `feat(api): /api/v1 key auth + scope enforcement`.

### Task 4: Public actions (ideas / drafts / launches)
- [ ] **Test** (part 2): with a key scoped `ideas:write,drafts:read,drafts:write,campaigns:launch`:
  - `POST /api/v1/ideas {content, source}` → `201`, and the signal appears via the existing app route.
  - `GET /api/v1/drafts` → only `pending_review` drafts for the key's workspace.
  - `POST /api/v1/drafts/:id/approve` → draft becomes `approved`; an already-approved draft → `409 invalid_transition`.
  - `POST /api/v1/launches {name, audienceId, channels}` → `201`.
- [ ] **Run red** → implement the handlers as thin shells: validate with the **existing** schemas (`createSignalInputSchema`, `createLaunchInputSchema`), call the existing services (`createSignal`, `listDrafts`, `applyDraftAction`, `createLaunch`) with `actor = { userId: null, label: "api:"+keyId }`. Map `InvalidTransitionError`→409.
- [ ] **Run green** + full `npm test`. **Commit:** `feat(api): public actions — ideas, drafts read/approve, launches`.

### Task 5: fetch-insights (gated by Sprint 34)
- [ ] **Test** (part 3): `GET /api/v1/insights/...` with `analytics:read` returns `503 insights_unavailable` while Sprint 34 is not on `main`.
- [ ] **Implement** the route to detect the insights service's presence (feature flag / dynamic import guard) and return `503 insights_unavailable` until it exists. Add a code comment + the merge-order note pointing at Sprint 34. **Commit:** `feat(api): insights endpoint (gated until Sprint 34 merges)`.

### Task 6: MCP server (`apps/mcp`)
- [ ] Scaffold `apps/mcp` workspace: add `@modelcontextprotocol/sdk` and a `dev`/`build`/`typecheck` script; `src/index.ts` creates an MCP server over stdio exposing tools `submit_idea`, `list_drafts`, `approve_draft`, `launch_campaign`, `fetch_insights`. Each tool validates inputs and calls `fetch(${TUEZDAY_API_URL}/api/v1/…, { headers: { Authorization: Bearer ${TUEZDAY_API_KEY} } })`, returning the JSON result (or surfacing `403/503`). No DB access.
- [ ] **Verify:** `npm run typecheck -w @tuezday/mcp && npm run build -w @tuezday/mcp`. (No vitest for MCP; the public API it calls is fully covered by Task 4 tests.) **Commit:** `feat(mcp): stdio MCP server over the /api/v1 surface`.

### Task 7: key management UI + env + push
- [ ] Add `apps/web/app/workspaces/[id]/api-keys/page.tsx`: create a key (pick scopes → show the raw key once with a copy button), list masked keys, revoke.
- [ ] Append `TUEZDAY_API_URL`/`TUEZDAY_API_KEY` (MCP) to `.env.example`; document running the MCP server.
- [ ] `npm test && npm run typecheck` green; `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): API key management UI + docs`. Then `git push -u origin sprint-40-mcp-public-api` (**do not merge**).

---

## Automated verification
- Contracts: scopes + key input.
- api-keys: hashed storage, raw-once, verify/revoke, `lastUsedAt`.
- public-api: 401 no key / 403 wrong scope / 200 right scope; session guard ignores `/api/v1`; ideas/drafts/launches happy paths + 409 illegal transition; insights 503 (gated).
- MCP: typecheck + build.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] Create a scoped key (`ideas:write`, `drafts:read`, `drafts:write`) in the UI; copy the raw key once.
- [ ] Point an MCP client at `apps/mcp` with that key → `submit_idea` creates a signal; `list_drafts` shows pending drafts; `approve_draft` approves one — all visible in the app.
- [ ] A key missing `drafts:write` is refused (`insufficient_scope`) when approving.
- [ ] `fetch_insights` reports "unavailable" until Sprint 34 is merged (then it returns real data).

## Known limitations
- Workspace-scoped keys only (no per-user keys); no rate limiting/quotas yet.
- `fetch-insights` is inert until Sprint 34 (insights service) lands on `main` — by design (no faked data).
- MCP transport is stdio only in v1.
- Public-API actors are labelled `api:<keyId>` with `userId: null` in decision logs.

## Progress log
- 2026-06-26 — Spec drafted against `main` (HEAD Sprint 31). Verified reuse points: `createSignal` (`services/signals.ts`) + `createSignalInputSchema`; `listDrafts`/`applyDraftAction`/`InvalidTransitionError` (`services/drafts.ts`); `createLaunch` (`services/launches.ts`) + `createLaunchInputSchema`; auth guard structure (`auth/guard.ts`). **Confirmed insights (Sprint 34) is NOT on `main`** → `fetch-insights` gated with a merge-order note. Highest migration on `main` = `0022_rich_bloodstorm.sql`. Branch not yet cut (awaiting founder go-ahead).
- 2026-06-27 — Re-saved after the untracked working-tree copy was lost during branch switches; content unchanged.
