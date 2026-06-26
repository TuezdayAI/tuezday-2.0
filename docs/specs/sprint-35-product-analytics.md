# Sprint 35 — Product/behavior analytics instrumentation

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U3 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 35"
- **Branch:** `sprint-35-product-analytics`, cut from `main`
- **Merge order:** none. "Builds on: web + api" only. Everything this slice instruments — auth/register (Sprint 19), generate (Sprint 4), approve (Sprint 5), publish (Sprint 17), connect (Sprint 12/25) — is already merged into `main`. No unmerged 21+ predecessor is required. The unmerged working branches `sprint-30-rag-hardening` / `sprint-31-discovery-expansion` are **not** dependencies.
- **Size:** S–M.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

> **For agentic workers:** this spec is self-contained (the founder resets the session between sprints). Implement it task-by-task with strict TDD — write the failing test first, run it red, implement minimally, run it green, commit. Steps use checkbox (`- [ ]`) syntax for tracking. REQUIRED SUB-SKILL: superpowers:executing-plans (or superpowers:subagent-driven-development).

---

## Goal

Capture how users actually use the platform — the **key product funnel** onboarding → generate → approve → publish → connect — to **PostHog** (internal product analytics), behind a thin, provider-agnostic analytics interface, with per-workspace privacy opt-out and strict PII minimization.

Founder acceptance (from the roadmap):

> Events flow to PostHog; the **generate→approve→publish funnel** is visible.

This is **internal product/web analytics**. It is a different surface from the **native customer GTM dashboard** (Sprint 34) — that decision is locked in CLAUDE.md ("Analytics: PostHog (product/web) … customer dashboard stays native"). Sprint 35 adds **no** customer-facing reporting.

---

## Decisions locked (recommended defaults)

1. **A separate analytics seam, NOT a mirror of `emitEvent`.** The repo already has a domain-event/webhook system (`apps/api/src/services/events.ts` → `emitEvent`). It is the wrong vehicle for analytics: its payloads carry PII (e.g. `draft.approved` ships the full draft `content` — see `apps/api/src/routes/drafts.ts`), it delivers signed HMAC webhooks to external URLs, and its vocabulary (`EVENT_TYPES`) is webhook-shaped. Sprint 35 adds an **independent** `AnalyticsSink` with a **curated, non-PII** event set. (DRY note: we deliberately do not reuse `emitEvent` because the two boundaries have different privacy contracts.)
2. **Mirror the LLM-gateway seam.** `AnalyticsSink` is an interface (`apps/api/src/analytics/sink.ts`); `PostHogSink` is the impl (REST `/capture/`, no SDK, fire-and-forget); `NoopSink` is the default when `POSTHOG_API_KEY` is unset and in every test. Injected through `buildApp({ analytics })` exactly like `llm`, `evidence`, `connectors`, `mailer`. Routes never touch PostHog — they call a thin `track()` helper.
3. **`distinct_id` = the real user id** (`request.actor.userId`), which auth (Sprint 19) already attaches to every authenticated request. The **system/worker actor** (`actor.userId === null`) is never tracked. The web client calls `identify(userId)` on login/register so client pageviews join server funnel events on the same id.
4. **Curated funnel events, non-PII properties only** (ids, enums, counts). Never send draft/generation content, emails, names, tokens, or credentials.
5. **Privacy/opt-out is per-workspace** (`workspaces.analyticsOptOut`, default opted-in) for workspace-scoped events; plus a global kill switch (no `POSTHOG_API_KEY` ⇒ `NoopSink` ⇒ nothing leaves the process). The user-lifecycle event (`user.registered`) has no workspace yet, carries only the user id (no email/name), and is gated solely by the global kill switch.
6. **No new worker job, no polling.** Capture is synchronous-but-fire-and-forget at the existing request path; it must never block or fail a request.

---

## Out of scope (YAGNI)

