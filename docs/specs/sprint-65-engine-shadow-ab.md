# Sprint 65 — First agent-executed pipeline, measured (engine path + shadow A/B)

**Branch:** `sprint-65-engine-shadow-ab` (forked from `sprint-64-pipeline-engine`).
**Merge order:** `sprint-61-campaign-opportunities` → `sprint-62-content-packages` → `sprint-63-deliverables` → `sprint-64-pipeline-engine` → this branch. Do not merge this before Sprint 64.
**Sources:** PRD `docs/plans/prd-agentic-platform.md` §7 (Sprint 65), direction doc `docs/plans/agentic-intelligence-direction.md` Move 3 ("Convert exactly one pipeline first … keep the old path behind a flag, and compare them on the metric you already collect: approval rate at the gate"), Sprint 64 spec §10 (out-of-scope list this sprint picks up).

## 1. Problem

Sprint 64 built the pipeline engine, but nothing feeds it automatically. Signal → social post automation still runs exclusively through the legacy `automation.ts` → `generateSignalDraft` path (one prompt, one generation, optional pre-review). The engine's runs so far are founder-clicked. The PRD requires: the reference pipeline running end to end **from automation**, the legacy path preserved behind a per-workspace flag, both paths measured side by side (approval rate, edit distance, cost), and a founder decision **recorded** before anything is deleted. Deleting the legacy path is explicitly *not* this sprint — it happens only after the engine wins in production.

## 2. Goal

A founder can flip a workspace between three generation paths — `legacy`, `shadow`, `pipeline` — from the Automation page. In `shadow`, every automation draft is still produced by the legacy path *and* the same (signal, campaign, channel) is replayed through the engine as a paired shadow run; the founder reviews pairs side by side and records verdicts. A comparison panel aggregates approval rate, edit distance, and cost per path. When the evidence is in, the founder records a rollout decision (with the metrics snapshot frozen into it) that flips the flag. A new worker loop executes queued engine runs in the background.

## 3. Founder decisions (D-65.x)

