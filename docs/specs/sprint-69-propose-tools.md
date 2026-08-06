# Sprint 69 — Propose-tools: the agent can act

**Branch:** `sprint-69-propose-tools` (forked from `sprint-68-preference-memory` @ `c4f87aa`)
**PRD:** `docs/plans/prd-agentic-platform.md` §8, "Sprint 69 — Propose-tools: the agent can act"
**Direction doc:** Move 7 — Surface the intelligence in the product
**Plane epic:** TAP-28
**Size:** L · **Risk:** Medium · **Depends on:** 57 (tool registry), 54 (ads governance spine / policy tree)

**Merge order.** This branch forks the Sprint 68 branch, which forks 67, which forks 66,
which forks 65, which forks 64, which forks 63 → 62 → 61. The founder merges in order:
**61 → 62 → 63 → 64 → 65 → 66 → 67 → 68 → 69.** Sprint 69's migration is `0075`, which
assumes `0074` (Sprint 68) is already applied.

Although the PRD lists the dependencies as 57 and 54 — both long merged into `main` — this
branch forks 68 rather than `main` so the migration numbering stays sequential and the
founder's one-at-a-time merge chain is not broken.

---

## 1. Problem

Sprint 57 built the tool registry with two access tiers and shipped only one of them.
`read` tools let a model *find out* anything about a workspace; `propose` was declared in
the vocabulary, documented in the registry header ("none ship until Phase L"), and left
empty. The result is an agent that can research exhaustively and then do nothing but hand
a paragraph back to the engine, which does the acting on its behalf through fixed,
hard-coded step outputs.

That is the right order — capability after governance — and the governance is now finished.
Sprint 49 built external actions with a durable state machine. Sprint 52 collapsed the
double gate and made humanity of the actor explicit. Sprint 54 built the policy tree:
five scopes (workspace → campaign → persona → connection → lane), six action kinds, an
`inherit` rule, and a resolver that produces an effective `autonomous` / `human_required`
answer plus the contributing rules that produced it. Every external action in the product
— human-initiated from a route, system-initiated from a cadence or a sequence — already
goes through it.

**So the work of this sprint is not to make acting safe. It is to stop writing a second
copy of the safety.** An agent that wants to publish should call the same command builder
the publish route calls, hand it to the same runtime, and get gated by the same policy
tree. If the answer is `human_required`, it parks in the same queue the founder already
reads. If the answer is `autonomous`, it goes — because that is precisely what the founder
configured that setting to mean.

The one thing genuinely missing is *attribution*: today the queue cannot tell a founder
that the thing waiting for authorization was proposed by an agent rather than by them.

---

## 2. Deliverables

**(a) Five propose tools.** `propose_draft`, `propose_publication`, `propose_reply`,
`propose_sequence_step`, `propose_ad_mutation` — added to the registry alongside the
eleven read tools, at access tier `propose`.

**(b) Every one routes to a gate that already exists.** Four mint a `proposed` external
action through `ExternalActionRuntime.propose` and return its id; the policy tree decides
`autonomous` vs `authorization_required` with no branch for who asked. `propose_draft`
submits to the approval gate (`draft → pending_review`) — see D-69.2.

**(c) Caps.** A per-run proposal budget and a per-workspace-per-day cap, both returned to
the model as instructive error data rather than thrown.

**(d) Agent-originated actions are labeled as such.** A typed `origin` on the external
action itself (visible in the authorization queue) and a durable `agent_proposals` ledger
(visible on the agent-run inspector, and the thing the daily cap counts).

**(e) Nothing acts outside a live run.** Dry runs, shadow runs and eval replays get a
*simulating* implementation of the same interface — same tool surface for the model, same
transcript shape for A/B comparison, zero durable effect.

---

## 3. Decisions

**D-69.1 — The policy tree decides, exactly as it does for a human.**
`propose()`, not `proposeForReview()`. Under `human_required` the action parks; under
`autonomous` it dispatches. This is a deliberate difference from the copilot (Sprint 42
P2), which always parks: there, a human is in the loop asking for a proposal, and the
in-chat confirm is a request to *propose*, never to send. Here the agent is acting under a
policy the founder set for that kind in that scope. Forcing review anyway would mean
writing a second safety mechanism on top of the policy tree — the exact thing the PRD says
not to do — and it would make `autonomous` mean two different things depending on who
asked. A founder who wants every agent action reviewed sets `human_required`; that control
already exists and is per-kind and per-scope, which is strictly better than a global
agent-only switch.

