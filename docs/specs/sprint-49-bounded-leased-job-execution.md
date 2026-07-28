# Sprint 49 — Bounded, Leased, Restart-Safe Job Execution

> **Status:** Design direction approved; written specification awaiting founder review
> **Date:** 2026-07-28
> **Branch:** `sprint-49-bounded-leased-job-execution`
> **Base:** `sprint-48-safe-fetch-tenant-isolation` at `d9717aa`
> **Merge order:** `main` ← `sprint-48-safe-fetch-tenant-isolation` ←
> `sprint-49-bounded-leased-job-execution`
> **Plane epic:** TAP-8
> **Plane cards:** TAP-44 through TAP-50
> **Source:** `docs/plans/prd-agentic-platform.md` §3 and
> `docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
> P1.6, P1.7, P1.8, P1.10, and P1.11

## 1. Goal

Make automatic discovery dependable under overlap, slow providers, process
restarts, pagination bursts, and scoring races, and close the adjacent
automation overlap that can turn one accepted signal into duplicate drafts.

Today a discovery run marks several jobs running before they begin, has no lease
owner or fencing token, does not advance provider cursors, can exceed its
apparent limits, and can let triage copy an incomplete scoring result. The
repository also does not start the worker through its normal development command
or load and validate worker configuration consistently.

Sprint 49 replaces those timing assumptions with database-enforced ownership:

- one bounded scheduler tick at a time;
- one leased execution per source;
- fenced heartbeat, page-checkpoint, completion, and failure writes;
- idempotent occurrence persistence;
- atomic cursor progression;
- an explicit scoring state and version fence;
- a tested worker startup and narrowly scoped authentication path.

This is the last discovery execution-safety sprint before provider correctness
and non-destructive deduplication work in Sprint 50.

## 2. Founder-approved product outcome

The founder approved the **thin worker plus API-owned leased runtime** direction.

For the product, this means:

- restarting a worker does not create duplicate discovery items or downstream
  automated drafts;
- two overlapping ticks do not run the same source twice or double the amount
  of work admitted by one tick;
- a slow or hung provider cannot hold a source forever;
- a stale execution cannot overwrite a newer execution's cursor or result;
- connected sources resume from durable checkpoints and can drain bursts larger
  than one provider page;
- an item cannot be accepted while its first scoring result is incomplete or
  retryable;
- accepted signals receive one coherent, completed matching result;
- persona or campaign edits re-score the affected blast radius rather than the
  entire matched backlog;
- `npm run dev` starts automatic discovery with the same root environment as the
  API and web processes;
- invalid worker URLs, credentials, or intervals fail at startup instead of
  producing silent `401` loops or near-continuous timers.

## 3. Architecture decision

### 3.1 Chosen approach

Keep the worker deliberately thin. Its validated, self-scheduling loops call
internal discovery and automation tick endpoints. The API owns database-backed
scheduling, lease acquisition, provider execution, cursor checkpoints,
matching, automation coordination, and fencing.

The lease helpers are written as reusable database primitives so Sprint 73 can
reuse their owner/version/expiry rules when the wider worker becomes a durable
queue. Sprint 49 applies them to discovery and to the known automation overlap;
it does not prematurely migrate every background loop into that future queue.

### 3.2 Rejected alternatives

**Patch the current timestamp lock.** Adding only an owner column to the current
five-row upfront claim would leave completion unfenced, pagination non-atomic,
provider work unbounded, and worker startup unreliable.

**Build the complete platform job queue now.** Moving ads, publishing, inbox,
sequences, evidence, cadence, and every future agent task into one queue is the
right later architecture, but it expands this release-blocker sprint into the
work already assigned to Sprint 73.

**Run scheduling only in API memory.** An in-process mutex or “tick is running”
boolean disappears on restart and cannot coordinate two API or worker
processes. Correctness must live in durable compare-and-swap writes.

## 4. Scope and Plane card order

Cards are implemented in dependency order. A card moves to `Done` only after its
focused tests, relevant regressions, and typecheck pass.

1. **TAP-44 — Real leases**
   - Add owner identity, monotonically increasing lease version, expiry, and
     heartbeat fields.
   - Add a singleton scheduler lease and per-job leases.
   - Fence heartbeat, checkpoint, completion, retry, and failure by
     owner/version.
   - Reclaim expired work without allowing the previous owner to write again.
2. **TAP-45 — Hard runner bounds**
   - Claim work just in time rather than five jobs upfront.
   - Enforce tick, source, page, item, provider-call, response-byte, and
     per-source concurrency limits.
   - Propagate an abort signal into safe fetch, connector fabric, provider JSON
     reads, and discovery scoring.
3. **TAP-46 — Idempotent occurrence handling**
   - Treat `(sourceId, externalId)` as the occurrence idempotency key.
   - Replace read-then-insert deduplication with conflict-safe transactional
     insertion.
   - Add a database invariant preventing multiple queued/running jobs for one
     source.
   - Add a stable automation idempotency key for
     `(workspaceId, signalId, campaignId, channel)` so two callers cannot
     persist duplicate automatic drafts.
   - Prove replay and overlapping ticks produce one durable occurrence.
4. **TAP-47 — Serialize scoring and triage**
   - Add explicit matching readiness, version, lease, and retryable-error state.
   - Claim matching work with a version fence.
   - Allow first acceptance only from a completed matching result.
   - Preserve Sprint 48's atomic match replacement and write-time tenant
     revalidation.
5. **TAP-48 — Cursor persistence**
   - Refactor connected adapters into bounded page readers.
   - Read durable high-watermark/continuation state before provider calls.
   - Commit every admitted page and its next checkpoint atomically.
   - Replay overlap on expired or invalid provider cursors.
6. **TAP-49 — Reliable startup**
   - Give the worker a distinct internal API URL.
   - Load the root environment consistently.
   - Validate URLs, credentials, and timer values at process startup.
   - Replace fire-and-forget discovery and automation intervals with
     self-scheduling loops whose next wake-up is installed after completion.
   - Add the worker to root development and deployment documentation.
   - Restrict the worker token to an explicit internal/runner allowlist.
7. **TAP-50 — Incremental re-scoring**
   - Replace the global configuration watermark scan.
   - Invalidate only new items dependent on the edited persona/campaign plus
     the conservative no-match set that could gain a match.
   - Keep unrelated ready results untouched.

The audit findings close through those cards as follows:

| Audit finding | Closing design |
|---|---|
| P1.6 | TAP-49 startup, root environment, internal URL, scoped credential |
| P1.7 | TAP-44/45 leased just-in-time source work, hard budgets, aborts, matching task |
| P1.8 | TAP-48 per-target cursor checkpoints and overlap replay |
| P1.10 | TAP-47/50 versioned matching readiness, acceptance fence, targeted invalidation |
| P1.11 | TAP-44/46/49 discovery and automation leases, draft idempotency, validated self-scheduling loops |

P1.7's target architecture also names package and fan-out stages that do not yet
exist as first-class discovery records. Sprint 49 independently bounds every
live boundary: source delivery/page commit, per-item matching, and automatic
signal-to-draft output. It does not invent the opportunity/package model owned
by later discovery sprints.

## 5. Runtime topology

### 5.1 One discovery execution path

Both automatic and founder-triggered discovery use the same scheduler service.
The public workspace route may scope the tick to one workspace, but it cannot
bypass leases, budgets, occurrence idempotency, cursor rules, or matching state.

The automatic path is:

1. Worker timer calls `POST /internal/discovery/tick`.
2. API authenticates the narrowly scoped worker credential.
3. Scheduler acquires the singleton `discovery:scheduler` lease.
4. Due source jobs are enqueued idempotently.
5. Scheduler claims one job just before execution.
6. Adapter reads one bounded provider page.
7. API atomically persists occurrences and the next cursor checkpoint.
8. The lease is heartbeated and the next page is read while budget remains.
9. Job completion is fenced by the same owner/version.
10. Pending matching work is claimed and persisted under its own item version
    fence while tick budget remains.
11. Scheduler releases its lease or lets it expire safely if the process dies.

A second overlapping tick that cannot acquire the scheduler lease returns a
successful “already running” result and performs no work.

### 5.2 Automation overlap path

P1.11 is not closed by fixing discovery alone. Automatic signal-to-draft
generation currently performs a read for an existing draft, awaits LLM work,
and then inserts. Two automation ticks can both pass the read.

Sprint 49 therefore makes the following narrow automation correction without
turning automation into the Sprint 73 queue:

1. Worker calls `POST /internal/automation/tick` from a validated
   self-scheduling loop.
2. The endpoint acquires the singleton `automation:scheduler` lease before
   listing workspaces.
3. Each workspace run, including the founder-triggered public route, acquires
   `automation:<workspace-id>` before reading signals or generating.
4. Automatic draft submission writes a deterministic idempotency key derived
   from `(workspaceId, signalId, campaignId, channel)`.
5. A unique database index on that key is the final exactly-once boundary.
6. Draft insertion and the `scheduled_auto` approval transition commit in one
   transaction. A conflict means another execution won; the losing execution
   returns the existing draft as an idempotent success and never approves it
   twice.

The scheduler and workspace leases suppress duplicate LLM work in the normal
case. The unique idempotency key remains authoritative if a manual run races the
worker, a lease expires during a slow model call, or two API processes overlap.

Other worker domains receive strict timer validation in this sprint, but their
full durable task migration and domain-specific idempotency boundaries remain
Sprint 73 unless an existing route already provides one.

### 5.3 Ownership identity

The API creates one stable process instance ID at startup:

`<configured-instance-name-or-host>:<random-process-uuid>`

Each scheduler invocation and job claim adds a fresh execution UUID. The full
owner value identifies the API process and the specific execution. The worker
does not get to choose a database lease owner.

### 5.4 Reusable lease record

A new `task_leases` table owns singleton/background-task coordination:

| Column | Meaning |
|---|---|
| `key` | Stable lease name, primary key |
| `owner` | Current execution owner |
| `version` | Monotonic fencing token |
| `expires_at` | Epoch milliseconds after which another owner may claim |
| `heartbeat_at` | Last successful renewal |
| `created_at` / `updated_at` | Audit timestamps |

Sprint 49 uses the following stable lease keys:

- `discovery:scheduler`;
- `automation:scheduler`;
- `automation:<workspace-id>`.

A claim transaction creates an absent row or replaces only an expired row, then
increments `version`. A live row returns `busy` without mutation. Heartbeats and
release update only the current owner/version; release expires the row rather
than deleting it so the fencing version cannot reset.

`discovery_jobs` receives the same execution fields:

- `leaseOwner`;
- `leaseVersion`;
- `leaseExpiresAt`;
- `heartbeatAt`.

It also records the claimed source's `executionVersion`.
`discovery_sources.executionVersion` increments whenever execution-relevant
source configuration, connection, enabled state, or target membership changes.
A page from an older source version cannot commit into the newer configuration.

The existing `lockedAt` remains a claimed-at timestamp for one compatibility
release; it no longer decides ownership or stale recovery.

### 5.5 Lease state machine

For a queued job:

`queued → running(owner=A, version=N, expiry=T)`

For an expired running job:

`running(expired, version=N) → running(owner=B, version=N+1, expiry=T2)`

Every mutation after claim includes:

```text
WHERE id = ?
  AND status = 'running'
  AND lease_owner = ?
  AND lease_version = ?
