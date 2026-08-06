# Sprint 73 — Durable Background Queue Design

> **Status:** Founder-approved
> **Date:** 2026-08-07
> **Branch:** `sprint-73-durable-queue`
> **Base:** `sprint-78-chat-that-acts` at `c028e8a`
> **Plane epic:** TAP-32
> **Source:** `docs/plans/prd-agentic-platform.md` §9, TAP-32, and the approved
> architecture discussion on 2026-08-07

## 1. Goal

Replace the worker's thirteen independent `setTimeout` scheduling loops with one
durable, database-backed background queue that provides persisted schedules,
lease-fenced execution, bounded retries, dead-letter handling, and fair service
across workspaces. Move launch generation off the request path at the same time.

The result is a thin worker that wakes one internal queue endpoint while the API
continues to own data, domain services, provider credentials, and execution.
Restarting either process must not lose work, duplicate active work, or let a
stale executor overwrite the result of a newer attempt.

## 2. Scope

Sprint 73 performs the full cutover selected by the founder:

1. discovery;
2. automation;
3. pipeline execution;
4. preference extraction;
5. learning synthesis;
6. ads synchronization;
7. cadence filling;
8. scheduled publishing;
9. social inbox polling;
10. Gmail mailbox polling;
11. outreach advancement;
12. launch-sequence advancement;
13. evidence sweeping; and
14. event-driven launch generation.

This closes deferred improvements #2, #4, #8, #12, and #19. It also absorbs the
four recurring worker loops added after TAP-32 was written: pipelines,
preferences, mailbox inbox, and outreach.

## 3. Non-goals

- Do not introduce Redis, BullMQ, Kafka, or another infrastructure dependency.
- Do not replace domain ledgers such as `discovery_jobs`, `pipeline_runs`,
  publications, launch messages, or outreach enrollments.
- Do not claim exactly-once external delivery. The queue is at-least-once and
  handlers must preserve existing receipts and idempotency checks.
- Do not build an end-user queue administration screen.
- Do not implement Sprint 79's background-agent cancellation, steering, or
  subagent delegation. The queue exposes the durable execution foundation those
  features will use.
- Do not perform the Sprint 74 PostgreSQL migration.

## 4. Architecture decision

### 4.1 Chosen approach

Use a generic queue and schedule registry stored in the existing application
database. Reuse Sprint 49's owner/version/expiry fencing model for dispatch and
job leases. Keep the worker deliberately thin: a single settled loop calls an
internal queue-tick endpoint; the API admits due schedules, fairly claims a
bounded batch, and executes typed handlers through existing domain services.

This preserves the current ownership boundary: the API owns the database and
all product behavior, while the worker owns only validated wake-up timing and
worker-token authentication.

### 4.2 Rejected alternatives

**External broker.** Redis or BullMQ supplies mature primitives but adds a new
required production service immediately before Sprint 74 moves the relational
store to PostgreSQL. It also splits queue and domain truth across systems.

**Independent per-domain queues.** Extending every domain ledger avoids a
generic abstraction but repeats lease, retry, fairness, and dead-letter logic
fourteen times and provides no common foundation for Sprint 79.

## 5. Durable data model

### 5.1 `background_schedules`

One row represents one recurring job kind for one workspace:

- `id`
- `workspace_id`
- `kind`
- `interval_ms`
- `next_run_at`
- `last_enqueued_at`
- `enabled`
- `created_at`
- `updated_at`

`(workspace_id, kind)` is unique. Workspace deletion cascades schedules. A
reconciliation pass creates missing schedules for every live workspace, updates
intervals when validated configuration changes, and removes no history.

Advancing `next_run_at` and inserting the scheduled job happen in one database
transaction. The inserted job uses a deterministic schedule-occurrence
idempotency key, so two dispatchers cannot admit the same occurrence twice.

### 5.2 `background_jobs`

Each row represents one retryable unit of background work:

- identity: `id`, `workspace_id`, `kind`, `payload_json`, `idempotency_key`;
- admission: `priority`, `available_at`, `created_at`;
- lifecycle: `status`, `attempt`, `max_attempts`, `started_at`, `finished_at`;
- lease: `lease_owner`, `lease_version`, `lease_expires_at`, `heartbeat_at`;
- diagnostics: `last_error`, `result_json`, `updated_at`.

Statuses are `queued`, `running`, `succeeded`, `dead_letter`, and `cancelled`.
Retry returns a job to `queued` with a future `available_at`; `attempt` and
`last_error` preserve that history without adding transient status values.
`cancelled` is reserved for safe operator/domain invalidation in this sprint;
cooperative agent cancellation remains Sprint 79 work.