- Any customer-facing dashboard or in-app charts (that is Sprint 34, native — explicitly a different surface).
- Server-side feature flags / A-B testing / session replay (PostHog capture only).
- Per-user (cross-workspace) opt-out UI beyond the workspace toggle + global kill switch.
- Backfilling historical events.
- A web test runner (the web workspace has none today; web verification is `typecheck` + `build`).
- Instrumenting every route — only the five funnel steps the roadmap names.

---

## Architecture & boundary

```
Web (Next.js)                         API (Fastify)
─────────────                         ─────────────
apps/web/lib/analytics.ts  ──init──►  POST /capture/ (PostHog)
   identify() on login                      ▲
   $pageview on route change                │ PostHogSink (REST, no SDK)
                                            │
route handler ──track(db, analytics, {…})──►│  AnalyticsSink (interface)
   (register/generate/approve/                  └─ NoopSink (default / tests)
    publish/connect)
```

- **Native boundary owned:** the funnel definition + the `AnalyticsSink` interface. **Integrated behind it:** PostHog (swap/disable by changing one factory).
- Routes depend only on `track()` (which depends only on `AnalyticsSink`). Swapping or disabling PostHog never touches a route — same rule as the LLM gateway.

### New files (API)
- `apps/api/src/analytics/sink.ts` — `AnalyticsSink`, `AnalyticsEventInput`, `NoopSink`, `createAnalyticsSink()` env factory.
- `apps/api/src/analytics/posthog.ts` — `PostHogSink`.
- `apps/api/src/analytics/track.ts` — opt-out-aware, never-throws `track()`.
- `apps/api/test/analytics-sink.test.ts`, `apps/api/test/analytics-track.test.ts`, `apps/api/test/analytics-capture.test.ts`.

### Modified files (API)
- `packages/contracts/src/index.ts` — `ANALYTICS_EVENTS` vocab + `setAnalyticsOptOutInputSchema`.
- `apps/api/src/db/schema.ts` — add `analyticsOptOut` to `workspaces`.
- `apps/api/drizzle/00NN_workspace-analytics-optout.sql` — generated migration (next number after the current highest).
- `apps/api/src/services/workspaces.ts` — `getAnalyticsOptOut` / `setAnalyticsOptOut`.
- `apps/api/src/app.ts` — add `analytics` to `BuildAppOptions` + default `createAnalyticsSink()`; thread it into the five route registrations.
- `apps/api/src/routes/auth.ts` — capture `user.registered`.
- `apps/api/src/routes/generations.ts` — capture `generation.created`.
- `apps/api/src/routes/drafts.ts` — capture `draft.approved`.
- `apps/api/src/routes/publications.ts` — capture `draft.published`.
- `apps/api/src/routes/connectors.ts` — capture `connection.connected` (both api-key connect and oauth/complete).
- `apps/api/src/routes/workspaces.ts` — opt-out GET/PUT endpoints.

### New/modified files (Web)
- `apps/web/lib/analytics.ts` — thin `posthog-js` wrapper (`initAnalytics`, `capture`, `identify`, `reset`, `optOut`, `optIn`).
- `apps/web/app/analytics-provider.tsx` — client component: init + `$pageview` on route change.
- `apps/web/app/layout.tsx` — mount `<AnalyticsProvider>`.
- `apps/web/lib/api.ts` — call `identify(userId)` where the token is set, `reset()` in `clearToken()`.
- `apps/web/app/login/page.tsx` — pass the user id to `identify` after auth.
- `apps/web/package.json` — add `posthog-js`.

