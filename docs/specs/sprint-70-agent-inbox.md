# Sprint 70 — The agent inbox: notify / ask / review

**Branch:** `sprint-70-agent-inbox` (forked from `sprint-69-propose-tools` @ `af24fdf`)
**PRD:** `docs/plans/prd-agentic-platform.md` §8, "Sprint 70 — The agent inbox: notify / ask / review"
**Direction doc:** Move 7(a) — add the ask lane; closes atlas conflict #7 (two ranking engines)
**Plane epic:** TAP-29
**Size:** XL · **Risk:** Medium · **Depends on:** 56 (agent runner), 64 (pipeline definitions & execution engine)

**Merge order.** This branch forks the Sprint 69 branch, which forks 68 → 67 → 66 → 65 → 64
→ 63 → 62 → 61. The founder merges in order:
**61 → 62 → 63 → 64 → 65 → 66 → 67 → 68 → 69 → 70.** Sprint 70's migration is `0076`, which
assumes `0075` (Sprint 69) is already applied.

**On sequencing.** The PRD's recommended execution order inserts Sprint 78 (chat: acting)
between 69 and 70. 78 has not been built, and Sprint 70 does not depend on it — 70's stated
dependencies are 56 and 64, both merged. Building 70 now leaves 76/77/78 as open insertion
points; nothing here forecloses them, and the ask lane is in fact a prerequisite for 79
(background agents), so it is not out of order in any way that costs work.

---

## 1. Problem

**Problem A — the system never asks a question.**

Sprint 69 gave the agent hands. It can research a workspace exhaustively and it can now
propose external actions that the policy tree gates. What it still cannot do is the thing a
competent colleague does first: *say it does not know something and wait.*

Every outcome in the runtime today is one of two shapes. It succeeds — and the founder
finds out by seeing a draft appear. Or it fails — and the founder finds out by seeing an
item in a queue with a failure reason attached. There is no third shape. A step that hits
"the campaign plan does not say whether we may name the investors in a funding-round post"
has exactly two options: guess, or fail. Both are worse than the obvious thing, which is to
ask a one-sentence question and stop.

The runtime already has all the machinery this needs and uses none of it for asking:

- `NeedsHumanSignal` (Sprint 56) — a tool may throw it, and the runner ends the run with
  `stopReason: "needs_human"` rather than crashing. Nothing throws it.
- `pipeline_runs.status = "escalated"` with `pausedAtStepKey` and `escalationReason`
  (Sprint 64) — a durable suspension. Succeeded step passes are cached, so resuming replays
  them and re-runs only the step that stopped.
- `decidePipelineRun(..., { action: "resume" })` — an operator can already un-pause a run.

So the suspend/resume half of the ask lane is **built**. What is missing is the question
itself: a first-class, durable, answerable object carrying enough context to be answered in
one click, and a path by which the answer reaches the resumed run.

**Problem B — Home has two ranking engines.**

`priorities` (`services/priorities.ts`, 584 lines) ranks nine kinds of operational work:
failed executions, blocked and stale actions, authorizations, content reviews, signal
triage, learning reviews, connection health, campaign risk. `next-action`
(`services/next-action.ts` + `nextActionFor` in contracts) ranks a different overlapping
set: pending drafts, blocked publishes, live campaigns without content, unconnected
insights, then a six-item setup checklist.

Both answer "what should you look at". They read the same tables. They can disagree, and
the disagreement is visible: the guide dot in the workspace layout comes from one engine and
the "Needs you now" list on Home comes from the other. This is atlas conflict #7, and the
agent inbox is the natural place to end it — three lanes over one queue.

---

## 2. Deliverables

**(a) The ask lane.** A new `ask` access tier and one tool, `ask_founder`, that a pipeline
step may call. It records a durable question and stops the run. The run suspends into the
`escalated` state it already had; the question row carries the pipeline run and step key, so
the queue and the run point at each other.

**(b) Four question types.** `disambiguation`, `missing_permission`, `missing_fact`,
`policy_escalation` — the PRD's list, unchanged. The type drives how the question reads and
whether the UI offers to remember the answer.