```

Lease comparison and expiry assignment use the database's clock inside the
claim/heartbeat transaction. Worker and API wall clocks never decide whether a
lease is live. Explicit release is also fenced by owner/version.

Heartbeat also requires the lease to be unexpired. An owner that wakes after its
lease expired cannot renew itself, complete the job, update counts, persist a
page, advance a cursor, or mark the newer execution failed.

Lease loss is a control-flow result, not a source failure. The stale owner stops
without changing source health.

### 5.6 Heartbeat and abort

The default job, scheduler, automation-workspace, and matching lease is 45
seconds and renews every 10 seconds. Work may be longer than one lease period
only while successful heartbeats continue.

The source execution owns one `AbortController`. Losing the lease, exceeding a
budget, shutting down, or reaching the wall-clock deadline aborts:

- keyless safe-fetch work;
- connector-fabric provider requests;
- bounded provider response parsing;
- the discovery LLM judgment.

A promise timeout without transport cancellation is not considered a hard
bound. The abort signal must reach the network transport so abandoned work does
not continue consuming sockets or later attempt persistence.

## 6. Hard budgets

The first release uses validated operator policy with these defaults and hard
ranges:

| Budget | Default | Hard range | Operator environment |
|---|---:|---:|---|
| Jobs admitted by one tick | 5 | 1–25 | `DISCOVERY_TICK_MAX_JOBS` |
| Tick wall clock | 180 s | 10–600 s | `DISCOVERY_TICK_TIMEOUT_MS` |
| One source wall clock | 60 s | 5–180 s | `DISCOVERY_SOURCE_TIMEOUT_MS` |
| Items admitted per source job | 100 | 1–500 | `DISCOVERY_SOURCE_MAX_ITEMS` |
| Provider pages per source job | 4 | 1–20 | `DISCOVERY_SOURCE_MAX_PAGES` |
| Provider calls per source job | 20 | 1–100 | `DISCOVERY_SOURCE_MAX_CALLS` |
| Decoded JSON per response | 2 MiB | 64 KiB–8 MiB | `DISCOVERY_RESPONSE_MAX_BYTES` |
| Decoded data per source job | 10 MiB | 256 KiB–32 MiB | `DISCOVERY_SOURCE_MAX_BYTES` |
| Matching items admitted per tick | 20 | 1–100 | `DISCOVERY_MATCH_MAX_ITEMS` |
| One matching judgment wall clock | 45 s | 5–120 s | `DISCOVERY_MATCH_TIMEOUT_MS` |
| Concurrent executions for one source | 1 | fixed | none |
| Lease duration | 45 s | 15–300 s | `DISCOVERY_LEASE_MS` |
| Heartbeat period | 10 s | 2–60 s | `DISCOVERY_HEARTBEAT_MS` |

The scheduler claims one job at a time and stops before claiming another when
the tick cannot give it a meaningful remaining budget. It never claims five
jobs upfront and then lets four age while the first runs.

These are deployment controls, not workspace or customer product settings.
Missing values use the defaults. Nonnumeric, non-integer, non-finite, zero,
negative, or out-of-range values fail startup. Cross-field validation requires
source and matching timeouts below the tick timeout and heartbeat below half of
the lease duration.

Budgets are source-global, not per tracked handle. A source containing many
accounts cannot multiply a 100-item cap into thousands of items. Multi-target
adapters resume targets in round-robin order from cursor state so a long source
does not starve handles beyond the first call budget.

Safe-fetch limits from Sprint 48 remain authoritative for workspace-influenced
keyless URLs. Sprint 49 adds equivalent bounded streaming for fixed-origin
connector JSON responses rather than routing trusted provider origins through
the untrusted-URL policy.

## 7. Idempotency and database invariants

### 7.1 Source job invariant

A partial unique index prevents more than one active job per source:

```text
UNIQUE(source_id) WHERE status IN ('queued', 'running')
```

Enqueue becomes an insert-with-conflict-ignore operation. The database, not a
preceding “busy source” read, resolves two concurrent enqueuers.

### 7.2 Occurrence invariant

The business idempotency key is `(sourceId, externalId)`. The existing
`discovered_items_source_external` unique index becomes the authoritative
exactly-once boundary.

Adapters must return a stable provider occurrence ID. An item without a stable
ID is rejected for that page with a safe adapter error; the runner never
manufactures an index-based ID that changes across replay.

Persistence uses conflict-safe insertion inside the page-checkpoint
transaction. Replaying an already committed page therefore produces zero new
occurrences while still allowing the checkpoint to converge.

### 7.3 Downstream idempotency

Canonicalization and match replacement remain transaction-scoped. A replayed
occurrence cannot create a second canonical item, a second match set, or a
second accepted signal because:

- occurrence insertion is unique;
- matching claims one item/version;
- triage changes `new` to `accepted` atomically;
- double acceptance remains a conflict.

Automated signal-to-draft output receives a separate nullable
`drafts.automationKey`. The automation path derives it from the four-part
business key and supplies it to a dedicated automatic-draft commit transaction.
A unique index over non-null automation keys makes the insert conflict-safe.
Draft creation and the `scheduled_auto` approval transition commit together;
the automation service returns the winning draft on a conflict and never
repeats its approval transition.

The key is nullable because founder-created drafts are revisions and creative
choices, not exactly-once automation outputs. The automation service still
recognizes a legacy draft with the same signal/campaign/channel as already
handled.

Sprint 49 does not claim global exactly-once delivery for ads, publishing,
inbox, cadence, sequence, evidence, or every future task. The generic lease
primitive is intentionally reusable, but moving those domains to the durable
queue and defining all of their business boundaries remains Sprint 73.

## 8. Cursor and pagination design

### 8.1 Cursor is a delivery checkpoint

`discovery_sources.cursor_json` becomes versioned internal state:

```ts
interface DiscoveryTargetCheckpoint {
  targetFingerprint: string;
  highWatermark: {
    externalId: string;
    publishedAt: number | null;
  } | null;
  continuation: {
    providerToken: string | null;
    boundaryExternalId: string | null;
    newestExternalId: string | null;
    newestPublishedAt: number | null;
  } | null;
  lastSafeError: string | null;
}

