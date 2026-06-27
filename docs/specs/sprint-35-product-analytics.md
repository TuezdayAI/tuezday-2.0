# Sprint 35 — Product/behavior analytics instrumentation

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U3 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 35"
- **Branch:** `sprint-35-product-analytics`, cut from `main`
- **Merge order:** none. "Builds on: web + api" only. Everything this slice instruments — auth/register (Sprint 19), generate (Sprint 4), approve (Sprint 5), publish (Sprint 17), connect (Sprint 12/25) — is already merged into `main` (verified via `git log`: HEAD = "Sprint 34 GTM Insights Dashboard"; the Sprints 12/17/19/25/27 chains are present). No unmerged 21+ predecessor is required. The unmerged working branches `sprint-30-rag-hardening` / `sprint-31-discovery-expansion` are **not** dependencies.
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

1. **A separate analytics seam, NOT a mirror of `emitEvent`.** The repo already has a domain-event/webhook system (`apps/api/src/services/events.ts` → `emitEvent`). It is the wrong vehicle for analytics: its payloads carry PII (e.g. `draft.approved` ships the full draft `content` — see `apps/api/src/routes/drafts.ts:198`), it delivers signed HMAC webhooks to external URLs, and its vocabulary (`EVENT_TYPES`) is webhook-shaped. Sprint 35 adds an **independent** `AnalyticsSink` with a **curated, non-PII** event set. (DRY note: we deliberately do not reuse `emitEvent` because the two boundaries have different privacy contracts.)
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
- `apps/api/src/db/schema.ts` — add `analyticsOptOut` to `workspaces` (currently `apps/api/src/db/schema.ts:6`).
- `apps/api/drizzle/00NN_workspace-analytics-optout.sql` — generated migration (next number after the current highest, e.g. `0022`).
- `apps/api/src/services/workspaces.ts` — `getAnalyticsOptOut` / `setAnalyticsOptOut`.
- `apps/api/src/app.ts` — add `analytics` to `BuildAppOptions` + default `createAnalyticsSink()`; thread it into the five route registrations below.
- `apps/api/src/routes/auth.ts` — capture `user.registered`.
- `apps/api/src/routes/generations.ts` — capture `generation.created`.
- `apps/api/src/routes/drafts.ts` — capture `draft.approved`.
- `apps/api/src/routes/publications.ts` — capture `draft.published`.
- `apps/api/src/routes/connectors.ts` — capture `connection.connected` (both api-key connect and oauth/complete).
- `apps/api/src/routes/workspaces.ts` — opt-out GET/PUT endpoints.

### New/modified files (Web)
- `apps/web/lib/analytics.ts` — thin `posthog-js` wrapper (`initAnalytics`, `capture`, `identify`, `reset`, `optOut`, `optIn`).
- `apps/web/app/analytics-provider.tsx` — client component: init + `$pageview` on route change.
- `apps/web/app/layout.tsx` — mount `<AnalyticsProvider>` (currently `apps/web/app/layout.tsx`).
- `apps/web/lib/api.ts` — call `identify(userId)` where the token is set, `reset()` in `clearToken()` (currently `apps/web/lib/api.ts:12`/`:16`).
- `apps/web/app/login/page.tsx` — pass the user id to `identify` after auth (uses `setToken(body.token)` at `apps/web/app/login/page.tsx:35`; `body.user.id` is available).
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

**Files:** Modify `packages/contracts/src/index.ts` (append after the Events+webhooks block ~`packages/contracts/src/index.ts:2351`); Test `packages/contracts/test/analytics.test.ts`.

- [ ] **Step 1 — failing test**

```typescript
// packages/contracts/test/analytics.test.ts
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS, setAnalyticsOptOutInputSchema } from "../src/index";

describe("analytics contracts", () => {
  it("enumerates the five funnel events", () => {
    expect(ANALYTICS_EVENTS).toEqual([
      "user.registered",
      "generation.created",
      "draft.approved",
      "draft.published",
      "connection.connected",
    ]);
  });
  it("validates the opt-out toggle", () => {
    expect(setAnalyticsOptOutInputSchema.parse({ optOut: true })).toEqual({ optOut: true });
    expect(setAnalyticsOptOutInputSchema.safeParse({ optOut: "yes" }).success).toBe(false);
  });
});
```

