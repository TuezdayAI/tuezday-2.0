# Sprint 73 Durable Background Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace thirteen independent worker schedulers with one durable, fair,
lease-fenced queue and move launch generation off the request path.

**Architecture:** SQLite-backed `background_schedules` admit one bounded unit of
work per workspace and kind into `background_jobs`. A single internal tick
fairly claims jobs, executes typed API-owned handlers with heartbeats, and
centralizes retry/dead-letter behavior; the worker only wakes that endpoint.
Existing domain ledgers and idempotency fences remain authoritative.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, SQLite/better-sqlite3, Zod,
Vitest, existing `apps/worker` HTTP client.

## Global Constraints

- Branch: `sprint-73-durable-queue`, based on `sprint-78-chat-that-acts` at `c028e8a`.
- Plane epic: TAP-32; post a progress comment after every completed task.
- No Redis, BullMQ, Kafka, or new production dependency.
- The API owns database access, queue execution, domain services, and provider credentials.
- The worker owns one validated settled wake-up loop and worker-token authentication.
- Queue delivery is at-least-once; all handlers must preserve domain idempotency.
- Every job is tenant-bound by non-null `workspaceId` and validated payload.
- Every production behavior follows a witnessed red-green TDD cycle.
- Full acceptance runs `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Contracts, schema, and migration

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/background-jobs.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0079_sprint_73_durable_queue.sql`
- Create: `apps/api/drizzle/meta/0079_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/test/background-jobs-migration.test.ts`

**Interfaces:**
- Produces: `BACKGROUND_JOB_KINDS`, `backgroundJobPayloadSchema`,
  `BackgroundJobPayload`, `BackgroundJobKind`, `backgroundJobStatusSchema`,
  `BackgroundJobStatus`.
- Produces database tables `background_jobs`, `background_schedules`, and
  `background_workspace_dispatch` with inferred row types.

- [x] **Step 1: Write failing contract and migration tests**

```ts
expect(BACKGROUND_JOB_KINDS).toEqual([
  "discovery", "automation", "pipelines", "preferences", "learning",
  "ads", "cadence", "publish", "inbox", "mailbox_inbox", "outreach",
  "sequence", "evidence", "launch_generate",
]);
expect(backgroundJobPayloadSchema.parse({
  kind: "launch_generate",
  workspaceId,
  launchId,
  input: { useEvidence: true },
  actor: { userId, label: "Founder", human: true },
})).toMatchObject({ kind: "launch_generate", launchId });
```

The migration test creates an in-memory database and asserts the three tables,
the active-idempotency unique index, workspace foreign keys, and schedule
uniqueness.

- [x] **Step 2: Run the tests and witness missing-export/table failures**

Run: `npx vitest run packages/contracts/test/background-jobs.test.ts apps/api/test/background-jobs-migration.test.ts`

Expected: FAIL because the contracts and tables do not exist.

- [x] **Step 3: Implement discriminated contracts and Drizzle schema**

Use a strict Zod discriminated union. The thirteen recurring payloads are
`{ kind, workspaceId }`; `launch_generate` additionally carries `launchId`,
`GenerateLaunchInput`, and the original `DraftActor` attribution.

`background_jobs` stores queued/running/succeeded/dead_letter/cancelled state,
availability, attempt budget, lease owner/version/expiry, bounded diagnostics,
and an `active_key` that is the idempotency key while active and null when
terminal. A normal unique index on `active_key` is portable to PostgreSQL and
allows unlimited null terminal rows without a partial-index dependency.

- [x] **Step 4: Generate and inspect migration artifacts**

Run: `npm run db:generate -w apps/api -- --name sprint_73_durable_queue`

Expected: creates migration 0079 and matching snapshot/journal entries. Inspect
the SQL for all foreign keys, unique indexes, and non-null bounds before keeping it.

- [x] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run packages/contracts/test/background-jobs.test.ts apps/api/test/background-jobs-migration.test.ts`

Run: `npm run typecheck -w packages/contracts && npm run typecheck -w apps/api`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/contracts apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/background-jobs-migration.test.ts
git commit -m "feat(queue): add durable job schema and contracts"
```

