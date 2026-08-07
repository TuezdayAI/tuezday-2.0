# Sprint 76 — Chat foundations: threads, streaming, grounded answers

**Branch:** `sprint-76-chat-foundations`, forked from `sprint-71-show-the-work` (bd5edee).
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66 → 67 → 68 → 69 → 70 → 71 → **76**. This branch contains Sprints 61–71; none are on `main` yet.
**PRD:** `docs/plans/prd-agentic-platform.md` §10, Sprint 76 (direction doc Move 9a; delivers R7, read half). Plane epic TAP-35.
**Depends on:** Sprint 56 (Gateway v2 + `AgentRunner`), Sprint 57 (internal tool registry + Agent Inspector), Sprint 55 (unified metric model), Sprint 59 (metered gateway + budgets). All on this chain.
**Migration:** base ends at `0076_sprint_70_agent_inbox.sql`, so this adds **0077**.

---

## 0. Why this sprint runs now, and what it is actually for

The PRD's own sequencing table says Sprint 76 should have run **immediately after 57** — *"Earliest possible moment the platform feels intelligent. Do not defer."* It was deferred by fourteen sprints because the build ran numerically. Its stated general-availability gate (Sprint 59, tiered routing and workspace budgets) has been shipped since. So this is overdue by the plan's own reasoning, and it is the substrate for 77, 78 and 79 — none of which can start until threads, streaming and grounded turns exist.

**The founder's framing, recorded 2026-08-06, changes the shape of the sprint.** This is not a ChatGPT-style Q&A box. The target interaction is:

> A user comes in and says *"I want to launch a campaign about this new product launch, across these channels."* The chat interacts with them, guides them, asks for the materials it needs, asks clarifying questions, and works out the strategy **with** the user. It then goes and creates that campaign on the platform using the agents. It ideates and helps the client understand their own requirements and figure out what is needed from the client side so we can generate and launch a good campaign.

That spans three sprints in the PRD's decomposition: the conversation that elicits and proposes (76/77), the chat that mints governed actions (78), and the detached agents that do minutes of work and report back (79). **Sprint 76 owns the conversational half of it** and nothing else. The consequence for this spec is that chat is built as an **intake-and-strategy conversation** — a thread with a persistent goal that elicits rather than assumes, names the material it still needs, and proposes strategy as options — rather than a stateless question-answerer that 78 would have to rip out and rebuild. The write half is bolted on in 78; the surface is not rebuilt.

**What that means concretely, and where the honesty line is.** Chat in this sprint **cannot change anything**, and it must not pretend otherwise. When a conversation reaches the point of "now go build it", the assistant states plainly what it would create and that executing it arrives next — it does not fabricate a completed action. That is enforced structurally (§4, D-76.9), not by prompt politeness.

---

## 1. Problem

**(a) The platform cannot be asked anything.** It holds more about a customer's GTM than the customer does — five brain docs, campaign plans and their revisions, every publication and its metrics, the evidence corpus, approval history, preference rules, outreach funnels — and every question about it requires knowing which of ~14 modules owns the answer. The software's intelligence is gated behind knowing its information architecture.

**(b) The chat that exists is pre-runtime.** Sprint 42 shipped a copilot: a prompt-engineered JSON tool-loop over `generate()` (`services/copilot.ts`), its own read registry (`services/copilot-tools.ts`, 10 tools), its own write path (`services/copilot-actions.ts`, propose/confirm), and a slide-over drawer. It works, and it is the wrong shape for everything after it:

| Sprint 42 copilot | What the runtime now provides |
|---|---|
| Free-text `{"tool","args"}` parsing out of prose | Native tool calls via `gateway.agentStep` (Sprint 56) |
| Its own 10-tool read registry | `apps/api/src/agents/tools` — 11 read tools with a typed `access` field (Sprint 57) |
| No trace: turns are invisible | Every `AgentRunner` run is an `agent_run` with persisted steps + the Agent Inspector (Sprint 57) |
| Single-response, no streaming | `agentStepStream` + `AgentRunner.onEvent` already emit deltas, tool boundaries and step boundaries |
| Its own propose/confirm write path | Sprint 69 propose-tools + the external-action policy tree |
| No thread scope; no context bundle | The Context Resolver, which every other generating surface already goes through |

`copilot.ts:105` says so in a code comment: *"its real migration is to agentStep function calling / the AgentRunner in the Phase O chat-surface refactor."* This is that refactor.

**(c) Chat is not grounded in the brain.** The Sprint 42 preamble is five hand-written sentences plus a tool catalogue. Every other generating surface in the platform resolves a context bundle through `packages/brain` first. Chat that does not is a generic assistant pointed at an export — which is precisely the difference the PRD calls out.

