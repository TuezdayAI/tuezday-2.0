# Sprint 79 — Background agents & delegation

**Branch:** `sprint-79-background-agents` (forked from `sprint-74-postgres-migration` @ `7ce9181`)
**PRD:** `docs/plans/prd-agentic-platform.md` §10, "Sprint 79 — Background agents & delegation"
**Direction doc:** Move 9c — "spin up agents"
**Size:** XL · **Risk:** High · **Depends on:** 78 (chat that acts), 70 (ask lane + inbox), 73 (durable queue)

**Merge order.** Sprint 79's three stated dependencies are already on `main` (70, 71, 73, 75, 76,
77, 78 all landed via PRs #32 and #33). The one thing *not* on `main` is Sprint 74 — the Postgres
migration — and this branch forks it, by founder decision (D-79.0). So:

> **74 → 79.** Accept and merge `sprint-74-postgres-migration` first. This branch's migration is
> `0079_*`, generated against the Postgres dialect, and it will not apply to a SQLite `main`.

---

## 0. What this sprint is, and what it is not

### 0.1 The problem in one paragraph

Everything the platform can do, it currently does inside a request. A chat turn is bounded at 8
steps, 32k tokens and 120 seconds (`CHAT_TURN_BOUNDS`), because a founder staring at a spinner
will not wait longer, and an HTTP connection should not be asked to. But the work the founder
actually wants — *"research what our top three competitors shipped this quarter and draft a
positioning post"* — is minutes of work across dozens of tool calls and several distinct lines of
enquiry. Today the honest answer is "that doesn't fit in a turn," and the dishonest answer is a
turn that runs out of steps and apologises. This sprint makes the work outlive the request.

### 0.2 The one-sentence invariant

**A background agent is the same runner, the same registry, the same propose gate and the same
approval queue — moved onto the durable queue and given an identity a human can watch, steer and
stop.** No new tool tier, no new write path, no second agent stack. Everything this sprint adds is
*lifecycle*: durability, delegation, interruption, and a place for the result to land.

### 0.3 What it is not

- **Not a scheduler.** Standing agents that fire on a trigger are Sprint 80, and they compile to
  Sprint 64 pipeline definitions. Sprint 79 is one-off, founder-initiated work only.
- **Not an autonomy expansion.** A background run's writes are still `propose`-class, still
  recorded rather than executed, still confirmed by a person. A detached run that "drafts a
  positioning post" lands a *proposal* the founder confirms — exactly as an attached chat turn
  does (D-78.1). The one thing that changes is *where* the confirmation card appears.
- **Not resumable-after-crash.** See D-79.9. A run that loses its lease fails visibly rather than
  silently costing the founder twice.

---

## 1. Problem

Four concrete failures the founder can reproduce on `main` today:

1. **The multi-step ask dies at step 8.** Ask the drawer to research three competitors and draft
   a post. It reads two of them, hits `max_steps`, and says *"I ran out of steps before finishing
   this one."* The founder pays for seven steps of work and receives none of it.
2. **The thread is blocked while it thinks.** `POST .../messages` holds the connection for the
   whole turn. A two-minute turn is a two-minute-dead drawer.
3. **Context economy is unmanaged.** Every tool result a chat turn reads stays in the transcript
   at full size for every subsequent step. Four `search_evidence` calls and the model is reasoning
   over 30k tokens of raw excerpts, most of which it settled two steps ago.
4. **Nothing can be stopped.** `AgentRunner` has bounds but no cancel. If a run goes wrong, the
   founder waits for a bound to trip.

---

