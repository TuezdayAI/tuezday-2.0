# Sprint 56 — Gateway v2 & AgentRunner

> **Phase:** J (Agent Runtime Foundation) · **Workstream:** W3 · **Direction doc:** Move 1
> **PRD:** `docs/plans/prd-agentic-platform.md` §5, Sprint 56
> **Branch:** `sprint-56-gateway-v2-agent-runner` (off `main` @ `9d8714a`, post-Sprint-52 merge)
> **Size:** XL · **Risk:** Medium · **Blocks:** everything in Phases J–M
> **Status:** see Progress log at the bottom.

Phase J is pure capability: **no product behavior changes in this sprint.** Nothing in the
product calls the new runtime yet — Sprint 57 (tool registry + Agent Inspector) is the first
consumer. The founder-visible artifact for this sprint is the test suite plus rows in two new
tables; the exit criterion for the phase ("an agent can run a bounded, tool-using, fully-traced
loop inside a workspace") is proven here by automated tests against a scripted gateway.

Phase-skip note (founder decision, 2026-08-03): Sprints 53–55 are complete on a teammate's
machine but unpushed. Sprint 56 has **no dependency** on 53–55 (PRD §13: depends "—"), so it
proceeds directly off `main`. First sprint that needs 53 is Sprint 61 (Phase K).

---

## 1. Problem

`LlmGateway` is `generate({prompt, maxOutputTokens}) → {text}` — single-shot, no message
history, no tools, no structured output, no usage accounting. Every service is therefore
forced into prompt-assembly-then-parse-text, and nothing agentic can exist. This sprint adds
a real agent runtime **alongside** `generate()` without touching it.

## 2. Scope

**In:**
1. Contracts: agent vocabularies (stop reasons, run statuses, message roles, step kinds) and
   zod schemas for messages / tool calls / usage in `packages/contracts`.
2. Gateway v2: a per-model-call primitive (`agentStep`) with messages, tools, constrained
   JSON output, and usage — plus a streaming variant (`agentStepStream`).
3. Gemini implementation of both (function calling + `responseSchema` + SSE streaming +
   `usageMetadata`).
4. `FallbackGateway` passthrough for the new methods (OpenRouter impl itself is a later
   sprint; the interface is shared now, per PRD).
5. `AgentRunner`: the loop — call model → dispatch tool calls → append results → repeat until
   complete or a bound trips (`maxSteps`, `maxTokens`, `timeoutMs`), with `needs_human` as a
   tool-raisable stop and `error` capture.
6. Persistence: `agent_runs` + `agent_run_steps` (full transcript, tool calls with arguments
   and results, per-step usage, stop reason).
7. Cost accounting: token usage → `costCents` via a per-model pricing table.
8. Streaming variant of the runner emitting token deltas, tool-call start/end, step
   boundaries, and stop reason (the Phase-O chat surface depends on this shape).
9. One proof tool: `search_evidence` over the native evidence store.
10. `ScriptedGateway` — the testing contract: canned sequence of steps, fully deterministic,
    no network.

**Out (explicitly deferred):**
- Tool registry, `read`/`propose` access tiers, per-tool budgets, Agent Inspector UI → Sprint 57.
- Migrating any existing service to structured output → Sprint 58.
- Model routing/tiers, prompt-cache measurement, entitlements → Sprint 59.
- Any HTTP route. The runner is invoked in-process; read routes ship with the Inspector (57).
- OpenRouter `agentStep` implementation (interface only, per PRD "Gemini first").

## 3. Design

### 3.1 Contracts (`packages/contracts`)

New vocabularies (single source of truth, per repo rule):

```ts
export const AGENT_STOP_REASONS = [
  "complete", "max_steps", "max_tokens", "timeout", "needs_human", "error",
] as const;
export const AGENT_RUN_STATUSES = ["running", "done"] as const; // stopReason set iff done
export const AGENT_MESSAGE_ROLES = ["user", "assistant", "tool"] as const; // system is a separate stable prefix
export const AGENT_STEP_KINDS = ["model_call", "tool_call"] as const;
```

Zod schemas: `agentToolCallSchema` (`{id, name, arguments}`), `agentMessageSchema`
(`{role, content, toolCalls?, toolCallId?, toolName?}`), `agentUsageSchema`
(`{inputTokens, outputTokens, cachedTokens, costCents}`). These validate persisted
transcripts now and become the Inspector API contract in Sprint 57.

### 3.2 Gateway v2 (`apps/api/src/llm/gateway.ts`)

`generate()` and `embed()` are untouched. The gateway-level primitive is **one model
invocation**, not the loop — the loop belongs to `AgentRunner` (so bounds, persistence and
tool dispatch stay provider-agnostic):

```ts
export interface ToolDefinition { name: string; description: string; inputSchema: JsonSchema }

export interface AgentStepParams {
  system: string;                 // stable prefix → cacheable (Sprint 59 measures)
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  responseSchema?: JsonSchema;    // constrained JSON output on the final step
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AgentStepResult {
  message: AgentMessage;          // assistant message: text and/or toolCalls
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  model: string; provider: string; durationMs: number;
}

export type AgentStepStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: AgentToolCall };

interface LlmGateway {
  generate(...); embed?(...);
  agentStep?(params: AgentStepParams): Promise<AgentStepResult>;
  agentStepStream?(params: AgentStepParams, onEvent: (e: AgentStepStreamEvent) => void): Promise<AgentStepResult>;
}
```

Both new methods are optional so every existing fake stays valid. The runner requires
`agentStep`; it uses `agentStepStream` when present *and* the caller asked for events,
otherwise degrades to non-streaming (one whole-text delta), so streaming is never a
correctness requirement.

### 3.3 Gemini implementation (`apps/api/src/llm/gemini.ts`)

- Mapping: `user`→`user`, `assistant`→`model` (text part + `functionCall` parts),
  `tool`→`user` with a `functionResponse` part. `tools` →
  `[{ functionDeclarations: [{name, description, parameters}] }]`. `responseSchema` →
  `generationConfig.responseMimeType: "application/json"` + `responseSchema`.
- Gemini does not return tool-call ids — the gateway mints them (`call_<step>_<i>` style
  uniqueness is the runner's job; the gateway uses a monotonic counter per response).
- Usage from `usageMetadata`: `promptTokenCount` → inputTokens, `candidatesTokenCount`
  (+ `thoughtsTokenCount` if present) → outputTokens, `cachedContentTokenCount` → cachedTokens.
- Streaming via `:streamGenerateContent?alt=sse` — parse `data:` lines, emit `text_delta`
  per chunk text part and `tool_call` per functionCall part, accumulate the final result.
- Thinking stays disabled (same `thinkingBudget: 0` knob as `generate`); Sprint 59 owns
  tiering decisions.

### 3.4 Pricing (`apps/api/src/llm/pricing.ts`)

`costCents(model, usage) → number` from a static per-model table (cents per 1M tokens:
input / output / cached input). Gemini 2.5 Flash seeded; unknown models cost 0 (accounting
telemetry, not billing — Sprint 59 hardens this into entitlements). Stored as REAL.

### 3.5 AgentRunner (`apps/api/src/agents/runner.ts`)

```ts
export interface AgentTool {
  definition: ToolDefinition;
  handler: (args: unknown) => Promise<unknown>;   // Sprint 57 wraps registry tools into this
}

export interface AgentRunParams {
  workspaceId: string;
  task: string;                    // short label, persisted ("proof", later "pipeline:research")
  createdBy: string;               // actor attribution label
  system: string;
  messages: AgentMessage[];        // initial user message(s)
  tools?: AgentTool[];
  responseSchema?: JsonSchema;
  maxSteps: number; maxTokens: number; timeoutMs: number;
  onEvent?: (e: AgentRunEvent) => void;   // streaming variant
}

export interface AgentRunResult {
  runId: string;
  messages: AgentMessage[];        // full transcript (input + everything appended)
  toolCalls: AgentToolCall[];
  output: unknown;                 // JSON.parsed final text when responseSchema given, else final text
  usage: { inputTokens; outputTokens; cachedTokens; costCents };
  stopReason: AgentStopReason;
}
```

Loop semantics:
1. Insert `agent_runs` row (`status: "running"`), emit `run_start`.
2. Each iteration: check deadline and token budget **before** calling the model; call
   `agentStep` with `AbortSignal` bound to the remaining time; persist a `model_call` step
   (assistant message JSON, per-step usage, duration); emit `step_start`/`text_delta`/…/`step_end`.
3. If the assistant message has tool calls: dispatch each sequentially via its handler —
   persist a `tool_call` step per call (name, arguments JSON, result JSON **or** error text,
   duration), emit `tool_call_start`/`tool_call_end`, append a `tool` message. A tool
   **handler error is data, not a crash**: the error text goes back to the model as the tool
   result and the loop continues. A handler may `throw new NeedsHumanSignal(reason)` to stop
   the run with `needs_human`.
4. No tool calls → terminal step: with `responseSchema`, `JSON.parse` the text (parse failure
   → `stopReason: "error"`; schema-level zod validation is Sprint 58's `generateStructured`);
   `stopReason: "complete"`.
5. Bounds: steps exhausted → `max_steps`; cumulative tokens ≥ maxTokens → `max_tokens`;
   deadline passed or in-flight abort → `timeout`. `GatewayError` → `error`.
6. Finalize the run row (status `done`, stop reason, totals, cost, finishedAt), emit
   `run_end`. **The runner never throws for run-level outcomes** — every outcome is a result
   with a stop reason; only programmer errors (e.g. gateway lacks `agentStep`) throw.

Runner events (superset of gateway stream events — the Phase-O SSE payload shape):

```ts
type AgentRunEvent =
  | { type: "run_start"; runId: string }
  | { type: "step_start"; stepIndex: number }
  | { type: "text_delta"; stepIndex: number; text: string }
  | { type: "tool_call_start"; stepIndex: number; call: AgentToolCall }
  | { type: "tool_call_end"; stepIndex: number; callId: string; result?: unknown; error?: string }
  | { type: "step_end"; stepIndex: number; usage: AgentStepUsage }
  | { type: "run_end"; stopReason: AgentStopReason; usage: AgentRunUsage };
```

### 3.6 Persistence (`apps/api/src/db/schema.ts` + generated migration)

```
agent_runs:      id PK, workspace_id FK→workspaces (cascade), task, created_by,
                 status ("running"|"done"), stop_reason (nullable until done), error (nullable),
                 model, provider, system, input_messages_json,
                 input_tokens, output_tokens, cached_tokens, cost_cents (REAL), step_count,
                 output_json (nullable), started_at, finished_at (nullable)
agent_run_steps: id PK, run_id FK→agent_runs (cascade), step_index, kind ("model_call"|"tool_call"),
                 message_json (model_call: the assistant message),
                 tool_name, tool_call_id, tool_args_json, tool_result_json, tool_error (tool_call),
                 input_tokens/output_tokens/cached_tokens/cost_cents (model_call, else 0),
                 duration_ms, created_at
                 index (run_id, step_index)
```

The full transcript is reconstructible without duplication: run row holds the input
(system + initial messages); steps hold everything appended, in order. This is exactly what
the Sprint 57 Inspector renders.

### 3.7 Proof tool (`apps/api/src/agents/tools/search-evidence.ts`)

`searchEvidenceTool(db, store, workspaceId): AgentTool` — input `{query, limit?≤10}`;
reuses `ensureWorkspaceCollection` and the ready-document filter from `services/evidence.ts`
(same workspace-scoping discipline as `retrieveEvidence`), returns
`[{title, kind, text, score}]`. Demonstrates the loop end to end; the full read-tool set is
Sprint 57.

### 3.8 ScriptedGateway (`apps/api/src/llm/scripted.ts`)

The testing contract, exported from `src` (it *is* part of the sprint's deliverable, like
the fakes contract in `buildApp`): constructed with a canned sequence of step results
(`{text?, toolCalls?, usage?, delayMs?}`); `agentStep` shifts the next one;
`agentStepStream` re-emits the text as multiple deltas and tool calls as events before
resolving identically; records every received `AgentStepParams` for assertions. `delayMs`
makes timeout tests deterministic-ish without real model latency. Throws if the script is
exhausted (a test that over-calls is a bug).

## 4. Step-by-step plan

1. **Contracts** — vocabularies + zod schemas (§3.1); `npm run typecheck`.
2. **Gateway types** — §3.2 types in `llm/gateway.ts`; `ScriptedGateway` in `llm/scripted.ts`.
3. **Schema + migration** — §3.6 tables; `npm run db:generate -w apps/api`; commit SQL.
4. **Pricing** — `llm/pricing.ts` with Gemini 2.5 Flash rates + unit test.
5. **AgentRunner** — §3.5 loop + persistence + events, with the test file driving it
   (tests written with implementation, red→green):
   - three-step tool loop against `ScriptedGateway`; assert persisted transcript,
     tool calls with args/results, per-step usage, run totals, `complete`.
   - `max_steps`, `max_tokens`, `timeout` each trip and are recorded as stop reason.
   - tool handler error → error result fed back, loop continues.
   - `NeedsHumanSignal` → `needs_human`.
   - `GatewayError` mid-run → `error`, run finalized (never stuck `running`).
   - `responseSchema` → parsed `output`; malformed JSON → `error`.
   - streaming: event order (`run_start`→`step_start`→deltas→`tool_call_*`→`step_end`→…→`run_end`),
     deltas concatenate to persisted text; non-streaming gateway degrades to one delta.
6. **Proof tool** — `search_evidence` + test: agent loop that searches a seeded in-memory
   evidence store and answers from it.
7. **Gemini agentStep/agentStepStream** — request/response mapping + SSE parsing, tested with
   a stubbed `fetch` (no network); `FallbackGateway` passthrough + test.
8. **Full verify** — `npm test`, `npm run typecheck`; update Progress log; push branch;
   sync Plane (TAP epic for Sprint 56 → comment with branch/HEAD/status; Done only when
   founder-merge status is recorded per CLAUDE.md rule 8).

## 5. Acceptance (from PRD)

- [x] A test drives a three-step tool-using loop against `ScriptedGateway` and asserts on the
      persisted transcript (`test/agent-runner.test.ts`).
- [x] Bounds trip correctly and are recorded as the stop reason (`max_steps`, `max_tokens`,
      `timeout`, `needs_human`, `error` each covered).
- [x] `generate()` untouched (`git diff` shows no change to its signature or behavior).
- [x] Streaming variant emits token deltas, tool-call start/end, step boundaries, stop reason
      (runner events + Gemini SSE parsing, both tested).
- [x] `search_evidence` proof tool demonstrates the loop end to end.
- [x] Usage (input/output/cached tokens + costCents) recorded per step and per run.

## 6. Progress log

- 2026-08-03 — Branch created off `main` @ `9d8714a`. Spec written. Implementation started.
- 2026-08-03 — Implemented in full: contracts vocabularies + schemas; Gateway v2
  (`agentStep`/`agentStepStream` on `LlmGateway`, Gemini implementation with function calling,
  constrained JSON output and SSE streaming, `FallbackGateway` passthrough); `ScriptedGateway`
  testing contract; `llm/pricing.ts` cost accounting; `agent_runs`/`agent_run_steps` tables
  (migration `0064_sprint_56_gateway_v2_agent_runner.sql` after reconciliation with Sprints 53–55);
  `AgentRunner` with bounds, tool dispatch,
  `NeedsHumanSignal`, streaming events and full persistence; `search_evidence` proof tool.
  25 new tests (`agent-runner.test.ts` 16, `agent-gateway.test.ts` 9). Full suite green:
  2136/2136 across 197 files; typecheck clean. Awaiting founder review/merge.