---

## 2. What this sprint delivers

1. **Threads with scope and a goal.** `chat_sessions` gains `campaign_id` / `persona_id` / `channel` / `goal` / lifetime token and cost counters. A thread's system prefix is a **resolved context bundle from `packages/brain`** — the same resolver generation uses — not a hand-written preamble.
2. **Every assistant turn is an `agent_run`.** The turn runs through `AgentRunner` with the Sprint 57 registry. The Agent Inspector works for chat on day one, with no new tracing code. The assistant message carries its `agent_run_id` and links there.
3. **Streaming.** The platform's first SSE endpoint: `POST /workspaces/:id/chat/sessions/:sessionId/messages` with `Accept: text/event-stream` streams token deltas, tool-call start/end, step boundaries, compaction, the persisted message and a terminal `done`. Same route without that header returns the finished turn as JSON (so `app.inject`, the MCP surface and any non-streaming client keep working).
4. **Six new `read` tools** on the Sprint 57 registry, over the Sprint 55 metric model and the campaign/persona surfaces — so "why did our LinkedIn engagement drop last month?" and "which campaigns do we have?" are answerable, and so pipelines and the critic can use them too.
5. **Mandatory citations.** A new leaf mapper turns each tool call's result into `ChatCitation[]`; assistant messages carry the union. An assistant turn that made tool calls and cites nothing is a defect the tests catch.
6. **Compaction** at 60% of the thread budget: older turns are summarized, the newest turns and pinned scope stay verbatim, and the compaction is persisted as its own message **and** its own `agent_run` — nothing silently disappears.
7. **Auto-titling, in-thread cost, and a hard 250k-token per-thread cap** enforced here rather than deferred.
8. **The Sprint 42 tool-loop, read registry and write path are deleted** (D-76.1). One chat, one data model, one tool registry.

---

## 3. Founder decisions (locked 2026-08-06)

| ID | Decision | Rationale |
|---|---|---|
| **D-76.1** | **Rebuild in place; chat goes read-only.** Keep `chat_sessions` / `chat_messages`; extend them. Delete `copilot.ts`'s tool-loop, `copilot-tools.ts` and `copilot-actions.ts`. | One chat, one data model, one tool registry. The temporary cost is losing copilot-propose until Sprint 78 re-adds it on propose-tools; the alternative is two coexisting write paths, which is the double-gate shape Sprint 52 spent a sprint removing. |
| **D-76.2** | **New analytics tools go into the Sprint 57 registry** as `access: "read"`, not into a chat-only list. | The registry is the platform's capability surface. A metric read is useful to a critic and a pipeline step, not just to chat. Founder chose the full set over the minimum. |
| **D-76.3** | **Evolve the existing slide-over drawer**; no dedicated `/chat` page this sprint. | Sprint 77 owns the interaction layer (keyboard summon, `/` commands, generative cards). One mount point to keep in sync through 77 and 78. |
| **D-76.4** | **250,000 tokens per thread, hard**; compaction at 60% of the per-turn context budget. | Founder raised it from the proposed 150k: these are long, multi-turn intake conversations, not one-shot questions. Sprint 59's workspace budgets remain the economic control; this is the runaway backstop. |
| **D-76.5** | **Chat is intake-and-strategy shaped, not Q&A shaped** — a persistent thread goal, elicitation before assumption, explicit naming of material still needed from the founder. | The founder's stated target interaction (§0). Building the conversational scaffolding now means Sprint 78 attaches propose-tools to a conversation that already knows what it is trying to do. |

### Decisions taken in this spec (founder may overrule at review)

