# Sprint 75 Renderer Extraction & Operational Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate Chromium rendering from the API and close deferred operational items #3, #5, #6, #9, #10, and #17 without changing Tuezday's approval or external-action governance.

**Architecture:** Add an authenticated `apps/renderer` service behind the existing injected render function; keep template authoring/storage in the API. Use Temporal-backed civil-time helpers, additive connection/settings/publication persistence, last-moment guard checks, and the existing worker/action runner to resume Instagram container processing.

**Tech Stack:** TypeScript ESM, Fastify 5, Playwright, Zod, `@js-temporal/polyfill`, Drizzle ORM, SQLite migrations, Vitest, npm workspaces.

## Global Constraints

- Base commit is exactly `c028e8a`; preserve the parent checkout's uncommitted Sprint 77 work by working only in `.worktrees/sprint-75-renderer-operational-hardening`.
- Node is version 20 or newer; CI uses Node 22.
- Tests never make external network calls; every renderer, connector, clock, and worker transport remains injectable.
- Shared vocabularies and wire schemas live in `packages/contracts`; do not redeclare statuses.
- Every external action remains governed by the existing policy tree and state machine.
- No fake success: renderer/provider uncertainty stays failed, blocked, or processing.
- Do not implement Sprint 73's generic durable queue or Sprint 74's Postgres migration.
- Every task ends with targeted tests, a progress-log update, a live-plan update, and a commit ending with `Co-Authored-By: Claude Opus 4.8`.

---

### Task 1: Renderer wire contract and service

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/renderer.test.ts`
- Create: `apps/renderer/package.json`
- Create: `apps/renderer/tsconfig.json`
- Create: `apps/renderer/vitest.config.ts`
- Create: `apps/renderer/src/config.ts`
- Create: `apps/renderer/src/template.ts`
- Create: `apps/renderer/src/browser-renderer.ts`
- Create: `apps/renderer/src/app.ts`
- Create: `apps/renderer/src/server.ts`
- Create: `apps/renderer/test/config.test.ts`
- Create: `apps/renderer/test/template.test.ts`
- Create: `apps/renderer/test/app.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `renderRequestSchema`, `RenderRequest`, `renderErrorSchema`, `RenderErrorResponse`.
- Produces: `buildRendererApp(options)`, `createBrowserRenderer(options)`, `parseRendererConfig(env)`.

- [x] **Step 1: Write failing contract/config/template tests**

Cover dimension/payload bounds, placeholder validation, HTML escaping, missing placeholders, production token requirement, test defaults, and invalid concurrency/timeout values.

- [x] **Step 2: Run tests to verify failure**

Run: `npm test -- renderer`

Expected: FAIL because renderer contracts/workspace do not exist.

- [x] **Step 3: Implement shared contracts and pure renderer modules**

Use these stable signatures:

```ts
export const RENDER_MAX_DOCUMENT_CHARS = 500_000;
export const RENDER_MAX_DIMENSION = 4_096;
export const renderRequestSchema: z.ZodType<RenderRequest>;

export function substituteTemplate(input: RenderRequest): string;
export function parseRendererConfig(env: NodeJS.ProcessEnv): RendererConfig;
```

- [x] **Step 4: Write failing authenticated route tests**

Assert health is public; render rejects missing/wrong bearer token; a valid request delegates once and returns `image/png`; validation errors are bounded 400s; renderer failures are stable 503/504 responses.

- [x] **Step 5: Implement Fastify app and browser owner**

`createBrowserRenderer` must block all requests, disable JavaScript, cap concurrent pages, enforce timeout, close pages in `finally`, and expose `close()` for shutdown. Keep Chromium lazy so health/startup does not allocate a browser.

- [x] **Step 6: Run renderer and contract tests**

Run: `npm test -- renderer`

Expected: PASS for contracts and renderer unit/injection tests.

- [x] **Step 7: Commit**

```bash
git add packages/contracts apps/renderer vitest.config.ts package.json package-lock.json docs/specs/sprint-75-renderer-operational-hardening.md docs/superpowers/plans/2026-08-07-sprint-75-renderer-operational-hardening.md
git commit -m "feat(renderer): isolate the Playwright render service" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: API renderer client and process wiring

**Files:**
- Modify: `apps/api/src/design/render.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/test/design-pipeline.test.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `RenderRequest`, `renderRequestSchema`.
- Produces: `Render`, `RendererError`, `createRendererClient(options): Render`.

- [x] **Step 1: Replace browser tests with failing HTTP-client tests**

Assert exact URL, bearer header, JSON body, timeout cancellation, PNG content type, maximum response size, non-2xx error mapping, and transport failure mapping using an injected fetcher.

- [x] **Step 2: Run the focused test**

Run: `npm test -- design-pipeline`

Expected: FAIL because `createRendererClient` is absent and local Chromium still owns the path.

- [x] **Step 3: Implement the client and remove API browser ownership**

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

Default `BuildAppOptions.render` to the client, remove `closeRenderer` and the browser shutdown hook, and remove Playwright from `apps/api` dependencies.

- [x] **Step 4: Wire local development and environment documentation**

