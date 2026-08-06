# Sprint 64 — Pipeline definitions as data + execution engine

**Branch:** `sprint-64-pipeline-engine` (forked from `sprint-63-deliverables` @ `18dd4d8`)
**Merge order:** `sprint-61-campaign-opportunities` → `sprint-62-content-packages` → `sprint-63-deliverables` → `sprint-64-pipeline-engine`. Sprint 63 is not yet on `main`, so this branch builds on its branch per the CLAUDE.md dependency caveat.
**Sources:** `docs/plans/prd-agentic-platform.md` §7 (Sprint 64), `docs/plans/agentic-intelligence-direction.md` Move 3, TAP-23. Depends on Sprint 56 (AgentRunner), 57 (tool registry), 59 (tier routing + metering), 63 (deliverable/variant model — branch lineage only; the engine does not touch deliverables this sprint).

## 1. Problem

A content pipeline is implicit in the control flow of `automation.ts` + `signal-drafting.ts`: one hard-coded sequence (retrieve evidence → resolve context → one `generate` call → pre-review → submit draft). It cannot be inspected, versioned, varied per lane or campaign, or edited without a code deploy. One workspace cannot run 100 pipelines without 100 branches of TypeScript.

## 2. Goal

Make the pipeline an explicit, versioned record — **definitions as data** — and give it an execution engine that is *deterministic between steps, agentic within a step*:

- `pipeline_definitions`, versioned like brain docs, scoped workspace → campaign → lane. An ordered list of steps, each declaring goal, tool allowlist, model tier, output kind, max agent steps, max tokens.
- `pipeline_runs` + `pipeline_run_steps`: an engine owning sequencing, retries, budgets, idempotency, escalation, and the approval-gate handoff. Each agent step executes as one bounded `AgentRunner` run.
- The reference **signal → social post** definition (research → angle → draft → critique → revise loop → propose, with an escalation rule), seeded per workspace.
- **Dry run against historical signals**: what would this definition have produced for recent signals, without writing drafts.
- Pipeline editor UI + run/dry-run views.

**Acceptance (PRD):** a pipeline definition change alters generation behaviour with no code deploy; the dry run shows what would have been produced for recent signals.

**Explicitly not this sprint (Sprint 65+):** flipping `automation.ts` onto the engine, the shadow A/B, worker loops for pipeline runs, the grounded critic upgrade (Sprint 66), customer-editable arbitrary output schemas (PRD decision D5 — after the eval harness), chat/ask lane, deliverable/variant integration with the engine.

## 3. Founder decisions recorded (D-64.x)