| ID | Decision | Rationale |
|---|---|---|
| **D-76.6** | **`gtm_conversation` becomes a `TASK_TYPE`** with its own `DEFAULT_TASK_DOC_MATRIX` row (`icp: full`, `history: full`), plus a new `GENERATION_TASK_TYPES` subset (everything except it) used by every task-type picker in the web app. | The resolver indexes its matrix by task type. Reusing `cold_email_opener` because its cell values happen to fit would bind chat's context policy to an unrelated task invisibly, and `/resolver` would tell a founder their strategy conversation resolved as a cold email. A strategy conversation genuinely needs ICP and history in full where a LinkedIn post does not — that *is* a matrix row. The subset constant keeps it out of generation dropdowns, following the existing `AD_CREATIVE_TASK_TYPES` precedent. |
| **D-76.7** | **`proposal_json` / `produced_ref` columns stay on `chat_messages`**, unwritten, after the Sprint 42 write path is deleted. `LLM_PIPELINES` keeps `copilot_action`. | Sprint 78 re-populates both. Dropping a column in SQLite is a table rebuild for no gain, and `copilot_action` is a ledger vocabulary with existing `llm_usage_events` rows pointing at it — removing an enum value that historical rows carry is a data-integrity bug, not a cleanup. |
| **D-76.8** | **Citations are derived from tool results by a leaf mapper** (`chat-citations.ts`), not by changing the registry tools' return shapes. | The 17 registry tools are shared with pipelines and the critic, which do not want a citation envelope. A per-tool mapper keeps the shared surface untouched and keeps citation logic in one testable file. |
| **D-76.9** | **Read-only is structural.** The turn assembles tools by filtering `access === "read"`, and builds its `ToolContext` **without** the `proposals` and `questions` services — so the propose and ask tools are not merely unlisted, they are unconstructable. | Same discipline as Sprint 69's D-69.7: there is no "propose without a gate" state. A test asserts both halves. |
| **D-76.10** | **The turn service takes an optional `onEvent`; the route is a thin SSE adapter.** | Mirrors `AgentRunner`. The testable unit is the service with an event collector; the route needs one framing test, not a streaming test suite. |
| **D-76.11** | **Compaction runs as its own `agent_run`** (`task: "chat:compaction"`, `cheap` tier) and is persisted as a `compaction`-role message. | "Record the compaction as a step in the trace so nothing silently disappears" (PRD). A message row makes it visible in the transcript; its own run makes it inspectable and metered. |
| **D-76.12** | **A thread's `goal` is derived once from the opening message** (same cheap call as the title) and is user-editable; the model does not rewrite it. | A model-updated goal is a write path with no gate, and drift in it would silently re-aim the system prefix. Sprint 77's pinned-context chips are where this becomes interactive. |

---

## 4. Design

### 4.1 The turn, end to end

```
POST /workspaces/:id/chat/sessions/:sid/messages   { message }
  │
  ├─ guard: workspace membership (existing global preHandler)
  ├─ assertLlmBudget(db, workspaceId)          → 402 upgrade_required
  ├─ assertThreadBudget(db, session)           → 409 thread_budget_exhausted
  ├─ appendMessage(role: "user")
  │
  ├─ buildChatContext(db, session)             → ResolvedContext (packages/brain)
  │     workspace brain docs + channel + persona + campaign + campaign plan
  │     taskType: "gtm_conversation", resolveMode: "draft"
  │
  ├─ maybeCompact(db, session, transcript)     → own agent_run + compaction message
  │
  ├─ AgentRunner.run({
  │     task: "chat", createdBy: "user:<id>",
  │     system: resolved.prompt + CONVERSATION_DIRECTIVE + goal,
  │     messages: transcriptToAgentMessages(...),
  │     tools: READ_TOOLS only (D-76.9),
  │     maxSteps: 8, maxTokens: 32_000, timeoutMs: 120_000,
  │     onEvent: → SSE frames
  │   })
  │
  ├─ citationsForRun(toolCalls, results)       → ChatCitation[]
  ├─ appendMessage(role: "assistant", agentRunId, citations, costCents)
  ├─ bump session totals (tokens, cost), auto-title if first turn
  └─ SSE `message` + `done`, or JSON ChatTurnResult
```

Nothing here is new machinery. The runner, the registry, the resolver, the metered gateway and the budget guard all exist; this sprint composes them and adds the transport.

### 4.2 Data model (migration 0077)

**`chat_sessions`** — added columns, all nullable or defaulted so existing rows migrate cleanly:

| Column | Type | Notes |
|---|---|---|
| `campaign_id` | text → `campaigns.id` **set null** | Thread scope. Feeds `ResolveInput.campaign` + `campaignPlan`. |
| `persona_id` | text → `personas.id` **set null** | Feeds `ResolveInput.persona`. |
| `channel` | text nullable | One of `CHANNELS`; null → resolve against `web`. |
| `goal` | text NN default `''` | D-76.12. Rendered into the system prefix and shown as a chip. |
| `total_input_tokens` | integer NN default 0 | Lifetime, for the cap and the cost display. |
| `total_output_tokens` | integer NN default 0 | |
| `total_cost_cents` | real NN default 0 | |
| `compacted_through_message_id` | text nullable | Newest message folded into the latest compaction. |

**`chat_messages`** — added columns:

| Column | Type | Notes |
|---|---|---|
| `agent_run_id` | text nullable | The `agent_runs` row for this assistant turn. Links to the Inspector. |
| `cost_cents` | real NN default 0 | Per-turn cost, for the in-thread display. |
| `input_tokens` / `output_tokens` | integer NN default 0 | |
| `stop_reason` | text nullable | `AgentStopReason` — a turn that hit `max_steps` says so in the UI. |

