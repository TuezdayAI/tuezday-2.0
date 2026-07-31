# Divergent Main Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one reviewed integration branch that preserves the complete
remote outreach/native-evidence stack and the complete local security,
tenant-isolation, and restart-safe execution stack.

**Architecture:** Start from remote `main` at `a2b5523` in the existing
isolated integration worktree. Replay local commits in dependency order,
resolve shared composition files by explicit ownership rules, and regenerate
the local persistence layers as migrations `0053`–`0055` after the remote
`0052` lineage. The API remains the correctness boundary; the worker only
wakes authenticated, await-completion loops.

**Tech Stack:** TypeScript 5.7, Node.js 20+, npm workspaces, Fastify 5, Drizzle
ORM 0.44, better-sqlite3 12, sqlite-vec 0.1.9, Zod 3.25, Vitest 3, Next.js,
Playwright, Nango connector fabric, Gmail/Resend provider seams.

## Global Constraints

- Work only in
  `/Users/ranjan/Desktop/tuezday-2.0/.worktrees/integration-remote-main-local-s48-s49`
  on branch `integration/remote-main-local-s48-s49`.
- Preserve remote baseline
  `a2b55231ebe38b9491151cd92928b521d22fed76`, local source
  `48a47c6800d1a77b176ad2e4d126fa2bf5b0af00`, and common ancestor
  `cb18bf1494eac4a111ca4376f7293d38419effcc`.
- If either source hash changes, stop before replaying code and repeat the
  read-only divergence audit.
- Never stage, commit, clean, or modify the founder-owned dirty checkout at
  `/Users/ranjan/Desktop/tuezday-2.0`.
- Remote native evidence, Gmail mailboxes, outreach sequences, compliance,
  reply actions, tracking, funnel reporting, and attribution remain present.
- Local safe-fetch, tenant isolation, task leases, budgets, cursors,
  idempotency, matching readiness, and restart-safe worker behavior remain
  present.
- Remote migrations `0048`–`0052` are immutable.
- The local lease, automation-idempotency, and matching-state schema changes
  become generated migrations `0053`, `0054`, and `0055`.
- Do not support upgrading databases created from the discarded local
  `0048`–`0050` migration lineage; all existing databases are disposable.
- Do not restore R2R code, Docker configuration, scripts, tests, or runtime
  documentation.
- Use one `LlmGateway` instance for generation and native evidence. Preserve
  both abort-aware generation and optional embedding support.
- Keep `/t/o/:token` and `/t/c/:token` public, with their signed token as the
  authorization boundary.
- Keep `/internal/*` routes worker-token-only. The worker token is not a
  general system-session credential.
- Every worker loop schedules its next run only after the current run settles.
- Database leases and idempotency—not timer ordering—are the duplicate-work
  boundary.
- Every task starts by reading its Plane card and moving only that card to
  `In Progress`.
- Every task ends with focused tests, relevant regressions, typecheck for
  affected workspaces, a focused commit, and a Plane completion comment
  containing commands, results, and commit SHA.
- Never start the next source commit while a cherry-pick is conflicted.
  Complete the task's stated conflict resolution, stage it, run
  `git cherry-pick --continue`, and only then resume the source sequence.
- The integration parent remains `In Progress` until local verification,
  GitHub Actions, code review, and founder acceptance are complete.
- Never push directly to or force-update `main`.

---

## File and Responsibility Map

### Integration control files

- `docs/integration/2026-07-29-divergent-main-ledger.md` — source hashes,
  per-commit disposition, migration map, task/Plane mapping, and verification
  evidence.
- `docs/superpowers/specs/2026-07-29-divergent-main-integration-design.md` —
  approved design and conflict ownership.
- `docs/superpowers/plans/2026-07-29-divergent-main-integration.md` — this
  executable plan.

### Local source units to replay

- `apps/api/src/safe-fetch/` — destination policy, DNS/redirect pinning,
  bounded body reading, and safe errors.
- `apps/api/src/runtime/operator-policy.ts` — deployment-only discovery
  budgets.
- `apps/api/src/discovery/paging.ts` — per-target cursor and budget types.
- `apps/api/src/connectors/bounded-json.ts` — bounded Nango JSON decoding.
- `apps/api/src/services/task-leases.ts` — database-clock lease lifecycle.
- `apps/api/src/services/discovery-scheduler.ts` — bounded discovery scheduler.
- `apps/api/src/services/discovery-matching.ts` — serialized matching claims.
- `apps/api/src/services/matching-invalidation.ts` — targeted invalidation.
- `apps/api/src/routes/internal-tasks.ts` — worker-only discovery/automation
  entrypoints.
- `apps/worker/src/config.ts` — strict environment parsing.
- `apps/worker/src/client.ts` — authenticated API client.
- `apps/worker/src/scheduler.ts` — await-completion loops.

### Shared composition files

- `apps/api/src/app.ts` — combines native evidence, Gmail/outreach, guarded
  fetching, operator policy, internal tasks, and shutdown.
- `apps/api/src/server.ts` — creates one LLM/native-evidence runtime and parses
  operator policy.
- `apps/api/src/auth/guard.ts` — combines tracking public routes with scoped
  worker authentication.
- `apps/api/src/db/schema.ts` — union of remote outreach/evidence and local
  execution persistence.
- `apps/api/src/llm/gateway.ts`, `gemini.ts`, `openrouter.ts` — generation
  aborts plus embeddings.
- `apps/worker/src/index.ts` — all remote and local task loops under the local
  scheduler.
- `packages/contracts/src/index.ts` — remote outreach/tracking and local
  matching/cursor contracts.
- `.env.example`, `README.md`, `CLAUDE.md`,
  `docs/founder-acceptance-tests.md` — combined operating instructions.
- `package.json`, `apps/api/package.json`, `apps/worker/package.json`,
  `vitest.config.ts`, `package-lock.json` — combined scripts, projects, and
  dependencies.

### Canonical migration outputs

- Create: `apps/api/drizzle/0053_sprint_49_leases.sql`
- Create: `apps/api/drizzle/meta/0053_snapshot.json`
- Create: `apps/api/drizzle/0054_sprint_49_automation_idempotency.sql`
- Create: `apps/api/drizzle/meta/0054_snapshot.json`
- Create: `apps/api/drizzle/0055_sprint_49_matching_state.sql`
- Create: `apps/api/drizzle/meta/0055_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Never create: local-numbered `0048_sprint_49_leases.sql`,
  `0049_sprint_49_automation_idempotency.sql`, or
  `0050_sprint_49_matching_state.sql`

### Integration-specific test changes

- Modify: `apps/api/test/sprint49-migrations.test.ts`
- Modify: `apps/api/test/sprint49-acceptance.test.ts`
- Modify: `apps/api/test/gateway-embed.test.ts`
- Modify: `apps/api/test/internal-tasks.test.ts`
- Modify: `apps/worker/test/config.test.ts`
- Modify: `apps/worker/test/scheduler.test.ts`
- Preserve all remote Gmail/outreach/evidence tests and every replayed local
  security/discovery/worker test.

---

### Task 1: Establish Plane control, source ledger, and complete baseline

**Files:**

- Create: `docs/integration/2026-07-29-divergent-main-ledger.md`
- Reference:
  `docs/superpowers/specs/2026-07-29-divergent-main-integration-design.md`

**Interfaces:**

- Produces the authoritative mapping from source commits to integration tasks.
- Produces the exact baseline commands and results that every later task uses.
- Does not change product code.

- [ ] **Step 1: Create or locate the Plane integration parent**

Use the connected Plane workspace. Search for an existing item titled:

```text
Integrate divergent local and remote main histories
```

If it does not exist, create it with the approved design file, source hashes,
and this plan linked in the description. Create these child tasks if they do
not already exist:

```text
Record integration baseline and source ledger
Replay local documentation history
Integrate safe-fetch foundation
Integrate tenant isolation and guarded discovery
Regenerate lease persistence as migration 0053
Combine execution bounds, LLM gateway, and native evidence
Regenerate automation idempotency as migration 0054
Regenerate matching state as migration 0055
Integrate scoped worker auth and managed scheduling
Reconcile UI, manifests, environment, and documentation
Run cross-history acceptance
Verify, review, and publish the integration branch
```

Move only `Record integration baseline and source ledger` to `In Progress`.

- [ ] **Step 2: Verify the protected source hashes**

Run:

```bash
git fetch origin --prune
git status --short
git rev-parse origin/main
git rev-parse main
git merge-base main origin/main
git branch --show-current
```

Expected:

```text
# status: no output
a2b55231ebe38b9491151cd92928b521d22fed76
48a47c6800d1a77b176ad2e4d126fa2bf5b0af00
cb18bf1494eac4a111ca4376f7293d38419effcc
integration/remote-main-local-s48-s49
```

- [ ] **Step 3: Create the reconciliation ledger**

Create `docs/integration/2026-07-29-divergent-main-ledger.md` with:

```markdown
# Divergent Main Reconciliation Ledger