## 2. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | **Agent tasks** — a durable, detached unit of agent work with a readable lifecycle | `agent_tasks`, `services/agent-tasks.ts` |
| 2 | **Execution on the Sprint 73 queue**, with an `agent` lane so long runs cannot starve the recurring ticks | `background_jobs` kind `agent_task`, `claimBackgroundJobs` lane change |
| 3 | **Subagent delegation** — bounded, read-only workers returning distilled structured summaries, rendered as children in the Inspector | `agents/subagents.ts`, `agents/tools/delegate.ts`, `agent_runs.parent_run_id` |
| 4 | **Interrupt, steer, cancel** — a mid-flight message injected at the next step boundary; cancellation that is immediate and leaves a clean partial trace | `agent_task_messages`, `AgentRunner` abort signal |
| 5 | **Per-workspace concurrency cap + budget warning** before a run that would breach the Sprint 59 cap | `AGENT_TASKS_PER_WORKSPACE`, `services/entitlements.ts` |
| 6 | **Questions resume the run** — an `ask_founder` from a background run appears in the Sprint 70 ask lane *and* inline in the thread; answering either resumes | `agent_questions.agent_task_id` |
| 7 | **The result lands twice** — an assistant message in the originating thread, and an `agent_task_result` item in the Sprint 70 inbox | `services/chat.ts`, `services/agent-inbox.ts` |
| 8 | **Live progress** — SSE over the task's steps and children, so a detached run is watchable | `GET .../agent-tasks/:taskId/stream` |
| 9 | **The drawer surface** — detach control, live task panel, subagent tree, steer box, cancel button | `apps/web/src/components/copilot/`, `apps/web/lib/agent-task-view.ts` |

---

## 3. Founder decisions taken in this spec

**D-79.0 — Fork Sprint 74, not `main`.** *(Founder, this session.)* Sprint 79's stated dependencies
are all on `main`, so the workflow's letter says fork `main`. But 79 adds four schema objects, and
`main` is still SQLite while 74 — built, unmerged, and the founder's working checkout — is
Postgres. Authoring these tables in SQLite and re-authoring them when 74 lands is pure waste, and
74 already contains every dependency 79 names. Cost, stated plainly: **79 cannot merge until 74 is
accepted.**

**D-79.1 — The unit is an `agent_task`, not an `agent_run`.** `agent_runs` is a *trace*: it has no
queue, no cancel, no resume, no owner, and it is subject to retention sweeps. A detached unit of
work needs an identity that outlives any single run — because a task that asks a question and
resumes is two runs, and a task that is steered is still one thing the founder is watching. So a
new table, and `agent_task.agent_run_id` points at the *current* run.

**D-79.2 — Execution rides Sprint 73's queue, in its own lane.** New `BackgroundJobKind`
`"agent_task"`. Leases, heartbeats, fair per-workspace dispatch, dead-lettering and the operator
routes come for free. **But** 73's `perWorkspaceConcurrency` (default 1) counts *all* running jobs
in a workspace, so a five-minute agent task would block that workspace's publish and discovery
ticks for five minutes. Sprint 79 therefore adds a **lane** to the claim function: `agent_task`
counts against a separate per-workspace budget from the thirteen maintenance kinds. This is a
seven-line change to `claimBackgroundJobs` and it is the only change this sprint makes to Sprint
73's code.

**D-79.3 — Detaching is explicit, never inferred.** The model does not get a "run this in the
background" tool. A founder detaches by pressing the button or typing `/background <request>`.
Reason: detaching commits real money to a run nobody is watching, and a model that decides when to
spend it is a model deciding the founder's budget. The button is also the honest UI — the founder
sees the cost warning *before* the run starts, which is what the PRD's "warn before starting a run
that would breach the cap" actually requires.

**D-79.4 — Subagents get read tools only, and cannot delegate.** A subagent has no `proposals`, no
`questions` and no `delegate` in its `ToolContext`, so those tools cannot be *constructed* for it —
the same two-lock pattern `chat-turn.ts` uses for the write boundary (D-78.3). Consequences worth
stating: only the orchestrator can propose, so every write in a background task passes through one
place; only the orchestrator can ask, so a founder never gets four near-identical questions from
four workers; and delegation cannot recurse, so the cost of a task is bounded by arithmetic rather
than by hope.