`proposal_json` and `produced_ref` stay, unwritten (D-76.7).

`CHAT_MESSAGE_ROLES` gains `"compaction"` → `["user", "assistant", "tool", "compaction"]`.

### 4.3 The system prefix

```
THREAD GOAL: <session.goal>         ← omitted when empty
──────────────────────────────────
<ResolvedContext.prompt>            ← the brain bundle, identical to generation's,
                                      ending in the task instruction for
                                      `gtm_conversation` — the conversation directive
```

The **conversation directive** is what makes this an intake rather than a Q&A box, and it is the part of the sprint that is prose rather than code. It instructs: ground every factual claim in a tool result and say so when you cannot; elicit before assuming, at most two questions a turn, highest-leverage first; state explicitly what material you still need **from the founder** (assets, dates, claims you cannot verify, positioning calls only they can make) rather than inventing it; propose strategy as options with tradeoffs plus a recommendation; prefer what this workspace has already learned over generic best practice, and say when you are falling back on the generic; and — the capability boundary — you can read everything and change nothing, so when the conversation reaches the point of building, say what you *would* create and that acting on it is not yet available, never implying it happened.

**Implementation note (differs from the first draft of this spec):** the directive is the `TASK_INSTRUCTIONS.gtm_conversation` entry in `packages/brain/src/resolver.ts`, not a string appended by a service. That is strictly better and is why the task type earns its keep: the directive travels inside the bundle, lands last like every other task instruction, and is therefore **inspectable in `/resolver`** rather than hidden in `chat-context.ts`. Only the thread goal is prepended outside the bundle — the resolver has no layer meaning "what this conversation is for".

`buildChatContext` lives in `services/chat-context.ts` and reuses `resolve-input.ts`'s existing helpers (`selectiveContextInputs`, `campaignResolveInputs`, `priorExampleInputs`, `preferenceRuleInputs`) exactly as `routes/generations.ts` does — the bundle a thread sees is assembled by the same code path as the bundle a draft sees.

Evidence, prior examples and preference rules participate through the same optional inputs every other call site uses. Retrieval is driven by a new highest-precedence `RetrievalContext.conversation` field (goal + latest message): a conversation states its subject directly, where every other call site has to infer one.

### 4.4 Tools

**Existing (11, unchanged):** `search_evidence`, `get_brain_section`, `get_campaign_plan`, `list_recent_publications_with_metrics`, `find_similar_approved_drafts`, `find_instructive_rejections`, `get_persona`, `list_channel_guardrails`, `search_discovery_items`, `get_prior_posts_on_topic`, `safe_fetch_url`.

**New (6), appended to `READ_TOOL_NAMES` and `READ_TOOLS` in order:**

| Tool | Wraps | Why chat needs it |
|---|---|---|
| `list_campaigns` | `services/campaigns` | Maps "the launch campaign" to an id. Without it the model cannot scope anything. |
| `list_personas` | `services/personas` | The intake question "who is this for?" needs the real answer set, not invention. |
| `get_campaign_insights` | `getCampaignInsights` (Sprint 55) | Per-campaign performance rollup. |
| `get_workspace_insights` | `getWorkspaceInsights` (Sprint 55) | "What's working?" across the workspace. |
| `get_metric_summary` | `listMetricsForSubject` + rollup | Windowed metric rollup by channel/campaign — the acceptance case's "engagement dropped last month". |
| `get_sequence_funnel` | outreach funnel service | Reply/meeting rates for outbound. |

Each is a thin `Tool<I, O>` in `apps/api/src/agents/tools/`, `access: "read"`, input schema in `packages/contracts` `toolInputSchemas`, added to `AGENT_TOOL_NAMES` — the existing lockstep test between `READ_TOOL_NAMES` and `READ_TOOLS` keeps them honest. Every one reads through an existing service; **no aggregation logic is reinvented**, which is the same rule Sprint 42 followed and the reason these are cheap.

The Sprint 42 tools that do **not** survive: `search_brain` (superseded by `get_brain_section`), `list_outreach_sequences` and `list_audiences` and `list_leads` (out of scope for a strategy conversation; add them when a thread needs them), `get_workspace_summary` (a composite of three reads the model can now make itself).

### 4.5 Streaming

SSE over `reply.raw` — Fastify's `reply.hijack()` then manual `writeHead`/`write`. Event names and payloads (all `data:` JSON):