## Protected sources

- Remote baseline: `a2b55231ebe38b9491151cd92928b521d22fed76`
- Local source: `48a47c6800d1a77b176ad2e4d126fa2bf5b0af00`
- Common ancestor: `cb18bf1494eac4a111ca4376f7293d38419effcc`

## Migration map

| Discarded local file | Canonical output | Disposition |
|---|---|---|
| `0048_sprint_49_leases.sql` | `0053_sprint_49_leases.sql` | regenerate after remote `0052` |
| `0049_sprint_49_automation_idempotency.sql` | `0054_sprint_49_automation_idempotency.sql` | regenerate after `0053` |
| `0050_sprint_49_matching_state.sql` | `0055_sprint_49_matching_state.sql` | regenerate after `0054` |

## Commit disposition

| Commit | Integration task | Initial disposition |
|---|---|---|
| `03329c4` | Replay local documentation history | planned replay |
| `e1ee8b5` | Replay local documentation history | planned replay |
| `310284c` | Replay local documentation history | planned replay |
| `aa2487c` | Integrate safe-fetch foundation | planned replay |
| `cab7d97` | Integrate safe-fetch foundation | planned replay |
| `10a97d5` | Integrate safe-fetch foundation | planned replay |
| `ddbb198` | Integrate safe-fetch foundation | planned replay |
| `db83e8f` | Integrate tenant isolation and guarded discovery | planned replay |
| `b0ae203` | Integrate tenant isolation and guarded discovery | planned replay |
| `4846c1e` | Integrate tenant isolation and guarded discovery | planned replay |
| `a957e15` | Integrate tenant isolation and guarded discovery | planned replay |
| `441fff7` | Integrate tenant isolation and guarded discovery | planned replay |
| `6f9a839` | Integrate tenant isolation and guarded discovery | planned replay |
| `d9717aa` | Integrate tenant isolation and guarded discovery | planned replay |
| `15d4bd8` | Replay local documentation history | planned replay |
| `6a78150` | Replay local documentation history | planned replay |
| `96da3a3` | Regenerate lease persistence as migration 0053 | planned replay |
| `7584eab` | Regenerate lease persistence as migration 0053 | planned replay |
| `1679852` | Combine execution bounds, LLM gateway, and native evidence | planned replay |
| `7ce5487` | Combine execution bounds, LLM gateway, and native evidence | planned replay |
| `2ea63c5` | Regenerate automation idempotency as migration 0054 | planned replay |
| `f182c8e` | Regenerate matching state as migration 0055 | planned replay |
| `cf58135` | Regenerate matching state as migration 0055 | planned replay |
| `e6b5a2f` | Regenerate matching state as migration 0055 | planned replay |
| `f01dd67` | Integrate scoped worker auth and managed scheduling | planned replay |
| `5221dbd` | Regenerate matching state as migration 0055 | planned replay |
| `555350d` | Reconcile UI, manifests, environment, and documentation | planned replay |
| `5c712c9` | Run cross-history acceptance | planned replay |
| `48a47c6` | Verify, review, and publish the integration branch | superseded by the new integration branch |

## Verification evidence

Append one dated entry per task with Plane item, commands, result, and commit.
```

- [ ] **Step 4: Run the complete remote baseline**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Expected:

- Typecheck exits `0`.
- The previously recorded test baseline remains 168 files and 1,597 tests, or
  increases only because the branch already contains documentation.
- Production build exits `0`.

If a source test fails before replay, stop and investigate the baseline; do
not attribute it to integration work.

- [ ] **Step 5: Commit and complete the Plane task**

Run:

```bash
git add docs/integration/2026-07-29-divergent-main-ledger.md
git commit -m "docs: record divergent main integration baseline" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Append the command results and commit SHA to the ledger. Move the Plane child
to `Done` and comment with the four baseline command results.

---

### Task 2: Replay the independent local documentation history

**Files:**

- Create: `docs/superpowers/specs/2026-07-19-instagram-login-threads-oauth-design.md`
- Create: `docs/specs/sprint-48-safe-fetch-tenant-isolation.md`
- Create:
  `docs/superpowers/plans/2026-07-28-sprint-48-safe-fetch-tenant-isolation.md`
- Create: `docs/specs/sprint-49-bounded-leased-job-execution.md`
- Create:
  `docs/superpowers/plans/2026-07-28-sprint-49-bounded-leased-job-execution.md`
- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`

**Interfaces:**

- Preserves five documentation commits that do not depend on integrated code.
- Uses descriptive local/remote track labels where new text would otherwise
  make Sprint 48/49 ambiguous.

- [ ] **Step 1: Read the Plane card and move it to `In Progress`**

Record the five source commit hashes in the start comment.

- [ ] **Step 2: Replay the documentation commits**

Run:

```bash
git cherry-pick \
  03329c4644375f312c8ae57e1efeb4338e96400e \
  e1ee8b507774e8a804ef8f427ae34cf2a4f871c6 \
  310284c4d383f0532117b0d2191dc305104c671f \
  15d4bd8788d7743e9e4b40ef5d2dbafede740afc \
  6a78150e3f50c12219000b8dabb84855647d423e
```

Expected: five clean documentation commits. If a documentation conflict
appears, preserve both histories and label them:

```text
Local Sprint 48 — security and tenant isolation
Remote Sprint 48 — outreach sequences
Local Sprint 49 — bounded leased execution
Remote Sprint 49 — reply actions and compliance
```

- [ ] **Step 3: Verify documentation integrity**

Run:

```bash
git diff --check origin/main...HEAD
rg -n "R2R|native evidence|safe-fetch|bounded leased" \
  docs/specs docs/superpowers/specs docs/superpowers/plans
```

Expected: no whitespace errors; all named documents are present. Historical
local documents may mention their then-current R2R baseline, but new
integration documents must state that native evidence wins.

- [ ] **Step 4: Record the replay**

Change the five ledger rows from `planned replay` to `replayed`, append the
five resulting SHAs, and commit:

```bash
git add docs/integration/2026-07-29-divergent-main-ledger.md
git commit -m "docs: record local design history replay" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Move the Plane child to `Done`.

---

### Task 3: Integrate the safe-fetch foundation

**Files:**