**D-69.2 — `propose_draft` is governed by the approval gate, not the policy tree.**
A draft is not an external action; it is the *subject* of one. Minting a `publish` action
for freshly written content would be wrong twice over: it would ask the founder to
authorize a send before anyone has read the words, and it would bypass the approval gate
that has governed content since Sprint 5. So `propose_draft` lands at `pending_review` and
returns a draft id. This is still "the gate that already exists" — it is simply a different
one, because the thing being proposed is different. A later `propose_publication` on that
draft is refused until a human approves it, because `publishIntent` already requires
`state === "approved"`. That is a pre-existing property, and it means the two-step path an
agent must walk to publish its own writing has a human in the middle by construction.

**D-69.3 — Origin does not enter the fingerprint.**
The action fingerprint covers subject, context, payload, timing and effective policy. It
does not cover the proposer today and must not start: the acceptance criterion is that an
agent-proposed action is gated *exactly* as a human-proposed one, and a fingerprint that
varied by origin would make the same action re-propose as a different one, break
idempotency across paths, and quietly create an agent-specific code path inside the very
mechanism that is supposed to be origin-blind.

**D-69.4 — Origin is a column, the ledger is a table, and they answer different questions.**
`external_actions.origin` / `origin_run_id` answer "who proposed *this action*" at the
point a founder reads the queue — one field, no join, on a row that already exists. The
`agent_proposals` ledger answers "what has this run proposed" and "how many proposals has
this workspace had today", across kinds including drafts, which have no external action to
carry a column. Backfill is honest rather than convenient: existing rows become `human`
when they have a `proposed_by_user_id` and `system` when they do not, which is exactly what
those rows meant.

**D-69.5 — The tools take an injected service, not the runtime.**
`ToolContext` gains `proposals?: AgentProposalService` — an interface declared in a leaf
module (`agents/proposals.ts`) with a type-only import into the registry. The five tool
files therefore import nothing but contracts and that type. The concrete implementation
(`services/agent-proposals.ts`) may freely import the coordinator, the adapters, the
connector fabric and `drafts.ts`. Without this, a propose tool would import
`external-action-adapters.ts`, which reaches `automation.ts`, and the Sprint 65 import
cycle — `agents/tools/index.ts` builds `TOOLS_BY_NAME` at module top-level — would leave
the registry half-initialized at load. Same lesson, third sprint running.

**D-69.6 — Non-live runs get a simulating implementation, not a missing tool.**
The alternative — omitting propose tools from the tool list in dry/shadow mode — changes
what the model sees, which would make a shadow A/B comparison compare two different
agents. `simulatedAgentProposals()` implements the identical interface, records nothing,
and returns `{ simulated: true, id: null }`. The engine picks the implementation from
`run.mode`, so a dry run, a shadow run and an eval replay of eighty historical cases
cannot mint an action between them.

**D-69.7 — Absent runtime means absent propose tools.**
When the engine is constructed without a runtime (older call sites, focused tests), the
propose tools are filtered out of the step's tool list entirely rather than defaulting to
something. There is no "propose without a gate" state to fall into.

**D-69.8 — Caps are error data, and the per-run one is enforced in the adapter.**
`ToolBudget` gains `maxProposals`, counted across all tools at access tier `propose` — a
per-tool cap would let a run make three publications *and* three ad mutations. The daily
cap is enforced inside the live implementation, because it is a durable, cross-run fact
that only a database read can answer. Both return `{ error: "proposal_cap_reached", … }`
so the model wraps up rather than crashing the step, consistent with every other budget in
the adapter.

**D-69.9 — Routing is resolved by the platform, not asked of the model.**
`propose_publication` takes a draft id and optionally a time; when no connection is named
it comes from the draft's persona social assignment (`resolvePersonaSocialConnection`, the
same resolution the cadence path uses), and the target defaults to the most recent
successful publication on that connection. A model asked to supply a connection UUID would
either hallucinate one or need a new read tool to enumerate them — and enumerating
credentials to a model that has just read an attacker-controlled web page is not a trade
worth making. When routing cannot be resolved the tool returns instructive error data
naming what to pass.

A connection the model *does* name goes straight through to `publishIntent`, which
validates it exactly as it validates a human's choice on the route. Adding a second,
stricter check here would have been easy and wrong: it would have made an agent proposal
refusable for a reason a human proposal is not, which is the same origin-dependent
behaviour D-69.3 refuses in the fingerprint.