**(c) One-click answer, same run continues.** `POST /workspaces/:id/questions/:qid/answer`
records the answer and, when the question blocks an escalated pipeline run, resumes that run
through the existing engine path. The answer reaches the resumed step two ways: injected
into its prompt, and returned by `ask_founder` if the model asks the same thing again.

**(d) One unified inbox with three lanes.** `GET /workspaces/:id/agent-inbox` returns one
ranked feed of items, each carrying a `lane` discriminator — `notify`, `ask`, `review` — plus
lane counts, the setup checklist, and the derived next action. `priorities` and `next-action`
stop being ranking engines and become projections of this one (D-70.8, D-70.9).

**(e) Answering is a training signal.** Every answer is durable and attributable. When the
founder marks an answer as worth remembering, it becomes a Sprint 68 preference rule with a
new origin, `answered_question`, linked back to the question that produced it.

**(f) Guardrails.** A per-pipeline-run question cap that survives resumes, and a per-workspace
open-question cap so a broken definition cannot flood the inbox.

---

## 3. Decisions

**D-70.1 — the ask tool suspends the run; it does not "request input and continue".**
`ask_founder` throws `NeedsHumanSignal`, which ends the agent run at `needs_human` and
escalates the pipeline run. The alternative — return "no answer yet" as tool data and let the
model carry on — is how you get an agent that asks a question and then ignores it, which is
worse than not asking. A question that does not stop anything is a log line.

**D-70.2 — the question is durable state, not a message.** It is a row with a status, an
answer, an answerer and a link to the run and step it blocks. This is what makes "the founder
answers in one click and the same run continues" implementable at all: the run is gone from
memory long before the answer arrives, and the only thing that survives is the database.

**D-70.3 — the answer reaches the resumed run twice, deliberately.** On resume, the failed
step re-runs from scratch (its pass was never cached). Two independent mechanisms carry the
answer into it:

1. The engine injects every answered question for this pipeline run into the step's user
   message, under `## Answers you already have`.
2. `ask_founder` fingerprints each question (sha256 of the normalized text plus type,
   scoped to the pipeline run). If the model asks a question that was already answered in
   this run, the tool returns the answer as data instead of suspending again.

Belt and braces, because the failure mode of getting this wrong is an infinite ask/resume
loop, and prompt injection of the answer is a request, not a guarantee. Mechanism 2 alone
would waste a model call every resume; mechanism 1 alone would loop the first time a model
ignored it.

**D-70.4 — the question cap is per *pipeline* run, not per agent run.** The adapter's
`ToolBudget` counts calls inside one agent run, and an agent run ends every time a question
suspends it — so a per-agent-run cap would reset on every resume and bound nothing. The cap
lives in the question service, counted over `pipeline_run_id`, so "two questions per run"
means two questions for the whole run including all its resumes. Over the cap the tool
returns error data (not a suspension) telling the model to proceed on its best judgment or
fail the step honestly — an agent that cannot ask any more must not be able to stall.

**D-70.5 — non-live runs get a simulating implementation, not a missing tool.** Same shape as
Sprint 69's proposals (D-69.6) and Sprint 65's propose step (D-65.2). A dry run, a shadow run
or an eval replay that calls `ask_founder` receives a canned answer and continues to
completion. If a dry run suspended, the eval harness would stall on any definition that asks,
and the shadow A/B would compare a completed run against a suspended one. The engine sees the
same tool list in every mode, so the comparison stays honest.

**D-70.6 — a workspace-wide open-question cap.** `AGENT_QUESTIONS_OPEN_MAX = 10`. Past it,
`ask_founder` refuses. The ask lane's whole value is that a question from an agent is worth
reading; twenty of them is a queue, which is the thing the ask lane exists to not be.

**D-70.7 — answering resumes the run inline, on the same request.** This is exactly what the
existing operator resume decision does (`POST /pipelines/runs/:id/decide`), through the same
`decidePipelineRun` call, so the ask lane introduces no new execution path. It is synchronous
and bounded by `RUN_MAX_DURATION_MS`, which is the same bound the decide route already
carries. Sprint 73 (worker → durable queue) is where both move off the request; doing it here
would mean building half of Sprint 73 to avoid a bound that already exists in production code.
`?resume=false` is available for an answer that should not restart the run.