- Create: `apps/api/src/safe-fetch/destination.ts`
- Create: `apps/api/src/safe-fetch/errors.ts`
- Create: `apps/api/src/safe-fetch/index.ts`
- Create: `apps/api/src/safe-fetch/policy.ts`
- Create: `apps/api/src/safe-fetch/body.ts`
- Create: `apps/api/src/safe-fetch/service.ts`
- Create: `apps/api/src/safe-fetch/transport.ts`
- Create: `apps/api/test/safe-fetch-policy.test.ts`
- Create: `apps/api/test/safe-fetch-routing.test.ts`
- Create: `apps/api/test/safe-fetch-body.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`

**Interfaces:**

- Produces `SafeFetchService`, `SafeFetchPolicy`, `SafeFetchError`,
  `createSafeFetchPolicy()`, and `createSafeFetchService()`.
- Keeps `sqlite-vec` while adding `ipaddr.js` and `undici`.

- [ ] **Step 1: Start the Plane task**

Move `Integrate safe-fetch foundation` to `In Progress`. Record commits
`aa2487c`, `cab7d97`, `10a97d5`, and `ddbb198`.

- [ ] **Step 2: Replay the four safe-fetch commits**

Run:

```bash
git cherry-pick aa2487c cab7d97 10a97d5 ddbb198
```

If `apps/api/package.json` conflicts, its dependency union must contain:

```json
{
  "ipaddr.js": "^2.4.0",
  "sqlite-vec": "^0.1.9",
  "undici": "^6.28.0"
}
```

If `package-lock.json` conflicts during a cherry-pick, restore the current
remote-derived lockfile for that conflict:

```bash
git restore --source=HEAD --staged --worktree package-lock.json
git add apps/api/package.json package-lock.json
git cherry-pick --continue
```

The lockfile is regenerated from the reconciled manifest in the next step.

- [ ] **Step 3: Regenerate and install the dependency union**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
```

Expected: `package-lock.json` includes `ipaddr.js`, `sqlite-vec`, and `undici`;
installation exits `0`.

- [ ] **Step 4: Run the safe-fetch gate**

Run:

```bash
npm test -- \
  apps/api/test/safe-fetch-policy.test.ts \
  apps/api/test/safe-fetch-routing.test.ts \
  apps/api/test/safe-fetch-body.test.ts
npm run typecheck -w apps/api
```

Expected: all safe-fetch tests and API typecheck pass.

- [ ] **Step 5: Commit the reconciled lockfile and record completion**

Run:

```bash
git add apps/api/package.json package-lock.json \
  docs/integration/2026-07-29-divergent-main-ledger.md
git commit -m "build: reconcile native evidence and safe fetch dependencies" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Mark the four source commits `replayed` in the ledger. Move the Plane child to
`Done` with focused test counts and the final SHA.

---

### Task 4: Integrate guarded discovery and tenant invariants

**Files:**

- Create: `apps/api/src/http.ts`
- Create: `apps/api/test/safe-fetch-fixtures.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/db/index.ts`
- Modify: discovery adapters, routes, and services listed in the source commits
- Modify: signal/public API routes and services
- Modify: discovery, connected-discovery, signals, public API, brand-profile,
  workspace, automation, and adapter tests
- Modify: `docs/specs/sprint-48-safe-fetch-tenant-isolation.md`
- Create: `docs/specs/sprint-48-tenant-invariant-audit.md`
- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`

**Interfaces:**

- `TrustedFetcher` remains the raw provider/connector seam.
- `SafeFetchService` is used only for user-influenced discovery and scraping
  destinations.
- `buildApp()` keeps remote native evidence/Gmail/outreach dependencies while
  injecting both trusted and guarded fetching.
- Signal creation and discovery triage are workspace-scoped and atomic.

- [ ] **Step 1: Start the Plane task**

Move `Integrate tenant isolation and guarded discovery` to `In Progress`.

- [ ] **Step 2: Begin the guarded-fetch adoption replay**

Run:

```bash
git cherry-pick db83e8f
```

Expected: `apps/api/src/app.ts` requires deliberate composition. Do not start
the next source commit yet.

- [ ] **Step 3: Resolve `buildApp()` by combining both sides**

The stable option surface after this task must contain:

```ts
export interface BuildAppOptions {
  db: Db;
  llm?: LlmGateway;
  fetcher?: TrustedFetcher;
  safeFetch?: SafeFetchService;
  evidence?: EvidenceStore;
  connectors?: ConnectorFabric;
  intent?: IntentProvider;
  exporter?: OutboundExporter;
  mailer?: Mailer;
  outboundEmail?: OutboundEmailProvider;
  gmail?: GmailMailboxProvider;
  resendWebhookVerifier?: ResendWebhookVerifier;
  workerToken?: string;
  analytics?: AnalyticsSink;
  design?: DesignProvider;
  assetStorage?: AssetStorage;
  render?: (input: RenderInput) => Promise<Uint8Array>;
}
```

The defaults and router bound must be:

```ts
llm = createLlmGatewayFromEnv(),
fetcher = fetch,
safeFetch,
evidence = new DbEvidenceStore(db, llm),
connectors = new NangoFabric(undefined, undefined, fetcher),
gmail = new FabricGmailProvider(connectors),
// ...
const guardedFetch =
  safeFetch ?? createSafeFetchService(createSafeFetchPolicy());
const app = Fastify({
  logger: false,
  routerOptions: { maxParamLength: 4_096 },
});
```

The external-action adapter must keep Gmail:

```ts
adapters: createExternalActionAdapters(
  db,
  connectors,
  fetcher,
  outboundEmail,
  gmail,
),
```

Use `guardedFetch` for workspace website scraping, brand-profile scraping, and
discovery. Keep `fetcher` for Nango, Gmail/Resend, analytics, webhook, and
other trusted provider seams. Preserve every remote mailbox, outreach,
compliance, and tracking route registration.

Stage all files from `db83e8f` and continue:

```bash
git add apps/api/src/app.ts apps/api/src apps/api/test
git cherry-pick --continue
```

- [ ] **Step 4: Replay the remaining six commits**

Run one at a time:

```bash
git cherry-pick b0ae203
git cherry-pick 4846c1e
git cherry-pick a957e15
git cherry-pick 441fff7
git cherry-pick 6f9a839
git cherry-pick d9717aa
```

If any commit pauses, resolve only its named service/test conflict by
preserving remote outreach/evidence behavior and the local workspace/atomicity
invariant, then continue that commit before starting the next.

- [ ] **Step 5: Run the security and remote-regression gate**

Run:

```bash
npm test -- \
  apps/api/test/safe-fetch-policy.test.ts \
  apps/api/test/safe-fetch-routing.test.ts \
  apps/api/test/safe-fetch-body.test.ts \
  apps/api/test/adapters.test.ts \
  apps/api/test/brand-profile.test.ts \
  apps/api/test/workspaces.test.ts \
  apps/api/test/signals.test.ts \
  apps/api/test/public-api.test.ts \
  apps/api/test/discovery.test.ts \
  apps/api/test/connected-discovery.test.ts \
  apps/api/test/evidence.test.ts \
  apps/api/test/mailboxes.test.ts \
  apps/api/test/outreach.test.ts
npm run typecheck -w apps/api
```

Expected: all listed tests and API typecheck pass. Verify in particular:

- foreign workspace references return `404` without leaking which reference
  was foreign;
- failed signal creation leaves no orphan signal;
- unsafe URLs never reach the supplied transport;
- native evidence still ingests and searches;
- Gmail and outreach tests still use their injected fakes.

- [ ] **Step 6: Commit any integration-only conflict resolution**

Cherry-picks already create source commits. If conflict resolution changed
files after the final cherry-pick, commit those changes:

```bash
git add apps/api docs/specs docs/integration
git commit -m "fix: compose guarded discovery with outreach runtime" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Mark the seven ledger rows `replayed`, record the final SHA, and move the Plane
child to `Done`.

---

