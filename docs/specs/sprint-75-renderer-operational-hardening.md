# Sprint 75 — Renderer extraction & operational hardening

**Branch:** `sprint-75-renderer-operational-hardening`, forked from the clean committed chain at `c028e8a`.
**Merge order:** This branch contains the committed Sprint 60–71 and 76–78 chain represented by `c028e8a`; it must be reviewed against that same chain. Sprint 75 has no explicit PRD dependency on Sprint 73 or 74 and does not implement either sprint's queue or Postgres work.
**PRD:** `docs/plans/prd-agentic-platform.md` §9, Sprint 75; operational tail from `docs/deferred-improvements.md` items #3, #5, #6, #9, #10, and #17.

---

## 1. Problem

Sprint 75 closes one infrastructure hazard and six deliberately deferred operational compromises.

The design renderer currently launches and shares one Playwright browser inside the API process. A Chromium memory spike, crash, or stuck page therefore competes with authenticated product traffic and can take the API down. The existing render function is injectable, so the missing piece is process isolation rather than a new design pipeline.

The social scheduler has six smaller correctness gaps:

1. Instagram video and reel publishing polls container readiness inside the request for up to twenty seconds instead of returning promptly and resuming on the worker.
2. A nonexistent spring-forward wall-clock time is silently shifted to a nearby instant.
3. Cadence fill can discover an invalid social post only by throwing while it builds the publication action, which aborts the rest of that fill instead of returning a useful preflight warning.
4. Posting caps use UTC calendar days rather than the connected account's local day.
5. The kill switch clears queued cadence actions on the next fill, but the final publication path does not independently prove that automated posting is still allowed immediately before provider dispatch.
6. Automated replies consume the same undifferentiated per-connection budget as original publications, also measured in UTC.

These are operational hardening changes. They must preserve Tuezday's core product invariants: every external change remains governed, content approval and external-action authorization stay distinct, retries are idempotent, provider uncertainty is never reported as success, and all account/workspace state remains tenant-scoped.

## 2. Goal

Make rendering and scheduled social delivery safe to operate under real load:

- Chromium runs in a separately deployable, authenticated internal service.
- The API reaches it only through the existing renderer seam and never imports or owns Playwright.
- Cadence slots and daily budgets use explicit IANA timezones with deterministic DST behavior.
- Invalid auto-slotted posts are reported before scheduling and never block valid drafts behind them.
- A kill-switch change is enforced again at the last reversible point before provider I/O.
- Instagram video/reel processing becomes durable, non-blocking, and resumable on the existing worker tick.

## 3. Renderer extraction

### 3.1 Shared wire contract

`packages/contracts` owns the internal render request schema:

```ts
export const renderTemplateSchema = z.object({
  html: z.string().min(1).max(500_000),
  css: z.string().max(500_000),
  placeholders: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).max(100),
});

export const renderRequestSchema = z.object({
  template: renderTemplateSchema,
  values: z.record(z.string().max(20_000)),
  width: z.number().int().min(64).max(4096).default(1080),
  height: z.number().int().min(64).max(4096).default(1080),
});
```

The request is JSON and the successful response is `image/png`. Errors are bounded JSON with stable codes. The service accepts no URL, script, filesystem path, or browser option from the caller.

### 3.2 `apps/renderer`

The new workspace is a small Fastify service with four focused modules:

- `config.ts` validates `PORT`, `TUEZDAY_RENDERER_TOKEN`, `RENDER_MAX_CONCURRENCY`, and `RENDER_TIMEOUT_MS`.
- `template.ts` performs placeholder completeness checks, HTML escaping, substitution, and construction of the self-contained document.
- `browser-renderer.ts` lazily owns one Chromium browser, bounds concurrent pages, renders one PNG, times out stuck pages, and closes every page in `finally`.
- `app.ts` exposes public `GET /health` and bearer-protected `POST /render`, parses the shared contract, returns only PNG bytes, and closes Chromium during shutdown.

The service never fetches application data and receives no workspace credentials. Templates are rendered with JavaScript disabled and network requests blocked. That preserves the current deterministic “HTML + CSS in, PNG out” hot path while removing API blast radius and accidental template egress.

### 3.3 API client

`apps/api/src/design/render.ts` becomes the renderer boundary and HTTP client:

```ts
export type RenderInput = RenderRequest;
export type Render = (input: RenderInput) => Promise<Uint8Array>;

export function createRendererClient(options?: {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Render;
```