**D-69.10 — The proof run stays read-only.**
`POST /workspaces/:id/agent-runs/proof` (the Sprint 57 inspector ignition) keeps
`READ_TOOLS`. It exists to demonstrate retrieval; giving an ad-hoc, founder-typed question
the ability to mint governed actions would make a debugging affordance the least
supervised write path in the product.

---

## 4. The prompt-injection surface arrives in this sprint (founder note)

Move 9 records this hazard against chat: it "is the first place the model reads
attacker-controlled text (fetched pages, discovery items) *while holding write tools in the
same turn*", and prescribes quarantining untrusted content with explicit confirmation for
writes derived only from it.

That is not right. The surface opens **here**, in Sprint 69, and it is worth naming plainly
rather than discovering in Sprint 78. A pipeline step's tool allowlist can contain both
`safe_fetch_url` and `propose_publication`; a fetched page is attacker-controlled text; the
model holds both in one loop.

What contains it today, honestly stated:

- **Pipeline definitions are internal-only** (founder decision D5 — customer-editable only
  after the eval harness can catch a bad definition). Only definitions we author can put a
  propose tool in a step's allowlist, so the surface is opt-in per step, not ambient.
- **`propose_publication` cannot publish unapproved content.** `publishIntent` requires
  `state === "approved"`, so an injected instruction to publish something can only replay
  content a human already approved — a real limit, though not a complete one, since *when*
  and *where* it goes remain agent-chosen.
- **The policy tree is the stop.** `human_required` on a kind means an injected proposal
  waits in the queue like any other.
- **Caps bound the blast radius**, per run and per day.

What is *not* built here, deliberately: content quarantine, provenance tainting, or a
confirmation gate for untrusted-derived writes. Those are Move 9's design and building a
half version now would create the second safety mechanism D-69.1 exists to avoid. The
recommendation is to keep `human_required` on `publish`, `send` and `reply` for any
workspace whose pipelines both fetch and propose, until Sprint 78 lands quarantining.

---

## 5. Domain model

### `external_actions` (two new columns)

| column | type | note |
|---|---|---|
| `origin` | text notNull default `'human'` | `human` / `system` / `agent` |
| `origin_run_id` | text nullable | the `agent_runs.id` for `agent` origin, else null |

Backfill (D-69.4): `'human'` where `proposed_by_user_id` is not null, `'system'` otherwise.

### `agent_proposals` (new)

| column | type | note |
|---|---|---|
| `id` | text pk | |
| `workspace_id` | text notNull → workspaces, cascade | |
| `agent_run_id` | text notNull | the run that called the tool |
| `tool` | text notNull | one of the five propose tool names |
| `target_kind` | text notNull | `draft` \| `external_action` |
| `draft_id` | text → drafts, set null | populated for `propose_draft` |
| `external_action_id` | text → external_actions, set null | populated for the other four |
| `summary` | text notNull | one line naming what was proposed |
| `rationale` | text notNull | the model's stated reason, bounded |
| `created_at` | integer notNull | |

Indexes: `(workspace_id, created_at)` for the daily cap; `(agent_run_id)` for the inspector.

Both foreign keys are `set null` on delete: the ledger is a record of what the agent *did*,
and deleting the draft it wrote must not erase the fact that it wrote one.

---

## 6. Contracts (`packages/contracts`)

- `EXTERNAL_ACTION_ORIGINS = ["human", "system", "agent"]` + `ExternalActionOrigin`
- `externalActionSchema` gains `origin` and `originRunId` (nullable uuid), with a refine:
  `origin === "agent"` requires an `originRunId`, and no other origin may carry one.
- `AGENT_TOOL_NAMES` gains the five propose names; `PROPOSE_TOOL_NAMES` is the subset, and
  `READ_TOOL_NAMES` the complement. A contracts test asserts the three stay consistent, and
  an API test asserts the registry matches `AGENT_TOOL_NAMES` exactly, as before.
- `toolInputSchemas` gains an entry per propose tool (the `satisfies Record<AgentToolName,…>`
  makes this mandatory, which is the point).
- `AGENT_PROPOSAL_TARGET_KINDS`, `agentProposalSchema`.
- `AGENT_PROPOSALS_PER_RUN = 3`, `AGENT_PROPOSALS_PER_DAY = 20`,
  `PROPOSAL_RATIONALE_MAX_CHARS = 500`.
- `agentRunDetailSchema` gains `proposals: agentProposalSchema[]`.

---

## 7. API surface

No new routes. Three existing ones change shape:

- `GET /workspaces/:id/agent-runs/:runId` — detail gains `proposals`.
- Every route returning an `ExternalAction` gains `origin` / `originRunId` (one mapper,
  `rowToExternalAction`).