### Task 5: Regenerate lease persistence as migration 0053

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0053_sprint_49_leases.sql`
- Create: `apps/api/drizzle/meta/0053_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/src/services/task-leases.ts`
- Modify: `apps/api/src/services/discovery-jobs.ts`
- Modify: `apps/api/src/services/discovery.ts`
- Modify: `apps/api/test/sprint49-migrations.test.ts`
- Create: `apps/api/test/task-leases.test.ts`
- Modify: discovery job/service tests

**Interfaces:**

- Produces `taskLeases`, `claimTaskLease()`, `heartbeatTaskLease()`,
  `releaseTaskLease()`, `withTaskLease()`, source execution versions, and
  fenced discovery-job lease fields.
- Produces migration `0053` whose predecessor is remote `0052`.

- [ ] **Step 1: Start the Plane task**

Move `Regenerate lease persistence as migration 0053` to `In Progress`.

- [ ] **Step 2: Begin replay of the persistence commit**

Run:

```bash
git cherry-pick 96da3a3
```

When the expected migration conflicts appear, keep the current remote
snapshots and journal:

```bash
git restore --source=HEAD --staged --worktree \
  apps/api/drizzle/meta/0048_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git rm apps/api/drizzle/0048_sprint_49_leases.sql
```

Resolve `apps/api/src/db/schema.ts` as the union of remote tables and the
local lease/source/job fields. Do not delete or rename any remote table.

- [ ] **Step 3: Rewrite the migration test for the disposable-database rule**

Replace old local filename/backfill assumptions with canonical checks:

```ts
function migrationFile(prefix: string): string {
  const matches = readdirSync(migrationsDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".sql"))
    .sort();
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function migratedEmptyDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    applySqlFile(sqlite, file);
  }
  return sqlite;
}

it("installs lease persistence after remote migration 0052", () => {
  const sqlite = migratedEmptyDatabase();

  expect(migrationFile("0053_")).toContain("sprint_49_leases");
  expect(columns(sqlite, "task_leases")).toEqual(
    expect.arrayContaining([
      "key",
      "owner",
      "version",
      "expires_at",
      "heartbeat_at",
      "created_at",
      "updated_at",
    ]),
  );
  expect(columns(sqlite, "discovery_sources")).toContain("execution_version");
  expect(columns(sqlite, "discovery_jobs")).toEqual(
    expect.arrayContaining([
      "source_execution_version",
      "lease_owner",
      "lease_version",
      "lease_expires_at",
      "heartbeat_at",
    ]),
  );

  const indexes = sqlite
    .prepare("PRAGMA index_list(discovery_jobs)")
    .all() as Array<{ name: string; unique: number }>;
  expect(indexes).toContainEqual(
    expect.objectContaining({
      name: "discovery_jobs_one_active_source",
      unique: 1,
    }),
  );
});
```

- [ ] **Step 4: Confirm the red migration state**

Run:

```bash
npm test -- apps/api/test/sprint49-migrations.test.ts
```

Expected: fail because migration `0053` does not exist.

- [ ] **Step 5: Generate migration 0053**

Run:

```bash
npm run db:generate -w apps/api -- --name sprint_49_leases
```

Expected generated files:

```text
apps/api/drizzle/0053_sprint_49_leases.sql
apps/api/drizzle/meta/0053_snapshot.json
```

Confirm `_journal.json` has index `53`, tag `0053_sprint_49_leases`, and a
predecessor chain from the remote `0052` snapshot.

- [ ] **Step 6: Finish the cherry-pick and replay lease behavior**

Stage the resolved schema, test, generated migration, snapshot, and journal:

```bash
git add apps/api/src/db/schema.ts \
  apps/api/src/services/discovery.ts \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/drizzle/0053_sprint_49_leases.sql \
  apps/api/drizzle/meta/0053_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git cherry-pick --continue
git cherry-pick 7584eab
```

- [ ] **Step 7: Run the lease gate**

Run:

```bash
npm test -- \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/test/task-leases.test.ts \
  apps/api/test/discovery-jobs.test.ts \
  apps/api/test/discovery.test.ts
npm run typecheck -w apps/api
```

Expected: all tests pass; a second active job for one source fails at the
database index; stale owners cannot commit after lease version changes.

- [ ] **Step 8: Record and complete**

Mark `96da3a3` and `7584eab` replayed, record the generated migration name and
SHAs, commit the ledger, and move the Plane child to `Done`.

---

### Task 6: Combine execution bounds, LLM gateway, and native evidence

**Files:**

- Create: `apps/api/src/connectors/bounded-json.ts`
- Create: `apps/api/src/runtime/operator-policy.ts`
- Create: `apps/api/src/discovery/paging.ts`
- Create: `apps/api/src/services/discovery-scheduler.ts`
- Modify: connector, discovery, safe-fetch, and provider files from commits
  `1679852` and `7ce5487`
- Modify: `apps/api/src/llm/gateway.ts`
- Modify: `apps/api/src/llm/gemini.ts`
- Modify: `apps/api/src/llm/openrouter.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: LLM, gateway-embed, operator-policy, discovery-bounds, connector,
  safe-fetch, evidence, and application tests

**Interfaces:**

- `GenerateParams.signal` remains optional and abort-aware.
- `EmbedParams`, `EmbedResult`, and optional `LlmGateway.embed()` remain
  available to native evidence.
- `buildApp()` gains operator policy, instance ID, structured operator log,
  and shutdown signal without losing remote dependencies.
- `server.ts` creates one gateway shared by generation and `DbEvidenceStore`.

- [ ] **Step 1: Start the Plane task and write the gateway regression first**

Move `Combine execution bounds, LLM gateway, and native evidence` to
`In Progress`.

Extend `apps/api/test/gateway-embed.test.ts` with:

```ts
it("keeps embedding support when generation is cancelled", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }
      return okResponse(1);
    }),
  );
  const gateway = new GeminiGateway();
  const controller = new AbortController();
  controller.abort(new Error("cancelled_by_test"));

  await expect(
    gateway.generate({
      prompt: "cancel me",
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled_by_test");

  const result = await gateway.embed!({ texts: ["evidence survives"] });
  expect(result.embeddings).toHaveLength(1);
  expect(result.dimensions).toBe(EVIDENCE_EMBEDDING_DIMENSIONS);
});
```

Use the test file's existing mocked Gemini responses. Run:

```bash
npm test -- \
  apps/api/test/gateway-embed.test.ts \
  apps/api/test/llm.test.ts
```

Expected: the new combined behavior fails before the gateway conflict is
resolved.

- [ ] **Step 2: Replay the execution-bound commits**

Run:

```bash
git cherry-pick 1679852
```

Resolve gateway conflicts with this union:

```ts
export interface GenerateParams {
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface EmbedParams {
  texts: string[];
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  provider: string;
  dimensions: number;
}

export interface LlmGateway {
  generate(params: GenerateParams): Promise<GenerateResult>;
  embed?(params: EmbedParams): Promise<EmbedResult>;
}
```

In `GeminiGateway`, preserve the complete remote `embed()` method. Add
`signal` only to `generate()` and pass it to `fetch`:

```ts
async generate({
  prompt,
  maxOutputTokens,
  signal,
}: GenerateParams): Promise<GenerateResult> {
  // existing key and body handling
  res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });
  // in catch
  if (signal?.aborted) throw signal.reason ?? err;
}
```

Keep the local OpenRouter abort-aware `generate()` implementation. It does not
implement `embed()`; `DbEvidenceStore` therefore degrades to lexical search
when OpenRouter is the selected gateway.

Stage and continue `1679852`:

```bash
git add apps/api/src/llm apps/api/src/connectors apps/api/src/discovery \
  apps/api/src/runtime apps/api/src/safe-fetch apps/api/test
git cherry-pick --continue
```

