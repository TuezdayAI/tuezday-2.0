# Sprint 49 Bounded, Leased Job Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discovery and automatic signal drafting bounded, lease-safe,
restart-safe, cursor-driven, and protected from scoring/triage races.

**Architecture:** The worker becomes a thin, validated caller of internal task
endpoints. The API owns database-clock leases, just-in-time claims, bounded
provider work, atomic occurrence/cursor checkpoints, versioned matching, and
automatic-draft idempotency. SQLite constraints and fenced writes remain the
correctness boundary across restarts and overlapping API/worker processes.

**Tech Stack:** TypeScript 5.7, Node.js 20+, Fastify 5, Drizzle ORM 0.44,
better-sqlite3 12, Zod 3.25, Vitest 3, Next.js web client.

## Global Constraints

- Work only in branch `sprint-49-bounded-leased-job-execution`, based on
  accepted Sprint 48 commit `d9717aa`.
- Preserve Sprint 48 safe-fetch destination, redirect, byte, timeout, and
  tenant-isolation guarantees.
- Lease comparisons and expiry assignment use the SQLite database clock, never
  a worker- or API-supplied clock.
- Lease duration defaults to 45 seconds; heartbeat defaults to 10 seconds and
  must be less than half the lease duration.
- One tick admits at most 5 source jobs and lasts at most 180 seconds.
- One source gets at most 60 seconds, 100 admitted items, 4 pages, 20 provider
  calls, 2 MiB decoded JSON per response, and 10 MiB decoded data in total.
- Matching admits at most 20 items per tick and 45 seconds per judgment.
- Per-source execution concurrency is fixed at one and is not customer
  configurable.
- Operator overrides are environment-only, integer, finite, positive, and
  constrained to the hard ranges in the approved specification.
- Never log or serialize worker tokens, OAuth credentials, provider cursor
  tokens, provider bodies, raw transport exceptions, or prohibited internal
  network details.
- Public source reads expose safe cursor progress only; provider tokens remain
  internal.
- Preserve manual signal drafting: multiple founder-created drafts per signal
  remain allowed. Exactly-once applies only to automatic
  signal×campaign×channel output.
- Every code change follows red-green TDD and gets a focused commit.
- Before starting a Plane card, read it and move it to `In Progress`. Move it to
  `Done` only after its focused tests, relevant regressions, and typecheck pass;
  add a completion comment with behavior, commands/counts, and commit SHA.
- TAP-8 remains `In Progress` until TAP-44 through TAP-50 are all `Done` and the
  automated founder-acceptance scenario passes.

---

## File and Responsibility Map

### New API files

- `apps/api/src/runtime/operator-policy.ts` — parse and validate API-owned
  discovery budgets.
- `apps/api/src/services/task-leases.ts` — generic database-clock singleton
  lease claim, heartbeat, release, and heartbeat runner.
- `apps/api/src/services/discovery-scheduler.ts` — one authoritative automatic
  and founder-triggered discovery scheduler.
- `apps/api/src/discovery/paging.ts` — internal cursor, target, page, and budget
  types plus cursor reconciliation.
- `apps/api/src/connectors/bounded-json.ts` — abortable decoded-response reader
  used by the Nango proxy.
- `apps/api/src/services/discovery-matching.ts` — matching claims, fingerprints,
  heartbeats, result commits, and retryable failures.
- `apps/api/src/services/matching-invalidation.ts` — targeted persona/campaign
  invalidation.
- `apps/api/src/routes/internal-tasks.ts` — worker-only discovery and automation
  tick endpoints.

### New worker files

- `apps/worker/src/config.ts` — root environment loading and strict startup
  validation.
- `apps/worker/src/scheduler.ts` — await-completion self-scheduling loops.
- `apps/worker/src/client.ts` — authenticated internal/allowlisted HTTP calls.
- `apps/worker/vitest.config.ts` — worker unit-test project.

### New focused tests

- `apps/api/test/sprint49-migrations.test.ts`
- `apps/api/test/task-leases.test.ts`
- `apps/api/test/operator-policy.test.ts`
- `apps/api/test/discovery-bounds.test.ts`
- `apps/api/test/discovery-idempotency.test.ts`
- `apps/api/test/discovery-matching-state.test.ts`
- `apps/api/test/discovery-cursors.test.ts`
- `apps/api/test/internal-tasks.test.ts`
- `apps/api/test/matching-invalidation.test.ts`
- `apps/api/test/sprint49-acceptance.test.ts`
- `apps/worker/test/config.test.ts`
- `apps/worker/test/scheduler.test.ts`

### Existing files with concentrated changes

- `apps/api/src/db/schema.ts` and generated migrations `0048`–`0050` — lease,
  source-version, automation-key, and matching-state persistence.
- `packages/contracts/src/index.ts` — matching readiness and safe cursor
  progress contracts.
- `apps/api/src/services/discovery-jobs.ts` — just-in-time leased job claims.
- `apps/api/src/services/discovery.ts` — bounded source execution, atomic page
  persistence, safe public cursor mapping, and acceptance fence.
- `apps/api/src/discovery/adapters.ts` and
  `apps/api/src/discovery/connected-adapters.ts` — bounded page readers.
- `apps/api/src/safe-fetch/index.ts`,
  `apps/api/src/safe-fetch/service.ts`,
  `apps/api/src/connectors/fabric.ts`,
  `apps/api/src/connectors/nango.ts`,
  `apps/api/src/llm/gateway.ts`,
  `apps/api/src/llm/gemini.ts`,
  `apps/api/src/llm/openrouter.ts`, and
  `apps/api/src/discovery/intent.ts` — abort propagation and bounded responses.
- `apps/api/src/services/drafts.ts`,
  `apps/api/src/services/signal-drafting.ts`, and
  `apps/api/src/services/automation.ts` — automatic draft idempotency and
  workspace lease.
- `apps/api/src/services/personas.ts` and
  `apps/api/src/services/campaigns.ts` — transactional targeted invalidation.
- `apps/api/src/auth/guard.ts`, `apps/api/src/app.ts`,
  `apps/api/src/routes/discovery.ts`, and
  `apps/api/src/routes/automation.ts` — scoped auth and shared execution paths.
- `apps/worker/src/index.ts`, root `package.json`, `.env.example`, `README.md`,
  `vitest.config.ts`, `docs/founder-acceptance-tests.md`, and the discovery page
  — startup, UI readiness, documentation, and acceptance.

---

### Task 1: TAP-44 — Add lease and source-version persistence

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0048_sprint_49_leases.sql`
- Create: `apps/api/drizzle/meta/0048_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/test/sprint49-migrations.test.ts`

**Interfaces:**

- Produces `taskLeases`, `TaskLeaseRow`,
  `discoverySources.executionVersion`,
  `discoveryJobs.sourceExecutionVersion`, and nullable discovery-job lease
  columns.
- Keeps source execution versions, owners, lease versions, expiry, and
  heartbeat fields internal to Drizzle rows. `discoveryJobSchema` remains
  unchanged and does not serialize them.

- [ ] **Step 1: Read TAP-44 and move it to `In Progress`**

Record the approved spec path and commit `15d4bd8` in the Plane start comment.
Do not change another child card.

- [ ] **Step 2: Write failing migration tests**

In `sprint49-migrations.test.ts`, migrate a temporary SQLite database through
`0047`, seed two active jobs for one source plus one running job, apply `0048`,
and assert:

```ts
const insertLegacyJob = (input: {
  id: string;
  workspaceId: string;
  sourceId: string;
  status: string;
  createdAt: number;
}) =>
  sqlite
    .prepare(`
      INSERT INTO discovery_jobs (
        id, workspace_id, source_id, status, attempt, locked_at, started_at,
        finished_at, fetched_count, new_count, error, created_at
      ) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, 0, 0, NULL, ?)
    `)
    .run(
      input.id,
      input.workspaceId,
      input.sourceId,
      input.status,
      input.createdAt,
    );
const columns = (table: string) =>
  sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
const scalar = (query: string) =>
  (sqlite.prepare(query).get() as { value: number }).value;

expect(columns("task_leases")).toEqual(
  expect.arrayContaining(["key", "owner", "version", "expires_at", "heartbeat_at"]),
);
expect(
  scalar(
    "SELECT COUNT(*) AS value FROM discovery_jobs WHERE status IN ('queued','running')",
  ),
).toBe(1);
expect(
  scalar(
    "SELECT COUNT(*) AS value FROM discovery_jobs WHERE status = 'running'",
  ),
).toBe(0);
expect(() =>
  insertLegacyJob({
    id: "duplicate-active",
    workspaceId,
    sourceId,
    status: "queued",
    createdAt: 3,
  }),
).toThrow(/UNIQUE constraint failed/);
```

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- sprint49-migrations.test.ts
```

Expected: FAIL because the columns, table, and unique active-job index do not
exist.

- [ ] **Step 4: Add the schema**

Use these exact columns:

```ts
export const taskLeases = sqliteTable("task_leases", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(),
  version: integer("version").notNull().default(1),
  expiresAt: integer("expires_at").notNull(),
  heartbeatAt: integer("heartbeat_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// discoverySources
executionVersion: integer("execution_version").notNull().default(1),

// discoveryJobs
sourceExecutionVersion: integer("source_execution_version").notNull().default(1),
leaseOwner: text("lease_owner"),
leaseVersion: integer("lease_version").notNull().default(0),
leaseExpiresAt: integer("lease_expires_at"),
heartbeatAt: integer("heartbeat_at"),
```

Replace `discovery_jobs_source_status` with:

```ts
index("discovery_jobs_source_status").on(t.sourceId, t.status),
uniqueIndex("discovery_jobs_one_active_source")
  .on(t.sourceId)
  .where(sql`${t.status} IN ('queued', 'running')`),
```