**D-70.8 — one ranker, and `priorities` becomes its projection.** `services/agent-inbox.ts`
owns ranking. `listWorkspacePriorities` calls it and drops the ask lane and setup items,
which is byte-identical to what it returned before. There is exactly one comparator in the
codebase that decides what a founder looks at first.

**D-70.9 — `nextActionFor` loses its four work-ranking branches.** It keeps the setup
checklist walk and `system_working`/`none`; the `review`, `connect_blocked`,
`campaign_content` and `connect_insights` branches are deleted. Those four are the overlap —
each of them re-derives, from raw counts, something the priority engine already computes as a
ranked item with a reason and a consequence. After the deletion the two functions answer
genuinely different questions: the feed answers "what needs you", the checklist answers "what
setup step is left". That is the honest way to close a two-engines conflict: delete one of
them, rather than keep both and add a third that reconciles them.

This changes behaviour the founder can see. The guide dot no longer says "Review drafts" when
a draft is pending — the review lane on Home does. Smart landing (which only fires while the
checklist is incomplete) now always lands on the next setup step. Three existing assertions
change with it, and that is the point of the sprint, not collateral damage.

**D-70.10 — the ask lane ranks second, not first.** Tier 0 stays "an overdue failure" —
something already broke and is getting worse. An open question is tier 1: nothing is broken,
but a run is stopped and the founder is the only one who can start it, and it is usually
fifteen seconds of work. Everything else moves down one tier. Ranking questions *above*
failures would let a chatty definition bury a dead connector.

**D-70.11 — the platform does not infer a rule from prose.** "Answering a question is a
training signal" is implemented as: the answer is durable, attributable and re-readable
(always), and the founder may promote it to a preference rule in the same click
(`remember: { rule, polarity, scope }`). The client prefills the rule text from the answer.
What the platform does *not* do is parse "no, don't name investors unless they're already
public" into a scoped rule and start steering generation with it. Sprint 68 earns its rules
from repeated observed edits with confidence and provenance; minting a permanent 100-confidence
rule out of one sentence of prose would put a different, weaker thing in the same store.

**D-70.12 — the question carries answer options when it has them, and they are advisory.**
`ask_founder` may supply up to four options. The UI renders them as one-click answers, which
is what "answerable in one click" means in practice. The answer field remains free text, so
an option list can never make a question unanswerable.

**D-70.13 — questions are workspace-scoped and read through the normal membership guard.**
No new auth path. A question belongs to a workspace; answering requires membership; the
system actor cannot answer one (an agent answering its own question is the failure this
sprint exists to prevent).

---

## 4. What this sprint does *not* make safe (founder note)

Sprint 69's note stands unchanged: a pipeline step's tool allowlist may hold `safe_fetch_url`
and a propose tool in the same loop, and Move 9's quarantine design is deliberately not
half-built. The ask lane changes one thing about that picture, in both directions:

- **Better:** a step that is unsure now has somewhere to go other than guessing. A definition
  that pairs fetching with proposing can be written to ask before it proposes, and the founder
  sees the question before the action.
- **Not better:** `ask_founder` reads its question text from the model, and the model may have
  read an attacker-controlled page. A question is therefore untrusted text rendered in the
  founder's inbox. It is stored and displayed as plain text, length-capped, never as markup or
  a link, and it can mint nothing on its own — but a sufficiently well-written injected
  question is a phishing surface aimed at a human rather than at the runtime.

The mitigation until Sprint 78 is unchanged and now covers one more thing: in any workspace
whose pipelines both fetch and act, keep `human_required` on `publish` / `send` / `reply`, and
read agent questions as *the agent's claim about what it needs*, not as fact.

---

## 5. Domain model