**D-79.5 — A subagent returns a distilled summary, enforced by a schema.** The delegate tool runs
its worker with a `responseSchema` requiring `{ summary, findings[], confidence, gaps }`, with
`summary` bounded at 1,200 characters and at most 8 findings. The orchestrator's transcript
therefore grows by a few hundred tokens per delegation instead of by the worker's whole
transcript. This is the context-economy pattern the PRD asks for, and making it a schema rather
than a prompt instruction is the difference between a property and a hope. The worker's full trace
is not lost — it is an `agent_run` with `parent_run_id` set, and the Inspector renders it.

**D-79.6 — A fixed catalogue of four subagent roles.** `research`, `competitor_scan`,
`variant_generation`, `metrics_review`. Each declares its own system fragment, tool subset and
bounds. A free-form "spawn an agent that does X" would be a second, unreviewable prompt surface
inside a sprint whose whole point is governance; four named roles are inspectable, individually
tunable, and enough for the PRD's acceptance test. Adding a fifth is a one-object change.

**D-79.7 — Steering is injected at the next step boundary, never mid-step.** A message arriving
while the model is generating cannot be applied to that generation, and applying it *after* the
tool calls of that step would leave the model reacting to results it was told to stop caring
about. So: the executor drains unconsumed steer messages at each `step_end`, appends them as user
turns, and marks them consumed with the step index that consumed them. A steer that arrives after
the run finished is refused with a clear reason rather than silently dropped.

**D-79.8 — Cancel is immediate and leaves a partial trace.** `AgentRunner` gains an optional
`signal: AbortSignal`. Aborting mid-step aborts the in-flight model call; the run terminates with
the new stop reason `cancelled`, every step persisted up to that point stays, and the task's
partial output text is kept and shown. "An agent you cannot stop is an agent nobody will start."
A cancel on a task still `queued` cancels the queue row too, so it never starts.

**D-79.9 — `maxAttempts: 1`. A crashed task fails; it does not silently re-run.** Sprint 73
recovers a crashed process by reclaiming the expired lease and incrementing `attempt`. For a
recurring tick that is exactly right. For an agent task it would silently spend the founder's
budget a second time on work they can no longer see the first half of. So an agent task gets one
attempt, a lost lease resolves the task as `failed` with `lease_lost`, and the founder gets an
explicit **Retry** that creates a *new* task. Visible, cheap, and their decision.

**D-79.10 — The working transcript is persisted on the task.** A task that suspends on a question
and resumes on the answer must continue from where it stopped, not re-derive it. `AgentRunner`
already returns the full `messages`; the executor writes them to `agent_tasks.transcript_json`
(bounded at 120k characters, oldest tool results dropped first) and the next attempt starts from
them plus the answer. This is why resume is exact rather than a summary of a summary.

**D-79.11 — The result lands in the thread *and* the inbox, and the inbox item is a projection.**
Sprint 70's inbox is a ranked projection over live tables, not a table of its own (that is the
whole point of its "one comparator" design). So `agent_task_result` is a new
`AgentInboxItemKind` projected from `agent_tasks` where the task is terminal and
`acknowledged_at IS NULL`. Lane: `notify` — the task finishing is a statement of fact; any
*decision* it produced is already an `authorization` or `content_review` item in its own right.

**D-79.12 — Progress streams by polling the database, not an in-process bus.** The API may run as
several processes and the executor may be in any of them, so an `EventEmitter` would work in dev
and silently fail in production. The stream endpoint polls the task row and `agent_run_steps`
every second and emits the delta. It is boring, it is correct across processes, and it is
testable without a live server.

---

## 4. Design

### 4.1 The lifecycle

```
                    ┌──────────────────────────── steer / answer ──────────┐
                    ▼                                                      │
  create ──▶ queued ──▶ running ──┬──▶ succeeded                           │
                │         │       ├──▶ failed                              │
                │         │       ├──▶ cancelled                           │
                │         │       └──▶ awaiting_answer ─── answered ───────┘
                │         │
                └── cancel┴─────────▶ cancelled
```