Do not add source execution versions or lease internals to
`discoveryJobSchema` or `discoverySourceSchema`.

- [ ] **Step 5: Generate and inspect the named migration**

Run:

```bash
npm run db:generate -w @tuezday/api -- --name sprint_49_leases
```

Edit only the generated `0048_sprint_49_leases.sql` to:

1. add the new source/job columns and `task_leases`;
2. reset legacy `running` rows to `queued` with cleared lock/lease fields;
3. keep the oldest active job per source and mark other active rows `skipped`
   with `migration_duplicate_active_job`;
4. create `discovery_jobs_one_active_source` only after repair.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- sprint49-migrations.test.ts discovery-jobs.test.ts
npm run typecheck
```

Expected: all selected tests pass and all workspaces typecheck.

- [ ] **Step 7: Commit the persistence foundation**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/sprint49-migrations.test.ts
git commit -m "feat(api): add Sprint 49 lease persistence"
```

Keep TAP-44 `In Progress`; the card is complete only after Task 2.

---

### Task 2: TAP-44 — Implement database-clock leases and fenced job claims

**Files:**

- Create: `apps/api/src/services/task-leases.ts`
- Modify: `apps/api/src/services/discovery-jobs.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/test/discovery-jobs.test.ts`
- Create: `apps/api/test/task-leases.test.ts`

**Interfaces:**

- Produces:

```ts
export interface LeaseToken {
  key: string;
  owner: string;
  version: number;
  expiresAt: number;
}

export function databaseNowMs(db: DbExecutor): number;
export function claimTaskLease(
  db: Db,
  key: string,
  owner: string,
  leaseMs: number,
): LeaseToken | null;
export function heartbeatTaskLease(
  db: Db,
  token: LeaseToken,
  leaseMs: number,
): LeaseToken | null;
export function releaseTaskLease(db: Db, token: LeaseToken): boolean;

export async function withTaskLease<T>(
  db: Db,
  input: {
    key: string;
    owner: string;
    leaseMs: number;
    heartbeatMs: number;
  },
  work: (context: { signal: AbortSignal; token: LeaseToken }) => Promise<T>,
): Promise<{ busy: true } | { busy: false; value: T }>;
```

- Replaces batch `claimDiscoveryJobs` with:

```ts
export interface DiscoveryJobClaim extends DiscoveryJobRow {
  leaseOwner: string;
  leaseExpiresAt: number;
}

export function claimNextDiscoveryJob(
  db: Db,
  input: {
    workspaceId?: string;
    owner: string;
    leaseMs: number;
  },
): DiscoveryJobClaim | null;
export function heartbeatDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  leaseMs: number,
): DiscoveryJobClaim | null;
export function completeDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  counts: { fetchedCount: number; newCount: number },
): boolean;
export function failDiscoveryJob(
  db: Db,
  claim: DiscoveryJobClaim,
  error: string,
): boolean;
```

- Removes `releaseStaleDiscoveryJobs` and
  `DISCOVERY_JOB_LOCK_TIMEOUT_MS`.

- [ ] **Step 1: Write failing task-lease tests**

Cover claim, live-owner rejection, heartbeat, fenced release, expiry reclaim,
monotonic versions, and `withTaskLease` aborting work when heartbeat loses its
fence:

```ts
const first = claimTaskLease(db, "discovery:scheduler", "owner-a", 45_000)!;
expect(first.version).toBe(1);
expect(claimTaskLease(db, first.key, "owner-b", 45_000)).toBeNull();
expect(heartbeatTaskLease(db, first, 45_000)?.version).toBe(1);
expect(releaseTaskLease(db, { ...first, owner: "stale" })).toBe(false);
expect(releaseTaskLease(db, first)).toBe(true);
const second = claimTaskLease(db, first.key, "owner-b", 45_000)!;
expect(second.version).toBe(2);
```

Expire a row with raw SQL using the database clock; do not add a caller `now`
parameter to production lease functions.

- [ ] **Step 2: Rewrite the discovery-job tests for just-in-time claims**

Pin these behaviors:

- one claim at a time;
- queued jobs remain queued until they can begin;
- an unexpired running job cannot be claimed;
- an expired job is reclaimed with `leaseVersion + 1`;
- heartbeat, success, and failure require current owner/version and an
  unexpired lease;
- a stale owner changes zero rows;
- two simultaneous enqueues converge through the partial unique index.

Use `Promise.allSettled` with two independently opened SQLite connections to a
temporary WAL database for the cross-process enqueue/claim cases.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- task-leases.test.ts discovery-jobs.test.ts
```

Expected: FAIL because the generic lease service and fenced job APIs do not
exist.

- [ ] **Step 4: Implement generic lease compare-and-swap**

Use one database-clock expression everywhere:

```ts
const DB_NOW_MS = sql<number>`
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
`;
```

Claim in a transaction. Insert an absent row at version 1; update only
`expires_at <= DB_NOW_MS`, set `version = version + 1`, and read back the token.
Heartbeat must include key, owner, version, and `expires_at > DB_NOW_MS`.
Release must include key, owner, version and set `expires_at = DB_NOW_MS`; never
delete a lease row.

`withTaskLease` claims once, renews from a recursive timeout, aborts its supplied
signal on heartbeat loss, releases the newest token in `finally`, and returns
`{ busy: true }` without invoking work when the initial claim fails.

- [ ] **Step 5: Implement just-in-time discovery job claims**

`enqueueDueDiscoveryJobs` writes the source's current `executionVersion` and
uses insert-with-conflict-ignore instead of a preceding busy-source query.

`claimNextDiscoveryJob` considers:

```text
status = queued
OR (status = running AND lease_expires_at <= database_now)
```

It selects oldest-first, updates one row with owner, incremented version,
expiry, heartbeat, attempt, and running status, and returns it only when the
compare-and-swap changed one row.

All heartbeat/complete/fail updates include:

```text
id + status=running + lease_owner + lease_version + unexpired lease
```

Lease loss returns `false`/`null`; it never marks the source unhealthy.

- [ ] **Step 6: Fence source edits against in-flight jobs**

In `updateDiscoverySource`, increment `executionVersion` when config,
connection, enabled state, or target membership changes. In the same
transaction, mark that source's queued/running old-version jobs `skipped` and
set `finishedAt`/`source_version_changed`. A stale runner's later job update
then changes zero rows.

- [ ] **Step 7: Run TAP-44 verification**

Run:

```bash
npm test -- task-leases.test.ts discovery-jobs.test.ts discovery.test.ts connected-discovery.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 8: Commit and close TAP-44**

```bash
git add apps/api/src/services/task-leases.ts apps/api/src/services/discovery-jobs.ts apps/api/src/services/discovery.ts apps/api/test/task-leases.test.ts apps/api/test/discovery-jobs.test.ts
git commit -m "feat(api): fence discovery work with real leases"
```

Add the focused commands/counts and SHA to TAP-44, then move TAP-44 to `Done`.

---

### Task 3: TAP-45 — Add validated policy and end-to-end cancellation

**Files:**

- Create: `apps/api/src/runtime/operator-policy.ts`
- Create: `apps/api/test/operator-policy.test.ts`
- Modify: `apps/api/src/safe-fetch/index.ts`
- Modify: `apps/api/src/safe-fetch/service.ts`
- Modify: `apps/api/test/safe-fetch-routing.test.ts`
- Create: `apps/api/src/connectors/bounded-json.ts`
- Modify: `apps/api/src/connectors/fabric.ts`
- Modify: `apps/api/src/connectors/nango.ts`
- Modify: `apps/api/test/connectors.test.ts`
- Modify: `apps/api/src/llm/gateway.ts`
- Modify: `apps/api/src/llm/gemini.ts`
- Modify: `apps/api/src/llm/openrouter.ts`
- Modify: `apps/api/src/llm/fallback.ts`
- Modify: `apps/api/src/discovery/intent.ts`

**Interfaces:**

- Produces:

```ts
export interface DiscoveryOperatorPolicy {
  maxJobsPerTick: number;
  tickTimeoutMs: number;
  sourceTimeoutMs: number;
  maxItemsPerSource: number;
  maxPagesPerSource: number;
  maxCallsPerSource: number;
  maxResponseBytes: number;
  maxBytesPerSource: number;
  maxMatchingItemsPerTick: number;
  matchingTimeoutMs: number;
  leaseMs: number;
  heartbeatMs: number;
}

export const DEFAULT_DISCOVERY_POLICY: DiscoveryOperatorPolicy;
export function parseDiscoveryOperatorPolicy(
  env: NodeJS.ProcessEnv,
): DiscoveryOperatorPolicy;
```

- Extends existing seams without breaking non-discovery callers:

```ts
// SafeFetchRequest
signal?: AbortSignal;

// GenerateParams
signal?: AbortSignal;

// IntentProvider
fetchSignals(
  config: DiscoverySourceConfig,
  signal?: AbortSignal,
): Promise<RawDiscoveredItem[]>;

// ConnectorFabric.proxyJson opts
signal?: AbortSignal;
maxResponseBytes?: number;

// ProxyJsonResult
decodedBytes?: number;
```

- [ ] **Step 1: Read TAP-45 and move it to `In Progress`**

Record TAP-44's closing SHA as the dependency in the Plane start comment.

- [ ] **Step 2: Write failing operator-policy tests**

Test every default, boundary, and cross-field invariant:

```ts
expect(parseDiscoveryOperatorPolicy({})).toEqual(DEFAULT_DISCOVERY_POLICY);
expect(() =>
  parseDiscoveryOperatorPolicy({ DISCOVERY_TICK_MAX_JOBS: "0" }),
).toThrow(/DISCOVERY_TICK_MAX_JOBS/);
expect(() =>
  parseDiscoveryOperatorPolicy({ DISCOVERY_SOURCE_MAX_ITEMS: "1.5" }),
).toThrow(/integer/);
expect(() =>
  parseDiscoveryOperatorPolicy({
    DISCOVERY_LEASE_MS: "15000",
    DISCOVERY_HEARTBEAT_MS: "10000",
  }),
).toThrow(/less than half/);
```

Pin every name/default/range from the approved spec; use one helper
`boundedInteger(env, name, fallback, min, max)`.

- [ ] **Step 3: Write failing abort and byte-bound tests**

Add tests proving:

- aborting the caller signal destroys a safe-fetch transport body;
- Nango stops reading as soon as decoded bytes exceed `maxResponseBytes`;
- the connector request receives the caller signal;
- Gemini/OpenRouter receive and honor `GenerateParams.signal`;
- the intent seam receives the source signal.

For the bounded JSON reader, stream two chunks where the second crosses the
limit:

```ts
await expect(
  readBoundedJsonResponse(responseWithChunks(["{\"x\":\"", "too-large\"}"]), {
    maxBytes: 8,
    signal: new AbortController().signal,
  }),
).rejects.toMatchObject({ code: "response_limit" });
```

- [ ] **Step 4: Run the focused tests and confirm the red state**

Run:

```bash
npm test -- operator-policy.test.ts safe-fetch-routing.test.ts connectors.test.ts llm.test.ts
```

Expected: FAIL on the missing policy, signal fields, and bounded reader.

- [ ] **Step 5: Implement strict operator-policy parsing**

Create the focused runtime directory:

```bash
mkdir -p apps/api/src/runtime
```

Expected: the directory exists and contains only the new policy module after
this step.

Use the approved variables and ranges:

```ts
export const DEFAULT_DISCOVERY_POLICY = Object.freeze({
  maxJobsPerTick: 5,
  tickTimeoutMs: 180_000,
  sourceTimeoutMs: 60_000,
  maxItemsPerSource: 100,
  maxPagesPerSource: 4,
  maxCallsPerSource: 20,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBytesPerSource: 10 * 1024 * 1024,
  maxMatchingItemsPerTick: 20,
  matchingTimeoutMs: 45_000,
  leaseMs: 45_000,
  heartbeatMs: 10_000,
} satisfies DiscoveryOperatorPolicy);
```

Map the fields to environment variables with these inclusive hard ranges:

| Field | Environment | Default | Minimum | Maximum |
|---|---|---:|---:|---:|
| `maxJobsPerTick` | `DISCOVERY_TICK_MAX_JOBS` | 5 | 1 | 25 |
| `tickTimeoutMs` | `DISCOVERY_TICK_TIMEOUT_MS` | 180000 | 10000 | 600000 |
| `sourceTimeoutMs` | `DISCOVERY_SOURCE_TIMEOUT_MS` | 60000 | 5000 | 180000 |
| `maxItemsPerSource` | `DISCOVERY_SOURCE_MAX_ITEMS` | 100 | 1 | 500 |
| `maxPagesPerSource` | `DISCOVERY_SOURCE_MAX_PAGES` | 4 | 1 | 20 |
| `maxCallsPerSource` | `DISCOVERY_SOURCE_MAX_CALLS` | 20 | 1 | 100 |
| `maxResponseBytes` | `DISCOVERY_RESPONSE_MAX_BYTES` | 2097152 | 65536 | 8388608 |
| `maxBytesPerSource` | `DISCOVERY_SOURCE_MAX_BYTES` | 10485760 | 262144 | 33554432 |
| `maxMatchingItemsPerTick` | `DISCOVERY_MATCH_MAX_ITEMS` | 20 | 1 | 100 |
| `matchingTimeoutMs` | `DISCOVERY_MATCH_TIMEOUT_MS` | 45000 | 5000 | 120000 |
| `leaseMs` | `DISCOVERY_LEASE_MS` | 45000 | 15000 | 300000 |
| `heartbeatMs` | `DISCOVERY_HEARTBEAT_MS` | 10000 | 2000 | 60000 |

Reject decimal, scientific non-integer, non-finite, zero, negative, and
out-of-range values. Validate source/matching timeouts below tick timeout and
heartbeat below half the lease.

- [ ] **Step 6: Propagate abort through safe fetch and LLM**

Combine the safe-fetch internal deadline with `request.signal` using
`AbortSignal.any`. Dispose the internal timer in `finally`. Pass the combined
signal to DNS, transport, and body reading.

Add `signal` to `GenerateParams`, pass it to provider `fetch` calls, and pass
the unchanged params through the fallback gateway. Existing call sites omit it
and remain source-compatible.

- [ ] **Step 7: Bound connector JSON while streaming**

`readBoundedJsonResponse` must:

1. read `Response.body` chunks;
2. count decoded bytes before concatenation;
3. cancel the reader and throw stable `response_limit` at the cap;
4. abort on `signal`;
5. parse JSON only after the bounded read;
6. return `{ json, decodedBytes }`.

In `NangoFabric.proxyJson`, combine a 30-second transport timeout with
`opts.signal`, use the bounded reader, and return `decodedBytes`. Keep a
conservative 10 MiB default for existing non-discovery callers; discovery
always supplies its 2 MiB policy limit.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm test -- operator-policy.test.ts safe-fetch-body.test.ts safe-fetch-routing.test.ts connectors.test.ts llm.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 9: Commit the policy and cancellation seams**

```bash
git add apps/api/src/runtime apps/api/src/safe-fetch apps/api/src/connectors apps/api/src/llm apps/api/src/discovery/intent.ts apps/api/test/operator-policy.test.ts apps/api/test/safe-fetch-routing.test.ts apps/api/test/connectors.test.ts
git commit -m "feat(api): enforce discovery budgets at transport boundaries"
```

Keep TAP-45 `In Progress`; the source runner is completed in Task 4.

---

### Task 4: TAP-45 — Build the bounded API-owned discovery scheduler

**Files:**

- Create: `apps/api/src/discovery/paging.ts`
- Create: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/discovery/adapters.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Create: `apps/api/test/discovery-bounds.test.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`
- Modify: `apps/api/test/discovery-jobs.test.ts`

**Interfaces:**

- Produces the stable page boundary:

```ts
export interface DiscoveryTargetCheckpoint {
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

export interface DiscoveryCursorV1 {
  version: 1;
  mode: string;
  nextTargetIndex: number;
  targets: Record<string, DiscoveryTargetCheckpoint>;
}

export interface DiscoveryTarget {
  key: string;
  fingerprint: string;
  handle?: string;
  externalId?: string | null;
}

export interface DiscoveryPage {
  targetKey: string;
  items: RawDiscoveredItem[];
  nextToken: string | null;
  reachedBoundary: boolean;
  exhausted: boolean;
  callsUsed: number;
  decodedBytes: number;
}
```

- Produces:

```ts
export interface DiscoverySchedulerResult extends DiscoveryRunResult {
  busy: boolean;
  budgetExhausted: boolean;
}

export interface DiscoverySchedulerDependencies {
  db: Db;
  llm: LlmGateway;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  policy: DiscoveryOperatorPolicy;
  instanceId: string;
  shutdownSignal: AbortSignal;
  log: (event: DiscoveryOperatorEvent) => void;
}

export interface DiscoveryOperatorEvent {
  code: string;
  taskKey: string;
  jobId: string | null;
  workspaceId: string | null;
  sourceId: string | null;
  leaseVersion: number;
  attempt: number;
  elapsedMs: number;
  calls: number;
  pages: number;
  bytes: number;
  items: number;
  continuationPending: boolean;
  replay: boolean;
}

export async function runDiscoveryScheduler(
  deps: DiscoverySchedulerDependencies,
  input: { workspaceId?: string },
): Promise<DiscoverySchedulerResult>;

export interface SourceBudget {
  deadlineMs: number;
  maxItems: number;
  maxPages: number;
  maxCalls: number;
  maxResponseBytes: number;
  maxBytes: number;
}

export interface DiscoverySourceExecution extends DiscoverySource {
  executionVersion: number;
  cursorState: DiscoveryCursorV1;
}

export interface DiscoverySourceDependencies {
  db: Db;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
}
```

- `BuildAppOptions` receives these optional test seams:

```ts
operatorPolicy?: DiscoveryOperatorPolicy;
instanceId?: string;
operatorLog?: (event: DiscoveryOperatorEvent) => void;
shutdownSignal?: AbortSignal;
```

`buildApp` defaults `operatorPolicy` to `DEFAULT_DISCOVERY_POLICY`,
`instanceId` to
`${process.env.HOSTNAME?.trim() || hostname()}:${randomUUID()}`, and
`operatorLog` to a safe structured console adapter. When no shutdown signal is
injected, `buildApp` owns an `AbortController` and aborts it in `onClose`.
Production `server.ts` must parse `process.env` and pass the validated policy
explicitly before listening.

- [ ] **Step 1: Write failing scheduler/bounds tests**

Pin:

- an overlapping scheduler returns `{ busy: true }` and makes zero provider
  calls;
- at most five jobs are claimed just in time;
- a slow first job does not pre-claim the remaining four;
- item/page/call/response/source-byte caps are global across all targets;
- source and tick deadlines abort the provider transport;
- closing the Fastify app aborts in-flight provider and discovery-LLM
  transports;
- no new job is claimed when less than one meaningful source budget remains;
- per-source concurrency never exceeds one;
- a target-local permission failure does not discard a healthy target result.
- operator events contain IDs/counters/stable codes plus safe
  continuation/replay booleans, but no token, provider cursor, provider body,
  or raw exception text.