### Task 2: Lease-fenced queue repository

**Files:**
- Create: `apps/api/src/services/background-jobs.ts`
- Create: `apps/api/test/background-jobs.test.ts`

**Interfaces:**
- Produces: `enqueueBackgroundJob` accepting `DbExecutor`, `claimBackgroundJobs`,
  `heartbeatBackgroundJob`, `completeBackgroundJob`, `retryBackgroundJob`,
  `deadLetterBackgroundJob`, `requeueDeadLetter`, `listBackgroundJobs`, and
  `getBackgroundQueueStats`.
- Produces `BackgroundJobClaim` carrying non-null lease owner/version/expiry.

- [x] **Step 1: Write failing repository tests**

Cover deterministic enqueue deduplication, future availability, fair first
pass across workspaces, per-workspace concurrency, expired-lease reclaim,
stale heartbeat/completion rejection, bounded exponential backoff, attempt
exhaustion, dead-letter requeue, and sanitized diagnostic size limits.

```ts
const [first, second] = claimBackgroundJobs(db, {
  owner: "worker-a", leaseMs: 30_000, limit: 2, perWorkspaceLimit: 1,
});
expect(new Set([first.workspaceId, second.workspaceId]).size).toBe(2);
expect(completeBackgroundJob(db, staleClaim, {})).toBe(false);
expect(completeBackgroundJob(db, currentClaim, {})).toBe(true);
```

- [x] **Step 2: Run and witness missing repository failures**

Run: `npx vitest run apps/api/test/background-jobs.test.ts`

Expected: FAIL because `background-jobs.ts` does not exist.

- [x] **Step 3: Implement transactional enqueue and claim**

Use `DATABASE_NOW_MS` for lease comparisons. Claim candidates in a SQLite
transaction, derive live counts from unexpired running jobs, order workspaces by
persisted `lastDispatchedAt`, claim one per workspace per pass, and update each
workspace dispatch row only after a successful compare-and-swap.

- [x] **Step 4: Implement fenced lifecycle transitions**

Every heartbeat and terminal update matches `(id, leaseOwner, leaseVersion)` and
requires an unexpired lease. Retry clears lease fields, increments no additional
attempt beyond the claim count, computes deterministic capped backoff, and
retains the active key. Terminal transitions null `activeKey`.

- [x] **Step 5: Implement bounded query/stats/requeue operations**

Stats report runnable depth, delayed retries (`attempt > 0` and future
availability), running, dead letters, oldest runnable age, and counts by kind.
Requeue accepts only a dead letter and creates a fresh active attempt without
deleting history.

- [x] **Step 6: Run focused tests and refactor green code**

Run: `npx vitest run apps/api/test/background-jobs.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/services/background-jobs.ts apps/api/test/background-jobs.test.ts
git commit -m "feat(queue): add fenced fair job lifecycle"
```

### Task 3: Persisted schedules and policy validation

**Files:**
- Create: `apps/api/src/runtime/background-job-policy.ts`
- Create: `apps/api/src/services/background-schedules.ts`
- Create: `apps/api/test/background-job-policy.test.ts`
- Create: `apps/api/test/background-schedules.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces `BackgroundJobPolicy`, `parseBackgroundJobPolicy(env)`, and
  `DEFAULT_BACKGROUND_JOB_POLICY`.
- Produces `reconcileBackgroundSchedules` and `admitDueBackgroundSchedules`.

- [ ] **Step 1: Write failing policy and schedule tests**

```ts
expect(parseBackgroundJobPolicy(BASE_ENV).pollMs).toBe(1_000);
expect(() => parseBackgroundJobPolicy({ ...BASE_ENV, BACKGROUND_JOB_BATCH: "0" })).toThrow("BACKGROUND_JOB_BATCH");
expect(reconcileBackgroundSchedules(db, policy, now)).toBe(13);
expect(admitDueBackgroundSchedules(db, now)).toMatchObject({ admitted: 13 });
expect(admitDueBackgroundSchedules(db, now)).toMatchObject({ admitted: 0 });
```

Test that downtime admits one occurrence per schedule and advances
`nextRunAt` to the first interval boundary after `now`, avoiding a catch-up storm.

- [ ] **Step 2: Run and witness missing-policy/service failures**

Run: `npx vitest run apps/api/test/background-job-policy.test.ts apps/api/test/background-schedules.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement strict API-side policy parsing**

