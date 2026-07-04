# Sprint 46 Part 1 - Foundation & Discovery Job Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the schema/contracts/service foundation for connected discovery sources and bounded discovery jobs while keeping every existing keyless source working.

**Architecture:** This part does not implement provider API fetching. It adds `connectionId`/cursor/backoff fields to discovery sources, adds a local `discovery_jobs` ledger, and rewires `/discovery/run` to enqueue and process bounded jobs through the existing keyless adapters. Sprint 45 scoring/dedup stays unchanged.

**Tech Stack:** TypeScript, Fastify, Drizzle SQLite migrations, Zod contracts, Vitest with Fastify `inject`.

---

## Branch And Context

- Branch: `sprint-46a-discovery-job-foundation`
- Base: `main` after Sprint 45 is merged. If Sprint 45 is not merged, branch from `sprint-45-discovery-routing`.
- Main spec: `docs/specs/sprint-46-connected-account-competitor-sourcing.md`
- Do not touch web UI or provider adapters in this part.

## File Map

- Modify: `packages/contracts/src/index.ts`
  - add discovery source modes/config fields;
  - add `connectionId`/cursor/backoff fields to source schema;
  - add discovery job schemas/constants.
- Modify: `packages/contracts/test/contracts.test.ts`
  - contract tests for source config, source rows, and job schemas.
- Modify: `apps/api/src/db/schema.ts`
  - add columns to `discovery_sources`;
  - add `discovery_jobs`.
- Create: `apps/api/src/services/discovery-jobs.ts`
  - enqueue due jobs, release stale jobs, claim bounded jobs, mark success/failure.
- Modify: `apps/api/src/services/discovery.ts`
  - route `runDiscovery` through job helpers;
  - keep existing `fetchSourceItems`, dedup, and `scoreUnscoredItems`.
- Modify: `apps/api/src/routes/discovery.ts`
  - return the new run summary shape.
- Modify/Create migration: `apps/api/drizzle/00NN_*.sql`
- Test: `apps/api/test/discovery-jobs.test.ts`
- Test: existing `apps/api/test/discovery.test.ts`

---

## Tasks

### Task 1: Contracts For Source Modes And Job Status

- [ ] Add `DISCOVERY_SOURCE_MODES = ["query", "account_timeline", "list_timeline", "subreddit", "hashtag"]`.
- [ ] Add `DISCOVERY_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"]`.
- [ ] Extend `discoverySourceConfigSchema` with `mode`, `handle`, `handles`, `listId`, `hashtag`, `trackedAccountId`, `trackedAccountIds`.
- [ ] Extend `discoverySourceSchema` with `connectionId`, `cursor`, `backoffUntil`, `lastAttemptedAt`.
- [ ] Add `discoveryJobSchema`.
- [ ] Add tests that parse:
  - keyless RSS source with `connectionId: null`;
  - X source config with `mode: "query"`;
  - queued/running/succeeded job rows.
- [ ] Run `npm test -- contracts`.
- [ ] Commit: `feat(contracts): add connected discovery source and job contracts`.

### Task 2: Schema And Migration

- [ ] Add nullable columns on `discoverySources`: `connectionId`, `cursorJson`, `backoffUntil`, `lastAttemptedAt`.
- [ ] Add `discoveryJobs` table with workspace/source/status/attempt/lock/timing/count/error columns.
- [ ] Add indexes on `(workspaceId, status, createdAt)` and `(sourceId, status)`.
- [ ] Run `npm run db:generate -w apps/api`.
- [ ] Run `npm test -w @tuezday/api -- discovery`.
- [ ] Commit: `feat(api): add discovery job ledger schema`.

### Task 3: Job Helper Service

- [ ] Create `apps/api/src/services/discovery-jobs.ts`.
- [ ] Export constants:
  - `DISCOVERY_JOB_BATCH_SIZE = 5`;
  - `DISCOVERY_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1000`.
- [ ] Implement:
  - `releaseStaleDiscoveryJobs(db, now)`;
  - `enqueueDueDiscoveryJobs(db, workspaceId, now)`;
  - `claimDiscoveryJobs(db, workspaceId, limit, now)`;
  - `completeDiscoveryJob(db, jobId, counts, now)`;
  - `failDiscoveryJob(db, jobId, error, now)`.
- [ ] Tests:
  - no duplicate queued job when one already exists for a source;
  - stale running job becomes failed with `stale_lock`;
  - claim respects batch size and marks `running`;
  - success/failure writes counts/error.
- [ ] Run `npm test -- discovery-jobs`.
- [ ] Commit: `feat(api): discovery job enqueue and claim helpers`.

### Task 4: Run Existing Discovery Through Jobs

- [ ] In `runDiscovery`, call stale release, enqueue due jobs, claim a bounded batch, and process each job.
- [ ] For Part 1, all processed jobs use existing keyless fetching:
  - `intent` still uses `intentProvider`;
  - everything else still calls `fetchSourceItems`.
- [ ] Preserve existing insertion, cross-source dedup, and `scoreUnscoredItems` logic.
- [ ] On source failure, mark the job failed and source `error`.
- [ ] On success, mark source `active`, update `lastFetchedAt`, `lastAttemptedAt`, and complete the job.
- [ ] Return `{ queued, processed, sources, scored }`.
- [ ] Update route tests to accept the new `queued`/`processed` fields without breaking existing assertions on `sources` and `scored`.
- [ ] Run `npm test -- discovery`.
- [ ] Commit: `feat(api): run discovery via bounded jobs`.

### Task 5: Regression Sweep

- [ ] Run `npm test -w @tuezday/api -- discovery`.
- [ ] Run `npm test -- contracts`.
- [ ] Run `npm run typecheck`.
- [ ] Update `docs/specs/sprint-46-connected-account-competitor-sourcing.md` progress log with Part 1 completion notes.
- [ ] Commit: `docs: mark Sprint 46 part 1 ready`.

## Completion Gate

Part 1 is complete when:

- existing RSS/Google News/Reddit keyless discovery still fetches and scores items;
- `/discovery/run` has bounded job behavior;
- no connected provider calls exist yet;
- `npm test -- discovery`, `npm test -- contracts`, and `npm run typecheck` pass.