### Config / docs
- `.env.example` — `POSTHOG_API_KEY`, `POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.

---

## Data model

One additive column on `workspaces` (privacy opt-out). No other schema change.

```ts
// apps/api/src/db/schema.ts — workspaces table
analyticsOptOut: integer("analytics_opt_out", { mode: "boolean" }).notNull().default(false),
```

### Captured events (curated; non-PII)

| Funnel step | Event | Fired at | distinct_id | Properties (non-PII) |
|---|---|---|---|---|
| onboarding | `user.registered` | `routes/auth.ts` (after `registerAccount`, before 201) | new user id | _(none)_ |
| generate | `generation.created` | `routes/generations.ts` (before the 201) | `actor.userId` | `taskType`, `channel`, `personaId?`, `campaignId?` |
| approve | `draft.approved` | `routes/drafts.ts` (approve branch) | `actor.userId` | `taskType`, `channel`, `campaignId?` |
| publish | `draft.published` | `routes/publications.ts` (after `createPublication`) | `actor.userId` | `providerKey`, `status` |
| connect | `connection.connected` | `routes/connectors.ts` (api-key connect **and** oauth/complete success) | `actor.userId` | `providerKey`, `authMode` |

---

## Implementation plan (TDD, bite-sized)

> Baseline first: `git checkout main && git pull`, `npm install`, `npm test` (record the green baseline count), then cut `git checkout -b sprint-35-product-analytics`.

### Task 1: Analytics event vocabulary in contracts
- [ ] **Failing test** (`packages/contracts/test/analytics.test.ts`): `ANALYTICS_EVENTS` equals `["user.registered","generation.created","draft.approved","draft.published","connection.connected"]`; `setAnalyticsOptOutInputSchema` parses `{optOut:true}` and rejects `{optOut:"yes"}`.
- [ ] **Run red** → implement `ANALYTICS_EVENTS`/`AnalyticsEvent`/`setAnalyticsOptOutInputSchema` in `packages/contracts/src/index.ts`.
- [ ] **Run green. Commit:** `feat(contracts): analytics event vocabulary + opt-out input`.

### Task 2: AnalyticsSink interface, NoopSink, env factory
- [ ] Create `apps/api/src/analytics/sink.ts` with `AnalyticsEventInput` (`event`, `distinctId`, optional `workspaceId`, non-PII `properties`), `AnalyticsSink.capture` (fire-and-forget, never throws), `NoopSink`, and `createAnalyticsSink(fetcher?)` (PostHog when `POSTHOG_API_KEY` set, else Noop; lazy-`require` the impl).
- [ ] Typecheck expected red until Task 3 (`./posthog` missing).

### Task 3: PostHogSink
- [ ] **Failing test** (`apps/api/test/analytics-sink.test.ts`, fixture fetcher): POSTs to `<host>/capture/` with `{api_key, event, distinct_id, properties.$groups.workspace}`; never throws on network failure; factory returns Noop/PostHog by env.
- [ ] **Run red** → implement `apps/api/src/analytics/posthog.ts` (REST `/capture/`, `void fetch(...).catch(()=>{})`, 5s timeout).
- [ ] **Run green** + `npm run typecheck -w @tuezday/api`. **Commit:** `feat(api): provider-agnostic analytics sink + PostHog impl`.

### Task 4: Opt-out column, service accessors, track() helper
- [ ] **Schema:** add `analyticsOptOut` to `workspaces`; `npm run db:generate`.
- [ ] Add `getAnalyticsOptOut`/`setAnalyticsOptOut` to `services/workspaces.ts`.
- [ ] **Failing test** (`apps/api/test/analytics-track.test.ts`): captures workspace-scoped events when opted in; drops when opted out; captures user-lifecycle (no workspace) regardless; never throws if the sink throws.
- [ ] **Run red** → implement `apps/api/src/analytics/track.ts` (opt-out-aware, wrapped in try/catch).
- [ ] **Run green** + full `npm test -w @tuezday/api`. **Commit:** `feat(api): workspace analytics opt-out + opt-out-aware track()`.

### Task 5: Wire the sink into buildApp + capture at the five funnel points
- [ ] **Failing test** (`apps/api/test/analytics-capture.test.ts`, real auth helpers + recording sink): `user.registered` on register (no email leak); `generation.created` with right distinctId/workspaceId/props (no content leak); opt-out suppresses workspace events.
- [ ] **Run red** → add `analytics` to `BuildAppOptions` (default `createAnalyticsSink()`); thread into `registerAuthRoutes`, `registerGenerationRoutes`, `registerDraftRoutes`, `registerPublicationRoutes`, `registerConnectorRoutes`. Add `track(...)` at each funnel point (only when `actor.userId` is non-null for workspace events).
- [ ] **Run green** + full `npm test -w @tuezday/api`. **Commit:** `feat(api): capture key funnel events through the analytics sink`.

### Task 6: Per-workspace opt-out endpoints
- [ ] **Failing test** (`apps/api/test/analytics-optout.test.ts`): default opted-in; GET/PUT toggle; 400 on bad input (membership/existence covered by the global guard).
- [ ] **Run red** → add `GET`/`PUT /workspaces/:id/analytics-optout` in `routes/workspaces.ts`.
- [ ] **Run green** + full suite. **Commit:** `feat(api): per-workspace analytics opt-out endpoints`.

### Task 7: Web client analytics behind a thin wrapper
- [ ] `npm install posthog-js -w @tuezday/web`; add `apps/web/lib/analytics.ts` (only importer of posthog-js: `initAnalytics`/`capture`/`identify`/`reset`/`optOut`/`optIn`); `apps/web/app/analytics-provider.tsx` (init + `$pageview` on pathname change); mount in `layout.tsx`; `identify(body.user.id)` after login, `reset()` in `clearToken()`.
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): PostHog client behind a thin wrapper (pageviews + identify)`.