- **D-64.1 Versioning pattern.** `pipeline_definitions` holds the current spec; `pipeline_definition_versions` is append-only history with a strict `UNIQUE (definition_id, version)` (tighter than the brain-doc pattern, matching the Sprint 63 `variants` convention). Every spec edit bumps `currentVersion` and appends a version row with actor attribution.
- **D-64.2 Scope + resolution.** A definition is scoped by `(workspaceId, taskKey, campaignId?, laneId?)`. `resolvePipelineDefinition` picks the most specific **active** definition (lane > campaign > workspace). At most one active definition per exact scope — enforced inside the activation transaction (activating one archives nothing but demotes any other active definition in the same exact scope to `draft`), covered by tests rather than an expression index (SQLite partial indexes over `IFNULL` expressions are not worth the migration complexity yet).
- **D-64.3 Output schemas are a registered vocabulary.** Steps declare `output` as one of `STEP_OUTPUT_KINDS` (`brief`, `angles`, `draft`, `findings`, `proposal`) whose zod schemas live in contracts. Definition changes (goals, tools, tiers, caps, thresholds, order) are data; output *structures* stay code-validated. Arbitrary customer JSON schemas arrive only with the eval-harness gate (PRD D5).
- **D-64.4 `propose` is an engine-owned deterministic step**, not a propose-access agent tool. The gate handoff is *between-steps* work: the engine takes the final validated Draft output and creates the generation + pending-review draft itself. `TOOL_ACCESS_LEVELS`' `propose` tier remains typed-but-unshipped; no agent ever holds a write tool this sprint.
- **D-64.5 Gate handoff provenance.** The propose step writes a real `generations` row whose trace is honest: `prompt` = the draft step's composed instruction, `sections` = one `ContextSection` per completed step (layer `task`, content = the step's structured output), then `submitDraft` → `pending_review`. Live mode only; dry runs record the would-be proposal in `resultJson` and write **no** generations/drafts.
- **D-64.6 Synchronous execution behind routes.** Runs execute synchronously in the run/dry-run routes under engine bounds (`STEP_TIMEOUT_MS` 60s, `RUN_MAX_DURATION_MS` 300s), lease-fenced so one run cannot execute twice concurrently. Worker loops and tick budgets are Sprint 65 work (when the shadow A/B needs them). `llmBudgetExhausted` blocks starts with the standard `blocked` idiom.
- **D-64.7 Revise loop is engine control flow.** The `revise` step declares `loop: { scoreFrom: <stepKey>, threshold, maxIterations ≤ 3 }`. The engine skips revise when the scoring step's `score ≥ threshold`; otherwise revise runs (producing a replacement Draft), the scoring step re-runs, up to `maxIterations`. Loop iterations are recorded as `iteration` 1..N on the step rows; the loop never lives inside a prompt.
- **D-64.8 Escalation is deterministic.** The definition carries `escalation: { minConfidence?, onGuardrailUncertain }`. After each step the engine inspects the structured output: `confidence < minConfidence` or `guardrailUncertain: true` → run status `escalated` with `pausedAtStepKey` + reason; the operator decides `resume` (continues from the paused point, the fired check suppressed once) or `cancel`. An `AgentRunner` `needs_human` stop escalates the same way.
- **D-64.9 Retries and budgets.** A failed step attempt (agent error/timeout/max_steps, or output that fails its kind schema) retries up to `STEP_MAX_ATTEMPTS = 2`; attempts are separate rows (`UNIQUE (runId, stepKey, iteration, attempt)`). Exhausted attempts fail the run (`step_failed:<key>`). The definition-level `budget.maxTokens` is cumulative across all agent steps; crossing it fails the run as `budget_exhausted` without retry.
- **D-64.10 Checklist.** The run carries `checklistJson`: one entry per executed step with `passes` and evidence (output kind, validated fields, agent-run id). `passes` is earned by zod-validating the structured output against the declared kind — a step cannot self-mark complete; parse/validation failure is a failed attempt.
- **D-64.11 Reference definition seeding.** `ensurePipelineDefinitions` lazily seeds the reference `signal_social_post` definition (version 1, status `draft`) on first list, like `ensureBrainDocs`. Activation is a founder action in the UI; nothing consumes active definitions automatically until Sprint 65.
- **D-64.12 Idempotency + spend.** Runs accept an optional `idempotencyKey` (partial unique per workspace `WHERE idempotency_key IS NOT NULL`) — Sprint 65's automation will pass `automaticDraftKey`-style keys; manual founder runs may repeat. All step LLM calls are metered under a new `LLM_PIPELINES` entry `pipeline_run` (per-step `tier` flows through `AgentRunParams.tier`, the Sprint 59 seam).

## 4. Domain model (migration 0070)

### `pipeline_definitions`
`id`, `workspaceId` FK cascade, `taskKey` (`PIPELINE_TASK_KEYS`, v1: `signal_social_post`), `name`, `description`, `campaignId` FK set-null (nullable), `laneId` FK set-null (nullable), `status` (`draft | active | archived`), `currentVersion`, `specJson` (the validated `PipelineSpec`), `createdByUserId`, `createdAt`, `updatedAt`. Index on `(workspaceId, taskKey, status)`.

### `pipeline_definition_versions`
`id`, `definitionId` FK cascade, `version`, `specJson`, `actorLabel`, `actorUserId`, `createdAt`. `UNIQUE (definitionId, version)`.

### `pipeline_runs`
`id`, `workspaceId` FK cascade, `definitionId` FK cascade, `definitionVersion`, `taskKey`, `mode` (`live | dry_run`), `dryRunBatchId` (nullable), `signalId` FK set-null, `campaignId` / `laneId` / `personaId` (nullable snapshots), `channel`, `status` (`PIPELINE_RUN_STATUSES`), `pausedAtStepKey`, `escalationReason`, `failureReason`, `checklistJson`, `resultJson` (final proposal payload), `generationId` / `draftId` FK set-null (live propose links), `inputTokens`, `outputTokens`, `costCents`, `idempotencyKey` (partial unique `WHERE NOT NULL` per workspace), `leaseOwner`, `leaseExpiresAt`, `createdBy`, `createdAt`, `startedAt`, `finishedAt`.