Move all thirteen domain intervals to the API policy. Add queue poll, batch,
global concurrency, per-workspace concurrency, lease, heartbeat, max attempts,
base backoff, and maximum backoff bounds. Preserve current environment variable
names and defaults for domain intervals.

- [ ] **Step 4: Implement schedule reconciliation and atomic admission**

Reconcile every live workspace against the thirteen recurring kinds. Admission
updates the schedule and inserts a deterministic job in one transaction.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run apps/api/test/background-job-policy.test.ts apps/api/test/background-schedules.test.ts`

Run: `npm run typecheck -w apps/api`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/runtime apps/api/src/services/background-schedules.ts apps/api/test/background-job-policy.test.ts apps/api/test/background-schedules.test.ts .env.example README.md
git commit -m "feat(queue): persist recurring workspace schedules"
```

### Task 4: Typed handlers, runner, and internal operator API

**Files:**
- Create: `apps/api/src/services/background-job-handlers.ts`
- Create: `apps/api/src/services/background-job-runner.ts`
- Create: `apps/api/src/routes/internal-background-jobs.ts`
- Create: `apps/api/test/background-job-handlers.test.ts`
- Create: `apps/api/test/background-job-runner.test.ts`
- Create: `apps/api/test/background-job-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/auth/guard.ts`

**Interfaces:**
- Produces `BackgroundJobHandler`, `BackgroundJobHandlerDependencies`,
  `createBackgroundJobHandlers(deps)`, and `runBackgroundJobTick(deps)`.
- Adds `POST /internal/background-jobs/tick`,
  `GET /internal/background-jobs`, `GET /internal/background-jobs/stats`, and
  `POST /internal/background-jobs/:jobId/requeue`.

- [ ] **Step 1: Write failing registry, runner, and route tests**

Assert all fourteen payload kinds map exactly once, malformed persisted payloads
dead-letter without handler invocation, handler retry/dead-letter outcomes drive
the correct repository transition, heartbeat loss aborts execution, and the
tick returns bounded totals. Route tests assert worker-token-only access, strict
empty tick bodies, bounded filters, and dead-letter-only requeue.

- [ ] **Step 2: Run and witness missing handler/route failures**

Run: `npx vitest run apps/api/test/background-job-handlers.test.ts apps/api/test/background-job-runner.test.ts apps/api/test/background-job-routes.test.ts`

Expected: FAIL because the registry, runner, and routes do not exist.

- [ ] **Step 3: Implement explicit handler outcomes and heartbeat runner**

```ts
type BackgroundJobOutcome =
  | { status: "complete"; result?: unknown }
  | { status: "retry"; error: string; availableAt?: number }
  | { status: "dead_letter"; error: string };
```

Acquire the dispatcher task lease only for schedule reconciliation, admission,
and claims. Release it before executing handlers. Execute the claimed batch with
bounded parallelism and one heartbeat timer per job.

- [ ] **Step 4: Register internal routes and remove the public worker allowlist**

The worker token remains valid for `/internal/*` only. Human run-now endpoints
remain session-authenticated. Route query schemas bound result sizes and reject
unknown fields.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run apps/api/test/background-job-handlers.test.ts apps/api/test/background-job-runner.test.ts apps/api/test/background-job-routes.test.ts apps/api/test/internal-tasks.test.ts`

Run: `npm run typecheck -w apps/api`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/background-job-* apps/api/src/routes/internal-background-jobs.ts apps/api/src/app.ts apps/api/src/auth/guard.ts apps/api/test/background-job-*
git commit -m "feat(queue): execute typed jobs through one internal tick"
```

### Task 5: Cut all thirteen domains onto queue handlers

**Files:**
- Modify: `apps/api/src/services/background-job-handlers.ts`
- Modify: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `apps/api/src/services/pipeline-tick.ts`
- Modify: `apps/api/src/routes/internal-tasks.ts`
- Modify: `apps/api/test/internal-tasks.test.ts`
- Modify: `apps/api/test/automation-ab-routes.test.ts`
- Create: `apps/api/test/sprint73-domain-cutover.test.ts`