- [ ] **Step 2 — run red:** `npm test -w @tuezday/contracts -- analytics` → FAIL (not exported).
- [ ] **Step 3 — implement.** Append to `packages/contracts/src/index.ts`:

```typescript
// ---------------------------------------------------------------------------
// Product analytics (internal — PostHog). NOT the native customer dashboard.
// ---------------------------------------------------------------------------

/** Curated product-funnel events. Non-PII payloads only (ids/enums/counts). */
export const ANALYTICS_EVENTS = [
  "user.registered",
  "generation.created",
  "draft.approved",
  "draft.published",
  "connection.connected",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export const setAnalyticsOptOutInputSchema = z.object({ optOut: z.boolean() });
export type SetAnalyticsOptOutInput = z.infer<typeof setAnalyticsOptOutInputSchema>;
```

- [ ] **Step 4 — run green:** `npm test -w @tuezday/contracts -- analytics` → PASS.
- [ ] **Step 5 — commit:** `feat(contracts): analytics event vocabulary + opt-out input`.

### Task 2: AnalyticsSink interface, NoopSink, env factory

**Files:** Create `apps/api/src/analytics/sink.ts`. (No standalone test; exercised by Task 3's factory test.)

- [ ] **Step 1 — implement**

```typescript
// apps/api/src/analytics/sink.ts
// Provider-agnostic product-analytics boundary. Routes depend only on this
// (via track.ts). Mirrors the LLM gateway seam.
import type { AnalyticsEvent } from "@tuezday/contracts";

export interface AnalyticsEventInput {
  event: AnalyticsEvent;
  /** Real user id (actor.userId). Required — the system actor is never tracked. */
  distinctId: string;
  /** Workspace for opt-out + grouping; omit for user-lifecycle events. */
  workspaceId?: string;
  /** Non-PII properties only (ids, enums, counts). */
  properties?: Record<string, string | number | boolean | null>;
}

export interface AnalyticsSink {
  /** Fire-and-forget. MUST NOT throw and MUST NOT block the request. */
  capture(input: AnalyticsEventInput): void;
}

export class NoopSink implements AnalyticsSink {
  capture(): void {
    /* intentionally does nothing */
  }
}

/** PostHog when a key is present, else Noop. */
export function createAnalyticsSink(fetcher: typeof fetch = fetch): AnalyticsSink {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return new NoopSink();
  const { PostHogSink } = require("./posthog") as typeof import("./posthog");
  return new PostHogSink(apiKey, process.env.POSTHOG_HOST, fetcher);
}
```

- [ ] **Step 2 — typecheck (expected red until Task 3):** `npm run typecheck -w @tuezday/api` → FAIL (`./posthog` missing). Continue to Task 3 before committing.

### Task 3: PostHogSink

**Files:** Create `apps/api/src/analytics/posthog.ts`; Test `apps/api/test/analytics-sink.test.ts`.

- [ ] **Step 1 — failing test**

```typescript
// apps/api/test/analytics-sink.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { NoopSink, createAnalyticsSink } from "../src/analytics/sink";
import { PostHogSink } from "../src/analytics/posthog";

afterEach(() => {
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
});

describe("PostHogSink", () => {
  it("POSTs a well-formed capture body to /capture/", async () => {
    let url: string | undefined;
    let body: any;
    const fetcher = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    new PostHogSink("phc_test", "https://eu.example.posthog.com", fetcher).capture({
      event: "generation.created",
      distinctId: "user-1",
      workspaceId: "ws-1",
      properties: { taskType: "linkedin_post", channel: "linkedin" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(url).toBe("https://eu.example.posthog.com/capture/");
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "generation.created",
      distinct_id: "user-1",
      properties: { taskType: "linkedin_post", channel: "linkedin", $groups: { workspace: "ws-1" } },
    });
  });

  it("never throws when the network fails", async () => {
    const fetcher = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const sink = new PostHogSink("phc_test", undefined, fetcher);
    expect(() => sink.capture({ event: "draft.approved", distinctId: "u" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("createAnalyticsSink", () => {
  it("returns Noop when no key is set", () => {
    expect(createAnalyticsSink()).toBeInstanceOf(NoopSink);
  });
  it("returns PostHogSink when a key is set", () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    expect(createAnalyticsSink()).toBeInstanceOf(PostHogSink);
  });
});
```

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- analytics-sink` → FAIL.
- [ ] **Step 3 — implement**

```typescript
// apps/api/src/analytics/posthog.ts
import type { AnalyticsEventInput, AnalyticsSink } from "./sink";

const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * PostHog via the public /capture/ REST endpoint. No SDK — one endpoint, one
 * body shape (matches GeminiGateway). Fire-and-forget; swallows every error so
 * a dead analytics endpoint can never break a request.
 */
export class PostHogSink implements AnalyticsSink {
  private readonly host: string;
  constructor(
    private readonly apiKey: string,
    host: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.host = (host ?? DEFAULT_HOST).replace(/\/$/, "");
  }

  capture(input: AnalyticsEventInput): void {
    const properties: Record<string, unknown> = { ...input.properties };
    if (input.workspaceId) properties.$groups = { workspace: input.workspaceId };
    const body = JSON.stringify({
      api_key: this.apiKey,
      event: input.event,
      distinct_id: input.distinctId,
      properties,
      timestamp: new Date().toISOString(),
    });
    void this.fetcher(`${this.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      /* analytics must never affect the request path */
    });
  }
}
```

- [ ] **Step 4 — run green:** `npm test -w @tuezday/api -- analytics-sink` → PASS; then `npm run typecheck -w @tuezday/api` → PASS (Tasks 2+3 together).
- [ ] **Step 5 — commit:** `feat(api): provider-agnostic analytics sink + PostHog impl`.

### Task 4: Opt-out column, service accessors, and the track() helper

**Files:** Modify `apps/api/src/db/schema.ts`, `apps/api/src/services/workspaces.ts`; Create `apps/api/src/analytics/track.ts`; generated migration; Test `apps/api/test/analytics-track.test.ts`.

- [ ] **Step 1 — schema.** Add to the `workspaces` table (`apps/api/src/db/schema.ts:6`):

```typescript
  analyticsOptOut: integer("analytics_opt_out", { mode: "boolean" }).notNull().default(false),
```

- [ ] **Step 2 — generate migration:** `npm run db:generate -w apps/api` → creates the next-numbered `apps/api/drizzle/00NN_*.sql` adding `analytics_opt_out`. Keep drizzle's `meta/_journal.json` entry.
- [ ] **Step 3 — service accessors.** Append to `apps/api/src/services/workspaces.ts` (ensure `eq` from `drizzle-orm` and `workspaces` from `../db/schema` are imported):

```typescript
export function getAnalyticsOptOut(db: Db, workspaceId: string): boolean {
  const row = db
    .select({ analyticsOptOut: workspaces.analyticsOptOut })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  return row?.analyticsOptOut ?? false;
}

export function setAnalyticsOptOut(db: Db, workspaceId: string, optOut: boolean): void {
  db.update(workspaces)
    .set({ analyticsOptOut: optOut, updatedAt: Date.now() })
    .where(eq(workspaces.id, workspaceId))
    .run();
}
```

- [ ] **Step 4 — failing test**

```typescript
// apps/api/test/analytics-track.test.ts
import { describe, expect, it } from "vitest";
import { track } from "../src/analytics/track";
import type { AnalyticsSink, AnalyticsEventInput } from "../src/analytics/sink";
import { createWorkspace, setAnalyticsOptOut } from "../src/services/workspaces";
import { createTestDb } from "./helpers";

function recording() {
  const calls: AnalyticsEventInput[] = [];
  const sink: AnalyticsSink = { capture: (i) => calls.push(i) };
  return { sink, calls };
}

describe("track()", () => {
  it("captures workspace-scoped events when opted in", () => {
    const db = createTestDb();
    const ws = createWorkspace(db, { name: "Acme" });
    const { sink, calls } = recording();
    track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(1);
  });
  it("drops workspace-scoped events when opted out", () => {
    const db = createTestDb();
    const ws = createWorkspace(db, { name: "Acme" });
    setAnalyticsOptOut(db, ws.id, true);
    const { sink, calls } = recording();
    track(db, sink, { event: "generation.created", distinctId: "u1", workspaceId: ws.id });
    expect(calls).toHaveLength(0);
  });
  it("captures user-lifecycle events (no workspace) regardless", () => {
    const db = createTestDb();
    const { sink, calls } = recording();
    track(db, sink, { event: "user.registered", distinctId: "u1" });
    expect(calls).toHaveLength(1);
  });
  it("never throws if the sink throws", () => {
    const db = createTestDb();
    const sink: AnalyticsSink = { capture: () => { throw new Error("boom"); } };
    expect(() => track(db, sink, { event: "draft.approved", distinctId: "u1" })).not.toThrow();
  });
});
```

> Confirm `createWorkspace(db, { name })`'s exact signature/return when you reach this step (it is used widely in `apps/api/test`); adjust the call if it differs.

- [ ] **Step 5 — run red:** `npm test -w @tuezday/api -- analytics-track` → FAIL (`track` missing).
- [ ] **Step 6 — implement**

```typescript
// apps/api/src/analytics/track.ts
import type { Db } from "../db";
import { getAnalyticsOptOut } from "../services/workspaces";
import type { AnalyticsEventInput, AnalyticsSink } from "./sink";

/**
 * The single entry point routes use to record a product event. Honors the
 * workspace opt-out (workspace-scoped events only), then hands to the
 * fire-and-forget sink. Wrapped so neither the lookup nor the sink can break a
 * request.
 */
export function track(db: Db, sink: AnalyticsSink, input: AnalyticsEventInput): void {
  try {
    if (input.workspaceId && getAnalyticsOptOut(db, input.workspaceId)) return;
    sink.capture(input);
  } catch {
    /* analytics is best-effort */
  }
}
```

- [ ] **Step 7 — run green:** `npm test -w @tuezday/api -- analytics-track` → PASS; then `npm test -w @tuezday/api` → full API suite green with the new migration applied.
- [ ] **Step 8 — commit:** `feat(api): workspace analytics opt-out + opt-out-aware track()`.

### Task 5: Wire the sink into buildApp + capture at the five funnel points

**Files:** Modify `apps/api/src/app.ts` + the five route files; Test `apps/api/test/analytics-capture.test.ts`.

- [ ] **Step 1 — failing test** (uses the repo's real auth helpers from `apps/api/test/helpers.ts`)

```typescript
// apps/api/test/analytics-capture.test.ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { AnalyticsSink, AnalyticsEventInput } from "../src/analytics/sink";
import type { LlmGateway } from "../src/llm/gateway";
import { asUser, registerUser, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Body.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

function setup() {
  const captured: AnalyticsEventInput[] = [];
  const analytics: AnalyticsSink = { capture: (i) => captured.push(i) };
  return { db: createTestDb(), analytics, captured };
}

describe("analytics funnel capture", () => {
  it("captures user.registered on POST /auth/register", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    await registerUser(app);
    const ev = captured.find((c) => c.event === "user.registered");
    expect(ev).toBeDefined();
    // PII guard: no email/name on the lifecycle event.
    expect(JSON.stringify(captured)).not.toContain("@test.dev");
  });

  it("captures generation.created on a successful generate", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    const user = await registerUser(app);
    const authed = asUser(app, user.token);
    const ws = (await authed.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    const res = await authed.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/generate`,
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(201);
    const ev = captured.find((c) => c.event === "generation.created");
    expect(ev).toMatchObject({ distinctId: user.id, workspaceId: ws.id });
    expect(ev?.properties).toMatchObject({ taskType: "linkedin_post", channel: "linkedin" });
    expect(JSON.stringify(ev)).not.toContain("Body."); // never ship content
  });

  it("respects the workspace opt-out", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    const user = await registerUser(app);
    const authed = asUser(app, user.token);
    const ws = (await authed.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    await authed.inject({ method: "PUT", url: `/workspaces/${ws.id}/analytics-optout`, payload: { optOut: true } });
    captured.length = 0;
    await authed.inject({ method: "POST", url: `/workspaces/${ws.id}/generate`, payload: { taskType: "linkedin_post", channel: "linkedin" } });
    expect(captured.find((c) => c.event === "generation.created")).toBeUndefined();
  });
});
```

> The opt-out endpoint asserted in the third case is built in Task 6 — keep the first two green as this task's gate; the third goes green after Task 6.

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- analytics-capture` → FAIL (no `analytics` option / nothing captured).
- [ ] **Step 3 — buildApp.** In `apps/api/src/app.ts`: add imports

```typescript
import type { AnalyticsSink } from "./analytics/sink";
import { createAnalyticsSink } from "./analytics/sink";
```

add to `BuildAppOptions`:

```typescript
  /** Product-analytics sink; defaults to PostHog-or-Noop from env. */
  analytics?: AnalyticsSink;
```

add to the destructured defaults:

```typescript
  analytics = createAnalyticsSink(),
```

and pass `analytics` into the five registrations (append the arg):

```typescript
  registerAuthRoutes(app, db, analytics);
  registerGenerationRoutes(app, db, llm, evidence, analytics);
  registerDraftRoutes(app, db, fetcher, llm, analytics);
  registerPublicationRoutes(app, db, connectors, fetcher, analytics);
  registerConnectorRoutes(app, db, connectors, fetcher, analytics);
```

- [ ] **Step 4 — capture `user.registered`** in `apps/api/src/routes/auth.ts`: add `analytics: AnalyticsSink` to `registerAuthRoutes`'s signature, import `track` + the type, and after `const result = registerAccount(db, parsed.data);` (before the 201):

```typescript
      track(db, analytics, { event: "user.registered", distinctId: result.user.id });
```

- [ ] **Step 5 — capture `generation.created`** in `apps/api/src/routes/generations.ts`: add `analytics: AnalyticsSink` to `registerGenerationRoutes`, import `track` + the type, and immediately before `return reply.status(201).send({ ...generation, review, angles, chosenAngle });`:

```typescript
      track(db, analytics, {
        event: "generation.created",
        distinctId: request.actor.userId ?? "system",
        workspaceId: request.params.id,
        properties: {
          taskType: generation.taskType,
          channel: generation.channel,
          personaId: generation.personaId ?? null,
          campaignId: generation.campaignId ?? null,
        },
      });
```

(Skip when `request.actor.userId` is null — the system actor isn't tracked. Simplest: `if (request.actor.userId) track(...)`.)

- [ ] **Step 6 — capture `draft.approved`** in `apps/api/src/routes/drafts.ts`: add `analytics: AnalyticsSink` to `registerDraftRoutes`, import `track` + the type, and inside the existing `if (action === "approve" || action === "reject")` block, right after the `emitEvent(...)` call, add (approve only):

```typescript
            if (action === "approve" && request.actor.userId) {
              track(db, analytics, {
                event: "draft.approved",
                distinctId: request.actor.userId,
                workspaceId: request.params.id,
                properties: { taskType: updated.taskType, channel: updated.channel, campaignId: updated.campaignId ?? null },
              });
            }
```

- [ ] **Step 7 — capture `draft.published`** in `apps/api/src/routes/publications.ts`: add `analytics: AnalyticsSink` to `registerPublicationRoutes`, import `track` + the type, and after `const publication = await createPublication(...)`, before the 201:

```typescript
      if (request.actor.userId) {
        track(db, analytics, {
          event: "draft.published",
          distinctId: request.actor.userId,
          workspaceId: request.params.id,
          properties: { providerKey: publication.providerKey, status: publication.status },
        });
      }
```

- [ ] **Step 8 — capture `connection.connected`** in `apps/api/src/routes/connectors.ts`: add `analytics: AnalyticsSink` to `registerConnectorRoutes`, import `track` + the type. Add the same capture at **both** success points: (a) the oauth/complete handler right before `return reply.status(201).send(getConnection(...))`, and (b) the api-key `connect` handler at its success return. Use the `provider` already in scope:

```typescript
      if (request.actor.userId) {
        track(db, analytics, {
          event: "connection.connected",
          distinctId: request.actor.userId,
          workspaceId: request.params.id,
          properties: { providerKey: provider.key, authMode: provider.authMode },
        });
      }
```

- [ ] **Step 9 — run green:** `npm test -w @tuezday/api -- analytics-capture` (first two cases) → PASS; `npm test -w @tuezday/api` → whole API suite green.
- [ ] **Step 10 — commit:** `feat(api): capture key funnel events through the analytics sink`.

### Task 6: Per-workspace opt-out endpoints

**Files:** Modify `apps/api/src/routes/workspaces.ts`; Test `apps/api/test/analytics-optout.test.ts`.

- [ ] **Step 1 — failing test**

```typescript
// apps/api/test/analytics-optout.test.ts
import { describe, expect, it } from "vitest";
import { buildAuthedApp, createTestDb } from "./helpers";
import type { AnalyticsSink } from "../src/analytics/sink";

const noop: AnalyticsSink = { capture: () => {} };

describe("analytics opt-out endpoints", () => {
  it("defaults opted-in and toggles", async () => {
    const app = await buildAuthedApp({ db: createTestDb(), analytics: noop });
    const ws = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    expect((await app.inject({ method: "GET", url: `/workspaces/${ws.id}/analytics-optout` })).json()).toEqual({ optOut: false });
    const put = await app.inject({ method: "PUT", url: `/workspaces/${ws.id}/analytics-optout`, payload: { optOut: true } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/workspaces/${ws.id}/analytics-optout` })).json()).toEqual({ optOut: true });
  });
  it("400s on bad input", async () => {
    const app = await buildAuthedApp({ db: createTestDb(), analytics: noop });
    const ws = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    const bad = await app.inject({ method: "PUT", url: `/workspaces/${ws.id}/analytics-optout`, payload: { optOut: "nope" } });
    expect(bad.statusCode).toBe(400);
  });
});
```

(The auth guard already 404s unknown workspaces and 403s non-members, so those cases are covered globally — no need to re-test here.)

- [ ] **Step 2 — run red:** `npm test -w @tuezday/api -- analytics-optout` → FAIL.
- [ ] **Step 3 — implement.** In `apps/api/src/routes/workspaces.ts`, import the schema + accessors and register two routes:

```typescript
import { setAnalyticsOptOutInputSchema } from "@tuezday/contracts";
import { getAnalyticsOptOut, setAnalyticsOptOut } from "../services/workspaces";
// ... inside registerWorkspaceRoutes:
  app.get<{ Params: { id: string } }>("/workspaces/:id/analytics-optout", async (request) => {
    return { optOut: getAnalyticsOptOut(db, request.params.id) };
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/analytics-optout", async (request, reply) => {
    const parsed = setAnalyticsOptOutInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", message: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    setAnalyticsOptOut(db, request.params.id, parsed.data.optOut);
    return { optOut: parsed.data.optOut };
  });