### `pipeline_run_steps`
`id`, `runId` FK cascade, `stepKey`, `iteration` (revise-loop pass, from 1), `attempt` (from 1), `status` (`PIPELINE_STEP_STATUSES`), `agentRunId` FK set-null (null for propose), `outputJson`, `passes` (bool int), `failureReason`, `stopReason`, `inputTokens`, `outputTokens`, `costCents`, `startedAt`, `finishedAt`. `UNIQUE (runId, stepKey, iteration, attempt)`.

## 5. Contracts additions (`packages/contracts`)

- `PIPELINE_TASK_KEYS = ["signal_social_post"]`.
- `PIPELINE_DEFINITION_STATUSES = ["draft", "active", "archived"]`.
- `PIPELINE_RUN_STATUSES = ["queued", "running", "escalated", "succeeded", "failed", "cancelled"]` with `PIPELINE_RUN_TRANSITIONS` + `canTransitionPipelineRun` / `transitionPipelineRun` (queued→running|cancelled; running→escalated|succeeded|failed|cancelled; escalated→running|cancelled; terminal: succeeded/failed/cancelled).
- `PIPELINE_STEP_STATUSES = ["pending", "running", "succeeded", "failed", "skipped"]` (row-level, no machine — attempts are append-only rows).
- `PIPELINE_STEP_KINDS = ["agent", "propose"]`.
- `STEP_OUTPUT_KINDS = ["brief", "angles", "draft", "findings", "proposal"]` with zod schemas: `briefOutputSchema` `{summary, keyFacts[], sources[]}`; `anglesOutputSchema` `{angles: [{title, rationale}] (1–5), confidence?}`; `draftOutputSchema` `{content, confidence?}`; `findingsOutputSchema` `{score 0–100, findings: [{issue, citation?}], guardrailUncertain, confidence?}`; `proposalOutputSchema` `{content, channel, taskType}`; plus `stepOutputSchemaFor(kind)`.
- `pipelineStepSpecSchema`: `{key (slug), title, goal, kind, tools: AgentToolName[] (agent only), tier: ModelTier, output: StepOutputKind, maxSteps 1–10, maxTokens ≤ 32_000, loop?: {scoreFrom, threshold 0–100, maxIterations 1–3}}`.
- `pipelineSpecSchema`: `{steps (1–10), escalation?: {minConfidence? 0–100, onGuardrailUncertain}, budget: {maxTokens ≤ 200_000}}` with `superRefine`: unique step keys; exactly one terminal `propose` step, last; agent steps only before it; `loop.scoreFrom` must name an earlier step with `output: "findings"`; tools must be known tool names; a loop step must produce `draft`.
- Record schemas: `pipelineDefinitionSchema` (+`versions` on detail), `pipelineRunSchema`, `pipelineRunStepSchema`, `pipelineRunDetailSchema`, list responses, `runPipelineInputSchema` `{signalId, channel, campaignId?, personaId?, idempotencyKey?}`, `dryRunPipelineInputSchema` `{signalIds? (≤10) | limit? (1–10, default 3)}`, `dryRunPipelineResultSchema`, `pipelineRunDecisionInputSchema` `{action: "resume" | "cancel", reason? (required for cancel)}`, `updatePipelineSpecInputSchema`, `createPipelineDefinitionInputSchema`.
- `LLM_PIPELINES` += `"pipeline_run"`.
- Nav child `{ label: "Pipelines", path: "/pipelines" }` after Deliverables.
- `REFERENCE_SIGNAL_SOCIAL_POST_SPEC` — the canonical reference definition (research cheap/Brief/6 · angle frontier/Angle[3]/3 · draft frontier/Draft/2 · critique cheap/Findings/4 · revise frontier/Draft with loop{scoreFrom: critique, threshold 70, maxIterations 2} · propose), escalation `{minConfidence: 60, onGuardrailUncertain: true}`, budget 120_000 — exported from contracts so web and api share it.

## 6. Engine (`apps/api/src/services/pipeline-engine.ts` + `pipeline-definitions.ts`)

