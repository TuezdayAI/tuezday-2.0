# Divergent Main Integration Design

> **Status:** Approved design
> **Date:** 2026-07-29
> **Decision owner:** Founder
> **Chosen approach:** Remote-first staged replay
> **Database decision:** All current databases are disposable development databases. The integration supports one clean fresh-database migration lineage; it does not support upgrading databases created from the discarded local migration lineage.

## Executive Summary

Local and remote `main` diverged after commit
`cb18bf1494eac4a111ca4376f7293d38419effcc`. Local `main` contains 29 commits
that remote does not, while `origin/main` contains 28 commits that local does
not.

The remote history is the canonical baseline because it already contains a
coherent five-part product stack:

1. Native SQLite evidence storage and the R2R exit.
2. Connected Gmail mailboxes and reply ingestion.
3. Multi-step outreach sequences.
4. Reply-driven compliance and suppression actions.
5. Open/click tracking, funnel reporting, and attribution.

The local history contributes two independent reliability and security layers:

1. Sprint 48 safe-fetch, atomicity, tenant isolation, and discovery lifecycle
   corrections.
2. Sprint 49 bounded, leased, cursor-driven, idempotent, and restart-safe
   background execution.

The integration will start from remote commit
`a2b55231ebe38b9491151cd92928b521d22fed76` in an isolated worktree. It will
replay the local security layer first and the local execution layer second.
Overlapping composition files will deliberately combine both histories rather
than selecting one side. Remote migrations `0048` through `0052` remain
unchanged; the three local Sprint 49 persistence changes will be regenerated
as canonical migrations `0053` through `0055`.

The current local checkout and both existing `main` histories remain untouched
until a reviewed integration branch passes every focused, combined, and
repository-wide gate.

## 1. Goals

The integration must:

- Preserve every shipped remote product capability.
- Preserve every accepted local Sprint 48 and Sprint 49 guarantee.
- Keep native evidence and permanently remove the R2R runtime dependency.
- Produce one deterministic Drizzle migration lineage through `0055`.
- Run every background job through the local managed, shutdown-safe scheduler.
- Keep public tracking endpoints public only when their signed tokens validate.
- Keep internal worker endpoints restricted to the system actor.
- Retain abort propagation, hard provider budgets, safe-fetch protections, and
  idempotency across the combined Gmail, outreach, evidence, and discovery
  workload.
- Account for every local-only commit, including documentation-only commit
  `03329c4644375f312c8ae57e1efeb4338e96400e`.
- Produce evidence sufficient for founder acceptance without requiring the
  founder to manually repeat the full regression suite.

## 2. Non-Goals

This integration will not:

- Preserve or migrate data from a database created with local migrations
  `0048_sprint_49_leases`, `0049_sprint_49_automation_idempotency`, or
  `0050_sprint_49_matching_state`.
- Reintroduce R2R, its Docker services, or its client tests.
- Redesign Gmail, outreach, evidence, discovery, or worker product behavior
  outside what is required to combine the accepted histories.
- Rename historical commits or rewrite historical sprint specifications.
- Add new providers, customer-facing features, or unrelated refactors.
- Push or merge directly to `main`.

## 3. Selected Integration Strategy

### 3.1 Canonical branch

The integration branch is
`integration/remote-main-local-s48-s49`, created from `origin/main` at
`a2b55231ebe38b9491151cd92928b521d22fed76`.

The isolated worktree protects the dirty local `main` checkout, including
founder-owned modified and untracked files. Integration work must never stage,
commit, delete, or normalize files from that checkout.

### 3.2 Replay order

The replay order is:

1. Record and verify the remote baseline.
2. Preserve local-only documentation that is independent of Sprint 48/49.
3. Replay local Sprint 48 security and tenant-isolation behavior.
4. Reconcile API composition, authentication, native evidence, Gmail, and LLM
   gateway seams.
5. Replay local Sprint 49 persistence and execution behavior in its original
   dependency order.
6. Attach remote mailbox, outreach, sequence, and evidence jobs to the local
   managed scheduler.