`AGENT_TASK_STATUSES = ["queued", "running", "awaiting_answer", "succeeded", "failed", "cancelled"]`.
Terminal: `succeeded | failed | cancelled`. Only terminal tasks produce an inbox item; only
non-terminal tasks count against the concurrency cap.

### 4.2 The four blocks

**`services/agent-tasks.ts`** — the durable half. Create (with cap + budget checks), read, list,
steer, cancel, acknowledge, and the transcript accessors. Leaf-ish: drizzle, contracts,
`services/chat.ts` for the thread write-back, `entitlements.ts` for the budget. It never imports
the runner — recording a steer and *applying* one are separate concerns, exactly as Sprint 70
separated recording an answer from resuming a run (D-70.7).

**`services/agent-task-executor.ts`** — the moving half. Given a claimed job it: loads the task,
resolves the thread's context bundle (the same `buildChatContext` a chat turn uses, so a
background run is not a different agent with a different prompt), assembles tools, runs the loop
with a step-boundary hook that heartbeats the lease / drains steers / checks cancellation, then
resolves the task and writes back to the thread.

**`agents/subagents.ts` + `agents/tools/delegate.ts`** — the delegation seam. The catalogue is
data; the tool is thin. Like the propose and ask tools, `delegate` takes an injected service
(`SubagentService`) rather than importing the runner, because `agents/tools/index.ts` builds
`TOOLS_BY_NAME` at module load and anything reachable from it must stay a leaf.

**`routes/agent-tasks.ts`** — thin adapters. Nine routes, all validating with a contracts schema
and calling a service.

### 4.3 Bounds

```ts
AGENT_TASK_BOUNDS  = { maxSteps: 40, maxTokens: 400_000, timeoutMs: 900_000 }   // 15 min
SUBAGENT_BOUNDS    = { maxSteps: 8,  maxTokens: 60_000,  timeoutMs: 180_000 }   // 3 min
AGENT_TASK_TOOL_BUDGET = { maxCalls: 60, perTool: { safe_fetch_url: 8, delegate: 4 },
                           maxProposals: AGENT_PROPOSALS_PER_RUN }
AGENT_TASKS_PER_WORKSPACE = 2      // concurrent, queued + running + awaiting_answer
AGENT_TASK_STEERS_PER_TASK = 10
AGENT_TASK_SUBAGENTS_PER_TASK = 4  // hard counter, belt to the perTool braces
```

Worst-case cost of one task is therefore arithmetic, not a guess: 400k orchestrator tokens plus
4 × 60k subagent tokens. The budget warning at creation uses that number.

### 4.4 The queue lane

`claimBackgroundJobs` currently counts live jobs per workspace and compares against a single
`perWorkspaceLimit`. It becomes a count per `(workspace, lane)` against a per-lane limit, where
`laneForJobKind(kind)` returns `"agent"` for `agent_task` and `"maintenance"` for everything else.
Policy gains `perWorkspaceAgentConcurrency` (env `BACKGROUND_JOB_PER_WORKSPACE_AGENT`, default 2).
Nothing else about 73 changes: the fairness ordering, the lease CAS, the dispatch table and the
candidate scan are untouched, and a workspace with no agent tasks behaves exactly as before.

### 4.5 API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workspaces/:id/agent-tasks` | Create a task (optionally bound to a chat session). 402 over budget, 409 at the cap. |
| `GET` | `/workspaces/:id/agent-tasks` | List, newest first, optional status filter. |
| `GET` | `/workspaces/:id/agent-tasks/:taskId` | Detail: task, steps, subagent runs, steer messages, proposals. |
| `GET` | `/workspaces/:id/agent-tasks/:taskId/stream` | SSE progress (D-79.12). |
| `POST` | `/workspaces/:id/agent-tasks/:taskId/messages` | Steer. |
| `POST` | `/workspaces/:id/agent-tasks/:taskId/cancel` | Cancel. |
| `POST` | `/workspaces/:id/agent-tasks/:taskId/retry` | Create a new task from a terminal one. |
| `POST` | `/workspaces/:id/agent-tasks/:taskId/acknowledge` | Clear it from the inbox. |
| `POST` | `/workspaces/:id/chat/sessions/:sessionId/detach` | Detach a request from a thread. |

