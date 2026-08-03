# Sprint 57 — Internal tool registry & Agent Inspector

> **Phase:** J (Agent Runtime Foundation) · **Workstream:** W3 · **Direction doc:** Move 2
> **PRD:** `docs/plans/prd-agentic-platform.md` §5, Sprint 57
> **Branch:** `sprint-57-tool-registry-agent-inspector` (off `sprint-56-gateway-v2-agent-runner` @ `18f9e26`)
> **Merge order:** `sprint-56-gateway-v2-agent-runner` must merge to `main` **before** this branch — Sprint 57 consumes the Sprint 56 runtime (`AgentRunner`, `agent_runs`/`agent_run_steps`, contracts vocabularies) directly.
> **Size:** XL · **Risk:** Low · **Depends on:** 56 (agent runtime), 48 (safe fetch)
> **Status:** see Progress log at the bottom.

Sprint 56 built the loop; nothing in the product calls it yet. This sprint gives the model
its capability surface (an internal tool registry with eleven read tools) and gives humans
the window onto it (the Agent Inspector, `/resolver`'s sibling). The founder-visible
artifact: trigger a proof run from the Inspector and watch exactly what the agent looked
up, in what order, and what it cost.

**Founder decision (2026-08-03):** one registry long-term. The Sprint 57 registry is the
canonical internal capability surface; the Sprint 42 copilot registry
(`services/copilot-tools.ts`) migrates onto it **in this sprint** as the final, severable
task (no behavior change, guarded by copilot's existing tests). If migration turns out
hairier than expected it drops to an immediate fast-follow without blocking acceptance.

---

## 1. Problem

The platform's capabilities are not exposed to the model. `apps/mcp` is a six-tool
customer-facing shim over the public API, not an internal capability surface. Sprint 56's
`AgentRunner` accepts `AgentTool[]` but only one hand-built proof tool exists
(`agents/tools/search-evidence.ts`), with no access tiers, no actor attribution, no
budgets, and no way for a human to see what an agent did. Separately, Sprint 42's copilot
carries its own private read-tool registry (`services/copilot-tools.ts`, 10 tools) — two
registries that drift is the predictable failure mode.

## 2. Scope

**In:**
1. Contracts: `TOOL_ACCESS_LEVELS` vocabulary, per-tool input schemas, agent-run API
   schemas (`agentRunSummarySchema`, `agentRunStepSchema`, `agentRunDetailSchema`) in
   `packages/contracts`.
2. The registry: `Tool<I, O>` interface with `access: "read" | "propose"`, a
   `ToolContext { db, evidence, safeFetch, workspaceId, actor, budget }`, and a
   whitelist-based lookup. The `propose` tier is **typed now, unimplemented** — no
   propose tools ship this sprint (they arrive with governed actions in Phase L).
3. Eleven read tools (§3.3), each wrapping an existing service.
4. `rankTexts` — a generalization of `packages/brain`'s BM25 `rankSections` so the four
   tools with no backing search primitive share one tested lexical ranker.
5. Per-run tool budget: max calls total and per tool, enforced in the registry adapter.
6. Registry → `AgentTool` adapter (zod-validated args, budget, output size bounds), plus
   a small zod→JSON-Schema deriver so tool inputs are defined once.
7. Inspector API: `GET /workspaces/:id/agent-runs` (list) and
   `GET /workspaces/:id/agent-runs/:runId` (run + steps), plus
   `POST /workspaces/:id/agent-runs/proof` — a founder-triggered proof run over the
   registry so the Inspector has something real to show in dev.
8. Agent Inspector UI at `/workspaces/[id]/inspector`: run list → run detail (transcript,
   steps, tool calls with args/results, tokens + cost per step, stop reason, elapsed),
   nav entry beside "Advanced context" in the Brain group.
9. Copilot migration: `COPILOT_TOOLS` re-implemented as adapters over registry tools
   (severable — see founder decision above).

**Out (explicitly deferred):**
- `propose` tools and any write path → Phase L (governed actions already exist; the
  registry merely reserves the tier).
- Structured-output migration of existing services → Sprint 58.
- Model routing, cache measurement, entitlements/budget billing → Sprint 59.
- Embedding-based similarity for drafts/discovery (BM25 lexical only this sprint; the
  evidence corpus remains the only vector search).
- Any change to `apps/mcp`.
- Streaming/SSE over HTTP for live run watching (the runner emits events in-process;
  the HTTP streaming surface is Phase O's chat transport).

## 3. Design

### 3.1 Contracts (`packages/contracts`)

```ts
export const TOOL_ACCESS_LEVELS = ["read", "propose"] as const;
export type ToolAccessLevel = (typeof TOOL_ACCESS_LEVELS)[number];
```

Agent-run API schemas, next to the Sprint 56 agent vocabularies (the comment at
`contracts:6463` reserves exactly this): `agentRunSummarySchema` (id, task, createdBy,
status, stopReason, model, provider, usage totals, costCents, stepCount, startedAt,
finishedAt), `agentRunStepSchema` (stepIndex, kind, message?, toolName?, toolArgs?,
toolResult?, toolError?, usage, durationMs), `agentRunDetailSchema` (summary + system +
inputMessages + output + error + steps[]). These are the Inspector's wire contract; the
web app imports the types.

Per-tool input schemas live in contracts too (they are enum-adjacent vocabulary — e.g.
`get_brain_section` takes a `BrainDocType`), exported as `toolInputSchemas` keyed by tool
name so tests can assert the registry and contracts stay in lockstep.

### 3.2 Registry (`apps/api/src/agents/registry.ts`)

```ts
export interface ToolBudget {
  maxCalls: number;                        // per run, across all tools
  perTool?: Record<string, number>;        // per-tool override caps
}

export interface ToolContext {
  db: Db;
  evidence: EvidenceStore;
  safeFetch: SafeFetchService;
  workspaceId: string;
  actor: { userId: string | null; label: string };  // actorOf() shape; carried into every call
  budget: ToolBudget;
}

export interface Tool<I, O> {
  name: string;
  description: string;                     // written for the model, not for docs
  input: z.ZodType<I>;                     // single source; JSON Schema derived (§3.6)
  access: ToolAccessLevel;                 // "read" | "propose" — never "execute"
  run(ctx: ToolContext, input: I): Promise<O>;
}

export const READ_TOOLS: readonly Tool<any, any>[] = [ /* the eleven */ ];
export function getTool(name: string): Tool<any, any> | undefined;
```

Workspace scoping follows the only pattern the codebase has: **every backing service
takes `workspaceId` explicitly and every query filters on it** — the registry passes
`ctx.workspaceId` down, exactly as HTTP routes do below the auth guard. There is no
ambient scoping to inherit; tests prove tenant isolation per tool (§4 step 8).

The actor rides along for attribution parity with routes (`actorOf(request)` shape,
`auth/guard.ts:43`). Read tools don't write, but the context shape is fixed now so
`propose` tools slot in without a breaking change — and note the guard's rule: an
agent-initiated action is **never** `human`, so nothing reachable from a tool can ever
collapse the Sprint 52 publish gate.

### 3.3 The eleven read tools (`apps/api/src/agents/tools/`)

One file per tool, each a thin wrapper over an existing service. Output discipline copies
copilot's `compact()` convention: every free-text field is truncated (2 000 chars,
`"… (truncated)"` suffix); list tools cap at 10 items unless noted. All timestamps ISO.

| Tool | Backing service | Notes |
|---|---|---|
| `search_evidence` | `retrieveEvidence` (`services/evidence.ts:288`) | **Upgraded from the Sprint 56 proof tool**: goes through the retrieval *policy* (blended rank, per-doc cap, jaccard dedup, source weights) rather than raw `store.search`, matching what generation actually sees. Input `{query, limit? ≤10}`. The Sprint 56 `agents/tools/search-evidence.ts` is refactored into this registry tool (its tests move with it). |
| `get_brain_section` | `getBrain` (`services/brain.ts:64`) + `parseDocSections` + `rankSections` (`packages/brain`) | Two modes: `{docType, sectionId}` returns that section verbatim (slug-path ids, e.g. `"operating-principles/brain-first"`); `{query, docType?}` BM25-ranks sections across docs (top 6, 320-char bodies) — the proven pipeline from `copilot-tools.ts:74-108`. |
| `get_campaign_plan` | `getCurrentCampaignPlan` (`services/campaign-plans.ts:256`) + `getCampaign` (`services/campaigns.ts:126`) | Input `{campaignId}`. Returns campaign summary (name, objective, kpi, timeframe, status, pillars) + current plan revision + lanes (`listLaneRevisionsForPlan` — persona × channel × format × cadence live here). 404-style error string if the campaign has no plan yet. |
| `list_recent_publications_with_metrics` | `listPublications` (`services/publications.ts:38`) | Input `{limit? ≤10, channel?, campaignId?}`. Filters `status === "published"`, returns publication + draft excerpt + `publication_metrics` snapshots (24h/7d). Campaign filter joins through `draftId → drafts.campaignId` (publications carry no campaignId — `insights.ts:80`). Uses `publication_metrics`, not the legacy `engagement_metrics`. |
| `find_similar_approved_drafts` | `listTrainingExamples` (`services/learning.ts:126`) + `rankTexts` (§3.4) | Input `{query, taskType?, channel?, limit? ≤5}`. Candidates: examples with `decision === "approved"` or `rating === "accepted"`. BM25-ranked by content against the query; falls back to recency when nothing scores > 0. Returns content, taskType, channel, `wasEdited`, createdAt. **Lexical, not semantic — stated here deliberately; drafts are not embedded.** |
| `find_instructive_rejections` | `listTrainingExamples` + `draft_revision_turns` (`db/schema.ts:329`) + `rankTexts` | Input `{query?, taskType?, channel?, limit? ≤5}`. Candidates: `decision === "rejected"`, `rating === "rejected"|"needs_edit"`, plus edited examples (`wasEdited`) where the **content delta is the instruction** (`originalContent` vs `content`). For drafts with conversational-editor turns, includes the human's `instruction` text — the only written "why" in the schema (`approval_decisions` has no reason column; adding one is out of scope). |
| `get_persona` | `getPersona` (`services/personas.ts:83`) → `toResolvePersona` (`:34`) | Input `{personaId}`. Output shape is `ResolvePersona` — the single mapping point call sites already share, so tool output can't drift from generation's view. |
| `list_channel_guardrails` | `listChannelGuidance` (`services/guidance.ts:124`) + automation limits | Input `{channel?}`. Returns per-channel guidance (defaults included, one row per channel; scoped overrides noted with their precedence) **plus** a `limits` block: `social_automation_settings` (kill switch, per-connection/per-campaign daily caps) and compliance flags (`services/compliance.ts:10`) — an agent asking "what are the rules for LinkedIn" needs both the voice rules and the caps. |
| `search_discovery_items` | `listDiscoveredItems` (`services/discovery.ts:584`) + `rankTexts` | Input `{query?, status?, limit? ≤10}`. No query → score-ordered list (existing behavior). With query → BM25 over `title + summary`. Returns title, url, summary (compact), score, scoreReason, status, matches (persona/campaign suggestions). |
| `get_prior_posts_on_topic` | `listPublications` + `rankTexts` | Input `{topic, channel?, limit? ≤5}`. **Direct lexical search over published drafts' content** (complete coverage), not the evidence corpus (which only holds founder-accepted published posts — real semantic search but partial coverage; noted as a future upgrade once coverage is automatic). Returns title, channel, publishedAt, externalUrl, content excerpt, metrics summary if present. |
| `safe_fetch_url` | `SafeFetchService` (`safe-fetch/index.ts`, Sprint 48) | Input `{url, profile? = "website"}` (`SafeFetchProfile = "feed" | "json" | "website"`). The one tool that leaves the tenant: SSRF-guarded (DNS-validated, per-address pinned), 20 s total deadline, 2 MiB/5 MiB body bounds — all Sprint 48 policy, unchanged. Failures serialize via `safeFetchPublicMessage` — **never raw transport errors** (they can leak internal addressing to a prompt-injected model). Text output truncated to 5 000 chars. Default per-tool budget cap: **3 calls per run** (§3.5) — it burns wall-clock and is the obvious exfiltration/probe vector. |

### 3.4 `rankTexts` (`packages/brain/src/zoom.ts`)

Generalize the tested BM25 core: `rankTexts(query: string, texts: {id: string; text: string}[]): {id: string; score: number}[]` (K1 1.2, B 0.75, shared IDF, positive scores only — same constants). `rankSections` becomes a thin adapter over it; its existing tests pin behavior. Four tools (§3.3) share this one primitive instead of growing four ad-hoc rankers.

### 3.5 Budget

Defaults: `maxCalls: 20` per run, `perTool: { safe_fetch_url: 3 }`. Enforced in the
adapter (§3.6): a call over budget **does not crash the run** — the handler returns
`{ error: "tool_budget_exhausted", tool, callsUsed, maxCalls }` as the tool result, so
the model sees it as data and can wrap up (mirrors Sprint 56's "handler error is data"
rule). The runner's own `maxSteps`/`maxTokens`/`timeoutMs` remain the hard stops.
Budget consumption is per *attempted* call (a failed call still counts — retry loops are
what budgets exist for).

### 3.6 Adapter + schema derivation (`apps/api/src/agents/adapter.ts`, `agents/json-schema.ts`)

`toAgentTools(tools: Tool[], ctx: ToolContext): AgentTool[]` — wraps each registry tool
into Sprint 56's `AgentTool { definition, handler }`:

1. `definition.inputSchema` derived from the zod schema by `jsonSchemaFor(zodType)` — a
   ~60-line converter for the subset tool inputs use (object, string, number, boolean,
   enum, array, optional, default, min/max), unit-tested against all eleven inputs. No
   new dependency (repo is on the zod v3 API); a tool input using an unsupported zod
   construct fails loudly at registration, not silently at call time.
2. `handler` = budget check → `tool.input.safeParse(args)` (failure → zod issues
   returned as error data, model can retry) → `tool.run(ctx, parsed)` → output
   compaction. Thrown errors become error-data results per the Sprint 56 rule;
   `NeedsHumanSignal` passes through untouched.

### 3.7 Copilot migration (`services/copilot-tools.ts`) — severable

`CopilotTool.run` bodies are replaced by calls to the corresponding registry tools where
overlap exists (`search_brain` → `get_brain_section` query mode, `search_evidence` →
`search_evidence`); copilot-only tools (the other eight) are re-registered as registry
`read` tools with a copilot-side formatter (its `{summary, citations}` result shape and
`compact()` sizes are presentation, and stay in the copilot layer). `CopilotToolContext`
is constructed from `ToolContext` (its `{db, evidence, workspaceId}` is a strict subset).
**No behavior change intended** — the existing copilot test suite is the guard; snapshot
any drift it catches. If this task exceeds a day it is cut from the sprint and logged as
an immediate fast-follow (founder decision above).

### 3.8 Inspector API (`apps/api/src/routes/agent-runs.ts`)

`registerAgentRunRoutes(app, db, deps)` — registered in `app.ts` beside its peers; the
global auth guard gives session + membership + 404-unknown-workspace for free on the
`/workspaces/:id` prefix.

- `GET /workspaces/:id/agent-runs?limit=&task=` — summaries, `startedAt desc` (uses the
  `agent_runs_workspace_started` index), default limit 50. Wrapped response
  `{ runs: [...] }` (the newer list style — `external-actions.ts:68`).
- `GET /workspaces/:id/agent-runs/:runId` — `agentRunDetailSchema`: run row + steps
  ordered by `stepIndex` (JSON columns parsed server-side so the client gets typed
  objects, not strings). 404 `{ error: "not_found" }` if absent or other-workspace.
- `POST /workspaces/:id/agent-runs/proof` — body `{question: string}`. Runs the
  `AgentRunner` with the full read-tool registry (`toAgentTools(READ_TOOLS, ctx)`),
  the live gateway, a fixed system prompt ("answer using the workspace's tools; cite
  which tools you used"), `task: "proof"`, `createdBy` from `actorOf(request)`,
  conservative bounds (maxSteps 8, maxTokens 16k, timeoutMs 60s). Returns the run id.
  This is the build-rule-4 artifact: something a human can trigger and inspect. It is
  deliberately minimal — not a chat surface (Phase O), just the Inspector's ignition.

Service logic in `apps/api/src/services/agent-runs.ts` (`listAgentRuns`,
`getAgentRunDetail`) — routes stay thin per convention.

### 3.9 Inspector UI (`apps/web/app/workspaces/[id]/inspector/`)

`/resolver`'s sibling, following its exact conventions: `"use client"`, `apiFetch`,
`useCallback` load + `useEffect`, `PageHeader` + `Card` blocks, colocated
`inspector.module.css` with editorial tokens only, global classes (`matrix-table`,
`section-content`, `meta`, `error`) where they fit.

- **Run list** — table: task, createdBy, status/stop-reason `Badge` (map stop reasons
  onto existing tones: `complete`→approved, `needs_human`→pending, `error`→danger,
  bounds→edited), model, steps, tokens, cost, started, elapsed. Empty state
  (`EmptyState`) explains what agent runs are and offers the proof-run form.
- **Proof-run form** — one text input + button posting to `/agent-runs/proof`, then
  refreshes and opens the run.
- **Run detail** — drill-in on the same page (state, resolver-style, not a nested
  route): header (task, stop reason, totals, cost, elapsed), the system prompt and
  input messages, then the step timeline — each `model_call` step shows the assistant
  text and any tool calls it issued; each `tool_call` step shows tool name, arguments,
  result **or** error, duration; per-step tokens + cost in a `meta` line. JSON rendered
  via a small `<JsonBlock>` (pretty-printed `<pre className="section-content">` —
  no JSON viewer exists in the app; this is the first, kept deliberately dumb).
- **Pure logic in `apps/web/lib/agent-inspector.ts`** (+ unit test, per the app's
  lib-test convention): transcript reconstruction (run row + steps → ordered timeline),
  cost/token formatting, elapsed formatting, stop-reason → badge tone mapping.
- **Nav**: child of the Brain group in `WORKSPACE_NAV`
  (`packages/contracts/src/index.ts:5518`, beside "Advanced context"): label
  "Agent inspector", path `/inspector`, summary "Watch what agents did and why", tone
  `system`, an icon already in the registry (the nav-icon contract tests enforce this).
  No `requires` gate — visible to all members.

## 4. Step-by-step plan

1. **Contracts** — `TOOL_ACCESS_LEVELS`, `toolInputSchemas`, agent-run API schemas;
   `npm run typecheck`.
2. **`rankTexts`** — generalize in `packages/brain` with `rankSections` re-based on it;
   existing zoom tests stay green, new tests for the generalized shape.
3. **Registry core** — `Tool`/`ToolContext`/`ToolBudget`, `jsonSchemaFor` (+ tests),
   `toAgentTools` adapter with budget + zod validation + error-as-data (+ tests against
   `ScriptedGateway`).
4. **Tools, batch 1 (existing-service wraps)** — `search_evidence` (refactor of the
   Sprint 56 proof tool), `get_brain_section`, `get_persona`, `get_campaign_plan`,
   `list_channel_guardrails`. One test file per tool, seeded in-memory db.
5. **Tools, batch 2 (ranked/list)** — `list_recent_publications_with_metrics`,
   `search_discovery_items`, `get_prior_posts_on_topic`, `find_similar_approved_drafts`,
   `find_instructive_rejections`.
6. **Tool, batch 3** — `safe_fetch_url` (stubbed transport in tests, per the Sprint 48
   test pattern; assert public-message error serialization and the 3-call budget).
7. **Inspector API** — `services/agent-runs.ts` + `routes/agent-runs.ts` + proof-run
   route; route tests via `buildAuthedApp` (list, detail, cross-workspace 404, proof run
   against `ScriptedGateway`).
8. **Tenant isolation sweep** — one test that seeds two workspaces and asserts every
   read tool returns only workspace-A data for a workspace-A context.
9. **Inspector UI** — `lib/agent-inspector.ts` + test; page + css; nav entry in
   contracts (+ nav contract tests green).
10. **Copilot migration (severable)** — §3.7; copilot suite green with no snapshot
    drift, or the task is cut and logged.
11. **Full verify** — `npm test`, `npm run typecheck`; Progress log; push branch; sync
    Plane (TAP epic for Sprint 57: comment with branch/HEAD/merge status; Done only per
    CLAUDE.md rule 8).

## 5. Acceptance (from PRD)

- [ ] A tool registry distinct from `apps/mcp`, `Tool<I,O>` with `access: "read" | "propose"` (never "execute"), zod inputs from `packages/contracts`.
- [ ] All eleven read tools implemented and tested; `safe_fetch_url` routed through Sprint 48's service.
- [ ] Workspace scoping enforced by the same rule as HTTP routes; actor carried into every tool call.
- [ ] Per-run tool budget: max calls total and per tool.
- [ ] Agent Inspector UI: run transcript, each step, tools called with arguments and results, tokens and cost per step, stop reason, total elapsed — shipped this sprint.
- [ ] **A founder can open a run and see exactly what the agent looked up, in what order, and what it cost** (proof-run trigger → Inspector detail).
- [ ] Copilot uses the registry (or the cut is logged as fast-follow with the founder informed).

## 6. Progress log

- 2026-08-03 — Branch created off `sprint-56-gateway-v2-agent-runner` @ `18f9e26`. Spec
  written after code survey (backing services for all eleven tools identified; Sprint 42
  copilot-registry overlap surfaced; founder decided single-registry convergence, copilot
  migration in-sprint as severable task). Implementation not started.