7. Reconcile UI, contracts, environment documentation, founder acceptance
   documentation, and package metadata.
8. Run focused, combined, repository-wide, and CI gates.

The integration must not advance to the next stage while the current stage has
a failing focused test, type error, migration invariant, or unexplained
behavioral regression.

### 3.3 Why the alternatives were rejected

A direct merge was rejected because only eight files produce explicit conflict
markers while additional high-risk files—schema, contracts, gateway, auth, and
lockfile—can auto-merge incorrectly. A manual reconstruction of the remote
features was rejected because it would duplicate approximately 10,800 lines of
already-tested source, tests, migrations, and documentation.

## 4. Conflict Ownership Rules

### 4.1 Remote-authoritative capabilities

Remote behavior remains authoritative for:

- `DbEvidenceStore`, evidence chunking, FTS5/sqlite-vec retrieval, RRF fusion,
  embedding fallback, migration tooling, and parity tooling.
- Gmail mailbox connection, mailbox settings, sending, thread linkage, reply
  polling, and reply classification.
- Outreach sequence models, enrollment, personalization, mailbox allocation,
  sending windows, daily limits, delayed same-thread follow-ups, and stop
  behavior.
- Postal-address compliance, unsubscribe footers, suppression imports,
  bounce/unsubscribe/OOO/positive-reply actions, and CRM task creation.
- Signed open/click tracking, public tracking routes, funnel computation,
  attribution, manual outcomes, and the outreach UI.

### 4.2 Local-authoritative guarantees

Local behavior remains authoritative for:

- Safe-fetch DNS and redirect validation, destination policy, content and
  decompression limits, and redacted failures.
- Workspace ownership checks, reference validation, atomic signal creation,
  source transition validation, and discovery tenant invariants.
- Database-clock task leases, lease fencing, heartbeats, stale recovery, and
  one-active-job constraints.
- Operator-owned hard budgets, bounded provider calls, abort propagation,
  cursor checkpoints, and per-target resumability.
- Discovery and automatic-draft idempotency.
- Matching claims, versioning, invalidation, serialized triage, and readiness
  projection.
- Worker configuration validation, self-scheduling await-completion loops,
  scoped startup, graceful shutdown, and stop-admitting-new-work semantics.

### 4.3 Files that must combine both histories

The following areas may not resolve by taking either side wholesale:

| Area | Required combined behavior |
|---|---|
| `apps/api/src/app.ts` | Native evidence and Gmail/outreach dependencies coexist with safe-fetch, operator policy, internal tasks, and shutdown signaling. |
| `apps/api/src/server.ts` | One shared Gemini gateway serves generation and embeddings while operator policy and local shutdown semantics remain active. |
| `apps/api/src/auth/guard.ts` | Signed tracking endpoints have the narrow required public access; worker task endpoints remain system-only. |
| `apps/api/src/db/schema.ts` | The schema is the union of remote outreach/evidence models and local lease/idempotency/matching state. |
| `apps/api/src/llm/gateway.ts` | Remote `embed()` support coexists with local abort signals and bounded generation behavior. |
| `apps/api/src/llm/gemini.ts` | Generation and embedding share the provider without losing cancellation, response limits, or stable error mapping. |
| `apps/worker/src/index.ts` | Remote job types are registered through the local managed scheduler; independent overlapping `setInterval` loops are not restored. |
| `packages/contracts/src/index.ts` | Outreach, tracking, cursor progress, and matching readiness contracts coexist without redeclared vocabularies. |
| `package.json` and workspace manifests | Remote evidence dependencies and scripts coexist with local worker/test scripts; obsolete R2R scripts remain removed. |
| `package-lock.json` | Regenerated from the reconciled manifests; never accepted from a textual conflict resolution. |

## 5. Database and Migration Design

Remote migrations remain immutable:

- `0048_oval_ben_urich` — Gmail mailboxes.
- `0049_goofy_xorn` — outreach sequences.
- `0050_goofy_mother_askani` — compliance.
- `0051_mute_madripoor` — native evidence chunks.
- `0052_clever_doctor_doom` — outreach tracking.