The client uses `TUEZDAY_RENDERER_URL` (loopback default for development), `TUEZDAY_RENDERER_TOKEN`, and `TUEZDAY_RENDERER_TIMEOUT_MS`. It validates the input locally, sends the bearer token, requires `image/png`, bounds the response size, and translates timeout/unavailable/invalid-response cases into actionable renderer errors. Tests continue injecting `BuildAppOptions.render`; no API test starts Chromium or makes network calls.

The root `npm run dev` starts API, web, worker, and renderer. The API removes its Playwright dependency and browser shutdown hook. Only `apps/renderer` depends on Playwright.

## 4. Time and budget model

### 4.1 Library-backed civil time

`@js-temporal/polyfill` is the single civil-time implementation. New leaf module `apps/api/src/services/civil-time.ts` owns:

```ts
export type WallClockResolution =
  | { ok: true; instantMs: number }
  | { ok: false; reason: "nonexistent_local_time" };

export function resolveWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): WallClockResolution;

export function zonedDayBounds(instantMs: number, timeZone: string): {
  start: number;
  end: number;
};
```

Spring-forward gaps return `nonexistent_local_time`; the scheduler skips that one occurrence and reports it in the fill result. Fall-back overlaps choose the earlier occurrence deterministically so one local slot never becomes two posts. Local-day bounds follow the actual 23-, 24-, or 25-hour civil day.

### 4.2 Per-account timezone

Every connection gains an IANA `timezone`, defaulting to `UTC` for existing rows. It is included in the connection contract and editable through the existing connection PATCH route. Cadence creation/update already requires an IANA timezone; when a cadence's destination connection has a different timezone, the account timezone is authoritative for account and campaign daily caps while the cadence timezone remains authoritative for the scheduled wall clock.

### 4.3 Separate post and reply budgets

The existing `perConnectionDailyCap` remains the original-post/DM cap for wire compatibility. Social automation settings add `perConnectionReplyDailyCap`, with the same positive bounded validation and a conservative default equal to the existing default connection cap.

- Publication counts use the destination connection's local-day bounds.
- Campaign publication counts use the candidate destination account's local-day bounds.
- Reply counts use their connection's local day and compare only against `perConnectionReplyDailyCap`.
- Publications no longer consume the automated-reply budget.
- X DM accounting becomes account-local but continues using the existing connection cap; Sprint 75 does not invent a third budget setting.

## 5. Cadence preflight and kill-switch immediacy

### 5.1 DST and validation reporting

`slotsBetweenDetailed` returns both valid instants and structured skipped-slot issues. `slotsBetween` remains a compatibility wrapper for calendar callers.

`fillCadence` returns:

```ts
export interface FillResult {
  filled: number;
  issues: Array<{
    code: "nonexistent_local_time" | "publish_validation";
    cadenceId: string;
    draftId: string | null;
    slot: number | null;
    message: string;
  }>;
}
```

Before an external action is persisted, each candidate runs through the canonical `preparePublicationAction` validation. A validation failure records an issue, consumes that invalid draft for this fill pass, and tries the next eligible draft against the same open slot. It does not create a publication/action, burn the slot, or abort valid work behind it. The route and worker response surface the warning.

### 5.2 Last-moment kill switch

`attemptPublication` classifies a receipt as automated from its persisted cadence/external-action lineage. Immediately before the adapter call it reloads social automation settings. If the kill switch is on, the receipt stays scheduled, no provider method is called, and the run returns `blocked: "kill_switch_on"`. Turning the switch off makes the same idempotent receipt eligible on the next tick.

The external-action adapter retains its existing dispatch guard. The publication check is defense in depth for legacy receipts, state changes between action guard and provider I/O, and any future caller of `attemptPublication`.

## 6. Asynchronous Instagram finalization

### 6.1 Adapter protocol

Social publishing adds a tagged pending result and an optional resume method:

```ts
export type SocialPublishResult =
  | { status: "published"; externalId: string; url: string }
  | { status: "processing"; operationId: string; retryAfterMs: number };

export interface SocialAdapter {
  publishPost(input: PublishPostInput): Promise<SocialPublishResult>;
  finalizePost?(operationId: string): Promise<SocialPublishResult>;
  // existing optional read/reply methods remain unchanged
}
```

All synchronous providers return `published`. Instagram images and image-only carousels continue synchronously. A video/reel or video carousel creates its container once and returns `processing` immediately. `finalizePost` reads `status_code`: `IN_PROGRESS`/`PUBLISHED`-not-ready returns processing with a later retry, `ERROR` fails durably, and `FINISHED` calls `media_publish`, reads the permalink, and returns published.