### Task 8: Env, docs, whole-repo verification
- [ ] Append `POSTHOG_*` / `NEXT_PUBLIC_POSTHOG_*` to `.env.example`.
- [ ] `npm test && npm run typecheck` green. **Commit:** `docs: PostHog analytics env vars`. Then `git push -u origin sprint-35-product-analytics` (**do not merge**).

---

## Automated verification
- Contracts: `ANALYTICS_EVENTS` shape; opt-out input validation.
- Sink: PostHog `/capture/` request shape; never-throws; factory Noop vs PostHog by env.
- track(): opt-out honored for workspace events; user-lifecycle bypasses workspace opt-out; never throws.
- Capture (authed app, recording sink): each funnel route fires with the right ids/props; PII guards assert no content/email leaks; opt-out suppresses.
- Opt-out endpoints: default-in, toggle, bad-input 400.
- Web: typecheck + build.

## Founder acceptance checklist
- [ ] With keys set, `npm run dev`, then register → create workspace → generate → approve → publish → connect.
- [ ] In PostHog, `user.registered → generation.created → draft.approved → draft.published → connection.connected` appear under one person; a generate→approve→publish funnel is visible.
- [ ] Opt a workspace out → no further workspace events.
- [ ] With keys unset, the app runs and emits nothing.
- [ ] No PII in any captured property.

## Known limitations
- Best-effort/fire-and-forget; dropped events are not retried.
- Opt-out is per-workspace (+ global kill switch); no per-user cross-workspace opt-out UI.
- `user.registered` is gated only by the global kill switch (no workspace at register time); carries the user id only.

## Progress log
- 2026-06-26 — Spec + step-by-step plan drafted. Verified against the working tree: real homes for all five funnel events; `request.actor.userId` available (auth guard, Sprint 19) for `distinct_id`; the `emitEvent`/webhook system ships PII (draft `content`) and so is deliberately NOT reused. Confirmed test auth helpers (`registerUser`/`asUser`/`buildAuthedApp`), the `buildApp` injection pattern, and the web auth/token utils. Branch not yet cut (awaiting founder go-ahead).
- 2026-06-27 — Re-saved after the untracked working-tree copy was lost during branch switches; content unchanged.
