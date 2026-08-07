# Production Runbook

> Operational reference for the processes, secrets, and recovery behavior introduced or hardened by
> Sprint 75. It covers what an operator needs to deploy the isolated renderer, reason about
> account-local posting budgets, use the emergency stop, and understand a publication that is waiting
> on a provider. It does not describe approval or external-action policy, which are unchanged.

## 1. Processes

Four processes make up a complete deployment. All four are required in production; `npm run dev`
starts them together locally.

| Process | Workspace | Default port | Required | Owns |
|---|---|---:|---|---|
| Renderer | `apps/renderer` | 7457 | yes (image rendering) | Chromium, deterministic PNG rendering |
| API | `apps/api` | 3001 | yes | database, leases, task identity, all business logic |
| Web | `apps/web` | 3000 | yes | dashboard |
| Worker | `apps/worker` | — | yes | validated, non-overlapping background loops |

The API no longer launches or bundles a browser. It reaches the renderer over HTTP through an
injected `render` function, so a renderer outage degrades image generation only — it cannot stall or
crash the API process.

## 2. Renderer service

### Configuration

| Variable | Where | Default | Bounds |
|---|---|---:|---|
| `TUEZDAY_RENDERER_URL` | API | `http://127.0.0.1:7457` | HTTPS required outside loopback |
| `TUEZDAY_RENDERER_TOKEN` | API **and** renderer | none — required | must match on both processes |
| `TUEZDAY_RENDERER_TIMEOUT_MS` | API | 20000 | keep above `RENDER_TIMEOUT_MS` |
| `RENDER_MAX_CONCURRENCY` | renderer | 2 | 1–32 concurrent pages |
| `RENDER_TIMEOUT_MS` | renderer | 15000 | 1000–120000 ms |
| `PORT` | renderer | 7457 | 1–65535 |
| `RENDER_HOST` | renderer | loopback | bind address |

`TUEZDAY_RENDERER_TOKEN` is a **dedicated** shared secret. Never reuse `TUEZDAY_WORKER_TOKEN`, a
user session token, or an API key. The renderer starts only if the token is present (outside
`NODE_ENV=test`), and rejects an invalid or out-of-range concurrency/timeout at startup rather than
serving degraded traffic.

### Surface

- `GET /health` — public, no browser allocation. Chromium launches lazily on the first render, so
  health checks and rolling restarts stay cheap.
- `POST /render` — bearer-authenticated, returns `image/png`.

### Isolation guarantees

Rendered pages block **all** network requests and run with JavaScript disabled. Template HTML/CSS,
placeholder count and value sizes, output dimensions, response size, page concurrency, and render
duration are all bounded by the shared contract in `packages/contracts`. Pages are closed in a
`finally` block, and `close()` shuts the browser down on service shutdown.

### Failure behavior

| Condition | Renderer response | API result |
|---|---|---|
| Missing/wrong token | 401 `unauthorized` | render fails; no draft created |
| Invalid request | 400 `invalid_render_request` | render fails; no draft created |
| Exceeded time limit | 504 `render_timeout` | render fails; no draft created |
| Browser/page failure | 503 `render_failed` | render fails; no draft created |

The API side validates the response independently: `TUEZDAY_RENDERER_URL` must be HTTPS unless it is
loopback, the response must advertise a PNG content type, and the body must carry a real PNG
signature within a 20 MB ceiling. A malformed or oversized response is an
`invalid_renderer_response`, not an image.

A render failure never creates a carousel or ad-image draft and never consumes generation credit;
existing transaction ordering is preserved. Deploy the renderer on an internal network — it needs no
public ingress.

## 3. Account-local posting budgets

Every social connection carries an editable IANA timezone, editable per account on the Integrations
page. Connections that existed before Sprint 75 default to `UTC`, so behavior is unchanged until an
operator chooses a zone.

Post, campaign, reply, and X-DM guardrails count usage inside the **destination account's** civil
day, resolved through a Temporal-backed helper — not the server's day and not the cadence's day. DST
produces honest 23- and 25-hour windows.

