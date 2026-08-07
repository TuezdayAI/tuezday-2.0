# Tuezday

AI-powered GTM orchestration platform. The product is GTM that remembers: one shared brain (`soul`, `icp`, `voice`, `history`, `now`) that every campaign, channel, and module resolves context from.

Planning docs: `product-strategy-and-positioning.md`, `greenfield-rebuild-plan.md`, `oss-integration-recommendations.md`, `docs/plans/sprint-plan.md`.

## Getting started

```bash
npm install
npm run dev      # renderer :7457, API :3001, web :3000, and the required background worker
npm run dev:app  # API + web only (no automatic background processing)
npm test         # run all tests
npm run typecheck
```

Copy `.env.example` to `.env` and set `TUEZDAY_WORKER_TOKEN` before starting
the complete stack. The API and worker are both required production processes:
the worker runs one validated, non-overlapping queue poll; the API owns durable
schedules, fair admission, database access, leases, retries, and domain work.
Copy `.env.example` to `.env` and set `TUEZDAY_WORKER_TOKEN` and
`TUEZDAY_RENDERER_TOKEN` before starting the complete stack. The renderer, API,
and worker are all required production processes: the renderer owns Chromium and
deterministic PNG rendering, the worker wakes validated, non-overlapping loops,
and the API owns scheduler leases, database access, and discovery/automation
task identity.

`docs/production-runbook.md` is the operator reference — renderer deployment and
failure modes, account-local posting budgets, the emergency stop, and how a
publication waiting on a provider recovers.

## Layout

```
apps/
  web/        # Next.js dashboard (port 3000)
  api/        # Fastify API + services + Drizzle/SQLite (port 3001)
  worker/     # one validated, non-overlapping durable-queue poll
  worker/     # validated, non-overlapping background task loops
  renderer/   # isolated Fastify + Playwright PNG renderer (port 7457)
packages/
  contracts/  # shared zod schemas and types
  testing/    # shared test fixtures
docs/
  plans/ specs/
```

The API stores data in `apps/api/tuezday.db` (SQLite, gitignored). Tests run against in-memory databases with the same checked-in migrations.

Evidence is stored natively in the same SQLite database with FTS5 and
`sqlite-vec`; normal development does not require Docker or an external RAG
service. Existing installations can run `npm run evidence:migrate` once to
import an old R2R corpus, then use
`npm run evidence:parity -- <workspace-id>` before retiring that old service.

Worker traffic uses `TUEZDAY_INTERNAL_API_URL` (HTTPS outside loopback) and
never uses the browser/MCP `TUEZDAY_API_URL`. The public URL may point at the
web/API gateway; the internal URL must point directly at the API process.
`TUEZDAY_WORKER_TOKEN` is shared only by API and worker, authorizes only
`/internal/*` routes, and is not a user, system-session, or general API
credential.

In production, run the API and worker as separate, required processes. The API
owns data, schedules, leases, bounds, and task identity; the worker only calls
`POST /internal/background-jobs/tick` from one settled loop. Restarting either
process is safe: schedules survive, expired leases are reclaimed, and domain
receipts/checkpoints prevent duplicate completed writes.
In production, run the renderer, API, and worker as separate, required
processes. The API owns data, leases, bounds, and task identity; the worker only
wakes settled loops and calls the scoped routes; the renderer owns Chromium
behind its own dedicated `TUEZDAY_RENDERER_TOKEN` and needs no public ingress.
Restarting any of them is safe: expired leases, persisted discovery checkpoints,
and persisted provider operation ids resume work without duplicating completed
writes.

Sprint 73 stores recurring schedules in the application database and runs them
through one durable queue. The worker only wakes the queue; the API owns fair
admission, lease-fenced execution, retry backoff, and dead-letter state.

### Background scheduling

All limits are inclusive and invalid configuration stops API startup. Recurring
schedule intervals are parsed and owned by the API; units are part of each
variable name:

| Variable | Default | Range |
|---|---:|---:|
| `DISCOVERY_INTERVAL_MIN` | 30 | 1–1440 min |
| `AUTOMATION_INTERVAL_MIN` | 5 | 1–1440 min |
| `PIPELINES_INTERVAL_MIN` | 2 | 1–1440 min |
| `PREFERENCES_INTERVAL_MIN` | 10 | 1–1440 min |
| `LEARNING_SYNTHESIS_DAYS` | 7 | 1–365 days |
| `ADS_SYNC_HOURS` | 6 | 1–168 hours |
| `PUBLISH_INTERVAL_MIN` | 1 | 1–1440 min |
| `CADENCE_FILL_INTERVAL_MIN` | 5 | 1–1440 min |
| `INBOX_INTERVAL_MIN` | 5 | 1–1440 min |
| `MAILBOX_INBOX_INTERVAL_MIN` | 5 | 1–1440 min |
| `OUTREACH_INTERVAL_MIN` | 5 | 1–1440 min |
| `SEQUENCE_INTERVAL_MIN` | 5 | 1–1440 min |
| `EVIDENCE_SWEEP_MIN` | 30 | 1–1440 min |

Queue execution policy:

| Variable | Default | Range |
|---|---:|---:|
| `BACKGROUND_JOB_POLL_MS` | 1000 | 250–60000 ms |
| `BACKGROUND_JOB_BATCH_SIZE` | 4 | 1–100 jobs |
| `BACKGROUND_JOB_PER_WORKSPACE` | 1 | 1–100 jobs, not above batch |
| `BACKGROUND_JOB_LEASE_MS` | 300000 | 15000–3600000 ms |
| `BACKGROUND_JOB_HEARTBEAT_MS` | 30000 | 1000–60000 ms |
| `BACKGROUND_JOB_MAX_ATTEMPTS` | 5 | 1–25 attempts |
| `BACKGROUND_JOB_BACKOFF_MS` | 5000 | 100–3600000 ms |
| `BACKGROUND_JOB_MAX_BACKOFF_MS` | 3600000 | 100–604800000 ms |

Heartbeat multiplied by two must be below the lease duration. Base backoff must
not exceed maximum backoff.

### Queue operations

The worker token has no access to workspace or founder routes. From a trusted
operator shell, use it only against the internal API:

```bash
curl -fsS -H "Authorization: Bearer $TUEZDAY_WORKER_TOKEN" \
  "$TUEZDAY_INTERNAL_API_URL/internal/background-jobs/stats"

curl -fsS -H "Authorization: Bearer $TUEZDAY_WORKER_TOKEN" \
  "$TUEZDAY_INTERNAL_API_URL/internal/background-jobs?status=dead_letter&limit=50"

curl -fsS -X POST -H "Authorization: Bearer $TUEZDAY_WORKER_TOKEN" \
  -H "Content-Type: application/json" -d '{}' \
  "$TUEZDAY_INTERNAL_API_URL/internal/background-jobs/JOB_ID/requeue"
```

Requeue preserves the dead-letter row and creates a fresh active job with the
same tenant-scoped idempotency key. Watch `runnable`, `retrying`, `running`,
`deadLetter`, `oldestRunnableAgeMs`, `averageDurationMs`,
`saturatedWorkspaces`, and `byKind` during rollout. Alert on a
steadily growing runnable depth/age, non-zero dead-letter growth, repeated
`lost` transitions, or absent `background_jobs_tick` worker events. Roll back
the worker and API together; the database rows are forward-compatible and no
queue history should be deleted during rollback.

API-side discovery policy:

| Variable | Default | Range |
|---|---:|---:|
| `DISCOVERY_TICK_MAX_JOBS` | 5 | 1–25 |
| `DISCOVERY_TICK_TIMEOUT_MS` | 180000 | 10000–600000 ms |
| `DISCOVERY_SOURCE_TIMEOUT_MS` | 60000 | 5000–180000 ms |
| `DISCOVERY_SOURCE_MAX_ITEMS` | 100 | 1–500 |
| `DISCOVERY_SOURCE_MAX_PAGES` | 4 | 1–20 |
| `DISCOVERY_SOURCE_MAX_CALLS` | 20 | 1–100 |
| `DISCOVERY_RESPONSE_MAX_BYTES` | 2097152 | 65536–8388608 bytes |
| `DISCOVERY_SOURCE_MAX_BYTES` | 10485760 | 262144–33554432 bytes |
| `DISCOVERY_MATCH_MAX_ITEMS` | 20 | 1–100 |
| `DISCOVERY_MATCH_TIMEOUT_MS` | 45000 | 5000–120000 ms |
| `DISCOVERY_LEASE_MS` | 45000 | 15000–300000 ms |
| `DISCOVERY_HEARTBEAT_MS` | 10000 | 2000–60000 ms |

Source and matching timeouts must be below the tick timeout.
`DISCOVERY_HEARTBEAT_MS × 2` must be below `DISCOVERY_LEASE_MS`. The commented
operator block in `.env.example` is copy-ready and contains the same defaults.
