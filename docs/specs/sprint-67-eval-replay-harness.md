# Sprint 67 — Eval & replay harness

**Branch:** `sprint-67-eval-replay-harness`, forked from `sprint-66-grounded-critic-fewshot` (23f45cf).
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66 → 67. This branch contains Sprints 61–66; none are on `main` yet.
**PRD:** `docs/plans/prd-agentic-platform.md` §7, Sprint 67 (direction doc Move 6). Plane epic TAP-26.
**Depends on:** Sprint 55 (unified metric model), Sprint 64 (pipeline engine + `runPipelineDryRun`), Sprint 65 (production comparison + edit distance), Sprint 66 (required citations — the thing `citation_validity` validates).

> **Sequencing note the PRD attaches to Sprint 66, resolved here.** Sprint 66's acceptance is "approval rate improves measurably against the Sprint 67 baseline," and the PRD tells us to capture that baseline *before* 66 lands. Sprint 66 is on a branch and unmerged, so nothing has landed yet. This sprint delivers the baseline mechanism; the founder captures a labelled baseline on `main`-as-it-stands (or on the 65 branch) **before** merging 66. `POST /evals/runs` with `baselineLabel` is that action, and it freezes the §1.3 production metrics alongside the replay metrics so the comparison survives the merge.

## 1. Problem

Nothing in the codebase answers "did that change make the output better?" with a number.

- Quality changes are argued, not measured. Sprint 66 rewrote the critique step's goal, added three retrieval tools, and made citations mandatory. Whether that helped is currently unknowable.
- The workspace holds months of `(signal, resolved context, generated draft, founder decision, founder edit)` tuples — `signals`, `generations.sectionsJson`, `drafts.originalContent`/`content`, `approvalDecisions` (now with `reason`, Sprint 66), `draftRevisionTurns` — and has never replayed a single one.
- Sprint 64 shipped `runPipelineDryRun`, which replays historical signals through a definition. It reports *what came out*. It never compares that to *what the founder actually did*, and it scores nothing.
- Sprint 65 measures the two production paths against each other, but only on drafts that actually happened. It cannot answer counterfactuals, cannot run on a branch, and cannot run in CI.
- CI runs `typecheck` and `test`. A prompt edit, a dropped tool from a step's allowlist, or a resolver section that stops being pushed all pass CI silently today.

## 2. What this sprint delivers

### (a) A stored, replayable eval suite built from history

`buildEvalSuite(db, ws, {name, limit, channel?})` walks decided drafts newest-first and freezes each into an `eval_cases` row: the triggering signal, channel, campaign/persona, the **generated** content, the founder's **final** content, the ground-truth outcome (`approved` / `rejected` / `edited`), and the rejection reason when one exists. Snapshots are copied in, not joined at read time (D-67.2), so later edits never rewrite history.

### (b) Replay + two scoring layers

`runEvalSuite(db, deps, ws, {suiteId, definitionId, judge})` replays every case through the **pipeline engine** in `dry_run` mode (D-67.1) — a real, metered, traced engine execution that writes no generation and no draft — then scores each result:

**Hard checks** (`services/eval-checks.ts`, pure, no network, no LLM):

| kind | fails when |
|---|---|
| `length_bounds` | body exceeds `SOCIAL_POST_CONSTRAINTS[channel].bodyMaxChars`, or is under `EVAL_MIN_BODY_CHARS` (40) |
| `banned_claims` | any workspace banned claim appears (word-boundary, case-insensitive) — D-67.5 |
| `placeholder_leak` | template residue survived (`[insert`, `{{`, `TODO`, `lorem ipsum`, `<name>`, `XX%`) |
| `cta_presence` | the suite expects a CTA and none is detectable, or forbids one and a CTA is present (`any` ⇒ `skipped`) |
| `citation_validity` | a critique finding's citation is not grounded in that run's retrieved corpus — D-67.6 |

**Rubric judge** (`services/eval-judge.ts`, LLM): five dimensions 0–5 (voice fit, specificity/evidence, channel fit, brand safety, actionability) with a one-line justification each, plus `overall` 0–100. Optional per run; absent ⇒ judged metrics are `null` and never gate (D-67.4).

### (c) Ground truth, agreement, and metrics