Two independent caps live in workspace automation settings (Automation → guardrails):

| Cap | Counts | Default |
|---|---|---:|
| Per-connection daily cap | posts and DMs on that connection | existing value |
| Per-connection reply daily cap | automated replies only | 10 |

Before Sprint 75 replies and publications shared one UTC-day counter. They are now separate budgets;
the agent guardrail tool reports both.

**Symptom → cause:** if an account stops posting earlier or later than an operator expects, check the
connection's timezone first — the budget boundary follows the account, not the server.

## 4. Emergency stop (kill switch)

The kill switch is re-checked immediately before provider dispatch — the last reversible point in the
publish path. Flipping it on stops a due automated publication even if it was already scheduled and
the runner is mid-flight.

- Automated lineage is identified from the publication's durable external-action payload, with
  cadence/campaign fallback for legacy receipts.
- A stopped attempt performs **zero** provider calls and returns a stable `kill_switch_on` blocked
  outcome.
- The receipt stays retryable — it is **not** marked failed. Lifting the switch publishes that same
  receipt exactly once.
- Manual approved publishing is unaffected by the switch.

The worker logs blocked outcomes per workspace alongside published, processing, and failed counts.

## 5. Publications that are waiting on a provider (`processing`)

`processing` is an honest **nonterminal** publication status: the provider has accepted media but has
not finished preparing it. It is not a success and is never reported as one. It appears in contracts,
execution results, the calendar and content surfaces, and worker logs.

Today only Instagram video/reel publishing uses it.

### Lifecycle

1. First attempt creates the provider container **once** and stores its operation id, the next
   attempt time, the processing start time, and an attempt count.
2. Each due tick performs exactly one status read via the adapter's `finalizePost`. A receipt whose
   `nextAttemptAt` is in the future is skipped with no provider I/O.
3. The container is never recreated. If the provider returns a different operation id while
   finalizing, the attempt fails loudly rather than duplicating a post.
4. When the media is ready, it publishes once and the permalink is read.
5. Provider errors become durable failed receipts with a bounded error message, recoverable through
   the existing retry path.

Retry spacing comes from the provider's requested delay, clamped to 1 second – 1 hour (5 seconds when
the provider gives nothing usable).

### Worker ordering

The publish loop calls `POST /workspaces/:id/external-actions/run` **before**
`POST /workspaces/:id/publish/run`. Action-linked receipts are finalized by the action runner, so a
governing external action reaches `succeeded` only after the media is genuinely published; it stays
`dispatching` while processing. The legacy publication runner handles only receipts with no external
action.

Restarting the API or worker mid-processing is safe: the operation id is persisted, and the next
action run resumes with the same idempotency key.

## 6. Cadence fill

Cadence slot math is Temporal-backed:

- A wall-clock time that does not exist locally (the spring-forward gap) is **skipped** and reported
  as a structured `nonexistent_local_time` issue rather than silently shifted.
- A fall-back overlap produces exactly one occurrence, using the earlier instant.

Every fill candidate is preflighted through the canonical publication preparation. An invalid draft
produces a bounded `publish_validation` issue, creates no action and no receipt, and consumes only
itself — the next eligible draft is tried against the same slot. Issues survive through the route and
the worker log even when zero slots fill, so a fill that produces nothing still explains why.

## 7. Quick checks

```bash
curl -fsS "$TUEZDAY_RENDERER_URL/health"                 # renderer up, no browser allocated
npm run dev                                              # renderer, api, web, worker together
```

- Renderer errors in API logs but a healthy `/health` → check that `TUEZDAY_RENDERER_TOKEN` matches
  on both processes and that `TUEZDAY_RENDERER_TIMEOUT_MS` exceeds `RENDER_TIMEOUT_MS`.
- Publications stuck in `processing` → confirm the worker is running and reaching
  `/external-actions/run`; check the receipt's `nextAttemptAt` before assuming it is stalled.
- Nothing publishing at all → check the workspace kill switch before investigating connectors.