- `registerPipelineRoutes` and `registerInternalTaskRoutes` gain the external-action
  runtime in their dependency object, wired from `app.ts` where it is already constructed.

---

## 8. Tests

| file | covers |
|---|---|
| `packages/contracts/test/propose-tools.test.ts` | origin vocabulary + refine, tool-name partition, input schemas, caps |
| `apps/api/test/sprint69-migrations.test.ts` | `0075` applied, backfill correctness, ledger FKs and cascade |
| `apps/api/test/agent-proposals.test.ts` | the service: each of the five, routing resolution, daily cap, simulated impl |
| `apps/api/test/propose-tools.test.ts` | the tools through the adapter: validation, per-run cap, error data |
| `apps/api/test/propose-tools-engine.test.ts` | **acceptance** — agent proposes a publication, policy tree gates it; `human_required` stops it; shadow mode mints nothing |
| `apps/api/test/agent-run-proposals-route.test.ts` | inspector detail carries the ledger |
| `apps/web/lib/action-origin.test.ts` | origin label helper |

---

## 9. Out of scope

- Content quarantine / provenance tainting (§4, Move 9 / Sprint 78).
- The ask lane and the unified inbox (Sprint 70).
- The "why this" panel (Sprint 71).
- Customer-editable pipeline definitions (D5).
- Any new external-action *kind*. The five tools cover the six existing kinds; nothing new
  becomes possible that a human could not already do from a route.

---

## 10. Progress log

### 2026-08-06 — delivered

**Contracts.** `EXTERNAL_ACTION_ORIGINS` and `origin` / `originRunId` on
`externalActionSchema`, refined both ways: an `agent` action must name its run, and no other
origin may carry one — an unattributable agent action is the single failure this sprint
could not tolerate. `AGENT_TOOL_NAMES` is now `READ_TOOL_NAMES ++ PROPOSE_TOOL_NAMES`, which
made the five input schemas mandatory rather than optional (the existing
`satisfies Record<AgentToolName, …>` did the enforcing). Added `agentProposalSchema`,
the two caps, and `proposals` on `agentRunDetailSchema`.

**Database (`0075`).** Two columns on `external_actions` plus the `agent_proposals` ledger.
The backfill is the part worth reading: pre-existing rows are set to `system` where no user
id was attributed and left `human` otherwise, rather than taking the column default, which
would have quietly relabelled every cadence and sequence proposal as a person's.

**The seam.** `agents/proposals.ts` (leaf: the interface and the simulating implementation)
and `services/agent-proposals.ts` (live: builds commands with the same `prepare*Action`
builders the human routes use and hands them to the same runtime). The five tool files
import the interface type and contracts, nothing else — third sprint running that the
top-level `TOOLS_BY_NAME` map has dictated a module boundary, and the first where the
alternative was genuinely tempting.

**Caps.** Per-run in the adapter, keyed on `tool.access === "propose"` so the budget is
shared across all five. Per-day in the live implementation, read before any command is
built. Both are error data.

**Engine.** `PipelineEngineDeps.proposals`, the tool filter widened to `ALL_TOOLS`, and the
mode switch: live gets the real seam, everything else the simulating one. The agent run id
is now minted by the engine and passed to the runner (`AgentRunParams.runId`) — a propose
tool has to name the run it is acting for while that run is still going.

**Verification.** `npm run typecheck` clean. Full suite green. `npm run eval` unchanged —
the golden cases declare no tools, and the harness runs `dry_run`, so the propose layer is
invisible to it by construction rather than by luck.

**Three things worth the founder's attention.**

1. **The prompt-injection surface opens now, not in Sprint 78.** §4 is the long version. The
   short version: a step's allowlist can hold `safe_fetch_url` and a propose tool at once.
   Nothing in this sprint quarantines untrusted content, and building half of Move 9's
   design here would have been the second safety mechanism D-69.1 exists to avoid. Until
   Sprint 78, keep `human_required` on `publish` / `send` / `reply` in any workspace whose
   pipelines both fetch and propose.

2. **`autonomous` now means what it says, for agents too.** That is the acceptance
   criterion, and it is a real change in what the setting implies. The copilot's
   always-park behaviour is unchanged; the difference is deliberate and explained in
   D-69.1.

3. **An agent still cannot publish its own writing without you.** `propose_draft` lands at
   `pending_review`, and `publishIntent` refuses anything not `approved`. That is a
   pre-existing property rather than something built here, and it is the reason the
   two-step path an agent must walk has a human in the middle by construction.