Per case: `editDistanceToFinal` (normalized Levenshtein against what the founder actually shipped — reuses Sprint 65's `edit-distance.ts`) and the harness's own verdict (`pass` when no hard check failed and, if judged, `overall ≥ EVAL_JUDGE_PASS`). Aggregated per run (D-67.7):

- `hardCheckPassRate`, `violations` (count per check kind)
- `avgJudgeScore`, `judged`
- `avgEditDistanceToFinal`
- `agreementRate` — harness verdict matches the founder's outcome
- `rejectRecall` — of founder-**rejected** cases, the share the harness also flagged
- `approvePassRate` — of founder-**approved** cases, the share the harness passed
- `costCents`, `avgDurationMs`
- `production` — the full Sprint 65 `AutomationComparison` snapshot, so a baseline carries every §1.3 metric and not just replay numbers

### (d) Baselines, trends, regression gate

A run labelled with `baselineLabel` is a baseline (D-67.3) — no separate table; the baseline is a run you can open. `compareEvalRuns(current, baseline)` applies `EVAL_REGRESSION_THRESHOLDS` (one exported constant, reviewable in a diff) and returns `{ok, regressions[], improvements[]}`. A metric that is `null` on either side is skipped, never a regression.

### (e) The CI gate

`npm run eval` runs a checked-in **golden suite** (D-67.8): a seeded workspace (brain docs, channel guidance, banned claims, signals, historical drafts + decisions) driven through the *real* harness code with a `ScriptedGateway`, then compared against `apps/api/eval/golden/expected.json`. It fails — non-zero exit, so the merge is blocked — on any of:

1. **Context invariant broken.** Each golden case declares `mustContain` fragments that have to appear in the composed draft-step prompt (the guardrail text, the prior-examples block, the signal, the channel). Deleting Sprint 66's few-shot injection or unpacking the guardrails trips this by name, not by digest.
2. **Context digest moved.** A sha256 of the composed step prompts. Any prompt, step-goal, tool-allowlist, tool-description, or resolver change moves it. The failure message says exactly that and points at `npm run eval:record`.
3. **Metric regression** against the recorded golden metrics via the same `compareEvalRuns` used in production.
4. **A weakened check.** Adversarial golden cases carry scripted outputs that deliberately violate (over-length, banned claim, placeholder residue, fabricated citation) and are recorded as *expected failures*. Soften a check and those cases start passing — which is itself a regression the gate reports.

## 3. Decisions (D-67.x)

- **D-67.1 — the harness replays the engine path only.** Replaying the legacy path would mean either persisting eval drafts through `submitDraft` or refactoring `signal-drafting.ts`, which Sprint 66 (D-66.1) deliberately froze because Sprint 65's A/B is still running against it. Legacy numbers already exist, measured on production traffic, in `getAutomationComparison` — so they enter the harness as the `production` snapshot on every run instead of being re-derived. The harness answers "is the engine getting better?"; Sprint 65 answers "is the engine beating legacy?".
- **D-67.2 — a suite is stored and frozen, not derived per run.** A trend line is meaningless if the case set silently changes underneath it. Cases copy their content snapshots at build time; deleting the source draft later leaves the case intact (`ON DELETE SET NULL` on the source FKs).
- **D-67.3 — a baseline is a labelled run, not a table.** `eval_runs.baseline_label` non-null ⇒ this run is that named baseline. Labels are unique per (workspace, task key); re-labelling moves the label and is recorded on the run.
- **D-67.4 — only the deterministic layer gates.** The judge needs a gateway and a key; CI has neither. Judged metrics are reported and trended but excluded from the CI comparison. The number that blocks a merge must be one CI can actually compute.
- **D-67.5 — banned claims become a first-class list.** The PRD names them as a hard check and nothing in the codebase stores them; `list_channel_guardrails` returns prose guidance, which is not machine-checkable. New `workspace_banned_claims` (phrase + optional note), founder-editable, surfaced to agents through the existing guardrails tool so the critic can cite them.
- **D-67.6 — citation validity means grounding, not URL-checking.** A citation is valid when a significant n-gram of it actually occurs in that run's retrieved corpus (composed step prompts + tool results + injected context). Sprint 66 made citations mandatory; without this check "mandatory" only guarantees a non-empty string.
- **D-67.7 — the founder's decision is ground truth, and agreement with it is the headline.** `rejectRecall` is the number that matters most: a critic that never flags anything scores a perfect hard-check pass rate and is useless. Reporting recall and pass rate together makes that failure mode visible.
- **D-67.8 — the CI gate is a golden fixture suite, not a live replay.** A live replay needs an API key, real workspace history, and non-determinism. The golden suite is deterministic, runs offline in seconds, and exercises the real harness code path end to end.
- **D-67.9 — thresholds live in contracts.** `EVAL_REGRESSION_THRESHOLDS` is one exported constant so loosening the gate shows up in a reviewable diff instead of a config file nobody reads.
- **D-67.10 — eval services are leaves where they must be.** `eval-checks.ts` and `banned-claims.ts` import contracts + drizzle only, so `list_channel_guardrails` can read banned claims without closing the Sprint 65 import cycle through the agent registry. `eval-harness.ts` imports the engine and is never imported by a tool.

## 4. Domain model (migration 0073)

- **`workspace_banned_claims`** — `id` PK, `workspace_id` (cascade), `phrase`, `note` default `''`, `created_at`; unique on (`workspace_id`, `phrase`).
- **`eval_suites`** — `id` PK, `workspace_id` (cascade), `name`, `task_key`, `channel`, `cta_expectation` default `'any'`, `case_count`, `created_by_user_id` (set null), `created_at`.
- **`eval_cases`** — `id` PK, `suite_id` (cascade), `workspace_id` (cascade), `signal_id` (set null), `signal_content`, `signal_source`, `channel`, `campaign_id`/`persona_id` (set null), `source_draft_id` (set null), `generated_content`, `final_content`, `outcome`, `rejection_reason`, `decided_at`, `created_at`; index on `suite_id`.
- **`eval_runs`** — `id` PK, `workspace_id` (cascade), `suite_id` (cascade), `definition_id`/`definition_version` (set null / int), `status`, `judge_enabled`, `metrics_json`, `comparison_json`, `baseline_label`, `failure_reason`, `created_by_user_id` (set null), `created_at`, `finished_at`; unique on (`workspace_id`, `baseline_label`) where non-null; index on (`workspace_id`, `created_at`).
- **`eval_case_results`** — `id` PK, `run_id` (cascade), `case_id` (cascade), `pipeline_run_id` (set null), `produced_content`, `checks_json`, `judge_json`, `verdict`, `edit_distance_to_final`, `cost_cents`, `duration_ms`, `failure_reason`, `created_at`; index on `run_id`.

## 5. Contracts

`EVAL_CASE_OUTCOMES = ["approved","rejected","edited"]`, `EVAL_CHECK_KINDS = ["length_bounds","banned_claims","placeholder_leak","cta_presence","citation_validity"]`, `EVAL_CHECK_STATUSES = ["pass","fail","skipped"]`, `EVAL_RUN_STATUSES = ["running","succeeded","failed"]`, `EVAL_VERDICTS = ["pass","flag"]`, `CTA_EXPECTATIONS = ["any","required","forbidden"]`.

Schemas: `evalCheckResultSchema`, `evalRubricSchema`, `evalCaseSchema`, `evalSuiteSchema`, `evalCaseResultSchema`, `evalRunMetricsSchema`, `evalRunSchema`, `evalRunDetailSchema`, `evalComparisonSchema`, plus inputs `buildEvalSuiteInputSchema`, `runEvalSuiteInputSchema`, `labelBaselineInputSchema`, `bannedClaimInputSchema`, `bannedClaimSchema`. Constants `EVAL_MIN_BODY_CHARS`, `EVAL_JUDGE_PASS`, `EVAL_REGRESSION_THRESHOLDS`.

## 6. Services

- **`banned-claims.ts`** (leaf) — list/add/remove; `matchBannedClaims(claims, text)` word-boundary matcher.
- **`eval-checks.ts`** (leaf) — `runHardChecks(input): EvalCheckResult[]` over `{content, channel, bannedClaims, ctaExpectation, findings, corpus}`; `detectCta`, `citationsGrounded`, `significantNgrams`.
- **`eval-judge.ts`** — `judgeDraft(llm, {…}) : EvalRubric | null` via `generateStructured`; never throws (a judge failure degrades to `null`, it does not fail the run).
- **`eval-harness.ts`** — `buildEvalSuite`, `listEvalSuites`, `runEvalSuite`, `listEvalRuns`, `getEvalRunDetail`, `labelBaseline`, `getEvalComparison`, `compareEvalRuns` (pure, exported for the golden script), `evalRunMetrics` (pure aggregation).

## 7. API surface (`routes/evals.ts`)

- `POST|GET /workspaces/:id/evals/suites`
- `POST /workspaces/:id/evals/runs` → 201 run (executes inline; suite size is capped)
- `GET /workspaces/:id/evals/runs` (newest first, trend source) · `GET /workspaces/:id/evals/runs/:runId` (detail + case results)
- `POST /workspaces/:id/evals/runs/:runId/baseline` → labels it
- `GET /workspaces/:id/evals/runs/:runId/comparison?baselineLabel=` → regression report
- `GET|POST /workspaces/:id/banned-claims`, `DELETE /workspaces/:id/banned-claims/:claimId`

## 8. Web

`/workspaces/[id]/evals` — suite builder, run trigger (judge toggle), a runs table with the regression banner, per-case results with violation chips and judge scores, baseline marker, and a metric trend. Banned claims editor lives on the existing guidance/automation surface. `lib/evals-view.ts` pure helpers (`metricLabel`, `formatMetric`, `regressionSeverity`, `trendSeries`, `verdictTone`) with tests.

## 9. CI

`npm run eval` → `tsx apps/api/scripts/eval-golden.ts`; `npm run eval:record` → same with `--record`. `.github/workflows/ci.yml` gains an `eval` job running `npm ci && npm run eval`.

## 10. Tests

- `packages/contracts/test/evals.test.ts` — vocabularies, schema validation, thresholds constant shape.
- `apps/api/test/eval-checks.test.ts` — each check's pass/fail/skip cases, CTA detection, citation grounding (grounded vs fabricated), banned-claim word boundaries.
- `apps/api/test/eval-harness.test.ts` — suite build from history (outcome classification, snapshots frozen), replay through a scripted engine, metrics math (recall/precision/edit distance), judge on and off, baseline labelling + uniqueness, regression comparison in both directions.
- `apps/api/test/evals-routes.test.ts` — full HTTP flow, auth/membership, banned-claims CRUD.
- `apps/api/test/eval-golden.test.ts` — the golden suite passes its own gate in-process (so `npm test` catches a broken gate too).
- `apps/api/test/sprint67-migrations.test.ts` — journal tag, table shapes, baseline-label uniqueness, cascade/set-null behavior.
- `apps/web/lib/evals-view.test.ts`.

## 11. Out of scope

Chat eval suite (needs Sprint 76), preference memory (68), auto-tuning prompts from eval results, deleting the legacy path, cross-workspace benchmark corpora.

## 12. Progress log

- 2026-08-06 — Spec written. Branch forked from `sprint-66-grounded-critic-fewshot`. Surveyed: `runPipelineDryRun` (Sprint 64) as the replay primitive, `getAutomationComparison` (Sprint 65) as the production snapshot, `ScriptedGateway` as the deterministic driver, `SOCIAL_POST_CONSTRAINTS` for length bounds, and confirmed no banned-claims storage exists anywhere.
- 2026-08-06 — Implemented and verified green. `npm run typecheck` clean; `npm test` 257 files / 2,648 tests passing (Sprint 66 baseline was 250 / 2,577 — +7 files, +71 tests); `npm run eval` passes its own gate.
  - **Contracts:** eval vocabularies (`EVAL_CASE_OUTCOMES`, `EVAL_CHECK_KINDS`, `EVAL_CHECK_STATUSES`, `EVAL_RUN_STATUSES`, `EVAL_VERDICTS`, `CTA_EXPECTATIONS`), the suite/case/run/result/metrics/comparison schemas, `EVAL_MAX_BODY_CHARS` (sourced from `SOCIAL_POST_CONSTRAINTS`, no invented limit for channels without one), `EVAL_REGRESSION_THRESHOLDS`, banned-claim schemas.
  - **DB:** migration `0073_sprint_67_eval_harness.sql` — `workspace_banned_claims`, `eval_suites`, `eval_cases`, `eval_runs` (partial unique index on the baseline label), `eval_case_results`. Source FKs on `eval_cases` are set-null so deleting a draft cannot rewrite eval history.
  - **API:** `services/banned-claims.ts` and `services/eval-checks.ts` are leaves (contracts + drizzle only) because `list_channel_guardrails` reads the claims — the Sprint 65 cycle lesson. `services/eval-judge.ts` degrades a failed judge to `null` rather than failing the run. `services/eval-harness.ts` owns suite building, replay through the engine in `dry_run` mode, `runCorpus`/`runCitations` for grounding, pure `evalRunMetrics` and `compareEvalRuns`, and baseline labelling that moves a label instead of colliding on the unique index. `routes/evals.ts` wired into `app.ts`; `list_channel_guardrails` now returns `bannedClaims`.
  - **CI:** `apps/api/src/eval/golden-cases.ts` (one clean case plus four adversarial ones, each built to trip exactly one check, plus a fixed resolver input), `src/eval/golden.ts`, `scripts/eval-golden.ts`, `npm run eval` / `npm run eval:record`, and a second `eval` job in `.github/workflows/ci.yml`.
  - **Web:** `/workspaces/[id]/evals` (suite builder, banned-claims editor, run trigger with judge toggle, runs table with the regression banner and per-case violations) + `lib/evals-view.ts`; the automation A/B section links across to it.
  - **Tests:** `packages/contracts/test/evals.test.ts` (10), `apps/api/test/eval-checks.test.ts` (19), `eval-harness.test.ts` (17), `evals-routes.test.ts` (6), `eval-golden.test.ts` (7 — the gate proves it still fails when it should), `sprint67-migrations.test.ts` (5), `apps/web/lib/evals-view.test.ts` (7).
  - Fixed a Sprint 66 test that asserted its migration was the journal's *last* entry — self-invalidating the moment a later sprint lands. Both it and the Sprint 67 equivalent now pin by index, as Sprint 65's does.
  - Note for the reviewer: the golden gate's context digest moves on any prompt, step-goal, tool-allowlist or resolver change. That is the mechanism, not a bug — an intentional change is accepted with `npm run eval:record` and shows up in the diff.