| Event | Payload | Source |
|---|---|---|
| `session` | `{ sessionId, userMessageId, assistantMessageId }` | Emitted first so a client can render placeholders. |
| `compaction` | `{ messageId, summarizedThrough, agentRunId }` | `maybeCompact` |
| `step_start` | `{ stepIndex }` | runner |
| `text_delta` | `{ stepIndex, text }` | runner |
| `tool_call_start` | `{ stepIndex, name, arguments }` | runner |
| `tool_call_end` | `{ stepIndex, callId, ok, error? }` | runner (**result payload is dropped** — tool results can be large and the citation mapper already extracts what the client needs) |
| `step_end` | `{ stepIndex, usage }` | runner |
| `message` | the persisted `ChatMessage` | turn service |
| `done` | `{ stopReason, usage, costCents, threadTokens, threadCostCents }` | turn service |
| `error` | `{ error, message }` | turn service |

A heartbeat comment (`:\n\n`) every 15s keeps proxies from closing an idle stream during a long tool call. The connection closes after `done` or `error`; there is no reconnect/resume in this sprint (a dropped stream leaves a fully persisted transcript the client refetches).

**Client:** `apiFetch` already returns a `Response`, so the drawer reads `res.body.getReader()` and parses frames. `EventSource` is not usable — it cannot carry the bearer token.

### 4.6 Compaction

Triggered when the estimated transcript tokens exceed **60%** of the per-turn `maxTokens` (32k → 19.2k). Behaviour:

- Keep verbatim: the system prefix (not part of the transcript), the thread goal, and the **most recent 6 messages**.
- Summarize: everything older that is not already inside a previous compaction, in one `cheap`-tier `AgentRunner` run (`task: "chat:compaction"`, no tools, `responseSchema` for a bounded summary + a `pinnedEntities: string[]`).
- Persist: a `compaction`-role message holding the summary, and `compacted_through_message_id` on the session.
- Subsequent turns build their message list from `[latest compaction message] + [messages after it]`.
- On failure the compaction degrades to a truncation with a persisted note — a compaction that throws must never lose a turn.

### 4.7 Caps and budgets

| Bound | Value | Enforced |
|---|---|---|
| Per-thread lifetime tokens | **250,000** (`CHAT_THREAD_TOKEN_CAP`) | Checked before the turn; exceeded → `409 { error: "thread_budget_exhausted" }` with a message telling the founder to start a new thread. |
| Per-turn model calls | 8 (`maxSteps`) | `AgentRunner` |
| Per-turn tokens | 32,000 (`maxTokens`) | `AgentRunner` |
| Per-turn wall clock | 120,000 ms | `AgentRunner` |
| Per-turn tool calls | 20, with `safe_fetch_url` capped at 3 | `DEFAULT_TOOL_BUDGET` (existing) |
| Workspace LLM budget | existing | `assertLlmBudget` → 402 |

All chat model calls go through `meteredLlm(..., { pipeline: "copilot" })` so they land in `llm_usage_events` and roll up in `/billing` exactly as before — the pipeline name is kept for ledger continuity (D-76.7).

### 4.8 What gets deleted

- `apps/api/src/services/copilot.ts` — replaced by `services/chat-turn.ts`. `parseJsonObject` goes with it (Sprint 58 called it "the ONE surviving free-text parser"; this sprint is its stated migration).
- `apps/api/src/services/copilot-tools.ts` — replaced by the registry.
- `apps/api/src/services/copilot-actions.ts` — the Sprint 42 write path. Sprint 78 replaces it with propose-tools.
- `POST /workspaces/:id/chat/sessions/:sessionId/confirm` and the affirmative-detection path.
- Contracts: `COPILOT_WRITE_TOOLS`, `chatProposalSchema`, `confirmChatProposalInputSchema` and the `proposal` / `status: "awaiting_confirmation" | "committed"` fields on `chatTurnResultSchema`. `producedRef` stays on `chatMessageSchema` (D-76.7).
- `apps/api/test/copilot.test.ts` and `copilot-actions.test.ts` — superseded by the new suites.

---

## 5. API surface

| Route | Change |
|---|---|
| `POST /workspaces/:id/chat/sessions` | Body gains optional `campaignId`, `personaId`, `channel`, `goal`. |
| `GET /workspaces/:id/chat/sessions` | Unchanged shape + new scope/cost fields. |
| `GET /workspaces/:id/chat/sessions/:sid` | Unchanged shape + new message fields. |
| `PATCH /workspaces/:id/chat/sessions/:sid` | **New** — edit `title`, `goal`, scope. |
| `POST /workspaces/:id/chat/sessions/:sid/messages` | **Rebuilt.** SSE when `Accept: text/event-stream`, else JSON. |
| `DELETE /workspaces/:id/chat/sessions/:sid` | Unchanged. |
| `POST /workspaces/:id/chat/sessions/:sid/confirm` | **Removed** (D-76.1). |