**Interfaces:**
- Consumes all current domain service entry points.
- Extends `runPipelinesTick` with an optional `workspaceId` filter.
- Produces one tenant-scoped handler for every recurring kind.

- [ ] **Step 1: Write the failing full-cutover test**

The test creates two workspaces, reconciles schedules, runs queue ticks with
injected fake dependencies, and asserts each of the thirteen handler spies is
invoked only with its job workspace. It also asserts the legacy discovery,
automation, pipelines, and preferences internal tick routes return 404.

- [ ] **Step 2: Run and witness legacy-route/handler failures**

Run: `npx vitest run apps/api/test/sprint73-domain-cutover.test.ts apps/api/test/internal-tasks.test.ts apps/api/test/automation-ab-routes.test.ts`

Expected: FAIL because legacy routes still exist and handlers are incomplete.

- [ ] **Step 3: Wire all domain handlers through existing bounded services**

Discovery uses its existing per-source durable ledger with `workspaceId` input.
Pipelines filter queued runs by workspace. Automation retains its per-workspace
idempotency lease as defense in depth. The remaining handlers call their
existing per-workspace service functions; current domain receipts and unique
constraints remain their replay fences.

- [ ] **Step 4: Remove all four legacy internal task tick routes**

Delete `/internal/discovery/tick`, `/internal/automation/tick`,
`/internal/pipelines/tick`, and `/internal/preferences/tick`. Keep manual
workspace routes for founders, but the worker can no longer authenticate to them.

- [ ] **Step 5: Run domain regression suites**

Run: `npx vitest run apps/api/test/sprint73-domain-cutover.test.ts apps/api/test/sprint49-acceptance.test.ts apps/api/test/automation-ab-routes.test.ts apps/api/test/preference-extraction.test.ts apps/api/test/cadences.test.ts apps/api/test/mailboxes.test.ts apps/api/test/outreach.test.ts apps/api/test/launch-sequences.test.ts`

Expected: PASS after updating assertions to the single queue entrypoint.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(queue): migrate every worker domain to durable jobs"
```

### Task 6: Asynchronous, resumable launch generation

**Files:**
- Modify: `apps/api/src/services/launches.ts`
- Modify: `apps/api/src/routes/launches.ts`
- Modify: `apps/api/src/services/background-job-handlers.ts`
- Modify: `apps/api/test/launches.test.ts`
- Modify: `apps/api/test/launch-sequences.test.ts`
- Modify: `apps/api/test/outbound-convergence.test.ts`
- Modify: `apps/api/test/external-action-messaging.test.ts`
- Modify: `apps/web/app/workspaces/[id]/launches/page.tsx`
- Create: `apps/web/lib/launch-generation-view.test.ts`

**Interfaces:**
- Produces `enqueueLaunchGeneration` and an idempotent
  `resumeLaunchGeneration` service path.
- Changes `POST .../launches/:launchId/generate` to return `202` with
  `{ launch, jobId }`.

- [ ] **Step 1: Write failing async-launch tests**

Assert the route performs zero LLM calls, persists a queue job transactionally,
returns 202, rejects duplicate active generation, and preserves actor/input.
Execute the queued job and assert generation reaches ready. Simulate a crash
after one stored launch message, reclaim the job, and assert the second run
skips completed units and creates no duplicate drafts/messages.

- [ ] **Step 2: Run and witness synchronous-route failures**

Run: `npx vitest run apps/api/test/launches.test.ts -t "queues launch generation|resumes launch generation"`

Expected: FAIL because the route still waits for `generateLaunch`.

- [ ] **Step 3: Split admission from resumable execution**

Admission validates draft/audience/sequence state, changes the launch to
`generating`, and inserts the job in one transaction. Execution accepts both
`draft` and `generating`, derives deterministic generation-unit keys from
launch/channel/recipient, skips stored units, and marks ready only after every
required unit is terminal.

- [ ] **Step 4: Update UI behavior**

Show queued/generating state immediately and poll the open launch detail while
status is `generating`; stop polling at ready or on unmount. Do not add a new
progress endpoint.

- [ ] **Step 5: Run launch/API/UI regression suites**

Run: `npx vitest run apps/api/test/launches.test.ts apps/api/test/launch-sequences.test.ts apps/api/test/outbound-convergence.test.ts apps/api/test/external-action-messaging.test.ts apps/web/lib/launch-generation-view.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/launches.ts apps/api/src/routes/launches.ts apps/api/src/services/background-job-handlers.ts apps/api/test apps/web
git commit -m "feat(launches): generate asynchronously on durable queue"
```

### Task 7: Thin worker cutover and acceptance proof

**Files:**
- Replace: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/client.ts`
- Modify: `apps/worker/test/config.test.ts`
- Modify: `apps/worker/test/client.test.ts`
- Create: `apps/worker/test/index.test.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/deferred-improvements.md`
- Create: `apps/api/test/sprint73-acceptance.test.ts`
- Modify: `docs/superpowers/plans/2026-08-07-sprint-73-durable-queue.md`