Use a fake page reader that records the supplied signal and counters; do not
sleep in tests.

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
npm test -- discovery-bounds.test.ts discovery-jobs.test.ts
```

Expected: FAIL because the scheduler and page boundary do not exist.

- [ ] **Step 3: Add page/cursor validation primitives**

In `paging.ts`, add Zod-free internal parsers that treat `{}`, malformed JSON,
and legacy cursor JSON as an empty V1 cursor. Add:

```ts
export function readCursor(raw: string, mode: string): DiscoveryCursorV1;
export function reconcileTargets(
  cursor: DiscoveryCursorV1,
  targets: DiscoveryTarget[],
): DiscoveryCursorV1;
export function safeCursorProgress(cursor: DiscoveryCursorV1, checkpointAt: number | null): {
  version: 1;
  targetCount: number;
  backlog: boolean;
  lastCheckpointAt: number | null;
};
```

No public helper may return `providerToken`.

- [ ] **Step 4: Adapt existing fetchers to one bounded page**

Before provider pagination lands in Tasks 7–8, wrap every current adapter in a
single-page implementation:

```ts
export async function fetchSourcePage(input: {
  source: DiscoverySource;
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  signal: AbortSignal;
  maxItems: number;
}): Promise<DiscoveryPage>;
```

Keyless sources return `exhausted: true`, `nextToken: null`, and one call.
Connected sources use one resolved target instead of looping over all handles.
Pass `signal` and `maxResponseBytes` to every connector call and return actual
call/byte counts.

- [ ] **Step 5: Implement the scheduler lease and just-in-time loop**

The service must:

1. claim `discovery:scheduler`;
2. enqueue eligible sources for the requested workspace or every workspace;
3. check tick deadline and job count;
4. claim exactly one job;
5. create a per-source abort controller;
6. combine its signal with tick deadline and API shutdown using
   `AbortSignal.any`;
7. heartbeat scheduler and job leases while the page reader runs;
8. stop/abort on budget, shutdown, or lease loss;
9. complete/fail through the fenced job APIs;
10. release the scheduler lease in `finally`.

The API creates both owner values; routes and the worker never provide them:

```ts
const schedulerOwner =
  `${instanceId}:discovery-scheduler:${randomUUID()}`;
const jobOwner =
  `${instanceId}:discovery-job:${randomUUID()}`;
```

The public `/workspaces/:id/discovery/run` calls this service with
`workspaceId`; it must not call an alternate unleased path.

In `server.ts`, call `parseDiscoveryOperatorPolicy(process.env)` before
`buildApp`. A configuration error prints one safe actionable message and exits
before the API registers routes or starts listening.

- [ ] **Step 6: Make the legacy runner a source-execution helper**

Split `runDiscovery` so one exported helper executes only the already-claimed
source:

```ts
export async function runClaimedDiscoverySource(
  deps: DiscoverySourceDependencies,
  claim: DiscoveryJobClaim,
  budget: SourceBudget,
  signal: AbortSignal,
): Promise<SourceRunResult>;
```

It re-resolves workspace, source, connection, and tracked accounts after claim.
It checks `claim.sourceExecutionVersion === source.executionVersion` before
external work and before persistence.

Map expected failures to stable codes:

```text
lease_lost
source_timeout
tick_budget_exhausted
item_budget_exhausted
page_budget_exhausted
call_budget_exhausted
response_limit
```

Emit one `DiscoveryOperatorEvent` per completed/failed source using only safe
codes and counters. Persisted errors use the same safe codes/messages.

- [ ] **Step 7: Run TAP-45 verification**

Run:

```bash
npm test -- discovery-bounds.test.ts discovery-jobs.test.ts discovery.test.ts connected-discovery.test.ts safe-fetch-body.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 8: Commit and close TAP-45**

```bash
git add apps/api/src/discovery apps/api/src/services/discovery-scheduler.ts apps/api/src/services/discovery.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/src/routes/discovery.ts apps/api/test/discovery-bounds.test.ts apps/api/test/discovery.test.ts apps/api/test/connected-discovery.test.ts apps/api/test/discovery-jobs.test.ts
git commit -m "feat(api): run discovery inside hard leased budgets"
```

Add evidence and the SHA to TAP-45, then move TAP-45 to `Done`.

---

### Task 5: TAP-46 — Make occurrence and automatic-draft output idempotent

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0049_sprint_49_automation_idempotency.sql`
- Create: `apps/api/drizzle/meta/0049_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/test/sprint49-migrations.test.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Create: `apps/api/test/discovery-idempotency.test.ts`
- Modify: `apps/api/src/services/drafts.ts`
- Modify: `apps/api/src/services/signal-drafting.ts`
- Modify: `apps/api/src/services/automation.ts`
- Modify: `apps/api/src/routes/automation.ts`
- Modify: `apps/api/test/automation.test.ts`

**Interfaces:**

- Adds nullable internal `drafts.automationKey`.
- Produces:

```ts
export function automaticDraftKey(input: {
  workspaceId: string;
  signalId: string;
  campaignId: string;
  channel: Channel;
}): string;

export function submitAutomaticDraft(
  db: Db,
  input: SubmitDraftInput & { automationKey: string; autoApprove: boolean },
  actor: DraftActor,
): { draft: Draft; created: boolean; autoApproved: boolean };

export interface AutomationDependencies {
  db: Db;
  llm: LlmGateway;
  evidence: EvidenceStore;
  leaseMs: number;
  heartbeatMs: number;
}

export async function runAutomationWithLease(
  deps: AutomationDependencies,
  workspaceId: string,
  owner: string,
): Promise<AutomationRunResult & { busy: boolean }>;
```

- Produces atomic page persistence:

```ts
export interface DiscoveryCheckpointHooks {
  afterOccurrenceInsert?(index: number): void;
  afterCanonicalization?(): void;
  beforeCursorUpdate?(): void;
}

export function persistDiscoveryPage(
  db: Db,
  input: {
    claim: DiscoveryJobClaim;
    source: DiscoverySourceExecution;
    page: DiscoveryPage;
    cursor: DiscoveryCursorV1;
    hooks?: DiscoveryCheckpointHooks;
  },
): { inserted: number; fetched: number } | null;
```

- [ ] **Step 1: Read TAP-46 and move it to `In Progress`**

Record the TAP-44/45 closing SHAs in the Plane start comment.

- [ ] **Step 2: Write failing migration and automatic-output tests**

Seed two legacy drafts with the same signal/campaign/channel before `0049`.
After migration assert the oldest row has the deterministic key, the duplicate
remains visible with `NULL`, and a new duplicate key violates the unique index.

Add an automation race test:

```ts
const [a, b] = await Promise.all([
  runAutomationWithLease(deps, workspaceId, "owner-a"),
  runAutomationWithLease(deps, workspaceId, "owner-b"),
]);
expect(a.busy || b.busy).toBe(true);
const [draft] = listDrafts(db, workspaceId);
expect(draft).toBeDefined();
expect(listDrafts(db, workspaceId)).toEqual([draft]);
expect(listDecisions(db, draft!.id).map((d) => d.action)).toEqual([
  "submit",
  "approve",
]);
```

Force workspace lease expiry during the model call and verify the unique key
still permits one automatic draft and one approval transition.

- [ ] **Step 3: Write failing occurrence checkpoint tests**

Inject faults:

- after provider response, before transaction;
- after first attempted occurrence insert;
- after canonicalization;
- before cursor/source/job update;
- after committed checkpoint, before the next page.

For every case assert one `(sourceId, externalId)` row, no partial
occurrence/cursor commit, and a stale owner cannot mutate the page.

- [ ] **Step 4: Run the tests and confirm the red state**

Run:

```bash
npm test -- sprint49-migrations.test.ts discovery-idempotency.test.ts automation.test.ts
```

Expected: FAIL because the automation key, transaction, and page checkpoint do
not exist.

- [ ] **Step 5: Add and migrate `automation_key`**

Add:

```ts
automationKey: text("automation_key"),
```

and:

```ts
uniqueIndex("drafts_automation_key")
  .on(t.automationKey)
  .where(sql`${t.automationKey} IS NOT NULL`),
```

Generate:

```bash
npm run db:generate -w @tuezday/api -- --name sprint_49_automation_idempotency
```

In `0049`, backfill exactly one oldest legacy row for every non-null
signal/campaign/channel tuple with:

```ts
`automation:v1:${workspaceId}:${signalId}:${campaignId}:${channel}`
```

Leave any pre-existing duplicate row visible with a null key.

- [ ] **Step 6: Implement atomic occurrence and cursor persistence**

Inside one transaction:

1. recheck job owner/version/unexpired lease;
2. recheck source workspace and `executionVersion`;
3. insert each stable external ID with `onConflictDoNothing().returning()`;
4. canonicalize only rows that were actually inserted;
5. update cursor/source counters and job counters;
6. return `null` if any fence changed zero rows.

Reject empty external IDs with stable `adapter_missing_external_id`; never
manufacture array-index IDs.

- [ ] **Step 7: Implement automatic draft commit**

Refactor `submitDraft` into an internal transaction-compatible insert helper.
`submitAutomaticDraft` uses `onConflictDoNothing()` on the deterministic key,
logs `submit` only for the winning insert, and—when `autoApprove` is true—calls
`applyDraftActionInTransaction` before the same transaction commits.
When the insert returns no row, select the existing draft by `automationKey`
inside the transaction and return `{ draft, created: false,
autoApproved: false }`; never append another decision to that winner.

Keep `automationKey` internal. Change `rowToDraft` to remove it together with
`reviewJson` and `mediaJson` before spreading the public fields:

```ts
const { automationKey: _automationKey, reviewJson, mediaJson, ...rest } = row;
```

`generateSignalDraft` accepts:

```ts
automation?: {
  key: string;
  autoApprove: boolean;
};
```

Manual callers omit it and retain multiple-draft behavior. The automation
service prechecks legacy tuples to avoid unnecessary LLM work and acquires the
workspace lease using:

```ts
const leaseKey = `automation:${workspaceId}`;
```

The database idempotency key remains the final race boundary.

- [ ] **Step 8: Run TAP-46 verification**

Run:

```bash
npm test -- sprint49-migrations.test.ts discovery-idempotency.test.ts automation.test.ts drafts.test.ts signals.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 9: Commit and close TAP-46**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/discovery.ts apps/api/src/services/drafts.ts apps/api/src/services/signal-drafting.ts apps/api/src/services/automation.ts apps/api/src/routes/automation.ts apps/api/test/sprint49-migrations.test.ts apps/api/test/discovery-idempotency.test.ts apps/api/test/automation.test.ts
git commit -m "feat(api): make discovery and automatic drafting idempotent"
```

Add evidence and the SHA to TAP-46, then move TAP-46 to `Done`.

---

### Task 6: TAP-47 — Serialize matching and triage with item-version fences

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Create: `apps/api/drizzle/0050_sprint_49_matching_state.sql`
- Create: `apps/api/drizzle/meta/0050_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/test/sprint49-migrations.test.ts`
- Create: `apps/api/src/services/discovery-matching.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `apps/api/src/routes/discovery.ts`
- Create: `apps/api/test/discovery-matching-state.test.ts`
- Modify: `apps/api/test/discovery.test.ts`

**Interfaces:**

- Adds contract vocabulary:

```ts
export const DISCOVERY_MATCHING_STATES = [
  "pending",
  "running",
  "ready",
  "retryable_error",
  "frozen",
] as const;
export type DiscoveryMatchingState =
  (typeof DISCOVERY_MATCHING_STATES)[number];
```

- Adds only `matchingState` and stable `matchingError` to
  `discoveredItemSchema`. Matching version, fingerprint, lease owner, expiry,
  and heartbeat stay internal.
- Produces:

```ts
export interface MatchingClaim {
  itemId: string;
  workspaceId: string;
  owner: string;
  version: number;
  inputFingerprint: string;
  leaseExpiresAt: number;
}

export function claimMatchingBatch(
  db: Db,
  input: {
    workspaceId?: string;
    owner: string;
    limit: number;
    leaseMs: number;
  },
): MatchingClaim[];

export interface MatchingDependencies {
  db: Db;
  llm: LlmGateway;
  leaseMs: number;
  heartbeatMs: number;
}

export async function runMatchingBatch(
  deps: MatchingDependencies,
  claims: MatchingClaim[],
  signal: AbortSignal,
): Promise<{ ready: number; retryableErrors: number }>;
```

- Produces `MatchingNotReadyError` for the route's stable
  `409 matching_not_ready`.

- [ ] **Step 1: Read TAP-47 and move it to `In Progress`**

Record TAP-46's closing SHA as the dependency.

- [ ] **Step 2: Write failing contract and migration tests**

Assert the item schema accepts:

```ts
matchingState: "retryable_error",
matchingError: "matching_timeout",
```

Migration fixtures must prove:

- `new` + `scored_at` becomes `ready`;
- `new` + null `scored_at` becomes `pending`;
- accepted/skipped/duplicate becomes `frozen`;
- no signal, match, or founder-visible item is deleted.

- [ ] **Step 3: Write failing race and failure tests**

Cover:

- pending/running/retryable acceptance returns `409 matching_not_ready` and
  persists no signal;
- ready with zero matches can be accepted;
- accept, skip, and duplicate-link transitions atomically set
  `matchingState="frozen"` and clear matching lease fields;
- a delayed scorer cannot update an accepted item;
- expired matching work reclaims with a higher version;
- an old owner/version cannot heartbeat or commit;
- malformed LLM output and gateway failure become `retryable_error`, not ready
  zero-match;
- match rows, projections, score, reason, timestamp, fingerprint, and ready
  state commit or roll back together;
- a deleted/moved persona or campaign is removed at commit;
- a matching deadline aborts the gateway signal.

- [ ] **Step 4: Run the tests and confirm the red state**

Run:

```bash
npm test -- contracts.test.ts sprint49-migrations.test.ts discovery-matching-state.test.ts
```

Expected: FAIL because matching state and claims do not exist.

- [ ] **Step 5: Add matching persistence and generate migration**

Add:

```ts
matchingState: text("matching_state").notNull().default("pending"),
matchingVersion: integer("matching_version").notNull().default(0),
matchingInputFingerprint: text("matching_input_fingerprint"),
matchingLeaseOwner: text("matching_lease_owner"),
matchingLeaseExpiresAt: integer("matching_lease_expires_at"),
matchingHeartbeatAt: integer("matching_heartbeat_at"),
matchingError: text("matching_error"),
```

Generate:

```bash
npm run db:generate -w @tuezday/api -- --name sprint_49_matching_state
```

Edit `0050` to perform the exact state backfill before adding any state index.
In `rowToItem`, destructure the internal fields before creating the public
contract value:

```ts
const {
  matchingVersion: _matchingVersion,
  matchingInputFingerprint: _matchingInputFingerprint,
  matchingLeaseOwner: _matchingLeaseOwner,
  matchingLeaseExpiresAt: _matchingLeaseExpiresAt,
  matchingHeartbeatAt: _matchingHeartbeatAt,
  ...publicRow
} = row;
```

Return `publicRow` with `matchingState`, `matchingError`, matches, and duplicate
count. Add a contract/route assertion that none of the five internal fields
are serialized.

- [ ] **Step 6: Implement matching fingerprints and claims**

The input fingerprint is SHA-256 over stable JSON containing:

```ts
{
  item: { title, summary, url, contentHash },
  personas: orderedPersonas.map(
    ({ id, name, description, topics }) => ({
      id,
      name,
      description,
      topics,
    }),
  ),
  campaigns: orderedActiveCampaigns.map(
    ({ id, name, objective, personaIds }) => ({
      id,
      name,
      objective,
      personaIds,
    }),
  ),
}
```

Sort personas and active campaigns by ID, and sort each campaign's copied
`personaIds`, before both prompt construction and hashing. Keep persona
`topics` in their displayed order. Serialize with `JSON.stringify` and hash the
UTF-8 bytes with SHA-256.

Claim pending/retryable items or expired running items, oldest-first, in one
transaction. Increment `matchingVersion`, set the owner/expiry/heartbeat and
fingerprint, and never claim a non-`new`/duplicate item.

- [ ] **Step 7: Replace watermark scoring with fenced matching commits**

Move scoring out of `discovery.ts`. For each claimed batch:

1. heartbeat each claim while the LLM call runs;
2. parse one result per item;
3. re-read item/status/config and recompute the fingerprint;
4. revalidate tenant references;
5. replace match rows and projections in one transaction;
6. update only current owner/version/fingerprint to `ready`;
7. change malformed/missing result to `retryable_error` with a stable code;
8. leave zero valid matches as a legitimate `ready` result.

When canonicalization links a newly inserted occurrence as a duplicate, set
that duplicate item's matching state to `frozen` immediately.

The scheduler claims at most `maxMatchingItemsPerTick` while tick budget remains.

- [ ] **Step 8: Enforce the acceptance fence**

Inside `acceptDiscoveredItem`'s existing transaction, require:

```ts
item.status === "new" && item.matchingState === "ready"
```

The route maps `MatchingNotReadyError` to:

```json
{
  "error": "matching_not_ready",
  "message": "Scoring has not completed for this item yet."
}
```

Do not emit `discovery.item.accepted` when the transaction is rejected.
In the accepted transaction, and in the existing skip and duplicate-link
transactions, set `matchingState="frozen"` and clear owner/expiry/heartbeat.

- [ ] **Step 9: Run TAP-47 verification**

Run:

```bash
npm test -- contracts.test.ts sprint49-migrations.test.ts discovery-matching-state.test.ts discovery.test.ts signals.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 10: Commit and close TAP-47**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle packages/contracts/src/index.ts packages/contracts/test/contracts.test.ts apps/api/src/services/discovery-matching.ts apps/api/src/services/discovery.ts apps/api/src/services/discovery-scheduler.ts apps/api/src/routes/discovery.ts apps/api/test/sprint49-migrations.test.ts apps/api/test/discovery-matching-state.test.ts apps/api/test/discovery.test.ts
git commit -m "feat(api): serialize discovery matching and triage"
```

Add evidence and the SHA to TAP-47, then move TAP-47 to `Done`.

---

### Task 7: TAP-48 — Implement atomic per-target cursor checkpoints

**Files:**

- Modify: `apps/api/src/discovery/paging.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/src/services/tracked-social-accounts.ts`
- Modify: `apps/api/src/services/discovery-scheduler.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/test/discovery-cursors.test.ts`
- Modify: `apps/api/test/discovery-idempotency.test.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`
- Modify: `packages/contracts/test/contracts.test.ts`

**Interfaces:**

- `ResolvedTrackedAccount` gains `id` and `updatedAt`, allowing stable keys and
  fingerprints.
- Replaces the generic public cursor record with:

```ts
export const discoveryCursorProgressSchema = z.object({
  version: z.literal(1),
  targetCount: z.number().int().nonnegative(),
  backlog: z.boolean(),
  lastCheckpointAt: z.number().int().nullable(),
});
export type DiscoveryCursorProgress =
  z.infer<typeof discoveryCursorProgressSchema>;