```

(The global auth guard enforces membership on `/workspaces/:id/...`, so existence/role checks are already applied before these handlers run.)

- [ ] **Step 4 — run green:** `npm test -w @tuezday/api -- analytics-optout` → PASS; then `npm test -w @tuezday/api` → full suite green, including the previously-pending opt-out case in `analytics-capture.test.ts`.
- [ ] **Step 5 — commit:** `feat(api): per-workspace analytics opt-out endpoints`.

### Task 7: Web client analytics (PostHog) behind a thin wrapper

**Files:** Modify `apps/web/package.json`; Create `apps/web/lib/analytics.ts`, `apps/web/app/analytics-provider.tsx`; Modify `apps/web/app/layout.tsx`, `apps/web/lib/api.ts`, `apps/web/app/login/page.tsx`. Verification = typecheck + build (no web test runner).

- [ ] **Step 1 — dependency:** `npm install posthog-js -w @tuezday/web`.
- [ ] **Step 2 — thin wrapper**

```typescript
// apps/web/lib/analytics.ts
// The only module that imports posthog-js.
import posthog from "posthog-js";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
let started = false;

export function initAnalytics(): void {
  if (started || typeof window === "undefined" || !KEY) return;
  posthog.init(KEY, { api_host: HOST, capture_pageview: false, persistence: "localStorage" });
  started = true;
}
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (started) posthog.capture(event, properties);
}
export function identify(distinctId: string): void {
  if (started) posthog.identify(distinctId);
}
export function reset(): void {
  if (started) posthog.reset();
}
export function optOut(): void {
  if (started) posthog.opt_out_capturing();
}
export function optIn(): void {
  if (started) posthog.opt_in_capturing();
}
```

- [ ] **Step 3 — provider component**

```tsx
// apps/web/app/analytics-provider.tsx
"use client";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { capture, initAnalytics } from "@/lib/analytics";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => { initAnalytics(); }, []);
  useEffect(() => { capture("$pageview", { path: pathname }); }, [pathname]);
  return <>{children}</>;
}
```

- [ ] **Step 4 — mount in layout.** In `apps/web/app/layout.tsx`, wrap the body:

```tsx
import { AnalyticsProvider } from "./analytics-provider";
// ...
      <body>
        <AnalyticsProvider>{children}</AnalyticsProvider>
      </body>