**Definitions service:** `ensurePipelineDefinitions`, `listPipelineDefinitions`, `getPipelineDefinition` (with versions), `createPipelineDefinition`, `updatePipelineSpec` (validate → bump version → append version row), `setPipelineStatus` (activate demotes same-scope active sibling; archive), `resolvePipelineDefinition(db, {workspaceId, taskKey, campaignId?, laneId?})`.

**Engine:** `startPipelineRun` (insert `queued`, idempotency-checked) then `executePipelineRun(db, llm, evidence, safeFetch, runId, {now?})`:

1. Fence: claim `queued → running` (or `escalated → running` on resume) with a lease stamp; a concurrent claim loses.
2. Load the definition **version** the run was started against (spec frozen per run).
3. For each step in order (with D-64.7 loop control): compose the step's system prompt (goal + shared run context: signal content/source, channel, campaign/persona names) and a user message carrying prior step outputs as labelled JSON; filter `READ_TOOLS` by the step's allowlist → `toAgentTools` with a fresh `ToolContext`; run `AgentRunner.run` with `responseSchema = jsonSchemaFor(outputKind)`, the step's `tier`, `maxSteps`, `maxTokens`, `STEP_TIMEOUT_MS`, metered under `pipeline_run`.
4. Validate output against the kind schema → `passes`; record the step row; accumulate usage against `budget.maxTokens`.
5. Escalation check (D-64.8) after each step; revise-loop control after critique; retries per D-64.9.
6. `propose`: deterministic handoff (D-64.4/5) in live mode; simulated in dry_run. Run → `succeeded` with checklist + result.

**Dry run:** `runPipelineDryRun` — pick signals (explicit ids or most recent, capped), one `dry_run` run each under a shared `dryRunBatchId`, execute sequentially, return per-signal outcomes `{signalId, runId, status, proposal?, checklist, costCents}`.

## 7. API surface (`apps/api/src/routes/pipelines.ts`)

- `GET /workspaces/:id/pipelines` (seeds reference), `POST /workspaces/:id/pipelines`
- `GET|PUT /workspaces/:id/pipelines/:pipelineId` (PUT = new spec version)
- `POST /workspaces/:id/pipelines/:pipelineId/activate` · `POST .../archive`
- `POST /workspaces/:id/pipelines/:pipelineId/run` (live; 409 `llm_budget_exhausted`; 409 `duplicate_run` on idempotency conflict)
- `POST /workspaces/:id/pipelines/:pipelineId/dry-run`
- `GET /workspaces/:id/pipeline-runs` (`?definitionId&mode&status&limit&offset`), `GET /workspaces/:id/pipeline-runs/:runId` (steps + checklist + agent-run ids for the Inspector)
- `POST /workspaces/:id/pipeline-runs/:runId/decision` (`resume | cancel`)

Errors follow house style: 400 `invalid_input` / `invalid_transition`, 404s, 403 non-member via the global guard.

## 8. Web (`apps/web/app/workspaces/[id]/pipelines/page.tsx`)

- Definitions list (seeded on load): step chain visualization (key · tier · output · caps), status chip, activate/archive.
- Spec editor: guarded JSON editor validated client-side with `pipelineSpecSchema` before submit; save = new version; versions list.
- Dry run: trigger with limit; per-signal results (proposal content, checklist ✓/✗ per step, cost).
- Runs list + detail: status, escalation banner with resume/cancel, per-step rows (iteration/attempt, passes, stop reason, tokens), link to Inspector for each agent run.
- `apps/web/lib/pipeline-view.ts` helpers + tests (step summary labels, checklist rollup, escalation/decision affordances, run status chips).

## 9. Tests

- **Contracts:** spec validation rules (unique keys, propose-last, loop references, tool names), run-status machine, reference spec validates.
- **Migrations (0070):** table defaults, `UNIQUE (definitionId, version)`, `UNIQUE (runId, stepKey, iteration, attempt)`, partial unique idempotency key, FK behaviours.
- **Engine (ScriptedGateway):** happy path through all six reference steps (structured outputs scripted per step) → succeeded, checklist all-passes, draft `pending_review` + generation trace sections; per-step tier recorded by the gateway (**acceptance: definition edit changes tier/threshold → observably different behaviour, no code change**); tool allowlisting (out-of-list call returns unknown-tool data); revise loop (low critique score → revise → re-critique → pass; maxIterations cap); escalation (low confidence → `escalated` → resume completes; cancel); invalid structured output → retry → attempt rows; attempts exhausted → run failed; budget exhaustion → `budget_exhausted`; dry run writes no generations/drafts but returns proposals; idempotency conflict; lease fence.
- **Routes:** CRUD + versioning + single-active-per-scope demotion, run/dry-run/decision over HTTP, list/detail projections, non-member 403/404.
- **Web lib:** pipeline-view helpers.