```

- Produces:

```ts
export function resolveDiscoveryTargets(input: {
  source: DiscoverySource;
  trackedAccounts: ResolvedTrackedAccount[];
}): DiscoveryTarget[];

export function checkpointPage(input: {
  cursor: DiscoveryCursorV1;
  target: DiscoveryTarget;
  page: DiscoveryPage;
  nextTargetIndex: number;
}): DiscoveryCursorV1;
```

- `persistDiscoveryPage` writes cursor JSON only after source execution-version
  and current target fingerprint revalidation.

- [ ] **Step 1: Read TAP-48 and move it to `In Progress`**

Record TAP-47's closing SHA as the dependency.

- [ ] **Step 2: Write failing cursor-model tests**

Pin:

- malformed/legacy cursor becomes empty V1 state;
- tracked-account UUIDs are stable keys;
- inline target keys hash normalized provider/mode/target;
- every target owns an independent watermark and continuation;
- round-robin index survives restart;
- adding/changing/removing one target preserves unrelated checkpoints;
- tracked-account update changes only its target fingerprint;
- public cursor progress contains no provider token.

- [ ] **Step 3: Write failing atomic checkpoint tests**

Cover:

- page rows and cursor advance together;
- crash before transaction replays the page;
- crash inside transaction persists neither rows nor cursor;
- crash after commit resumes at the next page;
- source config change during fetch rejects the old execution version;
- tracked-account change during fetch rejects that target fingerprint;
- invalid continuation clears only that target and replays from newest;
- high-watermark is promoted only after old boundary/provider end;
- one target's permission failure records `lastSafeError` and advances
  round-robin without rolling back healthy targets.

- [ ] **Step 4: Run the tests and confirm the red state**

Run:

```bash
npm test -- discovery-cursors.test.ts discovery-idempotency.test.ts
```

Expected: FAIL on target reconciliation and checkpoint rules.

- [ ] **Step 5: Implement target identity and reconciliation**

Target identity rules:

```ts
const trackedKey = `tracked:${account.id}`;
const inlineHandleKey = sha256(`${provider}|${mode}|${normalizedHandle}`);
const queryKey = sha256(`${provider}|${mode}|${normalizedValue}`);
const keylessKey = sha256(`${source.type}|${normalizedConfig}`);
```

Fingerprint tracked targets from id, handle, external ID, enabled state, and
`updatedAt`. Fingerprint inline targets from normalized execution-relevant
config. Drop removed targets, initialize changed/new targets, and clamp
`nextTargetIndex` after reconciliation.

- [ ] **Step 6: Implement checkpoint transitions**

For the current target:

- preserve the prior high-watermark as `boundaryExternalId` while draining;
- capture the newest item from the first page;
- retain continuation when page/call/item/time budget stops;
- promote newest to high-watermark only when boundary/end is reached;
- clear only the invalid target continuation on provider cursor rejection;
- update `nextTargetIndex` modulo target count.

Write the serialized cursor in the existing occurrence transaction.

- [ ] **Step 7: Make public cursor output safe**

`rowToSource` must call `safeCursorProgress` and return only:

```ts
{
  version: 1,
  targetCount,
  backlog,
  lastCheckpointAt,
}
```

Set `discoverySourceSchema.shape.cursor` to
`discoveryCursorProgressSchema`. Update contract fixtures. Never return
internal target keys, fingerprints, external IDs, or provider tokens.

- [ ] **Step 8: Run cursor-core verification**

Run:

```bash
npm test -- discovery-cursors.test.ts discovery-idempotency.test.ts connected-discovery.test.ts contracts.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass. Keep TAP-48 `In Progress`
until provider page readers land in Task 8.

- [ ] **Step 9: Commit cursor persistence core**

```bash
git add apps/api/src/discovery/paging.ts apps/api/src/services/discovery.ts apps/api/src/services/tracked-social-accounts.ts apps/api/src/services/discovery-scheduler.ts packages/contracts/src/index.ts apps/api/test/discovery-cursors.test.ts apps/api/test/discovery-idempotency.test.ts apps/api/test/connected-discovery.test.ts packages/contracts/test/contracts.test.ts
git commit -m "feat(api): persist per-target discovery checkpoints"
```

---

### Task 8: TAP-48 — Add provider pagination and overlap replay

**Files:**

- Modify: `apps/api/src/discovery/adapters.ts`
- Modify: `apps/api/src/discovery/connected-adapters.ts`
- Modify: `apps/api/src/discovery/intent.ts`
- Modify: `apps/api/test/connected-discovery.test.ts`
- Modify: `apps/api/test/discovery-cursors.test.ts`
- Modify: `apps/api/test/discovery-bounds.test.ts`

**Interfaces:**

- Finalizes:

```ts
export async function fetchConnectedSourcePage(input: {
  source: DiscoverySource;
  connection: Connection;
  fabric: ConnectorFabric;
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  signal: AbortSignal;
  maxItems: number;
  maxResponseBytes: number;
}): Promise<DiscoveryPage>;
```

- Keyless `fetchSourcePage` uses the same return contract and reports one
  exhausted page.

- [ ] **Step 1: Add failing provider fixture tests**

For each provider, use two or more fixture pages and assert:

- X search/account/list sends and consumes `pagination_token`/`next_token`;
- Reddit sends and consumes `after`;
- LinkedIn advances supported `start`/`count` paging and stops at the durable
  high-watermark;
- Instagram account and hashtag media consume Graph `paging.cursors.after`;
- a burst larger than four pages resumes on the next job;
- the old high-watermark stops replay without dropping newer rows;
- provider `invalid_cursor` restarts newest-first and converges through
  occurrence uniqueness;
- page/call/item/byte budgets remain source-global across 25 targets.

- [ ] **Step 2: Run the tests and confirm the red state**

Run:

```bash
npm test -- connected-discovery.test.ts discovery-cursors.test.ts discovery-bounds.test.ts
```

Expected: FAIL because connected adapters still return one unpaged array.

- [ ] **Step 3: Implement one-target provider readers**

Remove loops over every handle from adapters; the scheduler chooses one
`DiscoveryTarget` at a time.

Map provider metadata exactly:

```text
X meta.next_token -> nextToken
Reddit data.after -> nextToken
LinkedIn paging.start + paging.count -> decimal nextToken
Instagram paging.cursors.after -> nextToken
```

Append provider tokens only to fixed provider paths created by the adapter.
Workspace requests never supply cursor state.

- [ ] **Step 4: Implement boundary and invalid-cursor behavior**

Each page marks `reachedBoundary` when an item external ID equals the target's
durable boundary. Exclude older remaining rows after the boundary.

Translate provider cursor rejection to stable `CursorInvalidError`. The runner
clears that target's continuation, records `cursor_replay`, and retries from
the newest page only while remaining call/time budgets allow.

- [ ] **Step 5: Prove target-local failure isolation**

Account lookup/private/deleted/permission errors become a target result with
`lastSafeError`; they do not throw away prior healthy page transactions or stop
later targets. Source-level connection revocation/rate limiting retains the
existing source-wide behavior.

- [ ] **Step 6: Run TAP-48 verification**

Run:

```bash
npm test -- connected-discovery.test.ts discovery-cursors.test.ts discovery-bounds.test.ts discovery-idempotency.test.ts discovery.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 7: Commit and close TAP-48**

```bash
git add apps/api/src/discovery/adapters.ts apps/api/src/discovery/connected-adapters.ts apps/api/src/discovery/intent.ts apps/api/test/connected-discovery.test.ts apps/api/test/discovery-cursors.test.ts apps/api/test/discovery-bounds.test.ts
git commit -m "feat(api): resume connected discovery through provider cursors"
```

Add both cursor commits, commands/counts, and the final SHA to TAP-48, then move
TAP-48 to `Done`.

---

### Task 9: TAP-49 — Add scoped internal task auth and reliable worker startup

**Files:**

- Modify: `apps/api/src/auth/guard.ts`
- Modify: `apps/api/test/auth.test.ts`
- Create: `apps/api/src/routes/internal-tasks.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/internal-tasks.test.ts`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/scheduler.ts`
- Create: `apps/worker/src/client.ts`
- Modify: `apps/worker/src/index.ts`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/test/config.test.ts`
- Create: `apps/worker/test/scheduler.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**

- Produces:

```ts
export interface WorkerConfig {
  internalApiUrl: string;
  token: string;
  intervals: {
    discoveryMs: number;
    automationMs: number;
    learningMs: number;
    adsMs: number;
    publishMs: number;
    cadenceMs: number;
    inboxMs: number;
    sequenceMs: number;
    evidenceMs: number;
  };
}

export function loadRootEnv(): void;
export function parseWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig;

export function startSettledLoop(input: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onError: (error: unknown) => void;
}): { stop(): void };
```

- Registers worker-only:

```text
POST /internal/discovery/tick
POST /internal/automation/tick
```

- [ ] **Step 1: Read TAP-49 and move it to `In Progress`**

Record TAP-48's closing SHA as the dependency.

- [ ] **Step 2: Write failing auth/internal-route tests**

Pin:

- a user session cannot call `/internal/*`;
- an absent/wrong worker token gets `401`;
- correct worker token calls both internal endpoints;
- both internal endpoints reject workspace or owner fields and accept only an
  empty body;
- worker token cannot read brain, users, billing, drafts, evidence, or
  connectors;
- worker token can call only this exact existing allowlist:

```text
GET  /workspaces
GET  /workspaces/:id/learning/syntheses
POST /workspaces/:id/learning/synthesize
POST /workspaces/:id/ads/sync
POST /workspaces/:id/publish/run
POST /workspaces/:id/cadences/run
POST /workspaces/:id/inbox/run
POST /workspaces/:id/sequences/run
POST /workspaces/:id/evidence/candidates/sweep
```