### `agent_questions` (new)

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `workspace_id` | text → workspaces, cascade | |
| `agent_run_id` | text not null | the run that asked; no FK, matching `agent_proposals` |
| `pipeline_run_id` | text → pipeline_runs, set null | null for a non-pipeline run — nothing to resume |
| `step_key` | text nullable | the paused step |
| `type` | text not null | `AGENT_QUESTION_TYPES` |
| `question` | text not null | ≤ 300 chars, model-written |
| `why` | text not null | ≤ 500 chars — what it needs the answer for |
| `options_json` | text nullable | up to 4 advisory one-click answers |
| `fingerprint` | text not null | sha256(type + normalized question), scoped per pipeline run |
| `status` | text not null | `open` \| `answered` \| `dismissed` |
| `answer` | text nullable | |
| `answered_by_user_id` | text → users, set null | |
| `answered_by_label` | text nullable | |
| `answered_at` | integer nullable | |
| `rule_id` | text → preference_rules, set null | the rule the answer minted, if any |
| `created_at` | integer not null | |

Indexes: `(workspace_id, status, created_at)`, `(pipeline_run_id)`, `(agent_run_id)`.

### No other table changes

The suspension itself reuses `pipeline_runs.status = "escalated"` + `paused_at_step_key` +
`escalation_reason`, which Sprint 64 built and Sprint 70 does not touch.

---

## 6. Contracts (`packages/contracts`)

- `TOOL_ACCESS_LEVELS` gains `"ask"`; `ASK_TOOL_NAMES = ["ask_founder"]`;
  `AGENT_TOOL_NAMES = [...READ, ...PROPOSE, ...ASK]`; `isAskToolName()`.
- `toolInputSchemas.ask_founder` — `{ type, question ≤300, why ≤500, options? ≤4 }`.
- `AGENT_QUESTION_TYPES`, `AGENT_QUESTION_STATUSES`, `agentQuestionSchema`,
  `answerAgentQuestionInputSchema` (`action: answer|dismiss`, `answer`, `remember?`).
- `AGENT_QUESTIONS_PER_RUN = 2`, `AGENT_QUESTIONS_OPEN_MAX = 10`,
  `QUESTION_TEXT_MAX_CHARS = 300`, `QUESTION_WHY_MAX_CHARS = 500`,
  `QUESTION_ANSWER_MAX_CHARS = 1000`.
- `AGENT_INBOX_LANES = ["notify","ask","review"]`, `AGENT_INBOX_ITEM_KINDS =
  [...PRIORITY_ITEM_KINDS, "agent_question", "setup_task"]`, `agentInboxLaneFor()`,
  `agentInboxItemSchema`, `agentInboxFeedSchema`. Prefixed `AGENT_INBOX_*` because
  `INBOX_ITEM_KINDS` / `InboxItem` are already taken by the Sprint 29 engagement inbox,
  which is a different inbox entirely.
- `PREFERENCE_RULE_ORIGINS` gains `"answered_question"`.
- `nextActionFor` loses four branches (D-70.9).

## 7. API surface

| method | path | purpose |
|---|---|---|
| GET | `/workspaces/:id/agent-inbox` | the one ranked feed: items + lane counts + checklist + next action |
| GET | `/workspaces/:id/questions?status=` | the ask lane on its own |
| POST | `/workspaces/:id/questions/:questionId/answer` | answer or dismiss; resumes the blocked run |
| GET | `/workspaces/:id/priorities` | unchanged output — now a projection of the feed |
| GET | `/workspaces/:id/next-action` | unchanged shape; `nextAction` no longer ranks work |

## 8. Tests

- **contracts** — lane mapping is total over kinds; the ask tool tier partition; question and
  answer schema bounds; `nextActionFor` no longer answers for work items.
- **migration** — the table, its indexes, and that an existing DB migrates.
- **ask service** — cap per pipeline run across resumes, open cap, fingerprint re-answer,
  simulated mode, dismissal.
- **engine (acceptance)** — a scripted step calls `ask_founder`; the run escalates with a
  question; the founder answers; the *same run* completes, and the second pass sees the
  answer.
- **inbox feed** — three lanes, ranking tiers, counts, projection equality with `priorities`.
- **routes** — answer/dismiss, membership isolation, `remember` mints a rule.
- **web** — lane view helpers, ask-card copy, guide-dot behaviour after D-70.9.

## 9. Out of scope

- Moving resume onto a durable queue (Sprint 73).
- Questions from chat threads (Sprints 78–79) — the table is ready for them; nothing wires it.
- "Why this" panels on artifacts (Sprint 71).
- Notifying the founder out-of-band (email/push) about an open question.
- Question expiry / auto-dismissal sweeps.
- Exposing questions through the public API or MCP.