- [ ] **Step 3: Replay the bounded scheduler commit**

Run:

```bash
git cherry-pick 7ce5487
```

Expected: `app.ts` and `server.ts` require the following two resolution steps.

- [ ] **Step 4: Resolve final API composition**

Add the local runtime options to the Task 4 option union:

```ts
operatorPolicy?: DiscoveryOperatorPolicy;
instanceId?: string;
operatorLog?: (event: DiscoveryOperatorEvent) => void;
shutdownSignal?: AbortSignal;
```

Keep:

```ts
evidence = new DbEvidenceStore(db, llm),
gmail = new FabricGmailProvider(connectors),
const app = Fastify({
  logger: false,
  routerOptions: { maxParamLength: 4_096 },
});
```

Add the local shutdown lifecycle:

```ts
const ownedShutdown = shutdownSignal ? undefined : new AbortController();
const effectiveShutdownSignal =
  shutdownSignal ?? ownedShutdown!.signal;

app.addHook("preClose", async () => {
  ownedShutdown?.abort(new Error("app_shutdown"));
});
app.addHook("onClose", async () => {
  ownedShutdown?.abort(new Error("app_shutdown"));
  await closeRenderer();
});
```

Keep all remote route registrations, and register discovery with guarded/raw
fetching plus policy and shutdown dependencies.

- [ ] **Step 5: Resolve `server.ts` without restoring R2R**

The runtime must be:

```ts
const operatorPolicy = parseDiscoveryOperatorPolicy(process.env);
const db = createDb(DB_FILE);
const llm = createLlmGatewayFromEnv();
const evidence = new DbEvidenceStore(db, llm);
const app = await buildApp({
  db,
  llm,
  evidence,
  operatorPolicy,
});
```

Import `DbEvidenceStore` and `createLlmGatewayFromEnv`; do not import
`R2REvidenceStore`. Keep the validated operator-policy startup error.

Stage and continue `7ce5487`:

```bash
git add apps/api/src/app.ts apps/api/src/server.ts \
  apps/api/src/discovery apps/api/src/routes apps/api/src/services \
  apps/api/test
git cherry-pick --continue
```

- [ ] **Step 6: Run the composition and bounds gate**

Run:

```bash
npm test -- \
  apps/api/test/gateway-embed.test.ts \
  apps/api/test/llm.test.ts \
  apps/api/test/operator-policy.test.ts \
  apps/api/test/discovery-bounds.test.ts \
  apps/api/test/connectors.test.ts \
  apps/api/test/safe-fetch-body.test.ts \
  apps/api/test/db-evidence-store.test.ts \
  apps/api/test/evidence.test.ts \
  apps/api/test/mailboxes.test.ts \
  apps/api/test/outreach.test.ts \
  apps/api/test/outreach-tracking.test.ts
npm run typecheck -w apps/api
```

Also run:

```bash
rg -n "R2REvidenceStore|evidence/r2r|r2r:up|r2r:down" \
  apps package.json README.md CLAUDE.md
```

Expected: tests and typecheck pass; the R2R scan has no runtime/script hits.
Historical documents may still describe the retired migration source.

- [ ] **Step 7: Record and complete**

Commit any integration-only composition changes, mark `1679852` and `7ce5487`
replayed, and move the Plane child to `Done`.

---

### Task 7: Regenerate automation idempotency as migration 0054

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0054_sprint_49_automation_idempotency.sql`
- Create: `apps/api/drizzle/meta/0054_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: automation, drafting, ad-creative, routes, and tests from `2ea63c5`
- Modify: `apps/api/test/sprint49-migrations.test.ts`

**Interfaces:**

- Produces nullable `drafts.automationKey`.
- Produces a partial unique `drafts_automation_key` index.
- Keeps manual signal drafting repeatable while automatic
  signal×campaign×channel drafting is exactly-once.
- Consumes `migrationFile(prefix: string)` and
  `migratedEmptyDatabase(): Database.Database` created in Task 5.

- [ ] **Step 1: Start the Plane task**

Move `Regenerate automation idempotency as migration 0054` to `In Progress`.

- [ ] **Step 2: Replay the source commit and discard its old migration artifacts**

Run:

```bash
git cherry-pick 2ea63c5
```

On the expected migration conflicts:

```bash
git restore --source=HEAD --staged --worktree \
  apps/api/drizzle/meta/0049_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git rm apps/api/drizzle/0049_sprint_49_automation_idempotency.sql
```

Resolve the schema as the union of all remote tables, migration `0053`, and
`drafts.automationKey`.

- [ ] **Step 3: Add the canonical fresh-database assertion**

Add to `sprint49-migrations.test.ts`:

```ts
it("installs automatic-draft idempotency as migration 0054", () => {
  const sqlite = migratedEmptyDatabase();
  expect(migrationFile("0054_")).toContain(
    "sprint_49_automation_idempotency",
  );
  expect(columns(sqlite, "drafts")).toContain("automation_key");
  const indexes = sqlite
    .prepare("PRAGMA index_list(drafts)")
    .all() as Array<{ name: string; unique: number; partial: number }>;
  expect(indexes).toContainEqual(
    expect.objectContaining({
      name: "drafts_automation_key",
      unique: 1,
      partial: 1,
    }),
  );
});
```

`migratedEmptyDatabase()` applies every numbered migration in lexical order to
an empty in-memory SQLite database.

- [ ] **Step 4: Confirm red, generate 0054, and continue**

Run:

```bash
npm test -- apps/api/test/sprint49-migrations.test.ts
```

Expected: fail because `0054` does not exist.

Generate:

```bash
npm run db:generate -w apps/api -- --name sprint_49_automation_idempotency
```

Expected:

```text
apps/api/drizzle/0054_sprint_49_automation_idempotency.sql
apps/api/drizzle/meta/0054_snapshot.json
```

Stage the generated lineage and continue:

```bash
git add apps/api/src/db/schema.ts \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/drizzle/0054_sprint_49_automation_idempotency.sql \
  apps/api/drizzle/meta/0054_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git cherry-pick --continue
```

- [ ] **Step 5: Run the idempotency gate**

Run:

```bash
npm test -- \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/test/automation.test.ts \
  apps/api/test/discovery-idempotency.test.ts \
  apps/api/test/drafts.test.ts
npm run typecheck -w apps/api
```

Expected: automatic retries return one draft and one approval path; manual
drafting remains repeatable.

- [ ] **Step 6: Record and complete**

Mark `2ea63c5` replayed with migration `0054`, record the SHA, and move the
Plane child to `Done`.

---

### Task 8: Regenerate matching state as 0055 and integrate cursors/invalidation

**Files:**

- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0055_sprint_49_matching_state.sql`
- Create: `apps/api/drizzle/meta/0055_snapshot.json`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/src/services/discovery-matching.ts`
- Create: `apps/api/src/services/matching-invalidation.ts`
- Modify: discovery paging, scheduler, services, adapters, and routes
- Modify: campaigns, personas, guidance, matching, and backfill services
- Modify: `packages/contracts/src/index.ts`
- Modify: matching, cursor, connected-discovery, contracts, and migration tests

**Interfaces:**

- Produces matching states `pending | running | ready | failed | frozen`.
- Produces versioned matching claims, fingerprints, expiry, heartbeat, and
  errors.
- Produces per-target durable discovery checkpoints.
- Invalidates only affected unaccepted work after persona/campaign changes.
- Consumes `migrationFile(prefix: string)` and
  `migratedEmptyDatabase(): Database.Database` created in Task 5.

- [ ] **Step 1: Start the Plane task**

Move `Regenerate matching state as migration 0055` to `In Progress`.

- [ ] **Step 2: Replay the matching-state commit and discard old artifacts**