### 4.6 Schema

```
agent_tasks
  id, workspace_id, session_id?, user_id?, created_by,
  request (text), title, status, agent_run_id?, job_id?,
  transcript_json?, output_text?, stop_reason?, error?,
  subagent_count, steer_count, step_count,
  input_tokens, output_tokens, cost_cents,
  cancel_requested_at?, acknowledged_at?,
  created_at, started_at?, finished_at?, updated_at
  idx (workspace_id, created_at), idx (workspace_id, status), idx (session_id, created_at)

agent_task_messages
  id, task_id, workspace_id, role ("steer"), content,
  consumed_at?, consumed_at_step?, created_at
  idx (task_id, created_at)

agent_runs        + parent_run_id (nullable, self-FK, indexed)
agent_questions   + agent_task_id (nullable, indexed)
```

---

## 5. Step plan

1. **Contracts.** Statuses, schemas, bounds, caps, subagent roles, the `agent_task` job kind and
   payload, the `cancelled` stop reason, the `agent_task_result` inbox kind, the task stream
   events, the `detach` input.
2. **Schema + migration** (`0079_sprint_79_background_agents`).
3. **Runner.** Optional `signal` and `parentRunId`; the `cancelled` stop reason; an
   `onStepBoundary` async hook the executor uses to heartbeat / steer / cancel.
4. **Subagents.** Catalogue, `SubagentService`, `delegate` tool, registry wiring.
5. **Agent task service.** Lifecycle, caps, budget projection, steering, cancel, transcript.
6. **Executor.** The loop, resume, thread write-back.
7. **Queue lane + handler wiring** in the composition root.
8. **Routes + shared SSE helper** (extracted from `routes/chat.ts`).
9. **Inbox projection + question resume.**
10. **Web.** View models with tests, then the drawer.
11. **Tests green, typecheck, push.**

---

## 6. Tests

New suites: `agent-tasks.test.ts` (lifecycle, caps, steering, cancel, retry), `agent-task-executor.test.ts`
(run → succeed, question → suspend → answer → resume, steer injection, cancellation mid-run,
lease-lost → failed), `subagents.test.ts` (distillation schema enforced, read-only context, no
recursion, per-task cap), `agent-task-routes.test.ts` (auth, 402/409, SSE frames), plus additions
to the queue, inbox and runner suites. Web: `agent-task-view.test.ts`.

The acceptance test from the PRD is written as an end-to-end test with a scripted gateway:
*research three competitors → delegate → ask one question → resume on the answer → propose a
draft → land in thread and inbox.*

---

## 7. Acceptance

"Research what our top 3 competitors shipped this quarter and draft a positioning post" detaches,
runs research subagents, asks one clarifying question, resumes on the answer, and lands a proposed
draft in both the thread and the inbox. Cancel stops it within a step. A second concurrent task is
allowed; a third is refused with the cap named.

---

## 8. Progress log

**All eleven steps landed. `npm test` and `npm run typecheck` are green.**

1. **Contracts** — done. `AGENT_TASK_STATUSES`, the bounds/caps block, `subagentReportSchema`,
   `agentTaskSchema` / `agentTaskDetailSchema`, the create/detach/steer inputs, the seven stream
   events, `SUBAGENT_ROLES`, `toolInputSchemas.delegate`. `agent_task` joined
   `BACKGROUND_JOB_KINDS`; `BACKGROUND_RECURRING_JOB_KINDS` is the new derived list every
   "everything except the event-shaped kinds" loop uses, which is what kept the queue's own
   handler table honest when a second event-shaped kind appeared. `AGENT_STOP_REASONS` gained
   `cancelled`, `AGENT_STEP_KINDS` gained `steer`, `AGENT_INBOX_ITEM_KINDS` gained
   `agent_task_result`.