## 10. Out of scope (Sprint 65+)

Automation flip + shadow A/B and the legacy-path flag; worker loop + operator-policy tick budgets for pipeline runs; grounded critic + retrieval few-shot (Sprint 66); eval/replay harness (Sprint 67); arbitrary/customer output schemas (PRD D5); propose-access agent tools; deliverable/variant execution through the engine; ask-lane UI beyond resume/cancel; streaming run progress.

## 11. Implementation plan

- **Task 1 — Contracts.** §5 vocabularies, machines, zod, reference spec, nav, `pipeline_run` metering entry.
- **Task 2 — Schema + migration 0070.** §4 tables; `db:generate`; rename + journal retag.
- **Task 3 — Definitions service.** CRUD, versioning, activation demotion, resolution, seeding.
- **Task 4 — Engine.** Step composer, AgentRunner integration, loop/escalation/retry/budget control, propose handoff, dry run.
- **Task 5 — Routes + app wiring.**
- **Task 6 — Web.** Pipelines page + `pipeline-view.ts`.
- **Task 7 — Verify + ship.** `npm test`, `npm run typecheck`, commit, push, Plane sync.

## 12. Progress log

- 2026-08-05 — Spec written; branch `sprint-64-pipeline-engine` forked from `sprint-63-deliverables` @ `18dd4d8`; TAP-23 moved to In Progress.
- 2026-08-05 — Tasks 1–6 delivered:
  - **Contracts**: full §5 vocabulary (`PIPELINE_TASK_KEYS`, definition/run/step statuses + `PIPELINE_RUN_TRANSITIONS` machine, `STEP_OUTPUT_KINDS` with the five output zod schemas, `pipelineStepSpecSchema`/`pipelineSpecSchema` with all superRefine rules, record + input + dry-run + decision schemas), `REFERENCE_SIGNAL_SOCIAL_POST_SPEC`, `LLM_PIPELINES` += `pipeline_run`, nav `/pipelines`.
  - **Schema + migration 0070** (`0070_sprint_64_pipelines.sql`): `pipeline_definitions`, `pipeline_definition_versions` (strict unique per version), `pipeline_runs` (partial-unique idempotency, lease fence columns), `pipeline_run_steps` (unique (run, step, iteration, attempt); ordered by rowid for deterministic replay).
  - **Services**: `pipeline-definitions.ts` (seeding, brain-style versioning, activation demoting the same-exact-scope sibling, lane > campaign > workspace resolution) and `pipeline-engine.ts` (claim fence with crash reclaim, per-step AgentRunner turns with tool-allowlist subsets + `jsonSchemaFor` structured outputs + tier routing, engine-owned revise loop, deterministic escalation with resume-from-cache, retries → `step_failed`, cumulative budget, engine-owned propose writing an honest generation trace + `submitDraft` → `pending_review`, dry-run batches that never write drafts, run projections + decisions).
  - **Routes** `routes/pipelines.ts` wired in `app.ts` with `{llm, evidence, safeFetch}`.
  - **Web**: `/workspaces/[id]/pipelines` (definition cards with step chips, guarded JSON spec editor validated by the contracts schema client-side, activate/archive, dry-run replay panel, live run-on-signal, run ledger with checklist rollups, escalation resume/cancel, per-step rows linking to the Inspector) + `lib/pipeline-view.ts`.
  - **Tests**: contracts (8), migrations (6), definitions (4), engine (11 — includes the acceptance test: a spec edit changes tier + forces the revise loop on the next run with no code change), routes (5), web lib (4). Suite: 2514/2514 across 239 files; typecheck clean.
- Decision refinement during build (D-64.9 note): `STEP_MAX_ATTEMPTS` retries also cover a `complete` run whose final text fails JSON parse (runner reports `error`) — both surface as failed attempt rows with the stop reason preserved.