`registerChatRoutes(app, db, llm, evidence, safeFetch)` — the `externalActionRuntime` argument is dropped (there is no write path) and `safeFetch` is added (the `safe_fetch_url` read tool needs it).

---

## 6. Implementation plan

1. **Contracts** — `gtm_conversation` task type + matrix row + `GENERATION_TASK_TYPES`; `"compaction"` role; six new tool names + input schemas; `CHAT_THREAD_TOKEN_CAP`, `CHAT_COMPACTION_THRESHOLD`, `CHAT_TURN_BOUNDS`; extended `chatSessionSchema` / `chatMessageSchema` / `chatTurnResultSchema`; new `chatStreamEventSchema`; delete the proposal schemas.
2. **Migration 0077** — edit `schema.ts`, run `db:generate`, commit the generated SQL.
3. **Six registry tools** + registration in `agents/tools/index.ts`.
4. **`services/chat-context.ts`** (leaf) — `buildChatContext(db, session) → ResolvedContext`.
5. **`services/chat-citations.ts`** (leaf) — per-tool result → `ChatCitation[]`.
6. **`services/chat-compaction.ts`** — `maybeCompact(...)`.
7. **`services/chat-turn.ts`** — `runChatTurn(db, deps, workspaceId, actor, sessionId, message, onEvent?)`. Replaces `copilot.ts`.
8. **`services/chat.ts`** — extend persistence for the new columns, scope, totals, auto-title.
9. **`routes/chat.ts`** — rebuild, SSE adapter, `PATCH`, drop `confirm`; update `app.ts` wiring.
10. **Delete** the Sprint 42 machinery (§4.8).
11. **Web** — `lib/chat-stream.ts` (frame parser) + `lib/chat-thread-view.ts` (view helpers) with tests; rebuild `components/copilot/copilot.tsx` for streaming, scope chips, goal, citations, per-turn cost, thread cost, Inspector link.
12. **Web pickers** — swap `TASK_TYPES` for `GENERATION_TASK_TYPES` in `/sandbox`, `/resolver`, `/learning`, `/ad-creatives`, the campaign plan form.
13. **Tests** (§7).

---

## 7. Tests

| File | Covers |
|---|---|
| `packages/contracts/test/chat-foundations.test.ts` | New task type has a matrix row; `GENERATION_TASK_TYPES` excludes exactly `gtm_conversation`; roles include `compaction`; tool-name lockstep; schema round-trips; proposal schemas gone. |
| `apps/api/test/chat-tools.test.ts` | Each of the six new tools: workspace scoping, empty-state note, arg validation, `access === "read"`. |
| `apps/api/test/chat-context.test.ts` | Bundle resolves with and without campaign/persona/channel; campaign plan participates; goal renders; the bundle is the resolver's, not a hand-written preamble. |
| `apps/api/test/chat-turn.test.ts` | Scripted gateway: a turn calls a tool and answers; **only read tools are offered** and the propose/ask services are absent (D-76.9); citations are produced for a tool-backed claim; a tool failure degrades to an answer; `max_steps` and gateway errors are results, not throws; the assistant message carries a real `agent_run_id` whose steps are persisted; thread totals accumulate; the 250k cap trips; auto-title on the first turn. |
| `apps/api/test/chat-compaction.test.ts` | Fires at threshold; keeps the last 6 verbatim; persists a `compaction` message + its own run; subsequent turns build from the compaction; a failing compaction degrades without losing a turn. |
| `apps/api/test/chat-route.test.ts` | JSON path; SSE path (headers + frame order `session → … → message → done`); 402 on workspace budget; 409 on thread cap; `PATCH` scope edit; `confirm` is gone (404); cross-workspace isolation. |
| `apps/web/lib/chat-stream.test.ts` | Frame parsing incl. split chunks, heartbeats, malformed frames. |
| `apps/web/lib/chat-thread-view.test.ts` | Message grouping, citation rendering, cost formatting, cap warning copy. |
| `apps/web/lib/chat-shell-contract.test.ts` | The drawer's mount points: scope chips, goal, Inspector link, citation chips, cost. |

Plus regression: `npm run typecheck` clean, full `npm test` green, `npm run eval` no regression.

---

## 8. Acceptance (PRD)

> *"Why did our LinkedIn engagement drop last month?" streams an answer citing specific publications and metric records, and the Agent Inspector shows which tools produced it. No answer is produced from the model's parametric memory alone.*

Covered by `chat-route.test.ts` (SSE frame order), `chat-turn.test.ts` (citations present, `agent_run_id` persisted with steps) and `chat-tools.test.ts` (`get_metric_summary` + `list_recent_publications_with_metrics` return the records cited).