2. **Schema + migration** — done as `0001_sprint_79_background_agents` (this branch forked Sprint
   74's Postgres baseline, so it is migration 1, not 79). `agent_tasks`, `agent_task_messages`,
   `agent_runs.parent_run_id`, `agent_questions.agent_task_id`, `chat_messages.agent_task_id`,
   `chat_proposals.agent_task_id`, and `chat_proposals.session_id` made nullable.
3. **Runner** — done. `signal`, `parentRunId`, and the `onStepBoundary` hook, which is where the
   heartbeat, the steer drain and the cancel check all ride. Signals are merged by hand
   (`deadlineSignal`) rather than with `AbortSignal.any`, so the listener is removed when the step
   ends — a fifteen-minute run makes forty of these and a leak would be forty live listeners on
   one long-lived signal.
4. **Subagents** — done. Four roles, each a read-tool allowlist plus a system fragment;
   `createSubagentService` holds the per-task counter; the report is enforced as the run's
   `responseSchema`, and a report that does not validate is a *failed worker*, not a soft result
   the orchestrator quotes as fact.
5. **Agent task service** — done, including `boundTranscript` (oldest tool results dropped first,
   never the request, never the last three) and the accumulate-by-SQL usage write, which is what
   makes a resumed task's cost the sum of its attempts rather than the last one.
6. **Executor** — done. `runAgentTask` is the testable unit; the queue handler and the routes are
   both thin over it. A task with no thread resolves its context against a scopeless stand-in
   session rather than an empty system prompt.
7. **Queue lane** — done. `claimBackgroundJobs` counts running jobs per *(workspace, lane)*, with
   `agent_task` its own lane. Without it a fifteen-minute agent task holds the workspace's single
   concurrency slot and its publish and discovery ticks stop dead — this is the change most worth
   re-reading, because the bug it prevents would have looked like "discovery is broken".
   Fairness ordering, lease CAS and the candidate scan are untouched.
8. **Routes + SSE** — done. The SSE mechanics moved to `routes/sse.ts` (nothing about them was
   chat-specific) and the web reader to `lib/sse-stream.ts`, which is schema-agnostic. Its
   `EventDecoder` is structural rather than `ZodType<E>`: zod's generic is invariant in its input
   type, so any defaulted field makes `ZodType<Output>` refuse to unify.
9. **Inbox + resume** — done. A terminal, unacknowledged task is an inbox item; acknowledging is
   what clears it, so there is no second table to keep in step. Answering a question with
   `resume: true` re-queues the task and the answer comes back as `resumedTask`.
10. **Web** — done. `lib/agent-task-view.ts` + 26 tests hold the copy and the state folding; the
    drawer gained a detach button, a live panel (status, worker tree, activity), a steer box and
    a stop button.
11. **Tests** — `agent-tasks.test.ts` (26, including the §7 acceptance case end to end),
    `agent-task-routes.test.ts` (19), plus additions to the runner, queue and contracts suites,
    and `agent-task-view.test.ts` (26) on the web side.

### Things a reviewer should push on

- **`AGENT_TASK_MAX_COST_CENTS` is a stated worst case, not a measured one.** It is arithmetic
  over the bounds at frontier-tier rates. If the real number is wildly different once a few tasks
  have run, the warning is either noise or false comfort — check it against `/billing` before
  trusting it.
- **The progress stream polls once a second and holds for at most five minutes.** That is a
  deliberately dumb transport (D-79.12) chosen because the executor runs in whichever process
  claimed the job. It is fine for one founder watching one task and would not be fine for fifty.
- **`maxAttempts: 1` means a deploy mid-task fails that task** (`lease_lost`, with copy that says
  so and offers Retry). The alternative — automatic retry — silently spends the budget twice on
  work nobody watched. The trade is deliberate but it is a trade.
- **Subagent context is a fresh brief, not a slice of the parent's transcript.** A worker given a
  brief that assumes context it cannot see will produce confident nonsense. The tool description
  says this loudly; whether the model obeys it is worth watching in the first real runs.