## 10. Progress log

### 2026-08-06 — delivered

Branch `sprint-70-agent-inbox`, forked from `sprint-69-propose-tools` @ `af24fdf`.

**Contracts.** A third access tier (`ask`) and one tool name; `AGENT_QUESTION_TYPES`,
`AGENT_QUESTION_STATUSES`, `agentQuestionSchema` with a two-way superRefine (an answered
question carries its answer; an open one carries no answer time);
`answerAgentQuestionInputSchema` (answer / dismiss, `resume`, explicit `remember`) and
`answerAgentQuestionResultSchema`; the four caps; the lane vocabulary and `agentInboxLaneFor`
as a total map; `answered_question` added to `PREFERENCE_RULE_ORIGINS`; `agentRunDetailSchema`
gained `questions`; and `nextActionFor` lost its four work-ranking branches (D-70.9).

**Database.** One new table, `agent_questions`, migration `0076_sprint_70_agent_inbox.sql`.
The suspension itself needed no schema at all — Sprint 64's `escalated` /
`paused_at_step_key` carries it, which is the reason this sprint is XL in surface and small
in machinery.

**The ask lane.** `agents/questions.ts` (leaf seam + simulating impl), `agents/tools/ask.ts`
(the one tool that throws `NeedsHumanSignal`), `services/agent-questions.ts` (the durable
half: fingerprinting, caps, answering, the `remember` hand-off to Sprint 68). The engine
injects answered questions into every step prompt under `## Answers you already have`, and
passes `pipelineRunId` / `stepKey` into the tool context.

**A real bug the acceptance test found.** `pipeline_run_steps` is unique on
`(run_id, step_key, iteration, attempt)`, and `runAgentStepPass` restarted attempt numbering
at 1 on every execution. Escalating on `needs_human` was written in Sprint 64 and never
exercised, so resuming from it had never actually worked — the first resume died on a UNIQUE
violation. Attempts now continue from the highest recorded attempt for that step and
iteration; the per-execution bound (`STEP_MAX_ATTEMPTS`) is unchanged, only the numbering
carries over. Without this fix the sprint's acceptance criterion is unreachable.

**The merge.** `services/agent-inbox.ts` is now the only comparator in the codebase that
decides what a founder looks at first. `priorities.ts` kept its item builders and lost its
`tier()` and its sort; `listWorkspacePriorities` moved into the inbox service as a
projection that returns exactly what it returned before. `nextActionFor` kept the checklist
walk and lost the overlap. `apps/web/lib/priorities.ts` was deleted — its presentation
metadata lives in `agent-inbox-view.ts` alongside the two new kinds.

**Verification.** `npm run typecheck` clean. `npm test` → **278 files / 2,803 tests**
(Sprint 69 baseline: 272 / 2,752). `npm run eval` → "✓ No regression", all four metrics
unchanged — the eval harness runs `dry_run`, which gets the simulating ask seam, so a
definition that asks still replays end to end.

**Nine pre-existing assertions changed, all deliberately.** Five in
`packages/contracts/test/next-action.test.ts` and two in `apps/api/test/next-action.test.ts`
asserted the four deleted branches — they now assert the *absence* of the duplication, which
is the deliverable. One in `propose-tools.test.ts` (two tiers → three) and one in
`preferences.test.ts` (two origins → three).

**Three founder notes.**

1. **The guide dot changes behaviour.** It no longer says "Review drafts" while a draft
   waits, and it disappears entirely once setup is complete. That is D-70.9 working: the
   review lane on Home says it instead, and the two surfaces can no longer disagree. Smart
   landing (which only fires while setup is incomplete) now always lands on the next setup
   step.
2. **The prompt-injection surface widened slightly.** §4 has the detail. A question is
   model-written text displayed in your inbox; it is stored and rendered as plain text and
   can mint nothing, but read it as the agent's claim about what it needs, not as fact.
3. **Answering resumes the run on the same HTTP request.** Bounded by
   `RUN_MAX_DURATION_MS`, exactly as the existing operator resume route already is. Sprint
   73 moves both onto the durable queue; doing it here would have meant building half of 73.