**Founder acceptance checklist:**
1. Open the drawer, create a thread scoped to a campaign, and watch an answer stream token by token with tool calls appearing as they run.
2. Ask the engagement question — the answer cites specific publications; click a citation and land on the record.
3. Open the Inspector and find the run for that turn, with its tools and step costs.
4. Say *"I want to launch a campaign for our new product across LinkedIn and email"* — the assistant asks clarifying questions, names what it needs from you, and proposes strategy options; it states plainly that creating it arrives next rather than claiming it did.
5. Confirm the thread's running cost is displayed and nothing in the workspace changed.

---

## 9. Out of scope

- **Any write.** No proposals, no drafts, no campaigns created — Sprint 78 (D-76.1).
- **Background / detached runs**, subagents, interrupt-and-steer — Sprint 79.
- **Generative UI**: typed result cards, `/` commands, `@` mentions, keyboard summon, image paste — Sprint 77.
- **File/material upload.** The founder's flow asks the client for materials; this sprint can *ask*, and `safe_fetch_url` can read a link, but there is no upload path yet. Sprint 77 owns it.
- **A dedicated `/chat` page** (D-76.3).
- **Stream resume/reconnect** (§4.5).
- **Role-filtered tools** — Sprint 78; every member sees the same read set here, which is exactly the workspace-membership rule the HTTP routes already enforce.
- **Untrusted-content quarantine.** `safe_fetch_url` and `search_discovery_items` return attacker-influenced text, but chat holds **no write tools in this sprint**, so the injection→action path does not exist yet. Sprint 78 introduces it and owns the quarantine, per the PRD.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **First SSE in the platform.** No precedent for `reply.hijack()` here, and `app.inject` may not capture raw writes. | The turn service is the testable unit (D-76.10). If `inject` cannot read the stream, the one SSE route test falls back to a real `app.listen(0)` + `fetch`. Recorded here so the reviewer knows it was a considered fallback, not a shortcut. |
| **Deleting the Sprint 42 write path is a visible regression** until 78. | Founder's explicit call (D-76.1). Mitigated by running 77 and 78 immediately after (see §11). |
| **Adding a `TASK_TYPE` touches every picker.** | Typechecker catches the matrix row; `GENERATION_TASK_TYPES` + a contracts test catch the pickers. Blast radius measured at 5 web files. |
| **Long threads get expensive** despite compaction. | 250k hard cap + per-turn bounds + `assertLlmBudget` + in-thread cost display. Three independent stops. |
| **The conversation directive is prose, and prose regresses silently.** | The intake behaviour gets an eval case in the golden suite, not just a unit test. |

---

## 11. Sequencing note for the founder

The PRD's recommended order runs **73 (durable queue)** after 71. Given the target interaction in §0, the better order is **76 → 77 → 78**, then 73 before 79 — 79 is the only remaining sprint that actually requires the queue, and 78 is what makes chat able to create the campaign. That is three L sprints to the founder's stated vision instead of one XL infrastructure sprint first. Raised at merge review; this spec assumes nothing about it.

---

## 12. Progress log