Only one active job may exist for an idempotency key. Terminal jobs remain as an
audit ledger. Payloads and results are size-bounded; errors are sanitized and
truncated before persistence.

### 5.3 `background_workspace_dispatch`

One row per workspace stores `last_dispatched_at`. Dispatch derives the current
leased-job count from `background_jobs`, then orders eligible workspaces by
oldest dispatch time and oldest runnable job. Each fairness pass claims no more
than one job per workspace before considering a second job from any workspace.

The default per-workspace concurrency cap is one. It is configuration-backed so
Sprint 79 can raise the cap without changing queue semantics. The global tick
batch is bounded independently.

## 6. Typed queue boundary

`packages/contracts` owns a discriminated `backgroundJobPayloadSchema` keyed by
job kind. Every enqueue validates before writing and every handler validates
again before executing. Unknown kinds and malformed payloads dead-letter
without invoking product code.

The handler interface receives:

- the validated payload;
- workspace identity;
- attempt number;
- a lease-scoped abort signal;
- a heartbeat function; and
- queue-safe logging metadata.

It returns one of three explicit outcomes: complete, retry with an optional
provider-supplied availability time, or dead-letter with a safe reason.
Unexpected exceptions use the job kind's retry policy.

Queue payloads store identifiers and routing context, never copies of mutable
domain records. Handlers reread current state and complete idempotently when the
target has already reached its terminal state.

## 7. Dispatch and lease lifecycle

1. The worker calls `POST /internal/background-jobs/tick` on a short validated
   interval.
2. The API acquires a brief global dispatcher lease using Sprint 49's fencing
   rules.
3. While holding that lease, it reconciles schedules, admits due occurrences,
   reclaims expired job leases, and fairly claims a bounded batch.
4. It releases the dispatcher lease before running handlers so multiple worker
   requests can execute different claimed jobs concurrently.
5. Each running job heartbeats its own lease. Heartbeat and completion match
   job id, owner, and lease version.
6. A successful handler is marked `succeeded` only by the current lease owner.
7. A retryable failure increments the attempt and returns the job to `queued`
   with exponential backoff and deterministic jitter.
8. A permanent failure or exhausted retry budget becomes `dead_letter`.
9. Process loss performs no unsafe cleanup. Lease expiry makes the job
   reclaimable by another executor.

The queue provides at-least-once execution. Domain handlers remain responsible
for deduplicating state transitions and external effects. Existing receipts,
unique constraints, and provider idempotency keys remain the final fence around
external actions.

## 8. Retry and dead-letter policy

The queue centralizes retry mechanics while each kind defines its retry budget.
The default is five attempts with exponential backoff capped at one hour.
Deterministic jitter prevents a provider recovery from releasing every workspace
at once while keeping tests repeatable.

Rate-limit responses may supply `available_at` directly. Validation,
authorization, deleted-target, and permanent provider rejections dead-letter
immediately. Shutdown and lease loss do not consume an attempt.

Internal operator endpoints provide:

- a bounded list filtered by status, workspace, and kind;
- queue statistics including depth, oldest runnable age, running count,
  retrying count, dead-letter count, duration, and workspace saturation; and
- an explicit dead-letter requeue operation that clears lease fields, schedules
  a fresh attempt, and records the operator action in application logs.

No endpoint deletes queue history.

## 9. Domain migration map

### 9.1 Recurring admission jobs

The schedule registry owns recurring admission for:

- `discovery.scan`
- `automation.scan`
- `preferences.extract`
- `learning.synthesize`
- `ads.scan`
- `cadence.scan`
- `publication.scan`
- `social_inbox.scan`
- `mailbox.scan`
- `outreach.scan`
- `sequence.scan`
- `evidence.sweep`

Admission handlers are bounded. When more work remains they enqueue granular
child jobs and complete; they do not hold a queue lease across an unbounded
workspace fan-out.

### 9.2 Granular execution jobs

- Discovery admits one job per due source and keeps `discovery_jobs` as the
  source-fetch ledger.
- Automation admits bounded workspace work and queues the resulting pipeline
  runs rather than executing model work inline.
- Every queued `pipeline_run` receives a `pipeline.execute` job in the same
  transaction that makes the run runnable.