Root `dev` starts `renderer,api,web,worker`; `.env.example` documents renderer URL/token/timeouts/concurrency; `CLAUDE.md` names renderer ownership and the new commands.

- [x] **Step 5: Verify focused behavior and typecheck**

Run: `npm test -- design-pipeline carousels ad-image renderer`

Expected: PASS with no browser import in API tests.

Run: `npm run typecheck`

Expected: PASS across the new renderer workspace and all existing workspaces.

- [x] **Step 6: Commit**

```bash
git add apps/api apps/renderer package.json package-lock.json .env.example CLAUDE.md
git commit -m "refactor(api): route image rendering through the isolated service" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Civil time, account timezone, and separate reply budgets

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/services/civil-time.ts`
- Create: `apps/api/test/civil-time.test.ts`
- Modify: `apps/api/src/services/connections.ts`
- Modify: `apps/api/src/services/automation-settings.ts`
- Modify: `apps/api/src/services/automation.ts`
- Modify: `apps/api/src/services/inbox.ts`
- Modify: `apps/api/src/services/launch-sequences.ts`
- Modify: `apps/api/test/connectors.test.ts`
- Modify: `apps/api/test/automation.test.ts`
- Modify: `apps/api/test/inbox.test.ts`
- Create: generated `apps/api/drizzle/0079_sprint_75_operational_hardening.sql`
- Create: generated `apps/api/drizzle/meta/0079_snapshot.json`
- Modify: generated `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `resolveWallClock`, `zonedDayBounds`.
- Extends: `Connection.timezone`, `UpdateConnectionInput.timezone`.
- Extends: `SocialAutomationSettings.perConnectionReplyDailyCap`.

- [x] **Step 1: Install Temporal and write failing civil-time tests**

Run: `npm install @js-temporal/polyfill -w apps/api`

Test Kolkata/local midnight across UTC, New York 23/25-hour days, spring gap rejection, and fall overlap choosing exactly one earlier instant.

- [x] **Step 2: Implement the civil-time leaf module**

```ts
export function resolveWallClock(input: WallClockInput): WallClockResolution;
export function zonedDayBounds(instantMs: number, timeZone: string): { start: number; end: number };
```

- [x] **Step 3: Write failing persistence/contract tests**

Assert existing connections default to UTC, PATCH validates/stores an IANA timezone, settings default and round-trip `perConnectionReplyDailyCap`, and reply/post budget counts differ across a UTC boundary.

- [x] **Step 4: Extend contracts/schema/services and generate the migration**

Run: `npm run db:generate -w apps/api -- --name=sprint_75_operational_hardening`

Expected: migration 0079 adds only additive columns with safe defaults.

- [x] **Step 5: Replace UTC windows at social guardrail call sites**

Use the destination connection timezone for post, campaign, reply, and X-DM counts. Replies compare only reply rows against `perConnectionReplyDailyCap`; publications no longer contribute.

- [x] **Step 6: Run focused tests**

Run: `npm test -- civil-time connectors automation inbox launch-sequences sprint75-migrations`

Expected: PASS, including migration application against a fresh in-memory DB.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api package-lock.json
git commit -m "feat(automation): enforce account-local social budgets" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: DST-safe cadence fill and preflight validation

**Files:**
- Modify: `apps/api/src/services/cadences.ts`
- Modify: `apps/api/src/routes/cadences.ts`
- Modify: `apps/api/test/cadences.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/test/client.test.ts`

**Interfaces:**
- Produces: `slotsBetweenDetailed(...)` and structured `FillResult.issues`.
- Consumes: `resolveWallClock` and the canonical `preparePublicationAction` validation.

- [ ] **Step 1: Write failing DST occurrence tests**

Cover `02:30 America/New_York` on the spring-forward Sunday as a structured skipped issue, and `01:30` on fall-back Sunday as exactly one earlier occurrence.

- [ ] **Step 2: Implement detailed slot resolution**

Keep `slotsBetween` as `slotsBetweenDetailed(...).slots` so calendar callers retain their existing shape.

- [ ] **Step 3: Write failing fill-preflight tests**

Queue an invalid draft followed by a valid one. Assert the invalid draft creates no action/publication, the valid draft takes the open slot, and the response contains one bounded `publish_validation` issue.

- [ ] **Step 4: Implement non-aborting preflight and worker reporting**

Catch only canonical preparation/validation errors; unexpected errors still fail the task. Retry the same slot with the next candidate and return issues through the route/worker client.

- [ ] **Step 5: Run cadence and worker tests**

Run: `npm test -- cadences worker`

Expected: PASS with existing idempotency and withdrawal tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/cadences.ts apps/api/src/routes/cadences.ts apps/api/test/cadences.test.ts apps/worker
git commit -m "fix(cadence): reject invalid and nonexistent slots before scheduling" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: Immediate publish-time kill switch

**Files:**
- Modify: `apps/api/src/services/publications.ts`
- Modify: `apps/api/test/automation.test.ts`
- Modify: `apps/api/test/publish.test.ts`

**Interfaces:**
- Produces: `PublishRunResult.state: "published" | "processing" | "blocked" | "failed"` and optional stable error.

- [ ] **Step 1: Write a failing race-window test**

Schedule an automated publication, flip the kill switch after scheduling, run the due path, and assert zero provider calls plus unchanged `scheduled` status. Lift the switch and assert the same receipt publishes exactly once.

- [ ] **Step 2: Implement automated-lineage detection and last-moment guard**

Reload settings immediately before `adapter.publishPost`. Return a retryable blocked outcome without changing the receipt to failed.

- [ ] **Step 3: Run focused tests**

Run: `npm test -- automation publish external-action-publication`

Expected: PASS; manual approved publications remain unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/publications.ts apps/api/test/automation.test.ts apps/api/test/publish.test.ts
git commit -m "fix(publishing): enforce the kill switch at provider dispatch" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: Resumable Instagram finalization

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `apps/api/src/connectors/social/index.ts`
- Modify: `apps/api/src/connectors/social/reddit.ts`
- Modify: `apps/api/src/connectors/social/linkedin.ts`
- Modify: `apps/api/src/connectors/social/x.ts`
- Modify: `apps/api/src/connectors/social/instagram.ts`
- Modify: `apps/api/src/services/publications.ts`
- Modify: `apps/api/src/services/external-action-coordinator.ts`
- Modify: `apps/api/src/services/external-actions.ts`
- Modify: `apps/api/src/auth/guard.ts`
- Modify: `apps/api/test/connect-social.test.ts`
- Modify: `apps/api/test/publish.test.ts`
- Modify: `apps/api/test/external-action-publication.test.ts`
- Modify: `apps/api/test/external-actions.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/test/client.test.ts`

**Interfaces:**
- Produces: `SocialPublishResult` tagged union and optional `SocialAdapter.finalizePost`.
- Extends: publication status with `processing` and durable provider-operation retry fields.
- Extends: coordinator handling for execution receipt status `processing`.

- [ ] **Step 1: Write failing adapter tests**

Assert image-only Instagram stays synchronous; video creation returns processing without status polling/sleep; pending finalize performs one status read; ready finalize publishes once and reads permalink; error status throws.

- [ ] **Step 2: Implement tagged publish results across adapters**

All synchronous adapters return `{ status: "published", externalId, url }`. Instagram alone implements `finalizePost(operationId)`.

- [ ] **Step 3: Write failing publication persistence tests**

Assert the operation id is stored separately, processing attempts honor `nextAttemptAt`, repeated runs never recreate the container, ready transitions to published, and failures become retryable failed receipts.

- [ ] **Step 4: Implement processing persistence and execution semantics**

Keep in-flight external actions `dispatching` with their processing execution receipt. On resume, a published receipt transitions the governing action to `succeeded`; errors follow existing failure semantics.

- [ ] **Step 5: Add worker action-run before legacy publish-run**

Call `/external-actions/run` with the worker credential for every workspace, then `/publish/run`. Exclude action-linked processing rows from the legacy runner and log each nonterminal category without calling it failed.

- [ ] **Step 6: Run focused integration tests**

Run: `npm test -- instagram publish external-action-publication external-actions worker`

Expected: PASS, including the acceptance sequence from create → processing → processing → published/succeeded.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api apps/worker
git commit -m "feat(instagram): finalize video publications asynchronously" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: Operational records, complete verification, and handoff

**Files:**
- Modify: `docs/deferred-improvements.md`
- Modify: `docs/specs/sprint-75-renderer-operational-hardening.md`
- Modify: `docs/whats-actually-built.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: auditable closure of deferred #3/#5/#6/#9/#10/#17 and exact verification evidence.