- 2026-08-07 — **Implemented and verified green.** `npm run typecheck` clean; `npm test` 291 files / 2,965 tests passing (Sprint 71 baseline was 284 / 2,861 — +7 files, +104 tests, after deleting the two Sprint 42 copilot suites); `npm run eval` → "✓ No regression" (hard checks 20%, reject recall 100%, approve pass rate 100%, agreement 100%). Migration **0077**.
  - **Contracts:** `gtm_conversation` task type + its `DEFAULT_TASK_DOC_MATRIX` row (icp/history full) + `GENERATION_TASK_TYPES`; `compaction` role; `CHAT_THREAD_TOKEN_CAP` (250k), `CHAT_TURN_BOUNDS`, `CHAT_COMPACTION_THRESHOLD`/`_KEEP_RECENT`, `CHAT_GOAL_MAX_CHARS`; six new `READ_TOOL_NAMES` + `toolInputSchemas`; rewritten `chatSessionSchema` / `chatMessageSchema` / `chatTurnResultSchema`, new `updateChatSessionInputSchema` and `chatStreamEventSchema`; deleted `COPILOT_WRITE_TOOLS`, `chatProposalSchema`, `confirmChatProposalInputSchema`, `CHAT_TURN_STATUSES`.
  - **Two contract blocks were relocated, and both were load-bearing.** `chatStreamEventSchema` references `AGENT_STOP_REASONS` and the new tool schemas reference `METRIC_*`, both of which were declared *later* in `index.ts` — evaluated at module top level, that is a TDZ crash at import, not a type error. The chat block moved below the agent runtime section and the Sprint 55 metric vocabulary moved above it. Dependency order in this file is a runtime constraint, not a matter of taste.
  - **Services:** `chat-context.ts` (leaf), `chat-citations.ts` (leaf), `chat-compaction.ts`, `chat-turn.ts`; `chat.ts` extended for scope, lifetime totals, `listActiveMessages` and the cap predicate. `summarizeMetrics` added to `services/metrics.ts` — the rollup is business logic, so it lives in the service and the tool stays a wrapper.
  - **Routes:** `routes/chat.ts` rebuilt — SSE via `reply.hijack()` on `Accept: text/event-stream`, JSON otherwise, new `PATCH`, `/confirm` deleted, `app.ts` rewired to pass `guardedFetch` instead of the external-action runtime.
  - **Deleted:** `services/copilot.ts` (with `parseJsonObject`, which Sprint 58 called "the ONE surviving free-text parser" and named this sprint as its migration), `services/copilot-tools.ts`, `services/copilot-actions.ts`, and their two test suites.
  - **Web:** `lib/chat-stream.ts`, `lib/chat-thread-view.ts`, the rebuilt streaming drawer, and the four task-type label maps.
  - **The SSE risk did not materialize.** `app.inject` captures `reply.raw` writes, so the route test asserts real frame ordering (`session → tool_call_start → text_delta → message → done`) without a live server. The `app.listen(0)` fallback in §10 was not needed.
  - **Note for the reviewer — D-76.6 landed half as written.** The pickers do iterate `GENERATION_TASK_TYPES`, but the four `Record<TaskType, string>` label maps kept their full type and gained a `gtm_conversation` label. Narrowing them to `Record<GenerationTaskType, string>` broke `/learning` and `/sandbox`, which index those maps with a task type read *off a stored row* — a narrowed map makes a legitimate lookup a type error and, at runtime, would render `undefined`. Offering the task and labelling it are different questions; only the first needed restricting.
  - **Note for the reviewer — two tools deliberately produce no citations.** `find_similar_approved_drafts` and `find_instructive_rejections` return prior text *without the record id that produced it*, so there is nothing to link to. They are style anchors rather than sources of factual claims, so nothing is lost — but a chip that cannot be opened is worse than no chip, and the test asserts zero so this reads as a decision rather than an oversight. Fixing it means changing what those tools return, which is a shared-registry change and not this sprint's to make.
  - **Note for the reviewer — the metric rollup enforces Sprint 55's rule rather than assuming it.** `get_metric_summary` requires `window` (never defaulted) and aggregates by window *kind*: periodic (`1d`) sums every observation, cumulative (`24h`/`7d`) and point take **one reading per subject** before summing across subjects. Summing a publication's successive 7d readings would report 280 impressions for a post that has had 180. The result carries a plain-language `interpretation` back to the model, and the tests assert each kind separately.
  - **Tests:** `packages/contracts/test/chat-foundations.test.ts` (14), `apps/api/test/chat-tools.test.ts` (17), `chat-context.test.ts` (17 — bundle + citations), `chat-turn.test.ts` (15), `chat-compaction.test.ts` (10), `chat-route.test.ts` (9), `apps/web/lib/chat-stream.test.ts` (12), `chat-thread-view.test.ts` (17), `chat-shell-contract.test.ts` (10). The existing `agent-tools-isolation.test.ts` sweep forced tenant coverage for all six new tools and gained two assertions for the aggregate leak a marker sweep structurally cannot catch — no name crosses the boundary, just a number that is silently too big.
- 2026-08-06 — Spec written. Branch `sprint-76-chat-foundations` cut from `sprint-71-show-the-work` (bd5edee). Four founder decisions locked (D-76.1–.5, with D-76.4 raised to 250k on founder instruction); seven taken in-spec (D-76.6–.12). Surveyed: `AgentRunner` already emits `text_delta` / `tool_call_start` / `tool_call_end` / `step_start` / `step_end` / `run_end` and the gateway declares `agentStepStream`, so streaming needs **no runtime change** — only transport; the Sprint 57 registry's 11 read tools with `access` enforcement and `DEFAULT_TOOL_BUDGET`; `ResolvedContext.prompt` as the ready-made system prefix and `services/resolve-input.ts` as the assembly helper set; `meteredLlm` + `assertLlmBudget` as the existing spend controls; **no SSE anywhere in the repo** — this is the first; the Sprint 42 copilot (`copilot.ts` free-text tool-loop, `copilot-tools.ts` 10-tool registry, `copilot-actions.ts` propose/confirm, `chat_sessions`/`chat_messages`, the drawer at `apps/web/src/components/copilot/`) as the thing being rebuilt in place; `copilot.ts:105`'s own comment naming this sprint as its migration.