### 6.2 Publication persistence

Publication statuses add `processing`. The table adds nullable `provider_operation_id`, `next_attempt_at`, and `processing_started_at`, plus `processing_attempts` defaulting to zero. The operation id is distinct from the final external media id.

`attemptPublication` is idempotent:

- A scheduled first attempt calls `publishPost` once.
- A processing receipt never recreates a container; it calls only `finalizePost` with the stored operation id.
- A not-yet-due processing receipt returns without provider I/O.
- A published receipt is immutable.
- Provider errors mark the receipt failed with the bounded existing error field; no fake success is emitted.

### 6.3 External-action lifecycle and worker

The external-action coordinator treats an execution receipt whose status is `processing` as in-flight: it persists the receipt and keeps the action `dispatching`, without setting `completedAt`. The existing runnable-action recovery includes `dispatching`, so the next action-run resumes with the same idempotency key.

The worker's publish loop first calls `POST /workspaces/:id/external-actions/run`, then the legacy `POST /workspaces/:id/publish/run`. Action-linked receipts are finalized by the action runner so the governing action reaches `succeeded` only when the Instagram media is actually published. The legacy publication runner handles only receipts without an external action. Worker logging distinguishes published, processing, blocked, and failed outcomes.

## 7. Data migration

One generated Drizzle migration, `0079_sprint_75_operational_hardening.sql`, performs additive portable changes:

- `connections.timezone TEXT NOT NULL DEFAULT 'UTC'`
- `social_automation_settings.per_connection_reply_daily_cap INTEGER NOT NULL` using the existing default cap
- publication processing columns described in §6.2

No column is dropped or renamed. Existing connections and settings preserve current UTC behavior until the founder chooses an account timezone. Existing publications remain valid terminal/scheduled rows.

## 8. Security, failure, and observability rules

- Renderer authentication uses a dedicated secret, never the worker token or a user/API token.
- Render templates cannot initiate network requests or execute JavaScript.
- Renderer input, dimensions, placeholder count/value sizes, response size, concurrency, and duration are bounded.
- Renderer failure never creates a carousel/ad-image draft or consumes generation credit; existing transaction ordering stays intact.
- A skipped DST occurrence and a rejected fill candidate are data, not silent logs.
- Kill-switch blocks are retryable and never mutate the receipt to failed.
- Instagram processing is visibly nonterminal in contracts, execution results, and worker logs.
- Every query and mutation remains workspace-scoped; provider operation ids are never accepted from public input.

## 9. Acceptance

1. Starting the API does not import or launch Playwright. A render request goes to the authenticated renderer service, which returns the expected PNG; timeout, auth failure, oversized output, and renderer unavailability fail safely.
2. A cadence at `02:30 America/New_York` on the 2026 spring-forward date reports and skips the nonexistent occurrence. A fall-back overlap produces exactly one occurrence.
3. An invalid queued X/Reddit post is reported during fill, creates no action, and does not prevent the next valid draft from filling the slot.
4. A connection in `Asia/Kolkata` counts posts/replies inside its local day across the UTC boundary, with separate post and reply caps.
5. Flipping the kill switch after scheduling but before fire results in zero provider calls; the receipt remains retryable and publishes after the switch is lifted.
6. Instagram video publish returns processing without waiting; repeated ticks never recreate the container; readiness publishes exactly once; the external action succeeds only after final media publication.
7. `npm test`, `npm run typecheck`, and the renderer's browser-backed smoke test pass.

## 10. Out of scope

- Sprint 73's durable general-purpose queue, fairness, dead-lettering, and retry framework.
- Sprint 74's Postgres migration.
- Moving template authoring or asset storage into the renderer.
- Browser pools across machines or autoscaling policy; the service exposes the health/concurrency seams needed by deployment.
- Separate X-DM configuration; only its calendar boundary becomes account-local.
- Changing manual publishing, approval-state semantics, or external-action policy.

## 11. Progress log