- [ ] **Step 1: Update operational documentation**

Move or annotate exactly the six closed deferred items, document renderer deployment/configuration, account timezone/budget semantics, processing status, and recovery behavior. Do not claim Sprint 73 or 74 work.

- [ ] **Step 2: Run all targeted suites once more**

Run: `npm test -- renderer design-pipeline carousels ad-image civil-time cadences automation inbox launch-sequences publish connect-social external-action-publication external-actions`

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck`

Expected: PASS across every workspace.

Run: `npm test`

Expected: PASS across every project with zero failures.

- [ ] **Step 4: Inspect the final diff and migration**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only Sprint 75 files are modified/untracked.

Run: `git diff c028e8a --stat`

Expected: renderer, operational hardening, tests, generated migration, and documentation only.

- [ ] **Step 5: Update Plane and the progress log**

Move the TAP Sprint 75 epic and all of its subtasks together to Done only after verification. Comment with branch `sprint-75-renderer-operational-hardening`, final HEAD, push status, test counts, and “awaiting founder merge.” If Plane tooling is unavailable, record that limitation explicitly without fabricating an update.

- [ ] **Step 6: Commit final records and push**

```bash
git add docs CLAUDE.md
git commit -m "docs(sprint-75): record operational hardening acceptance" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin sprint-75-renderer-operational-hardening
```

- [ ] **Step 7: Handoff**

Report the worktree path, branch, final HEAD, commits, exact test/typecheck evidence, migration, Plane state, push state, and required founder merge. Do not merge into `main`.