- Ads synchronization is isolated per connection.
- Cadence filling is isolated per active cadence.
- Publishing is isolated per due publication.
- Social inbox polling is isolated per connection.
- Gmail polling is isolated per mailbox.
- Outreach and launch sequences advance bounded domain targets and re-enqueue
  continuation only when eligible work remains.
- Evidence and learning jobs remain one bounded unit per workspace because
  their existing services already cap work.

### 9.3 Launch generation

The generate route validates the launch, changes its state to `generating`, and
transactionally enqueues one job per target/channel with deterministic keys.
Each job performs one generation unit and persists through the existing launch
message service. The launch becomes ready only after every required unit has a
terminal domain result. A retry or dead letter is visible through launch status
and queue diagnostics; the request returns `202 Accepted` with progress counts
instead of waiting for model calls.

## 10. Worker cutover

`apps/worker` removes all thirteen domain loops and their API orchestration
functions. It retains environment loading, worker-token authentication, the
settled-loop scheduler, graceful shutdown, and one `background-jobs` loop.

The worker interval is validated in milliseconds and defaults to one second.
The API controls batch size, lease duration, heartbeat cadence, retry bounds,
and workspace concurrency through the same strict startup-validation style used
by Sprint 49.

There is no compatibility mode that runs old and new schedulers together.
Database idempotency makes the cutover safe; running both systems would make
operational behavior harder to reason about and would preserve the architecture
Sprint 73 is removing.

## 11. Security and tenancy

- Queue execution and operator endpoints remain under `/internal/*` and require
  `TUEZDAY_WORKER_TOKEN` through the existing internal-route guard.
- Every job has a non-null workspace id and every handler rereads domain records
  through that workspace boundary.
- Payload schemas reject unrecognized fields.
- Logs and stored errors never include provider tokens, authorization headers,
  prompts containing secrets, or arbitrary response bodies.
- A job cannot claim or mutate another workspace's target, even when a forged
  payload contains that target id.

## 12. Testing strategy

All behavior is implemented test-first.

### 12.1 Queue repository tests

- concurrent enqueue converges on one active idempotency key;
- due jobs are unavailable before `available_at`;
- claims are fenced by owner and version;
- stale heartbeats and completions fail;
- expired leases are reclaimed;
- retry backoff is deterministic and bounded;
- exhausted attempts dead-letter;
- explicit requeue restores one dead letter;
- payloads and errors respect size limits; and
- workspace deletion cannot leave runnable orphan jobs.

### 12.2 Fairness tests

- one noisy workspace cannot consume the whole first pass;
- oldest undispatched workspace is selected first;
- per-workspace and global caps are enforced under concurrent ticks;
- a workspace with a running job is skipped at cap; and
- fairness persists across process restart.

### 12.3 Handler and migration tests

- every job kind validates and resolves to exactly one handler;
- each of the thirteen legacy loops has a schedule or event-driven replacement;
- fan-out creates deterministic child jobs without duplicates;
- existing domain idempotency survives retry after a simulated post-write crash;
- pipelines execute without the pipelines timer;
- launch generation returns `202`, progresses asynchronously, retries one
  failed unit, and reaches ready only when all units complete; and
- the worker starts exactly one settled loop and sends only the internal queue
  tick.

### 12.4 Acceptance verification

- kill the worker during a leased job, restart it, and observe lease-based
  recovery without duplicate domain writes;
- run two workers and demonstrate fair cross-workspace progress;
- force a retryable provider error through backoff to success;
- exhaust a retry budget, inspect the dead letter, and requeue it;
- verify every former timer's work still executes through the queue; and
- run the full repository test, typecheck, and build commands.

## 13. Rollout and observability

The migration and code cut over atomically on this branch. Existing work is
discovered by reconciliation and domain scans after startup. Queue metrics and
structured logs make stalled work visible without a new UI.

The operator should watch queue depth, oldest runnable age, dead-letter count,
and per-workspace saturation after deployment. A growing oldest-job age with a
flat running count indicates worker availability; growth isolated to one kind
indicates a handler or provider problem.

## 14. Acceptance

Sprint 73 is accepted when:

- the worker has one queue loop and no domain scheduling loops;
- all thirteen former loops and launch generation run through durable jobs;
- jobs survive process restarts through lease expiry and fenced reclaim;
- retries back off, exhausted work dead-letters, and operators can requeue it;
- fair claiming prevents one workspace from starving another;
- domain state and external effects remain idempotent under replay;
- TAP-32 and its implementation cards reflect verified completion; and
- repository tests, typecheck, and build complete successfully.