The local persistence layers are reapplied after remote `0052`:

- `0053` — task leases, source execution versions, job lease fields, and the
  one-active-source-job invariant.
- `0054` — automatic-draft idempotency.
- `0055` — discovery matching claim and readiness state.

Each migration is generated from `apps/api/src/db/schema.ts` using the
repository Drizzle command after the preceding migration and snapshot are
present. Generated snapshots and `_journal.json` must form one predecessor
chain from remote `0052` through local `0055`.

Migration verification must:

- Create a brand-new empty SQLite database.
- Apply every checked-in migration in order.
- Assert the remote mailbox, outreach, compliance, evidence, and tracking
  tables and columns.
- Assert local lease, automation-key, matching-state, version, cursor, and
  unique-index invariants.
- Prove two active discovery jobs cannot exist for one source.
- Prove the active outreach-enrollment uniqueness rule remains intact.
- Prove foreign keys are enabled and valid.
- Run `PRAGMA foreign_key_check` with zero rows.
- Compare the migrated database shape with the final Drizzle schema.

Because all databases are disposable, no compatibility migration will attempt
to detect or repair the discarded local `0048` through `0050` history.

## 6. Runtime Composition

### 6.1 API composition

`buildApp()` remains the single dependency-injection root. Its combined
contract must support:

- one `LlmGateway` used by generation and native evidence embeddings;
- an optional trusted fetcher for provider and connector traffic;
- a guarded safe-fetch service for discovery and website scraping;
- the native database evidence store by default;
- connector fabric, Gmail mailbox provider, Resend provider, mailer, tracking
  signer, and analytics seams;
- parsed operator policy;
- worker token authentication; and
- a shutdown signal shared with bounded work.

Tests must be able to replace every external dependency. No test may require
live Gmail, Gemini, Nango, Resend, R2R, or public internet access.

### 6.2 Authentication

Public route access is an explicit allowlist. Tracking open and click routes
are public because their HMAC token is the authorization boundary. Invalid,
wrong-purpose, expired if expiry is present, or malformed tokens must not write
tracking events or redirect to attacker-controlled content.

Internal task routes are never placed on the public allowlist. They require the
system actor derived from `TUEZDAY_WORKER_TOKEN`; an ordinary workspace member
cannot invoke cross-workspace ticks.

### 6.3 Worker scheduling

The local worker scheduler is the only scheduling runtime. It starts
independent await-completion loops with explicit stop signals and validated
interval configuration.

Remote mailbox-inbox, outreach, sequence, and evidence jobs become managed
loop definitions alongside discovery, automation, cadence, publication, ads,
inbox, and learning work. A loop schedules its next run only after the current
run settles. Shutdown stops future scheduling, aborts or lets in-flight work
settle according to the task contract, and closes cleanly without calling
`process.exit()` from business logic.

Database leases and idempotency remain the correctness boundary. Scheduler
timing alone must never be relied on to prevent duplicates.

## 7. Verification Gates

### 7.1 Recorded remote baseline

The isolated remote baseline at `a2b5523` completed:

- 168 test files passed.
- 1,597 tests passed.
- Zero test failures.

The implementation plan must also record baseline typecheck and production
build before source replay begins.

### 7.2 Sprint 48 security gate

The replayed security layer must pass focused coverage for:

- forbidden destinations and DNS/redirect changes;
- timeouts, response size, decompression, and content-type bounds;
- redacted safe-fetch errors;
- workspace-scoped signal/persona/campaign/source references;
- atomic signal creation;
- source status transitions and deletion lifecycle; and
- existing discovery and connected-discovery regressions.

### 7.3 Composition gate

The combined composition must prove:

- native evidence ingest, search, deletion, citations, and lexical fallback;
- no runtime or package dependency on R2R;
- public tracking works only with valid signed tokens;
- internal task routes reject ordinary users;
- Gmail and Resend use their intended provider seams;
- `generate()` retains local cancellation/bounds;
- `embed()` retains remote vector support and graceful fallback; and
- application and server shutdown propagate to bounded work.