- 2026-08-07 — Branch/worktree created from `c028e8a`. Clean baseline verified: `npm test` passed 297 files / 3,046 tests; `npm run typecheck` passed all workspaces. Problem statement, deferred items, renderer seam, cadence math, action guardrails, publication runner, Instagram adapter, and worker scheduling paths surveyed. Detailed implementation plan recorded in `docs/superpowers/plans/2026-08-07-sprint-75-renderer-operational-hardening.md`.
- 2026-08-07 — Renderer isolation implemented. `apps/renderer` now owns lazy Chromium startup, bounded concurrency, request blocking, timeouts, template substitution, bearer authentication, and PNG rendering. The API now uses a deadline-bound streaming HTTP client with PNG signature and size checks and no longer depends on or shuts down Playwright. Renderer tests passed 21/21 (including browser-backed and late-launch deadline tests); API renderer/design/carousel/ad-image tests passed 40/40; renderer, API, and contracts typechecks passed.
- 2026-08-07 — Account-local budgets implemented. Temporal-backed civil-time tests cover Kolkata, New York 23/25-hour days, spring gaps, and fall overlaps. Migration `0079_sprint_75_operational_hardening.sql` additively defaults existing connections to `UTC` and reply caps to 10. Post, campaign, reply, and X-DM windows now follow the destination connection; replies have an independent cap exposed in the API, agent guardrail tool, Automation UI, and per-account Integrations timezone control. Focused API/contracts tests passed 249/249, web surface tests passed 2/2, and API/contracts/web typechecks passed.
- 2026-08-07 — Cadence hardening implemented. Temporal now owns cadence date/instant math; spring-forward wall clocks become structured `nonexistent_local_time` issues, fall overlaps resolve to one earlier instant, and `slotsBetween` remains compatible. Fill preflights each draft through canonical publication validation, reports bounded issues, and retries the same slot with the next valid draft. The API preserves issues and the worker reports them even when nothing fills. Cadence, deliverable, automation, and worker regression suites passed 94/94; API and worker typechecks passed.
- 2026-08-07 — Publish-time kill switch implemented (commit `d714749`). `attemptPublication` identifies automated lineage from the durable external-action payload, with cadence/campaign fallback for legacy receipts, and reloads workspace automation settings as the final synchronous check before `adapter.publishPost`. A stop returns a stable `kill_switch_on` blocked outcome with zero provider calls and leaves the receipt retryable rather than failed; lifting the switch publishes that same receipt exactly once. Manual approved publishing is unchanged. Automation and publish suites passed.
- 2026-08-07 — Operational records and full verification. All six deferred items (#3, #5, #6, #9, #10, #17) moved into the "Done (upgraded)" section of `docs/deferred-improvements.md` with what shipped, the better version, and exactly what closed them. A new `docs/production-runbook.md` documents renderer processes/configuration/failure modes, account-local budget semantics, the publish-time kill switch, the `processing` lifecycle and worker ordering, and cadence fill behavior; it is linked from `README.md` and `CLAUDE.md`, and `README.md` now names the renderer as a fourth required production process. **Deviation:** the plan's Task 7 listed `docs/whats-actually-built.md`, which does not exist at this branch's baseline; rather than invent a whole-product inventory, the operator-facing record went into the runbook. Verification: `npm run typecheck` passed across all six workspaces including the new `renderer`; `npm test` passed 307 files / 3,102 tests with zero failures (up from the 297 files / 3,046 tests baseline at `c028e8a`). An earlier full run on a loaded machine produced ten `Hook timed out in 10000ms` failures in files Sprint 75 does not change (`connect-social`, `design-systems`, `discovery-bounds`, `draft-editor-revision`, `generation-quality`, `generations`, `outreach`); those seven files then passed 132/132 in isolation, and the repeat full run was clean — load-induced `buildAuthedApp` hook timeouts, not regressions. `git diff --check` reported no whitespace errors and `git status` showed only Sprint 75 files.
- 2026-08-07 — Resumable Instagram finalization implemented (commit `afe3128`). Social publishing returns a tagged `published | processing` result across all adapters; Instagram alone implements `finalizePost(operationId)`. Migration `0079` additively adds the provider operation id, next-attempt time, processing start time, and attempt count to `publications`. Image-only posts stay synchronous; a video/reel container is created once, persisted, and resumed with exactly one status read per due tick — a receipt whose `nextAttemptAt` is in the future performs no provider I/O, and a changed operation id fails loudly instead of duplicating a post. Retry spacing follows the provider's requested delay clamped to 1 s – 1 h. The coordinator keeps an in-flight action `dispatching` and promotes it to `succeeded` only after the media actually publishes; the worker calls `/external-actions/run` before `/publish/run` and logs published/processing/blocked/failed separately. `processing` is exposed as an honest nonterminal state in contracts, execution results, and the calendar/content surfaces. Instagram, publish, external-action, and worker suites passed.