interface DiscoveryCursorV1 {
  version: 1;
  mode: string;
  nextTargetIndex: number;
  targets: Record<string, DiscoveryTargetCheckpoint>;
}
```

Each target has its own checkpoint because provider IDs and page tokens are not
comparable across accounts, lists, hashtags, or queries. The record key is an
internal stable target key: a tracked-account UUID when present, otherwise a
hash of the normalized provider/mode/target tuple. `targetFingerprint` detects
a configuration change without storing the raw target in the cursor.

Provider tokens are opaque, never logged, never included in error messages, and
never accepted from a workspace request. Public source reads keep the existing
`cursor` object but its mapper returns only safe progress fields—version, target
count, whether backlog remains, and last checkpoint time—rather than raw
continuation tokens. No current web flow consumes provider cursor contents.

### 8.2 Page reader contract

Connected adapters stop returning one unstructured item array. They implement a
bounded page contract:

```ts
interface DiscoveryPage {
  targetKey: string;
  items: RawDiscoveredItem[];
  nextToken: string | null;
  reachedBoundary: boolean;
  exhausted: boolean;
  callsUsed: number;
  decodedBytes: number;
  nextTargetIndex: number;
}
```

The adapter receives validated cursor state, remaining budget, and an abort
signal. It does not write the database.

Provider mappings:

- X search, account, and list timelines use `next_token`.
- Reddit listings use `after`.
- LinkedIn uses its supported start/page metadata and stops at the stored
  high-watermark when no opaque continuation is available.
- Instagram uses Graph paging cursors for media/hashtag pages.
- Keyless RSS/news/podcast sources remain bounded document reads and rely on
  occurrence IDs; they do not invent unsupported provider pagination.

### 8.3 Atomic page checkpoint

Every successfully fetched page is committed in one transaction:

1. Verify job owner/version and unexpired lease.
2. Re-resolve the source inside its workspace and require the job's
   `executionVersion` to equal the source's current version.
3. Insert valid occurrences with conflict-ignore.
4. Canonicalize only newly inserted occurrences.
5. Update accumulated job counts.
6. Write the current target's next continuation or completed high-watermark and
   the next round-robin target index.
7. Update safe source attempt/success state when appropriate.

If any write fails, neither the page's occurrences nor its cursor checkpoint
advance.

When a target's prior high-watermark or provider end is reached, its checkpoint
promotes the run's `newestExternalId` to the new high-watermark and clears that
target's continuation. When a page/call/time budget ends first, continuation
remains and the reclaimed or next scheduled job resumes the backlog.

### 8.4 Invalid and expired cursors

If a provider rejects an opaque continuation as invalid or expired:

- discard only that target's continuation;
- restart from the newest page;
- replay with overlap until the durable high-watermark;
- rely on occurrence uniqueness to remove duplicates;
- do not move the high-watermark forward until the gap has been traversed.

This prefers replay cost over silent loss.

### 8.5 Multi-target fairness

For sources containing many tracked accounts, calls advance round-robin and the
next checkpoint resumes at the following target. Page, call, byte, item, and
wall-clock budgets are shared across all targets.

A deleted, private, or permission-denied target records a stable target-local
error and yields to the next target. Pages already committed for healthy targets
remain committed. Removing a target drops only its checkpoint; adding or
materially changing one creates a fresh checkpoint and cannot reset the other
targets.

## 9. Scoring and triage serialization

### 9.1 Explicit matching state

`discovered_items` receives:

- `matchingState`: `pending | running | ready | retryable_error | frozen`;
- `matchingVersion`: monotonic integer;
- `matchingInputFingerprint`: hash of the canonical item content and the ordered
  persona/campaign matching inputs;
- `matchingLeaseOwner`;
- `matchingLeaseExpiresAt`;
- `matchingHeartbeatAt`;
- `matchingError`: stable safe code or `null`.

New canonical items begin `pending`. Duplicate, skipped, and historical terminal
items are `frozen`.

### 9.2 Matching claim

The scorer claims a bounded batch by changing:

`pending/retryable_error → running(owner, version+1, expiry)`

The matching lease uses the same heartbeat, expiry, and transport-abort rules as
a discovery job. The scorer builds the prompt, awaits the LLM with an abort
signal, and persists only if:

- the item still belongs to the workspace;
- its triage status is still `new`;
- matching state is still `running`;
- owner and matching version still match;
- matching input fingerprint still matches current item/configuration inputs;
- all referenced persona/campaign targets still pass Sprint 48's write-time
  tenant revalidation.

Match rows, suggested projections, score, reason, `scoredAt`, and
`matchingState=ready` commit in the existing atomic transaction.

A stale scorer writes nothing.

### 9.3 Acceptance rule

First acceptance requires `matchingState=ready` inside the acceptance
transaction. `pending`, `running`, and `retryable_error` return a stable `409`
such as `matching_not_ready`; no signal is created.

The UI disables Accept for those states and shows:

- “Scoring” for pending/running;
- “Scoring delayed — retry discovery” for retryable errors.

After a completed result, acceptance copies that exact match set and projections
into the signal transaction. A ready result with zero matches is still a valid
completed judgment; accepting it is an explicit human choice rather than a race
that silently lost matches.

If an item already has a ready result and a configuration-driven re-score begins,
acceptance is blocked until the new version becomes ready. The old result may
remain visible as stale context but cannot be copied as current.

### 9.4 Failure and recovery

LLM, timeout, or lease-loss failures never become “no relevance.”

- Retryable provider/timeout failures set `retryable_error` with a safe code.
- The next run may reclaim the item.
- An expired `running` matching lease may be reclaimed with a higher version.
- No partial match replacement or projection update survives.

## 10. Incremental re-scoring

The current global `max(personas.updatedAt, campaigns.updatedAt)` watermark is
removed from discovery selection.

Persona and campaign writes call an invalidation service inside the same
transaction as the configuration change. Only still-`new` items are eligible.

The conservative invalidation rules are:

- persona edit/delete: items with a match referencing that persona;
- campaign edit/delete: items with a match referencing that campaign or a
  persona in the campaign's previous/current assignment set;
- new persona/campaign or semantic targeting change: ready items with no match,
  because a former no-match verdict can plausibly become relevant;
- unrelated matched items: remain ready and are not re-sent to the LLM.

Invalidation increments `matchingVersion`, sets `matchingState=pending`, clears
the matching lease/error, and retains the old rows only as stale display context
until replacement succeeds. Triage cannot accept stale context.

Deletion invalidates before foreign-key cascades remove match rows so the blast
radius is not lost.

Tests measure prompt contents and prove one persona/campaign edit does not send
unrelated matched items back through the gateway.

## 11. Worker startup, configuration, and authentication

### 11.1 Environment

The worker uses:

- `TUEZDAY_INTERNAL_API_URL` for the API origin;
- `TUEZDAY_WORKER_TOKEN` for its narrowly scoped credential;
- validated interval and budget variables.

`TUEZDAY_API_URL` remains the public API base used by browser/MCP consumers and
is not reused by the worker.

The worker loads the repository root `.env` through its checked-in start command,
not through an operator's shell side effect.

Existing loop intervals keep their current defaults but receive explicit
bounds:

| Loop | Default | Hard range | Environment |
|---|---:|---:|---|
| Discovery | 30 min | 1–1,440 min | `DISCOVERY_INTERVAL_MIN` |
| Automation | 5 min | 1–1,440 min | `AUTOMATION_INTERVAL_MIN` |
| Learning synthesis | 7 days | 1–365 days | `LEARNING_SYNTHESIS_DAYS` |
| Ads sync | 6 h | 1–168 h | `ADS_SYNC_HOURS` |
| Publication | 1 min | 1–1,440 min | `PUBLISH_INTERVAL_MIN` |
| Cadence fill | 5 min | 1–1,440 min | `CADENCE_FILL_INTERVAL_MIN` |
| Inbox | 5 min | 1–1,440 min | `INBOX_INTERVAL_MIN` |
| Sequence | 5 min | 1–1,440 min | `SEQUENCE_INTERVAL_MIN` |
| Evidence sweep | 30 min | 1–1,440 min | `EVIDENCE_SWEEP_MIN` |

### 11.2 Startup validation

Before installing any timer, the worker validates:

- internal API URL is absolute;
- production uses HTTPS;
- development may use loopback HTTP;
- worker token is present outside explicit tests;
- every interval is finite, positive, and within its hard range;
- lease heartbeat is shorter than lease duration;
- source wall clock fits the allowed scheduler policy.

Failure prints one actionable configuration error and exits nonzero. No timer is
installed with `NaN`, zero, a negative value, or a near-continuous delay.

### 11.3 Repository commands

Root `npm run dev` starts API, web, and worker with named output streams. A
separate `dev:app` command may retain API+web-only startup for deliberate UI
work, but the documented default includes automatic discovery.

Discovery and automation no longer use independent `setInterval` callbacks.
Each loop awaits its tick and schedules the next wake-up from completion, so one
worker process cannot build an unbounded local backlog. Database leases remain
the correctness boundary across multiple workers, API processes, manual runs,
crashes, and lease expiry.

The deployment documentation names API and worker as separate required
processes and lists health/startup checks.

### 11.4 Credential scope

The worker credential is not a general workspace member or unrestricted system
actor.

- `/internal/discovery/tick` and `/internal/automation/tick` accept the
  credential.
- Existing non-discovery worker calls are restricted to an explicit
  method/path allowlist needed by the checked-in worker.
- The credential cannot read arbitrary brain, user, billing, evidence, draft,
  or connector routes.
- Internal authentication uses constant-time secret comparison.
- Public user tokens cannot call internal routes.

The wider worker-loop migration to dedicated durable tasks remains Sprint 73,
but Sprint 49 removes the current “worker token can act everywhere” posture.

## 12. API and contract behavior

The existing founder-triggered route remains:

`POST /workspaces/:id/discovery/run`

Its response stays additive-compatible and may include:

- `busy`: another scheduler owns the tick;
- `budgetExhausted`;
- `queued`;
- `processed`;
- `scored`;
- source results with stable safe errors;
- cursor progress summaries without opaque tokens.

The internal endpoints are not included in the public API/MCP scope.

Discovery item contracts add matching readiness and a stable retryable error
code. Raw lease owners, fencing versions, heartbeat timestamps, and provider
cursor tokens are operator-internal and not serialized to workspace users.

## 13. Error handling and observability

Expected durable job errors use stable codes:

- `lease_lost`
- `source_timeout`
- `tick_budget_exhausted`
- `item_budget_exhausted`
- `page_budget_exhausted`
- `call_budget_exhausted`
- `response_limit`
- `cursor_invalid`
- `cursor_replay`
- existing safe-fetch/provider permission/rate-limit codes

Budget exhaustion with a valid continuation is not source corruption. The job
checkpoints and remains resumable. Provider/domain failures retain the existing
source-local error behavior.

Operator logs include:

- task/job ID;
- workspace/source ID;
- lease version, never the credential;
- attempt;
- elapsed time;
- calls/pages/bytes/items admitted;
- replay or continuation state;
- terminal safe code.

Logs and persisted errors exclude:

- worker tokens;
- OAuth credentials;
- opaque provider cursor tokens;
- provider response bodies;
- raw transport exceptions;
- internal network details prohibited by Sprint 48.

## 14. Migration and compatibility

The migration:

1. Creates `task_leases`.
2. Adds `discovery_sources.execution_version` and the captured version plus
   lease fields on discovery jobs.
3. Adds the partial unique active-source-job index.
4. Adds nullable `drafts.automation_key` and a unique index over its non-null
   values.
5. Backfills one deterministic automation key onto the oldest existing draft
   for each signal/campaign/channel tuple. Any pre-existing duplicate remains
   visible with a null key; migration never deletes founder-visible work.
6. Adds matching state/version/lease/error fields.
7. Converts existing queued jobs unchanged.
8. Converts existing running jobs back to queued with cleared legacy locks so
   deployment does not preserve an unverifiable owner.
9. Backfills new canonical items with `scoredAt` as `ready`, unscored new items
   as `pending`, and terminal/duplicate items as `frozen`.
10. Treats empty/legacy cursor JSON as a valid no-high-watermark V1 cursor.

Migration tests start from representative Sprint 46–48 rows, including running
jobs, scored/unscored items, empty cursors, and duplicate legacy automation
drafts.

No historical accepted signal is reopened or deleted. Legacy accepted items
remain frozen even when their old signal has no match; Sprint 49 prevents new
race-created cases rather than rewriting founder history.

## 15. Verification

### 15.1 Lease and overlap tests

- One owner claims a queued job with version 1.
- Heartbeat renews only the current unexpired owner/version.
- A live heartbeat prevents another owner from claiming.
- An expired job is reclaimed with a higher version.
- The stale owner cannot checkpoint, complete, fail, or renew.
- Two simultaneous enqueues create one active source job.
- Two overlapping scheduler ticks make one provider call set and admit one
  tick's bounded work.
- Per-source concurrency never exceeds one.
- Two overlapping automation ticks admit one scheduler execution.
- A worker automation run racing a founder-triggered run admits one workspace
  execution.
- Forced lease expiry during generation still yields one automatic draft
  because the database idempotency key fences final output.

### 15.2 Restart and idempotency tests

Fault injection occurs:

- after provider response, before any write;
- after the first occurrence insert;
- after canonicalization;
- before cursor update;
- after page checkpoint, before next page;
- after final cursor promotion, before response;
- after lease expiry and reclaim.

Every case proves:

- no duplicate `(source, occurrence)` row;
- no partial page/cursor commit;
- no stale-owner overwrite;
- restart resumes at or before the last committed boundary;
- overlap replay converges to the same final observations;
- an automatic draft replay converges to one
  `(workspace, signal, campaign, channel)` output and one approval transition.

### 15.3 Bounds tests

- Item cap is global across all handles in one source.
- Page and call caps stop additional provider calls.
- Provider JSON byte cap aborts while streaming.
- Source and tick wall clocks abort through the transport signal.
- No new job is claimed when insufficient tick budget remains.
- Invalid numeric environment values fail startup before timers.

### 15.4 Cursor tests

- X/Reddit/LinkedIn/Instagram adapters consume stored cursor state.
- More than one page of new occurrences is retained across runs.
- A burst larger than one job budget resumes through continuation.
- Reaching the old high-watermark promotes the new one.
- Crash after a page checkpoint resumes at the next page.
- Invalid/expired continuation replays from newest without loss.
- Multi-target round-robin resumes beyond the first target group.
- One target's permission failure does not roll back healthy targets' committed
  pages or cursor checkpoints.
- Adding, changing, or removing one target preserves every unrelated target's
  checkpoint.
- A source edit during an in-flight fetch prevents the old execution version
  from committing items or cursor state.

### 15.5 Scoring and triage tests

- Acceptance while first scoring is pending/running returns `409` and persists
  no signal.
- Acceptance after `ready` copies the exact current result.
- LLM failure becomes `retryable_error`, not a zero-match ready result.
- Expired matching work is reclaimed with a higher version.
- A stale scorer cannot update an accepted or re-versioned item.
- Match rows and projections roll back together after injected faults.
- Foreign/moved persona and campaign targets are removed at commit time.

### 15.6 Incremental invalidation tests

- Persona edit re-scores its matched items but not unrelated matched items.
- Campaign assignment change invalidates its campaign and affected persona
  matches.
- No-match items are conservatively reconsidered on semantic additions.
- Terminal/duplicate items are never re-scored.
- Config update and invalidation commit or roll back together.

### 15.7 Startup and authentication tests

- Root development command includes worker.
- Worker reads the root environment and calls the internal API origin.
- Missing production token/URL or invalid interval exits nonzero.
- Discovery and automation loops schedule their next wake-up only after the
  current call settles.
- Worker credential can call only the internal/allowlisted runner paths.
- User tokens cannot call internal routes.
- Worker token cannot access ordinary workspace data routes.

### 15.8 Sprint acceptance

The automated founder-acceptance scenario must demonstrate:

1. Start a paginated source with more than one page of new occurrences.
2. Kill/fault execution after a committed page.
3. Expire/reclaim the lease and restart.
4. Confirm every occurrence exists once and the cursor reaches the correct
   high-watermark.
5. Start two overlapping ticks and confirm one run's worth of provider calls and
   durable work.
6. Race worker and manual automation for the same accepted
   signal/campaign/channel and confirm one automatic draft and one approval.
7. Attempt triage while matching is incomplete and confirm no signal is created;
   retry after matching is ready and confirm the accepted signal carries the
   completed match set.
8. Start the repository through its documented command and confirm automatic
   discovery and automation run with scoped worker authentication.

Before TAP-8 is complete:

```sh
npm run typecheck
npm test
```

## 16. Plane status protocol

- Read the full Plane card immediately before starting it.
- Move the active child card to `In Progress` when implementation begins.
- Move a child card to `Done` only after focused tests, relevant regressions, and
  typecheck pass.
- Completion comments record behavior, test commands/counts, and commit SHA.
- TAP-8 remains `In Progress` while any child card is unfinished.
- TAP-8 moves to `Done` only after TAP-44 through TAP-50 are `Done`, full
  verification passes, and founder acceptance evidence is recorded.
- If a card cannot meet its acceptance criteria, leave it unfinished and record
  the blocker without claiming completion.

## 17. Non-goals

- The general cross-domain durable queue, retries/dead letters, and global
  workspace fairness planned for Sprint 73.
- Provider repair for LinkedIn, Google Trends, or Instagram Login; Sprint 50
  owns those changes.
- Non-destructive duplicate clustering/source deletion repair; Sprint 50 owns
  it.
- New discovery source types.
- A customer-configurable lease, timeout, cursor, or safety-policy UI.
- Exactly-once semantics for ads, publishing, inbox, cadence, sequence,
  evidence, or future worker actions beyond the automatic-draft boundary
  explicitly fixed here.
- Replacing SQLite or introducing Redis/Kafka solely for this sprint.

## 18. Progress log

- **2026-07-28:** Sprint 48 passed delegated founder acceptance, was published
  at `d9717aa`, and Plane TAP-7 remained `Done` with final evidence.
- **2026-07-28:** Plane TAP-8 and TAP-44 through TAP-50 inspected; TAP-8 moved
  to `In Progress` for design discovery while child cards remained `Backlog`.
- **2026-07-28:** Founder approved the thin-worker, API-owned leased-runtime
  design direction.
- **2026-07-28:** Isolated Sprint 49 branch created from accepted Sprint 48 at
  `d9717aa`.
- **2026-07-28:** Clean isolated baseline confirmed: 165 test files,
  1,718/1,718 tests, and all seven workspace typechecks pass.