- **D-65.1 Three-valued per-workspace flag.** `generationPath ∈ {legacy, shadow, pipeline}` lives on `social_automation_settings` (default `legacy` — zero behavior change on merge). `legacy`: today's path. `shadow`: legacy produces the live draft; the engine additionally runs the same work as a `shadow`-mode run (simulated proposal, no draft). `pipeline`: the engine produces the live draft; legacy generation is skipped.
- **D-65.2 Shadow is a third run mode.** `PIPELINE_RUN_MODES` gains `"shadow"`. The propose step treats every non-`live` mode as simulated (no generation, no draft) — shadow runs are dry runs with a pairing identity. Shadow runs carry idempotency key `shadow:v1:<ws>:<signal>:<campaign>:<channel>`; live engine automation runs carry the exact `automaticDraftKey(...)` string, so run identity mirrors legacy draft identity.
- **D-65.3 Queue in the automation tick, execute in a pipelines tick.** `runAutomation` only *starts* engine runs (a cheap queued insert — no LLM work in the automation tick). A new `/internal/pipelines/tick` (worker loop `pipelines`, `PIPELINES_INTERVAL_MIN`, default 2 min) claims up to `PIPELINE_TICK_BATCH = 3` queued runs oldest-first and drives each through `executePipelineRun` (which already owns the claim fence, lease, budget check, and resume-from-cache). This is the Sprint 64 D-64.6 promise ("worker loops are Sprint 65 work") landing. Manual founder runs keep executing synchronously in their route.
- **D-65.4 Auto-approval stays outside the engine.** `scheduled_auto` semantics are preserved on the engine path: after a **live automation** run succeeds, the tick — not the engine — applies the `approve` action as the system actor (identical attribution to legacy's auto-approve). Kill switch semantics match legacy exactly: `scheduled_auto` + kill switch on blocks queueing in `runAutomation`, and the tick re-checks the switch before auto-approving (a switch flipped mid-flight leaves the draft at the gate). The engine itself never auto-approves — the double gate from Sprint 64 is untouched.
- **D-65.5 Failed automation runs do not silently retry.** The idempotency key makes a failed engine automation run terminal for that (signal, campaign, channel): later ticks hit `DuplicatePipelineRunError` and skip. During an A/B, engine failures must be *visible* (in `/pipelines` and the comparison panel), not papered over by retries. Escalated runs wait for the founder's resume/cancel as designed in Sprint 64. (`STEP_MAX_ATTEMPTS` still retries transient step failures *inside* a run.)
- **D-65.6 Legacy fallback when no active definition.** `pipeline`/`shadow` paths require an **active** pipeline definition resolving for (`signal_social_post`, campaignId) — Sprint 64 seeds the reference definition as `draft`, and activation is a founder action. If none resolves, the live path falls back to legacy generation (flipping the flag must never halt automation) and shadow simply doesn't queue. The per-campaign result reports `engineQueued`/`shadowQueued` counts so the fallback is observable.
- **D-65.7 Shadow pairs + founder verdicts are the shadow-side approval signal.** A `pipeline_shadow_pairs` row links the legacy draft and its shadow run (unique `pairKey`, the shadow idempotency key). Shadow proposals never enter the gate, so their "approval rate" is the founder's explicit side-by-side verdict: `engine` / `legacy` / `tie`, with optional notes, actor-attributed. This is the founder-visible A/B the PRD's acceptance names.
- **D-65.8 Comparison metrics, honestly labeled.** `getAutomationComparison` (default window 30 days) reports per path: automation drafts created (legacy = `automationKey IS NOT NULL`, engine = live runs' `draftId`), gate outcomes (approved / rejected / still pending → approval rate over decided only), mean normalized edit distance (Levenshtein between `originalContent` and final `content`, 0–100, computed over decided drafts — the "how much did the founder have to fix it" metric), and cost. Cost sides are measured differently and the UI says so: engine cost is the exact per-run metered sum (`pipeline_runs.cost_cents`); legacy cost is the workspace's `signal_draft` + `review` usage-event sum for the window, which includes founder-triggered manual drafts. Engine run health (succeeded / failed / escalated) and shadow verdict tallies ride along.
- **D-65.9 Rollout decisions are append-only records that also flip the flag.** `pipeline_rollout_decisions`: decision ∈ {`adopt_engine`, `keep_legacy`, `extend_shadow`}, required rationale, the full comparison snapshot frozen as JSON, decided-by attribution. Recording one atomically sets `generationPath` (`pipeline` / `legacy` / `shadow` respectively). "Legacy deleted only when the new one wins" therefore has a paper trail; the deletion itself is a later sprint after production evidence.
- **D-65.10 Edit distance is a plain two-row Levenshtein.** Implemented natively (`edit-distance.ts`), inputs capped at 20k chars (social posts are far below), normalized to `round(100 * distance / max(len))`. No dependency added.

## 4. Domain model (schema additions)

- `social_automation_settings` + `generation_path TEXT NOT NULL DEFAULT 'legacy'`.
- **`pipeline_shadow_pairs`** — `id` PK, `workspace_id` (cascade), `pair_key` UNIQUE, `signal_id`/`campaign_id` (set-null FKs), `channel`, `draft_id` (set-null FK → drafts), `run_id` (cascade FK → pipeline_runs), `verdict` (null until reviewed), `verdict_notes` default `''`, `verdict_by_user_id` (set-null), `verdict_at` null, `created_at`; index on (`workspace_id`, `created_at`).
- **`pipeline_rollout_decisions`** — `id` PK, `workspace_id` (cascade), `task_key`, `decision`, `rationale`, `metrics_json`, `decided_by_user_id` (set-null), `created_at`; index on `workspace_id`.

Migration `0071_sprint_65_shadow_ab.sql` via `db:generate` (journal retagged).

## 5. Contracts (`packages/contracts`)

- `AUTOMATION_GENERATION_PATHS = ["legacy", "shadow", "pipeline"]` (declared above the Sprint 28 settings schemas to avoid a module-eval TDZ); `socialAutomationSettingsSchema` + `generationPath`; update input + optional `generationPath`.
- `PIPELINE_RUN_MODES` gains `"shadow"` (Sprint 64 section).
- `automationCampaignResultSchema` + `engineQueued`, `shadowQueued` (ints; the orchestrator is the single producer).
- Sprint 65 section: `SHADOW_VERDICTS = ["engine", "legacy", "tie"]`; `pipelineShadowPairSchema` (wire shape enriched with `draftContent`, `draftState`, `proposalContent`, `runStatus`); `shadowVerdictInputSchema` (verdict + notes ≤ 2000); `automationPathMetricsSchema` {drafts, decided, approved, rejected, approvalRate nullable, avgEditDistance nullable, costCents}; `engineRunHealthSchema` {runs, succeeded, failed, escalated}; `shadowSummarySchema` {pairs, reviewed, engineWins, legacyWins, ties}; `automationComparisonSchema` {generationPath, windowDays, legacy, engine: metrics + health, shadow}; `ROLLOUT_DECISION_KINDS = ["adopt_engine", "keep_legacy", "extend_shadow"]`; `rolloutDecisionSchema`; `recordRolloutDecisionInputSchema` (decision + rationale 1–2000).

## 6. Services

- **`edit-distance.ts`** — `levenshtein(a, b)`, `normalizedEditDistance(a, b)` (0–100).
- **`pipeline-shadow.ts`** — `shadowPairKey(...)`; `createShadowPair`; `listShadowPairs(db, ws, {reviewed?})` joining draft content/state and the run's proposal content (from `result_json`) + run status; `recordShadowVerdict` (actor-attributed, 404 on missing); `getAutomationComparison(db, ws, {windowDays=30, now}, )` per D-65.8; `recordRolloutDecision(db, ws, input, actor)` — snapshot + insert + flag flip in one transaction; `listRolloutDecisions`.
- **`automation.ts`** — settings read/write for `generationPath`; `runAutomation` grows an engine branch per (campaign, signal, channel) after the existing `hasDraftFor` dedupe:
  - path `pipeline` + active definition → `startPipelineRun({mode: "live", idempotencyKey: automaticDraftKey(...), createdBy: "automation"})`, `engineQueued++`; `DuplicatePipelineRunError` → skip. No definition → legacy generation (D-65.6).
  - path `shadow` → legacy generation exactly as today; when this tick *created* the draft and a definition resolves → `startPipelineRun({mode: "shadow", idempotencyKey: shadowPairKey(...)})` + `createShadowPair`, `shadowQueued++`.
  - Definition resolution once per campaign via `resolvePipelineDefinition(db, ws, "signal_social_post", {campaignId})`.
- **`pipeline-engine.ts`** — propose's simulated branch keys off `mode !== "live"`; new `runPipelinesTick(db, deps, {batch=PIPELINE_TICK_BATCH, now})`: claim queued `live`/`shadow` runs oldest-first, `executePipelineRun` each, then the D-65.4 auto-approve hook (live + `createdBy: "automation"` + campaign `scheduled_auto` + kill switch off → `applyDraftAction(..., "approve", SYSTEM_ACTOR)`); returns `{processed, succeeded, escalated, failed, blocked, autoApproved}`.

## 7. API surface

- `PATCH /workspaces/:id/automation/settings` — accepts `generationPath` (existing route, extended schema).
- `GET /workspaces/:id/automation/comparison` → `automationComparisonSchema`.
- `GET /workspaces/:id/automation/shadow-pairs?reviewed=true|false` → pairs (newest first, limit 50).
- `POST /workspaces/:id/automation/shadow-pairs/:pairId/verdict` — 400 invalid, 404 missing, 200 pair.
- `GET|POST /workspaces/:id/automation/rollout-decisions` — POST 201 with the record; flag observable via settings GET.
- `POST /internal/pipelines/tick` — worker-token only (guard's `/internal/` branch), global `pipelines:scheduler` lease like the automation tick.

## 8. Worker

`config.ts` + `pipelinesMs` (`PIPELINES_INTERVAL_MIN`, default 2, min 1 min); `client.ts` union + `/internal/pipelines/tick`; `index.ts` loop `pipelines` logging processed/auto-approved/escalated/failed.

## 9. Web (`/workspaces/[id]/automation`)

New `generation-path.tsx` section on the existing Automation page (its nav home; no new nav entry):
- **Path picker** — three radio cards (legacy / shadow / pipeline) with plain-language consequences, saved via settings PATCH; a warning chip when `pipeline`/`shadow` is selected but no active definition exists (link to `/pipelines`).
- **Comparison panel** — per-path columns from `GET /comparison`: approval rate, mean edit distance, cost (with the D-65.8 asymmetry note), engine run health, shadow verdict tally.
- **Shadow review queue** — unreviewed pairs side by side (legacy draft vs engine proposal, or run status when not yet succeeded/failed/escalated), verdict buttons + optional note.
- **Rollout decision** — decision select + rationale, past decisions list with snapshot summary.
- `lib/automation-ab-view.ts` — pure helpers (`pathLabel`, `formatRate`, `formatCents`, `verdictTally`, `comparisonLeader`) with tests.

## 10. Tests

- `packages/contracts/test/automation-ab.test.ts` — vocabularies, shadow mode in `PIPELINE_RUN_MODES`, comparison/rollout schema validation (rationale required, verdict enum).
- `apps/api/test/edit-distance.test.ts` — distance + normalization cases.
- `apps/api/test/sprint65-migrations.test.ts` — journal tag, `generation_path` default, pair `pair_key` unique + cascade/set-null behavior, rollout table.
- `apps/api/test/automation-engine-path.test.ts` — pipeline mode queues a live run (idempotency key = automaticDraftKey, no legacy draft) and reruns dedupe; no-active-definition falls back to legacy; shadow mode drafts via legacy + queues paired shadow run + pair row, rerun no dup; kill switch blocks scheduled_auto queueing; tick executes runs (scripted gateway) → live run creates a pending_review draft, scheduled_auto auto-approves as system, shadow run succeeds simulated with no draft; failed run stays terminal (D-65.5).
- `apps/api/test/pipeline-shadow.test.ts` — pair listing enrichment, verdicts, comparison math (approval rate, edit distance on an edited draft, costs, verdict tallies), rollout decision snapshot + flag flip + append-only list.
- `apps/api/test/automation-ab-routes.test.ts` — settings PATCH path, comparison GET, shadow verdict flow over HTTP, rollout POST/GET, `/internal/pipelines/tick` with worker token (401 without), non-member 403/404.
- `apps/web/lib/automation-ab-view.test.ts`.

## 11. Out of scope (Sprint 66+)

Grounded critic & retrieval few-shot (66), eval/replay harness (67), deleting `automation.ts`'s legacy path (post-win, with production evidence), preference memory (68), chat lane, deliverable/variant engine integration.

## 12. Progress log

- Spec written; branch forked from `sprint-64-pipeline-engine`.
- Contracts + schema + migration `0071_sprint_65_shadow_ab` landed.
- Services: edit-distance, pipeline-shadow, automation engine branch, `runPipelinesTick`, propose `mode !== "live"`.
- Routes (automation extensions + internal pipelines tick) and worker loop landed.
- Web: generation-path section (picker, comparison, shadow review, rollout decisions) + view helpers.
- Import-cycle fix uncovered by the full run: automation.ts importing pipeline-engine closed a cycle through the agent tool registry (several read tools reach automation.ts via core services), leaving `READ_TOOLS` half-initialized on some entry orders. Split out two leaf modules — `services/automation-settings.ts` (settings get/update, re-exported from automation.ts) and `services/pipeline-runs.ts` (`startPipelineRun` + `DuplicatePipelineRunError` + `rowToRun`, re-exported from pipeline-engine.ts) — so enqueuing never loads the engine and tools never load the run loop.
- All suites green (`npm test`, `npm run typecheck`) — counts recorded in the delivery comment.