- token comparison works for unequal lengths without throwing and uses a
  fixed-length SHA-256 digest plus `timingSafeEqual`.

- [ ] **Step 3: Write failing worker config/scheduler tests**

Create the worker test directory:

```bash
mkdir -p apps/worker/test
```

Expected: the directory exists and the two new test files can be added with
`apply_patch`.

Test root env non-override behavior; internal URL absolute/HTTPS policy;
loopback HTTP development exception; required token; every interval's default
and range; rejection of `NaN`, decimals, zero, negative, and out-of-range
values.

With fake timers:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const first = deferred<void>();
const run = vi.fn(() => first.promise);
const loop = startSettledLoop({
  name: "discovery",
  intervalMs,
  run,
  onError: vi.fn(),
});
expect(run).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(intervalMs * 3);
expect(run).toHaveBeenCalledTimes(1);
first.resolve(undefined);
await vi.advanceTimersByTimeAsync(intervalMs);
expect(run).toHaveBeenCalledTimes(2);
loop.stop();
```

Also assert a rejected run calls `onError` and schedules the next wake, while
`stop()` during an unresolved run prevents any later wake after it settles.

- [ ] **Step 4: Run the tests and confirm the red state**

Run:

```bash
npm test -- auth.test.ts internal-tasks.test.ts config.test.ts scheduler.test.ts
```

Expected: FAIL because scoped internal auth and the worker modules do not
exist.

- [ ] **Step 5: Restrict the worker credential**

In the guard:

1. parse the bearer token;
2. compare a SHA-256 digest of supplied/expected tokens using
   `timingSafeEqual`;
3. require the worker token for `/internal/*` and reject user sessions;
4. for non-internal routes, permit a worker only when
   `METHOD + routeOptions.url` exactly matches the allowlist;
5. retain existing user membership behavior;
6. never put the credential in actor/log/error state.

Remove worker use of public discovery and automation workspace routes.

- [ ] **Step 6: Register the API-owned internal schedulers**

`POST /internal/discovery/tick` calls `runDiscoveryScheduler` without a
workspace scope.

`POST /internal/automation/tick` claims `automation:scheduler`, iterates
`listWorkspaces(db)`, and invokes `runAutomationWithLease` per workspace.
Heartbeat/release the scheduler lease in `finally`. Return busy as successful
no-op:

```json
{
  "busy": true,
  "processed": 0
}
```

Generate the automation owners inside the API:

```ts
const schedulerOwner =
  `${instanceId}:automation-scheduler:${randomUUID()}`;
const workspaceOwner =
  `${instanceId}:automation-workspace:${workspace.id}:${randomUUID()}`;
```

- [ ] **Step 7: Implement worker config and self-scheduling loops**

`loadRootEnv` resolves `../../../.env` from `apps/worker/src/config.ts`, ignores
blank/comment lines, strips matching quotes, and never overwrites an existing
environment variable.

`parseWorkerConfig` uses:

```text
TUEZDAY_INTERNAL_API_URL
TUEZDAY_WORKER_TOKEN
DISCOVERY_INTERVAL_MIN
AUTOMATION_INTERVAL_MIN
LEARNING_SYNTHESIS_DAYS
ADS_SYNC_HOURS
PUBLISH_INTERVAL_MIN
CADENCE_FILL_INTERVAL_MIN
INBOX_INTERVAL_MIN
SEQUENCE_INTERVAL_MIN
EVIDENCE_SWEEP_MIN
```

`TUEZDAY_WORKER_TOKEN` is required outside tests.
`TUEZDAY_API_URL` remains the browser/MCP public base and is never read as the
worker's internal origin.

Use these exact interval defaults and inclusive hard ranges:

| Field | Environment | Default | Minimum | Maximum |
|---|---|---:|---:|---:|
| `discoveryMs` | `DISCOVERY_INTERVAL_MIN` | 1800000 | 60000 | 86400000 |
| `automationMs` | `AUTOMATION_INTERVAL_MIN` | 300000 | 60000 | 86400000 |
| `learningMs` | `LEARNING_SYNTHESIS_DAYS` | 604800000 | 86400000 | 31536000000 |
| `adsMs` | `ADS_SYNC_HOURS` | 21600000 | 3600000 | 604800000 |
| `publishMs` | `PUBLISH_INTERVAL_MIN` | 60000 | 60000 | 86400000 |
| `cadenceMs` | `CADENCE_FILL_INTERVAL_MIN` | 300000 | 60000 | 86400000 |
| `inboxMs` | `INBOX_INTERVAL_MIN` | 300000 | 60000 | 86400000 |
| `sequenceMs` | `SEQUENCE_INTERVAL_MIN` | 300000 | 60000 | 86400000 |
| `evidenceMs` | `EVIDENCE_SWEEP_MIN` | 1800000 | 60000 | 86400000 |

Discovery and automation call the internal endpoints. Use
`startSettledLoop`—never `setInterval`—so a next wake-up is installed only
after the prior promise settles. Each loop runs once immediately at startup,
then waits its interval after settlement. Convert the remaining loops to the
same helper while preserving their existing routes and independent failure
logging. Store every returned handle and call `stop()` on `SIGINT`/`SIGTERM`
before process exit.

- [ ] **Step 8: Wire root development**

Set:

```json
{
  "scripts": {
    "dev": "concurrently -n api,web,worker -c blue,magenta,green \"npm run dev -w apps/api\" \"npm run dev -w apps/web\" \"npm run dev -w apps/worker\"",
    "dev:app": "concurrently -n api,web -c blue,magenta \"npm run dev -w apps/api\" \"npm run dev -w apps/web\""
  }
}
```

Add worker `dev` and `test` scripts, register `apps/worker` in the root Vitest
projects, document API+worker as required processes, and add all new variables
with safe defaults/comments to `.env.example`.

- [ ] **Step 9: Run TAP-49 verification**

Run:

```bash
npm test -- auth.test.ts internal-tasks.test.ts config.test.ts scheduler.test.ts
npm run typecheck
```

Then run the startup smoke test with a temporary non-secret token:

```bash
TUEZDAY_WORKER_TOKEN=sprint49-local-smoke TUEZDAY_INTERNAL_API_URL=http://localhost:3001 npm run dev
```

Expected: named `api`, `web`, and `worker` streams start; worker reports
validated intervals and uses the internal API origin. Stop the smoke process
after the first successful internal tick.

- [ ] **Step 10: Commit and close TAP-49**

```bash
git add apps/api/src/auth/guard.ts apps/api/src/routes/internal-tasks.ts apps/api/src/app.ts apps/api/test/auth.test.ts apps/api/test/internal-tasks.test.ts apps/worker package.json vitest.config.ts .env.example README.md
git commit -m "feat(worker): add scoped reliable task startup"
```

Add evidence and the SHA to TAP-49, then move TAP-49 to `Done`.

---

### Task 10: TAP-50 — Replace global matching watermark with targeted invalidation

**Files:**

- Create: `apps/api/src/services/matching-invalidation.ts`
- Modify: `apps/api/src/services/matching.ts`
- Modify: `apps/api/src/services/discovery-matching.ts`
- Modify: `apps/api/src/services/personas.ts`
- Modify: `apps/api/src/services/campaigns.ts`
- Modify: `apps/api/src/services/guidance.ts`
- Create: `apps/api/test/matching-invalidation.test.ts`
- Modify: `apps/api/test/personas.test.ts`
- Modify: `apps/api/test/campaigns.test.ts`
- Modify: `apps/api/test/discovery-matching-state.test.ts`

**Interfaces:**

- Removes `getMatchingConfigVersion`.
- Produces:

```ts
export interface MatchingInvalidation {
  directItemIds: string[];
  includeReadyNoMatch: boolean;
}

export function invalidateMatching(
  db: DbExecutor,
  workspaceId: string,
  input: MatchingInvalidation,
): number;

export function itemIdsForPersona(
  db: DbExecutor,
  workspaceId: string,
  personaId: string,
): string[];

export function itemIdsForCampaignChange(
  db: DbExecutor,
  workspaceId: string,
  campaignId: string,
  personaIds: string[],
): string[];
```

- [ ] **Step 1: Read TAP-50 and move it to `In Progress`**

Record TAP-49's closing SHA as the dependency.

- [ ] **Step 2: Write failing targeted-invalidation tests**

Create ready new items in four groups: matching edited persona, matching edited
campaign, unrelated matched, and zero-match.

Assert:

- persona semantic edit invalidates its matched items plus ready no-match
  items;
- persona delete invalidates only its matched items;
- active-campaign semantic edit or inactive-to-active transition invalidates
  campaign matches, items matched to previous/current assigned personas, and
  ready no-match items;
- active-to-inactive transition or delete invalidates only campaign matches
  plus items matched to previous/current assigned personas;
- inactive-to-inactive campaign edits do not invalidate matching;
- a new persona or new active campaign invalidates ready no-match items;
- unrelated matched items remain ready and are absent from the next prompt;
- terminal/duplicate items remain frozen;
- automation-mode/cap-only changes do not invalidate matching;
- configuration write and invalidation commit or roll back together;
- deletion captures IDs before cascade removes match rows.

- [ ] **Step 3: Run the tests and confirm the red state**

Run:

```bash
npm test -- matching-invalidation.test.ts personas.test.ts campaigns.test.ts
```

Expected: FAIL because services still use the global updated-at watermark.

- [ ] **Step 4: Implement one invalidation update**

`invalidateMatching` updates only `status='new'` canonical items in the union of
direct IDs and, when requested, ready items with no match rows:

```ts
{
  matchingState: "pending",
  matchingVersion: sql`${discoveredItems.matchingVersion} + 1`,
  matchingInputFingerprint: null,
  matchingLeaseOwner: null,
  matchingLeaseExpiresAt: null,
  matchingHeartbeatAt: null,
  matchingError: null,
}
```

Retain old match rows as stale display context until replacement succeeds;
acceptance remains blocked because state is pending.

- [ ] **Step 5: Make persona writes atomic with invalidation**

Wrap create/update/delete in transactions:

- create: invalidate ready no-match items;
- update: when `name`, `description`, or `topics` changes, gather direct persona
  matches, update, and invalidate direct + ready no-match;
- delete: gather direct matches, invalidate only those IDs, clean scoped
  guidance, then delete.

Change helper parameter types from `Db` to `DbExecutor` where the same operation
must run inside the transaction.

- [ ] **Step 6: Make campaign writes atomic with invalidation**

For create/update, compare matching-relevant fields:

```text
name, objective, personaIds, status
```

Creating an active campaign invalidates ready no-match items; creating an
inactive campaign does not. While either the prior or next state is active,
compare the fields above and gather the campaign plus previous/current persona
blast radius. An active semantic edit or inactive-to-active transition writes
the campaign and invalidates direct + ready no-match in one transaction. An
active-to-inactive transition or delete invalidates only the direct blast
radius because removing a target cannot make a ready no-match item gain a
match. Inactive-to-inactive edits do not invalidate. `setCampaignAutomation`
does not invalidate because automation mode/caps do not change matching
prompts.

- [ ] **Step 7: Remove watermark selection**

Delete `getMatchingConfigVersion` and any `scoredAt < max(updatedAt)` query.
Matching selection is exclusively state-driven:

```text
pending
retryable_error
expired running
```

- [ ] **Step 8: Run TAP-50 verification**

Run:

```bash
npm test -- matching-invalidation.test.ts personas.test.ts campaigns.test.ts discovery-matching-state.test.ts discovery.test.ts
npm run typecheck
```

Expected: all selected suites and typecheck pass.

- [ ] **Step 9: Commit and close TAP-50**

```bash
git add apps/api/src/services/matching-invalidation.ts apps/api/src/services/matching.ts apps/api/src/services/discovery-matching.ts apps/api/src/services/personas.ts apps/api/src/services/campaigns.ts apps/api/src/services/guidance.ts apps/api/test/matching-invalidation.test.ts apps/api/test/personas.test.ts apps/api/test/campaigns.test.ts apps/api/test/discovery-matching-state.test.ts
git commit -m "feat(api): invalidate discovery matching incrementally"
```

Add evidence and the SHA to TAP-50, then move TAP-50 to `Done`.

---

### Task 11: Finish matching readiness UI and operator-facing contracts

**Files:**

- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
- Create: `apps/web/lib/discovery-matching-state.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `docs/founder-acceptance-tests.md`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**

- The web consumes `DiscoveredItem.matchingState` and `matchingError`.
- The run summary consumes additive `busy` and `budgetExhausted`.

- [ ] **Step 1: Write failing UI contract tests**

Assert the page:

- renders “Scoring” for pending/running;
- renders “Scoring delayed — retry discovery” for retryable error;
- renders no scoring label for ready/frozen items;
- disables Accept unless `matchingState === "ready"`;
- handles `409 matching_not_ready` with the stable message;
- distinguishes a busy tick from a completed empty tick;
- never renders raw cursor/lease fields.

- [ ] **Step 2: Run the tests and confirm the red state**

Run:

```bash
npm test -- discovery-matching-state.test.ts contracts.test.ts
```

Expected: FAIL on missing readiness behavior.

- [ ] **Step 3: Implement the UI state**

Use:

```ts
const matchingReady = item.matchingState === "ready";
const matchingLabel =
  item.matchingState === "retryable_error"
    ? "Scoring delayed — retry discovery"
    : item.matchingState === "pending" || item.matchingState === "running"
      ? "Scoring"
      : null;
```

Disable only Accept; Skip remains available. Parse non-OK triage responses and
surface `body.message`. Update run copy for `busy` and `budgetExhausted`.

- [ ] **Step 4: Update operator and acceptance documentation**

Document:

- all policy variables/defaults/ranges;
- `TUEZDAY_INTERNAL_API_URL`;
- `TUEZDAY_WORKER_TOKEN`;
- the distinction from public `TUEZDAY_API_URL`;
- API and worker as separate required production processes;
- root `npm run dev` and `npm run dev:app`;
- scoped worker token behavior;
- automated Sprint 49 kill/restart, overlap, cursor, matching, and automation
  race tests.

Do not place a real credential or provider cursor in documentation.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npm test -- discovery-matching-state.test.ts contracts.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 6: Commit the product/readiness surface**

```bash
git add apps/web/app/workspaces/[id]/discovery/page.tsx apps/web/lib/discovery-matching-state.test.ts packages/contracts/src/index.ts packages/contracts/test/contracts.test.ts docs/founder-acceptance-tests.md .env.example README.md
git commit -m "feat(web): surface discovery matching readiness"
```

Add this commit as supporting evidence on TAP-47 and TAP-49 without reopening
either card unless a regression fails.

---

### Task 12: Run automated founder acceptance and close TAP-8

**Files:**

- Create: `apps/api/test/sprint49-acceptance.test.ts`
- Modify: `docs/founder-acceptance-tests.md`
- Modify:
  `docs/specs/sprint-49-bounded-leased-job-execution.md`

**Interfaces:**

- No new production interface. This task proves the approved acceptance
  contract through public/internal routes and real persistence.

- [ ] **Step 1: Write the end-to-end fault-injection test**

The test must:

1. create a paginated multi-target source with more than four pages;
2. run through the internal discovery endpoint;
3. fault after one committed page;
4. expire/reclaim the job lease;
5. restart through a separately built app instance on the same temporary DB;
6. assert every occurrence exists once and each target reaches its correct
   high-watermark;
7. race two discovery ticks and assert one provider-call/work budget;
8. attempt acceptance during matching and assert no signal;
9. finish matching and assert the accepted signal copies the exact match rows;
10. race worker/manual automation and assert one automatic draft and one
    approval.

Use fixture providers and a temporary SQLite file; do not require live OAuth or
network access.

- [ ] **Step 2: Run the new acceptance test**

Run:

```bash
npm test -- sprint49-acceptance.test.ts
```

Expected: PASS with every fault boundary asserted.

- [ ] **Step 3: Run all focused Sprint 49 suites together**

Run:

```bash
npm test -- sprint49-migrations.test.ts task-leases.test.ts operator-policy.test.ts discovery-bounds.test.ts discovery-idempotency.test.ts discovery-matching-state.test.ts discovery-cursors.test.ts internal-tasks.test.ts matching-invalidation.test.ts sprint49-acceptance.test.ts automation.test.ts discovery.test.ts connected-discovery.test.ts discovery-jobs.test.ts
```

Expected: all selected files and tests pass with zero failures.

- [ ] **Step 4: Run full repository verification**

Run:

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Expected:

- every workspace typechecks;
- the complete repository test suite has zero failures;
- no whitespace errors;
- only intended Sprint 49 changes remain.

- [ ] **Step 5: Commit acceptance evidence**

Update the spec progress log and founder-acceptance document with exact fresh
counts and SHAs, then:

```bash
git add apps/api/test/sprint49-acceptance.test.ts docs/founder-acceptance-tests.md docs/specs/sprint-49-bounded-leased-job-execution.md
git commit -m "test(api): prove Sprint 49 restart safety"
```

- [ ] **Step 6: Perform final code review**

Use `superpowers:requesting-code-review`. Resolve every correctness, security,
data-loss, lease-fencing, idempotency, or acceptance finding, then rerun the
focused and full verification commands after the last change.

- [ ] **Step 7: Close the Sprint 49 epic in Plane**

Confirm TAP-44 through TAP-50 are `Done`. Add a TAP-8 completion comment with:

- behavior delivered;
- migration names;
- focused and full commands/counts;
- acceptance test name;
- final commit SHA;
- known non-goals deferred to Sprint 50/73.

Move TAP-8 to `Done` only after that evidence is present.

- [ ] **Step 8: Prepare branch handoff**

Use `superpowers:finishing-a-development-branch` to present merge/push/PR
options. Do not merge to `main` without the founder's explicit choice.

---

## Plan Self-Review Checklist

- [x] TAP-44: schema, database-clock lease CAS, heartbeat, expiry reclaim,
  fencing, just-in-time claims, source-version cancellation.
- [x] TAP-45: exact policy variables/ranges, transport aborts, source-global
  page/item/call/byte/time budgets, concurrency one.
- [x] TAP-46: conflict-safe occurrence transaction and automatic-draft unique
  boundary with atomic approval.
- [x] TAP-47: explicit matching states, fingerprint/version lease, retryable
  failures, acceptance fence, UI readiness.
- [x] TAP-48: per-target cursor, atomic checkpoint, provider pagination,
  invalid-cursor overlap replay, target-local failure isolation.
- [x] TAP-49: root environment, validated intervals, internal endpoints,
  constant-time scoped worker auth, self-scheduling loops, root dev path.
- [x] TAP-50: direct dependency invalidation, conservative ready no-match set,
  unrelated matched items untouched, write+invalidation transaction.
- [x] P1.11: both discovery and automation overlap covered; database uniqueness
  remains authoritative after lease expiry.
- [x] Migration compatibility: running jobs reset, duplicate active jobs
  repaired, legacy draft duplicates preserved, matching state backfilled.
- [x] Full acceptance: crash/restart, overlap, cursor resume, triage fence,
  automatic draft race, startup/auth.