Run:

```bash
git cherry-pick f182c8e
```

On migration conflicts:

```bash
git restore --source=HEAD --staged --worktree \
  apps/api/drizzle/meta/0050_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git rm apps/api/drizzle/0050_sprint_49_matching_state.sql
```

Resolve `schema.ts` as the union of remote schema, `0053`, `0054`, and matching
fields/index.

- [ ] **Step 3: Add the canonical matching migration assertion**

Add:

```ts
it("installs matching claims as migration 0055", () => {
  const sqlite = migratedEmptyDatabase();
  expect(migrationFile("0055_")).toContain("sprint_49_matching_state");
  expect(columns(sqlite, "discovered_items")).toEqual(
    expect.arrayContaining([
      "matching_state",
      "matching_version",
      "matching_input_fingerprint",
      "matching_lease_owner",
      "matching_lease_expires_at",
      "matching_heartbeat_at",
      "matching_error",
    ]),
  );
  const indexes = sqlite
    .prepare("PRAGMA index_list(discovered_items)")
    .all() as Array<{ name: string }>;
  expect(indexes).toContainEqual(
    expect.objectContaining({
      name: "discovered_items_matching_queue",
    }),
  );
  expect(
    sqlite.prepare("PRAGMA foreign_key_check").all(),
  ).toEqual([]);
});
```

- [ ] **Step 4: Confirm red, generate 0055, and continue**

Run:

```bash
npm test -- apps/api/test/sprint49-migrations.test.ts
```

Expected: fail because `0055` does not exist.

Generate and continue:

```bash
npm run db:generate -w apps/api -- --name sprint_49_matching_state
git add apps/api/src/db/schema.ts \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/drizzle/0055_sprint_49_matching_state.sql \
  apps/api/drizzle/meta/0055_snapshot.json \
  apps/api/drizzle/meta/_journal.json
git cherry-pick --continue
```

- [ ] **Step 5: Replay cursor, resume, and invalidation behavior**

Run:

```bash
git cherry-pick cf58135
git cherry-pick e6b5a2f
git cherry-pick 5221dbd
```

For `packages/contracts/src/index.ts`, keep the complete remote outreach,
tracking, mailbox, compliance, funnel, and outcome schemas. Add the local
cursor and matching-readiness fields without redeclaring enums.

- [ ] **Step 6: Run the matching/cursor gate**

Run:

```bash
npm test -- \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/test/discovery-matching-state.test.ts \
  apps/api/test/discovery-cursors.test.ts \
  apps/api/test/discovery-idempotency.test.ts \
  apps/api/test/discovery-bounds.test.ts \
  apps/api/test/connected-discovery.test.ts \
  apps/api/test/matching-invalidation.test.ts \
  packages/contracts/test/contracts.test.ts \
  packages/contracts/test/outbound-email.test.ts
npm run typecheck -w apps/api
npm run typecheck -w packages/contracts
```

Expected: every focused test passes; existing remote contracts still parse;
matching claims and cursor tokens never cross workspaces or leak provider
tokens.

- [ ] **Step 7: Record and complete**

Mark `f182c8e`, `cf58135`, `e6b5a2f`, and `5221dbd` replayed, record migration
`0055`, and move the Plane child to `Done`.

---

### Task 9: Integrate scoped worker authentication and managed scheduling

**Files:**