```

- [ ] **Step 5 — identify on auth / reset on logout.** In `apps/web/lib/api.ts`, call `reset()` inside `clearToken()`:

```typescript
import { reset } from "./analytics";
// ...
export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  reset();
}
```

In `apps/web/app/login/page.tsx`, after `setToken(body.token);` add:

```typescript
      identify(body.user.id);
```

(import `identify` from `@/lib/analytics`; `body.user.id` is present in both the login and register responses — see `registerAccount` returning `{ user, token }`.)

- [ ] **Step 6 — verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web` → PASS. With `NEXT_PUBLIC_POSTHOG_KEY` unset, `initAnalytics()` no-ops (no network).
- [ ] **Step 7 — commit:** `feat(web): PostHog client behind a thin wrapper (pageviews + identify)`.

### Task 8: Env config, docs, whole-repo verification

**Files:** Modify `.env.example` (and optionally a one-line note in `CLAUDE.md`).

- [ ] **Step 1 — env.** Append to `.env.example`:

```bash
# Product analytics (internal — PostHog). Leave blank to disable entirely:
# API uses a Noop sink; the web client never initializes.
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

- [ ] **Step 2 — whole-repo verify:** `npm test && npm run typecheck` → all green.
- [ ] **Step 3 — commit:** `docs: PostHog analytics env vars`.
- [ ] **Step 4 — push the branch (do NOT merge):** `git push -u origin sprint-35-product-analytics`.

---

## Automated verification

- **Contracts:** `ANALYTICS_EVENTS` shape; opt-out input validation.
- **Sink:** PostHog `/capture/` request shape against a fixture fetcher; never-throws on network failure; factory returns Noop vs PostHog by env.
- **track():** opt-out honored for workspace-scoped events; user-lifecycle events bypass workspace opt-out; never throws.
- **Capture (authed app, recording sink):** each of the five funnel routes fires its event with the right `distinctId`/`workspaceId`/props; **PII guards** assert no content/email leaks into properties; opt-out suppresses workspace events.
- **Opt-out endpoints:** default-in, toggle, bad-input 400 (membership/existence covered by the global guard).
- **Web:** `typecheck` + `build` green; disabled cleanly when keys are unset.

## Founder acceptance checklist

- [ ] With `POSTHOG_API_KEY` + `NEXT_PUBLIC_POSTHOG_KEY` set, `npm run dev`, then: register → create workspace → generate → approve → publish → connect a provider.
- [ ] In PostHog, the events `user.registered → generation.created → draft.approved → draft.published → connection.connected` appear under the same person, and a **generate→approve→publish funnel** is visible.
- [ ] Toggle a workspace opted-out (`PUT /workspaces/:id/analytics-optout {optOut:true}`) → no further workspace events for it.
- [ ] With keys unset, the app runs normally and emits nothing (Noop sink; web never initializes).
- [ ] No PII (draft/generation content, emails, names, tokens, credentials) appears in any captured property.

## Known limitations

- All capture is best-effort/fire-and-forget; a dropped event is never retried (acceptable for product analytics).
- Opt-out is per-workspace (+ global kill switch); there is no per-user cross-workspace opt-out UI yet.
- `user.registered` is gated only by the global kill switch (no workspace exists at register time); it carries the user id only.

## Progress log

- 2026-06-26 — Spec + step-by-step plan drafted. Verified against the working tree at `/Users/aditya/Downloads/tuezday-2.0.1` (HEAD `e99d951` "Sprint 34 GTM Insights Dashboard"): confirmed real homes for all five funnel events — `POST /auth/register` (`routes/auth.ts:18`), generate 201 (`routes/generations.ts:161`), approve `emitEvent` site (`routes/drafts.ts:198`), publish 201 (`routes/publications.ts:105`), connect success (`routes/connectors.ts:138` oauth/complete + the api-key `connect` handler). Confirmed `request.actor.userId` is available (auth guard, Sprint 19) for `distinct_id`; confirmed the `emitEvent`/webhook system ships PII (draft `content`) and so is deliberately NOT reused. Confirmed test auth helpers (`registerUser`/`asUser`/`buildAuthedApp` in `apps/api/test/helpers.ts`), the `buildApp` injection pattern (`llm`/`evidence`/`connectors`/`mailer`), and the web auth/token utils (`apps/web/lib/api.ts`, `@/` → `./` alias). Branch not yet cut (awaiting founder go-ahead, per one-sprint-at-a-time).