### 7.4 Sprint 49 execution gate

The replayed execution layer must prove:

- fresh migration through `0055`;
- lease fencing, heartbeat, expiry, and recovery;
- one active discovery job per source;
- bounded source work and provider calls;
- atomic page persistence and cursor advancement;
- restart-safe per-target resume;
- automatic-draft idempotency;
- matching serialization and incremental invalidation;
- authenticated internal task routes; and
- managed scheduler startup and graceful shutdown.

### 7.5 Combined product acceptance gate

Automated acceptance must cover these cross-history scenarios:

1. A guarded discovery source runs, checkpoints progress, experiences a
   simulated worker restart, resumes, and creates no duplicate work.
2. A native evidence document is ingested and cited during generation with no
   R2R service; missing embeddings degrade to lexical retrieval.
3. A lead enrolls in outreach, sends through an injected Gmail mailbox,
   records open and click events, receives a classified reply, stops the
   sequence, and applies the correct compliance action.
4. Mailbox, outreach, discovery, and evidence loops execute concurrently
   without duplicate claims, leaked authorization, or interference between
   lease keys.

### 7.6 Repository-wide gate

The final integration branch must pass:

```bash
npm run typecheck
npm test
npm run build
npm run test:desktop
```

Any failure blocks completion. A skipped test must have a recorded
environmental reason and may not conceal a failure in an integrated product
path.

## 8. Documentation and Sprint Numbering

Both histories independently used “Sprint 48” and “Sprint 49” for different
work. Historical filenames, specifications, and commits remain unchanged to
preserve provenance.

New reconciliation material uses descriptive labels:

- **Local Sprint 48 — security and tenant isolation**
- **Remote Sprint 48 — outreach sequences**
- **Local Sprint 49 — bounded leased execution**
- **Remote Sprint 49 — reply actions and compliance**

`docs/founder-acceptance-tests.md`, roadmap references, and the integration PR
must use these labels whenever ambiguity is possible.

Environment and repository guidance must describe native evidence and remove
obsolete R2R startup instructions while preserving local operator-policy and
worker configuration.

## 9. Plane and Review Protocol

The implementation plan will map each independently reviewable integration
stage to one Plane task. Before work starts on a task:

1. Read the task and its current state.
2. Move it to `In Progress`.
3. Record the source hashes and the relevant design/plan section.

A task moves to `Done` only after its focused gate passes. Its completion
comment records:

- combined behavior delivered;
- exact commands executed;
- test file and test counts;
- migration or build evidence where applicable; and
- the resulting commit SHA.

The parent integration item remains `In Progress` until every child task, the
combined acceptance test, repository-wide verification, and GitHub Actions
are green.

## 10. Release and Rollback

Each stage receives a focused commit so reviewers can reject or revise one
layer without obscuring another. The integration branch is pushed only after
local verification. Its pull request must include:

- the two source branch hashes and common ancestor;
- the local-to-canonical migration map;
- the explicit conflict-ownership decisions;
- focused and full verification evidence;
- any accepted environmental skip; and
- the founder-acceptance result.

GitHub Actions must be green, and founder acceptance is required before merge.
The process never force-pushes or directly overwrites `main`.

Rollback requires no data operation. Until acceptance, local `main`,
`origin/main`, and their existing databases remain unchanged. A rejected
integration branch can be revised or abandoned without losing either source
history.

## 11. Success Criteria

The integration is successful only when:

- every local-only commit is explicitly replayed, superseded, or documented as
  intentionally omitted;
- every remote product track remains present;
- the final database installs cleanly through `0055`;
- no R2R runtime path remains;
- safe-fetch, tenant isolation, leases, bounds, cursors, and idempotency remain
  enforced;
- Gmail, outreach, compliance, tracking, and native evidence operate through
  the combined composition root;
- every background loop uses the managed scheduler and authenticated API
  boundary;
- focused tests, combined acceptance, typecheck, full tests, build, desktop
  tests, and GitHub Actions pass; and
- the founder accepts the integration branch before `main` changes.