**Interfaces:**
- Worker config becomes `{ internalApiUrl, token, queuePollMs }`.
- Worker client exposes `runBackgroundJobsTick()` only.

- [ ] **Step 1: Write failing worker and acceptance tests**

Assert worker startup creates one settled loop named `background-jobs`, client
traffic is only `POST /internal/background-jobs/tick`, and all thirteen old
interval fields/functions are absent. Acceptance tests cover two-workspace
fairness, crash/lease reclaim, retry-to-success, retry-to-dead-letter, explicit
requeue, and schedule persistence across app restart.

- [ ] **Step 2: Run and witness legacy-worker failures**

Run: `npx vitest run apps/worker/test apps/api/test/sprint73-acceptance.test.ts`

Expected: FAIL because thirteen loops and maintenance client methods remain.

- [ ] **Step 3: Replace worker orchestration with one loop**

Keep `loadRootEnv`, strict URL/token validation, `startSettledLoop`, structured
error logging, and graceful SIGINT/SIGTERM shutdown. Remove every domain API
shape and interval from the worker package.

- [ ] **Step 4: Close deferred records and document operations**

Move #2, #4, #8, #12, and #19 from open to resolved with the Sprint 73 queue
implementation. Document worker/API process requirements, queue policy
variables, dead-letter inspection/requeue, and rollout metrics.

- [ ] **Step 5: Run focused acceptance and all worker tests**

Run: `npx vitest run apps/worker/test apps/api/test/sprint73-acceptance.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0 with no failures.

- [ ] **Step 7: Commit**

```bash
git add apps/worker apps/api/test/sprint73-acceptance.test.ts README.md .env.example docs/deferred-improvements.md docs/superpowers/plans/2026-08-07-sprint-73-durable-queue.md
git commit -m "feat(worker): complete Sprint 73 durable queue cutover"
```

### Task 8: Final audit and Plane completion

**Files:**
- Modify only files required by audit findings.

**Interfaces:**
- Produces verified branch handoff and completed TAP-32 child cards.

- [ ] **Step 1: Audit spec coverage**

Check every requirement in
`docs/superpowers/specs/2026-08-07-sprint-73-durable-queue-design.md` against a
test and implementation. Search for legacy worker loop names, old internal tick
URLs, unbounded queue queries, unvalidated payload parsing, and unfenced job
updates.

- [ ] **Step 2: Fix each finding test-first**

For every behavioral gap, add a focused failing test, witness the expected
failure, implement the smallest correction, and rerun its neighboring suite.

- [ ] **Step 3: Run fresh final verification**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: exit 0; record exact test counts and any intentional warnings.

- [ ] **Step 4: Commit audit fixes if any**

Stage each audited production file together with the exact regression test added
in Step 2, then commit them as `fix(queue): close Sprint 73 acceptance gaps`.
If Step 1 finds no gap, make no empty commit.

- [ ] **Step 5: Update Plane**

Move every TAP-32 implementation child to Done with verification evidence, post
the branch/commit/test summary to TAP-32, and mark TAP-32 Done only after the
fresh verification gate passes.