- Create: `apps/api/src/routes/internal-tasks.ts`
- Modify: `apps/api/src/auth/guard.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/worker/src/client.ts`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/scheduler.ts`
- Modify: `apps/worker/src/index.ts`
- Create: worker tests and Vitest config from `f01dd67`
- Modify: root and worker manifests, root Vitest config, lockfile
- Modify: `.env.example`, `README.md`
- Modify: API auth/internal-task/team tests

**Interfaces:**

- `secureWorkerTokenEqual()` performs constant-shape digest comparison.
- `/internal/discovery/tick` and `/internal/automation/tick` accept only the
  worker token and an empty body.
- The worker token may call only the explicit maintenance allowlist.
- `WorkerConfig.intervals` includes discovery, automation, learning, ads,
  publish, cadence, social inbox, mailbox inbox, outreach, launch sequence, and
  evidence.
- Every loop uses `startSettledLoop()`.

- [ ] **Step 1: Start the Plane task**

Move `Integrate scoped worker auth and managed scheduling` to `In Progress`.

- [ ] **Step 2: Replay the worker source commit**

Run:

```bash
git cherry-pick f01dd67
```

Expected: the worker index and shared composition/auth/manifests require
resolution. Keep the cherry-pick open while completing Steps 3–7.

- [ ] **Step 3: Write the remote-loop expectations and confirm red**

Use the local managed-worker version as the conflict-resolution base:

```bash
git restore --source=f01dd67 --staged --worktree apps/worker/src/index.ts
```

Extend `apps/worker/test/config.test.ts` with:

```ts
expect(config.intervals).toMatchObject({
  discoveryMs: 30 * 60_000,
  automationMs: 5 * 60_000,
  learningMs: 7 * 86_400_000,
  adsMs: 6 * 3_600_000,
  publishMs: 60_000,
  cadenceMs: 5 * 60_000,
  inboxMs: 5 * 60_000,
  mailboxInboxMs: 5 * 60_000,
  outreachMs: 5 * 60_000,
  sequenceMs: 5 * 60_000,
  evidenceMs: 30 * 60_000,
});
```

Run:

```bash
npm test -- apps/worker/test/config.test.ts
```

Expected: fail for missing `mailboxInboxMs` and `outreachMs`.

- [ ] **Step 4: Resolve authentication as a strict union**

`PUBLIC_ROUTES` must include the remote tracking routes:

```ts
"GET /t/o/:token",
"GET /t/c/:token",
```

`WORKER_ROUTE_ALLOWLIST` must be exactly:

```ts
const WORKER_ROUTE_ALLOWLIST = new Set([
  "GET /workspaces",
  "GET /workspaces/:id/learning/syntheses",
  "POST /workspaces/:id/learning/synthesize",
  "POST /workspaces/:id/ads/sync",
  "POST /workspaces/:id/publish/run",
  "POST /workspaces/:id/cadences/run",
  "POST /workspaces/:id/inbox/run",
  "POST /workspaces/:id/mailbox-inbox/run",
  "POST /workspaces/:id/outreach/run",
  "POST /workspaces/:id/sequences/run",
  "POST /workspaces/:id/evidence/candidates/sweep",
]);
```

All `/internal/*` routes require the exact worker token. Ordinary user
sessions receive `401`; the worker token receives `403` outside the internal
routes and explicit maintenance allowlist.

- [ ] **Step 5: Add mailbox and outreach interval configuration**

Extend `WorkerConfig`:

```ts
intervals: {
  discoveryMs: number;
  automationMs: number;
  learningMs: number;
  adsMs: number;
  publishMs: number;
  cadenceMs: number;
  inboxMs: number;
  mailboxInboxMs: number;
  outreachMs: number;
  sequenceMs: number;
  evidenceMs: number;
};
```

Parse:

```ts
mailboxInboxMs: duration(
  env,
  "MAILBOX_INBOX_INTERVAL_MIN",
  5,
  60_000,
  60_000,
  86_400_000,
),
outreachMs: duration(
  env,
  "OUTREACH_INTERVAL_MIN",
  5,
  60_000,
  60_000,
  86_400_000,
),
```

- [ ] **Step 6: Add remote tasks to the managed scheduler**

Port the remote `runMailboxInboxForAllWorkspaces()` and
`runOutreachForAllWorkspaces()` bodies into the local worker. Add:

```ts
{
  name: "mailbox-inbox",
  intervalMs: config.intervals.mailboxInboxMs,
  run: runMailboxInboxForAllWorkspaces,
},
{
  name: "outreach",
  intervalMs: config.intervals.outreachMs,
  run: runOutreachForAllWorkspaces,
},
```

to `loopSpecs`. Do not add `setInterval`. Preserve the existing
`startSettledLoop()` map and signal handlers.

- [ ] **Step 7: Preserve the remote scripts and dependency union**

Root scripts must include:

```json
{
  "dev": "concurrently -n api,web,worker -c blue,magenta,green \"npm run dev -w apps/api\" \"npm run dev -w apps/web\" \"npm run dev -w apps/worker\"",
  "dev:app": "concurrently -n api,web -c blue,magenta \"npm run dev -w apps/api\" \"npm run dev -w apps/web\"",
  "evidence:migrate": "tsx apps/api/src/evidence/migrate.ts",
  "evidence:parity": "tsx apps/api/scripts/evidence-parity.ts"
}
```

Do not restore `r2r:up` or `r2r:down`. Ensure the root Vitest projects include
`apps/worker`.

Regenerate and install:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
```

- [ ] **Step 8: Finish the worker cherry-pick**

Stage the complete union and continue:

```bash
git add .env.example README.md package.json package-lock.json vitest.config.ts \
  apps/api/src/app.ts apps/api/src/auth/guard.ts \
  apps/api/src/routes/internal-tasks.ts apps/api/test \
  apps/worker
git cherry-pick --continue
```

- [ ] **Step 9: Run the auth and worker gate**

Run:

```bash
npm test -- \
  apps/api/test/auth.test.ts \
  apps/api/test/internal-tasks.test.ts \
  apps/api/test/teams.test.ts \
  apps/api/test/mailboxes.test.ts \
  apps/api/test/outreach.test.ts \
  apps/api/test/outreach-tracking.test.ts \
  apps/worker/test/client.test.ts \
  apps/worker/test/config.test.ts \
  apps/worker/test/scheduler.test.ts
npm run typecheck -w apps/api
npm run typecheck -w apps/worker
```

Add the mailbox/outreach paths to the allowlist assertion in
`internal-tasks.test.ts`. Also assert unauthenticated tracking requests reach
tracking validation rather than returning `401`.

Expected: no loop overlaps itself; stop prevents future scheduling; tracking
remains public; internal tasks remain scoped.

- [ ] **Step 10: Record and complete**

Mark `f01dd67` replayed, record the auth/worker test counts and SHA, and move
the Plane child to `Done`.

---

### Task 10: Reconcile matching UI, manifests, environment, and documentation

**Files:**

- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
- Create: `apps/web/lib/discovery-matching-state.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/founder-acceptance-tests.md`
- Modify: root/API/worker manifests, root Vitest config, lockfile
- Modify: contracts and contract tests if needed for UI readiness
- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`

**Interfaces:**

- Discovery UI exposes local matching readiness.
- Remote outreach/mailbox/compliance/tracking UI remains unchanged.
- Environment documentation includes both remote product variables and local
  worker/operator variables.
- Runtime documentation describes native evidence only.

- [ ] **Step 1: Start the Plane task and replay the UI commit**

Move `Reconcile UI, manifests, environment, and documentation` to
`In Progress`.

Run:

```bash
git cherry-pick 555350d
```

- [ ] **Step 2: Resolve `.env.example` as a union**

Keep remote:

```dotenv
GEMINI_EMBED_MODEL=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
TRACKING_BASE_URL=
```

Keep local:

```dotenv
TUEZDAY_INTERNAL_API_URL=http://localhost:3001
DISCOVERY_INTERVAL_MIN=30
AUTOMATION_INTERVAL_MIN=5
LEARNING_SYNTHESIS_DAYS=7
ADS_SYNC_HOURS=6
PUBLISH_INTERVAL_MIN=1
CADENCE_FILL_INTERVAL_MIN=5
INBOX_INTERVAL_MIN=5
MAILBOX_INBOX_INTERVAL_MIN=5
OUTREACH_INTERVAL_MIN=5
SEQUENCE_INTERVAL_MIN=5
EVIDENCE_SWEEP_MIN=30
TUEZDAY_SAFE_FETCH_ALLOW_HTTP=false
```

Keep the complete local `DISCOVERY_*` operator-policy block. Do not add R2R
variables.

- [ ] **Step 3: Reconcile repository guidance**

`README.md` and `CLAUDE.md` must state:

```text
- `npm run dev` starts API, web, and worker.
- `npm run dev:app` starts API and web without background processing.
- Native SQLite evidence needs no Docker service.
- `evidence:migrate` is the one-time R2R corpus import tool.
- `evidence:parity` is the pre-retirement parity check.
- Worker traffic uses TUEZDAY_INTERNAL_API_URL and TUEZDAY_WORKER_TOKEN.
- Gmail, mailbox polling, outreach, sequences, discovery, automation, and
  evidence sweep are scheduled background jobs.
```

Remove active instructions for `npm run r2r:up` and `npm run r2r:down`.

- [ ] **Step 4: Resolve founder acceptance documentation**

Preserve the remote acceptance sections for native evidence, Gmail, outreach,
compliance, and tracking. Preserve the local security/restart-safe sections.
Use these headings:

```markdown
## Local Sprint 48 — Safe fetch and tenant isolation
## Remote Sprint 48 — Outreach sequences
## Local Sprint 49 — Bounded leased execution
## Remote Sprint 49 — Reply actions and compliance
```

- [ ] **Step 5: Regenerate the final lockfile and test UI/contracts**

Stage the resolved UI, environment, manifests, and documentation and finish
the source replay before running tests:

```bash
git add .env.example README.md CLAUDE.md package.json package-lock.json \
  apps/api/package.json apps/worker/package.json vitest.config.ts \
  apps/web packages/contracts docs
if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then
  git cherry-pick --continue
fi
```

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
npm test -- \
  apps/web/lib/discovery-matching-state.test.ts \
  packages/contracts/test/contracts.test.ts \
  packages/contracts/test/outbound-email.test.ts \
  apps/api/test/outreach.test.ts \
  apps/api/test/outreach-replies.test.ts \
  apps/api/test/outreach-tracking.test.ts
npm run typecheck -w apps/web
npm run typecheck -w packages/contracts
```

Run the retirement scan:

```bash
rg -n "r2r:up|r2r:down|R2REvidenceStore|evidence/r2r" \
  package.json apps README.md CLAUDE.md .env.example
```

Expected: no active runtime/script references.

- [ ] **Step 6: Record and complete**

Mark `555350d` replayed, record the documentation/lockfile SHA, and move the
Plane child to `Done`.

---

### Task 11: Run cross-history automated acceptance

**Files:**

- Create by replay:
  `apps/api/test/sprint49-acceptance.test.ts`
- Modify: `apps/api/test/sprint49-acceptance.test.ts`
- Modify: `docs/founder-acceptance-tests.md`
- Modify: `docs/specs/sprint-49-bounded-leased-job-execution.md`
- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`

**Interfaces:**

- Proves local restart safety on the final remote-derived schema.
- Proves the acceptance runtime uses `DbEvidenceStore`, not an evidence fake or
  R2R.
- Runs the remote Gmail/outreach/compliance/tracking suites in the same
  acceptance gate.

- [ ] **Step 1: Start the Plane task and replay the acceptance commit**

Move `Run cross-history acceptance` to `In Progress`.

Run:

```bash
git cherry-pick 5c712c9
```

Resolve `docs/founder-acceptance-tests.md` using the four unambiguous headings
from Task 10.

Stage the resolved acceptance documents and finish the source replay:

```bash
git add apps/api/test/sprint49-acceptance.test.ts \
  docs/founder-acceptance-tests.md \
  docs/specs/sprint-49-bounded-leased-job-execution.md
if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then
  git cherry-pick --continue
fi
```

- [ ] **Step 2: Make the restart acceptance use native evidence**

Remove the `noEvidence` fake. Import:

```ts
import {
  DbEvidenceStore,
  EVIDENCE_EMBEDDING_DIMENSIONS,
} from "../src/evidence/db-store";
```

Extend the fixture gateway:

```ts
async embed({ texts }) {
  return {
    embeddings: texts.map(() =>
      Array.from(
        { length: EVIDENCE_EMBEDDING_DIMENSIONS },
        (_, index) => (index === 0 ? 1 : 0),
      ),
    ),
    model: "fixture-embedding",
    provider: "fixture",
    dimensions: EVIDENCE_EMBEDDING_DIMENSIONS,
  };
},
```

Construct each app with its database-bound native store:

```ts
appA = await buildApp({
  db: dbA,
  llm,
  evidence: new DbEvidenceStore(dbA, llm),
  // existing fixture connectors/policy/identity
});

appB = await buildApp({
  db: dbB,
  llm,
  evidence: new DbEvidenceStore(dbB, llm),
  // existing fixture connectors/policy/identity
});
```

After workspace creation, ingest and resolve evidence:

```ts
const evidenceUpload = await userA.inject({
  method: "POST",
  url: `/workspaces/${workspaceId}/evidence`,
  payload: {
    title: "Restart-safe operations",
    content:
      "Tuezday uses fenced leases and durable checkpoints for reliable GTM automation.",
  },
});
expect(evidenceUpload.statusCode, evidenceUpload.body).toBe(201);
expect(evidenceUpload.json()).toMatchObject({ status: "ready" });

const resolved = await userA.inject({
  method: "POST",
  url: `/workspaces/${workspaceId}/resolve`,
  payload: {
    taskType: "linkedin_post",
    channel: "linkedin",
    useEvidence: true,
  },
});
expect(resolved.statusCode, resolved.body).toBe(200);
expect(
  resolved.json().sections.find(
    (section: { key: string }) => section.key === "evidence",
  ),
).toMatchObject({ included: true });
```

- [ ] **Step 3: Run the combined acceptance command**

Run:

```bash
npm test -- \
  apps/api/test/sprint49-acceptance.test.ts \
  apps/api/test/sprint49-migrations.test.ts \
  apps/api/test/evidence.test.ts \
  apps/api/test/db-evidence-store.test.ts \
  apps/api/test/mailboxes.test.ts \
  apps/api/test/outreach.test.ts \
  apps/api/test/outreach-replies.test.ts \
  apps/api/test/outreach-tracking.test.ts \
  apps/api/test/internal-tasks.test.ts \
  apps/worker/test/config.test.ts \
  apps/worker/test/scheduler.test.ts
```

Expected:

- restart resumes from persisted per-target cursors;
- the stale API instance receives `lease_lost`;
- overlapping discovery and automation are busy rather than duplicated;
- exactly one automatic draft exists;
- native evidence is ready and included without R2R;
- Gmail send/reply privacy tests pass;
- outreach stop, compliance, suppression, and tracking tests pass;
- worker loops do not overlap themselves.

- [ ] **Step 4: Run focused typecheck and commit**

Run:

```bash
npm run typecheck -w apps/api
npm run typecheck -w apps/worker
git add apps/api/test/sprint49-acceptance.test.ts \
  docs/founder-acceptance-tests.md \
  docs/specs/sprint-49-bounded-leased-job-execution.md \
  docs/integration/2026-07-29-divergent-main-ledger.md
git commit -m "test: prove cross-history integration acceptance" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Mark `5c712c9` replayed. Move the Plane child to `Done` with exact test counts.

---

### Task 12: Verify, review, and publish the integration branch

**Files:**

- Modify: `docs/integration/2026-07-29-divergent-main-ledger.md`
- No product changes unless verification exposes a specific defect.

**Interfaces:**

- Produces the final audit trail, review result, GitHub branch, and pull
  request.
- Does not merge `main`.

- [ ] **Step 1: Start the Plane task and audit commit disposition**

Move `Verify, review, and publish the integration branch` to `In Progress`.

Run:

```bash
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff --check
```

In the ledger, confirm 28 local non-merge commits are marked `replayed` and
`48a47c6` is marked `superseded by integration branch`.

- [ ] **Step 2: Audit the canonical migration chain**

Run:

```bash
ls apps/api/drizzle/00*.sql | sort | tail -n 12
tail -n 80 apps/api/drizzle/meta/_journal.json
npm test -- apps/api/test/sprint49-migrations.test.ts
```

Expected tail:

```text
0048_oval_ben_urich.sql
0049_goofy_xorn.sql
0050_goofy_mother_askani.sql
0051_mute_madripoor.sql
0052_clever_doctor_doom.sql
0053_sprint_49_leases.sql
0054_sprint_49_automation_idempotency.sql
0055_sprint_49_matching_state.sql
```

No local-numbered Sprint 49 SQL file may remain under `0048`–`0050`.

- [ ] **Step 3: Run repository-wide verification**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Expected: all commands exit `0`; record exact test files/tests and build
outputs in the ledger.

- [ ] **Step 4: Run desktop acceptance**

In terminal/session A:

```bash
TUEZDAY_WORKER_TOKEN=desktop-integration-test-token npm run dev:app
```

Wait until:

```text
http://127.0.0.1:3001/health returns 200
http://127.0.0.1:3000 returns a page
```

In terminal/session B:

```bash
npm run test:desktop
```

Expected: all Playwright desktop tests pass. Stop session A gracefully with
`SIGINT`. If Chromium is missing, install only the required browser with:

```bash
npx playwright install chromium
```

Then rerun; do not convert a product failure into a skip.

- [ ] **Step 5: Request code review**

Use the `requesting-code-review` skill. The reviewer must inspect:

- migration numbering, snapshots, and fresh install;
- `app.ts`, `server.ts`, auth, gateway, schema, and worker composition;
- remote feature preservation;
- local security/restart guarantees;
- test gaps and silent auto-merge risks.

Resolve every P0/P1 finding and rerun affected gates. Record accepted lower
severity findings and decisions in the ledger.

- [ ] **Step 6: Commit the final ledger**

Run:

```bash
git add docs/integration/2026-07-29-divergent-main-ledger.md
git commit -m "docs: record divergent main integration verification" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git status --short
```

Expected: clean status.

- [ ] **Step 7: Push only the integration branch and open a PR**

Run:

```bash
git push -u origin integration/remote-main-local-s48-s49
```

Open a pull request targeting `main` with:

```markdown
## Summary

- preserves remote native evidence, Gmail, outreach, compliance, and tracking
- replays local safe-fetch, tenant isolation, leases, bounds, cursors,
  idempotency, and restart safety
- regenerates local persistence as canonical migrations 0053–0055
- moves every background task onto the managed worker scheduler

## Sources

- Remote baseline: `a2b55231ebe38b9491151cd92928b521d22fed76`
- Local source: `48a47c6800d1a77b176ad2e4d126fa2bf5b0af00`
- Common ancestor: `cb18bf1494eac4a111ca4376f7293d38419effcc`

## Verification

Copy exact typecheck, test, build, desktop, migration, and review results from
`docs/integration/2026-07-29-divergent-main-ledger.md`.

## Founder gate

Do not merge until GitHub Actions is green and founder acceptance is recorded.
```

- [ ] **Step 8: Complete child status and hold the parent gate**

After GitHub Actions passes, move `Verify, review, and publish the integration
branch` to `Done` with the PR URL and CI run. Keep the integration parent
`In Progress` until the founder accepts the PR. Do not merge it automatically.
