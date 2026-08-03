# Sprint 59 — Model Routing, Caching & Budgets

> **Phase:** J (Agent Runtime Foundation) · **Direction doc:** Move 8 (economics)
> **PRD:** `docs/plans/prd-agentic-platform.md` §5, Sprint 59 · Founder decision **D6: cost**
> **Branch:** `sprint-59-model-routing-caching-budgets` (off `sprint-58-structured-output-migration` @ `0a5fd2b`)
> **Required merge order:** 56 → 57 → 58 → 59. 59's hard dependency is 56 (usage +
> `costCents` accounting, `agentStep`); it branches off 58's tip because it extends
> `llm/structured.ts` (tier pass-through) and the founder merges in order anyway.
> **Size:** L · **Risk:** Medium · **Status:** see Progress log at the bottom.

Everything runs on Gemini 2.5 Flash at one tier. Agentic loops cost 5–20× a single-shot
call, and the entitlement model is denominated in "generations" (50/mo free, 1k/mo Pro),
which stops meaning anything when one generation is a twelve-step run. This sprint makes
the economics real: **per-call model tiers** (config, not code), **prompt-cache
measurement** on the Sprint 43 stable prefix, **a usage ledger** that gives every LLM
call a workspace + pipeline + cost, **entitlements re-denominated in cost** (D6) with a
soft warning and a hard stop, and **`/billing` spend-by-pipeline**.

---

## 1. Problem (what the code audit found)

1. **No routing.** The model is fixed per gateway *instance* (`gemini.ts:64-66` reads
   `GEMINI_MODEL` once); `GenerateParams`/`AgentStepParams` have no model or tier field.
   One process = one model for every task from email labeling to flagship drafts.
2. **The `generate()` path is cost-blind.** `GenerateResult` carries no usage at all;
   Gemini's `usageMetadata` is read only on the `agentStep` path. All 24 product call
   sites outside the AgentRunner produce zero accounting. `generateStructured` receives
   a full `AgentStepResult` and discards `usage`.
3. **Nothing aggregates.** `agent_runs` has per-run tokens + `costCents` (Sprint 56) but
   no SUM query exists anywhere. There is no usage ledger; `monthlyGenerations` is
   recomputed by counting `generations` rows over a rolling 30-day window.
4. **Pricing table has one entry** and unknown models silently cost 0 (`pricing.ts`).
5. **Caching is unmeasured.** Sprint 43's resolver puts the stable brain prefix first in
   every prompt (`resolver.ts:946-949` — prefix sections before the volatile boundary at
   `:676`), which is exactly what Gemini implicit caching needs — but `cachedTokens` is
   only captured on the agent path, so the hit rate is invisible.
6. **Worker paths are entirely ungated.** `automation`, `discovery-matching`,
   `mailbox-inbox`, engagement auto-reply, `outreach-engine`, `launch-sequences` burn
   LLM cost with no entitlement check of any kind — a free workspace over its plan
   still generates via automation. The copilot chat loop (`runCopilotTurn`, up to 6
   model calls/turn) is likewise ungated.
7. Drive-by (found in audit, fixed here): Stripe checkout success/cancel URLs point at
   `/workspaces/:id/settings/billing`, but the real page is `/workspaces/:id/billing`
   (`routes/billing.ts:50-51`) — a live dead link after checkout.

## 2. Scope

**In:**
1. `tier?: "cheap" | "frontier"` on `GenerateParams`, `AgentStepParams`,
   `GenerateStructuredParams`, `AgentRunParams`; gateways resolve tier → model from env
   config (`GEMINI_MODEL_CHEAP`, `OPENROUTER_MODEL_CHEAP`). Default `frontier` =
   today's model, so unannotated call sites keep exact behavior.
2. Usage on every path: `GenerateResult.usage?` (Gemini + OpenRouter map their native
   usage fields); pricing entries for `gemini-2.5-flash-lite` + OpenRouter model-id
   normalization.
3. **`llm_usage_events` ledger** (new table + migration) and a `meteredLlm(llm, db,
   {workspaceId, pipeline, campaignId?})` gateway proxy in `apps/api/src/llm/metered.ts`
   that records every successful call. All 25 call sites + the AgentRunner route wrap
   with it. Pipeline vocabulary `LLM_PIPELINES` in `packages/contracts`.
4. Cache-hit-rate measurement (`cachedTokens / inputTokens` over ledger rows) surfaced
   per workspace and per pipeline.
5. **Entitlements re-denominated:** `monthlyGenerations` → `monthlyLlmCents` (D6:
   cost). Rolling 30-day spend from the ledger; `assertWithinLimit` machinery reused;
   soft warning at 80% via the existing `usageMeter` thresholds; hard stop = existing
   402 `upgrade_required` convention. Carousels/ad-images (design-daemon LLM, not our
   gateway) record flat-cost ledger events so they stay governed.
6. **Graceful degradation** on worker paths: budget pre-check before each per-workspace
   batch; over-budget work is *skipped and left pending* (retried by later ticks once
   spend rolls out of the window or the plan upgrades — the queue is the existing
   pending state), following the `PostGuardrailCheck`/`blocked` idiom in
   `automation.ts`. Interactive routes hard-stop with 402 **before** the model call.
   New gates on previously ungated interactive LLM routes (outbound draft, PR, chat…).
7. `/billing`: API response gains a `spend` block (budget, spent, state, cacheHitRate,
   byPipeline); web page shows an AI-usage meter, spend-by-pipeline table, cache hit
   rate. Upgrade modal gets human labels + $ formatting for the new key.
8. Checkout URL fix (§1.7).

**Out (explicitly):**
- Explicit Gemini `cachedContents` API (paid cache reservations). We rely on **implicit
  caching** — automatic on Gemini 2.5 for prompts ≥ ~1k tokens with common prefixes —
  which Sprint 43's prefix-first ordering was designed for. We *measure*; if measured
  hit rate stays under target, explicit caching is a follow-up.
- OpenRouter `agentStep` (still deferred per Sprint 56).
- Pipeline definitions as data (Sprint 64) — but `AgentStepParams.tier` is the seam a
  step's declared tier will flow through.
- Billing-period alignment with Stripe `currentPeriodEnd`. Spend uses the same rolling
  30-day window `monthlyGenerations` always used; swapping to Stripe periods is a
  later, isolated change.
- Warmup/embedding accounting (`embed()` has no usage on Gemini's response we use;
  evidence embedding stays unmetered this sprint).
- `adSpendCapCents` (dead vocabulary since Sprint 37, external ad spend not LLM cost) —
  untouched, noted for a future cleanup.

## 3. Design

### 3.1 Tiers & routing (config, not code)

`packages/contracts`: `MODEL_TIERS = ["cheap", "frontier"] as const`, `type ModelTier`.

- `GenerateParams`, `AgentStepParams` gain `tier?: ModelTier` (default `frontier`).
- `GeminiGateway`: `model` (frontier, `GEMINI_MODEL` → `gemini-2.5-flash`) and
  `cheapModel` (`GEMINI_MODEL_CHEAP` → `gemini-2.5-flash-lite`); `modelFor(tier)`
  picks per call. Same for `OpenRouterGateway` (`OPENROUTER_MODEL_CHEAP` →
  `google/gemini-2.5-flash-lite`, generate-only as before).
- `generateStructured` passes `tier` through on both transports. `AgentRunParams.tier`
  flows into every step's `AgentStepParams`.
- `ScriptedGateway` records the tier it was called with, so tests can assert routing.
- `FallbackGateway` forwards params untouched (no change).

Cheap-tier call sites this sprint (the PRD's list — triage, matching, classification,
outline summaries): `matching.ts` (signal matching), `discovery-matching.ts` (batch
scoring), `mailbox-inbox.ts` (reply labeling), `brain.ts` (outline summaries),
`discovery.ts` (`suggestDiscoverySources`). Everything else stays frontier by default —
draft, critique/review, angles, planning, copilot: judgment is the product there.

### 3.2 Usage everywhere

`GenerateResult` gains `usage?: AgentStepUsage` (optional → every existing fake stays
valid). `gemini.ts` maps `usageMetadata` on the generate path exactly as `usageFrom()`
does for steps (`promptTokenCount` → input, `candidates+thoughts` → output,
`cachedContentTokenCount` → cached). `openrouter.ts` parses the OpenAI-style `usage`
field (`prompt_tokens`/`completion_tokens`; cached 0).

`pricing.ts`: add `gemini-2.5-flash-lite` (10 / 40 / 2.5 cents per 1M — half-precision
of Flash's 30 / 250 / 7.5); `costCents` normalizes OpenRouter ids by taking the segment
after the last `/` so `google/gemini-2.5-flash` prices as `gemini-2.5-flash`. Unknown
models still cost 0 (never fail a run), but `meteredLlm` logs one warning per unknown
model name per process, so a silently-free model is at least visible.

### 3.3 The ledger: `llm_usage_events`

```
llm_usage_events
  id TEXT PK · workspace_id FK→workspaces CASCADE · pipeline TEXT
  campaign_id TEXT NULL (FK→campaigns SET NULL) · agent_run_id TEXT NULL
  model TEXT · provider TEXT
  input_tokens INT · output_tokens INT · cached_tokens INT · cost_cents REAL
  created_at INT
  idx (workspace_id, created_at) · idx (workspace_id, pipeline, created_at)
```

`LLM_PIPELINES` (contracts, single enum home): `generation`, `angles`, `review`,
`revision`, `outbound_draft`, `pr_pitch`, `press_kit`, `ad_creative`, `signal_draft`,
`engagement_reply`, `launch`, `launch_sequence`, `outreach_step`, `copilot`,
`copilot_action`, `signal_matching`, `discovery_matching`, `mailbox_classification`,
`outline_summaries`, `source_suggestions`, `brand_profile`, `brain_autodraft`,
`learning_synthesis`, `design_render`, `agent_run`.

**One recording point.** `meteredLlm(llm, db, ctx)` (`apps/api/src/llm/metered.ts`)
proxies `generate`/`agentStep`/`agentStepStream`/`embed`, forwards params verbatim, and
after a successful call with usage writes one ledger row (cost via `costCents`). Call
sites change one line — wrap `deps.llm` with the pipeline they are — instead of each
service hand-rolling accounting. The AgentRunner route wraps its gateway with
`pipeline: "agent_run"`, so agent steps land in the ledger **without touching the
runner**; `agent_runs`/`agent_run_steps` columns stay as the Inspector's per-run view
(the ledger is the sole budget authority — no double counting because the runner itself
never writes ledger rows).

Repair retries in `generateStructured` are two gateway calls → two ledger rows: real
cost is recorded, not idealized cost.

**Design-daemon generations** (carousels, ad-images) don't cross our gateway. They
record a flat event after success: `pipeline: "design_render"`, `model:
"design-provider"`, zero tokens, `DESIGN_RENDER_FLAT_CENTS = 1` (constant in
`pricing.ts`, founder-tunable). That keeps them inside the one budget rather than
becoming free the moment `monthlyGenerations` dies.

### 3.4 Prompt caching & hit rate

Sprint 43 already orders every resolved prompt constitution-first (soul/icp/voice/
history/now → channel → campaign → persona → account, then the volatile boundary), and
the resolver is deterministic — no clocks, no UUIDs. Gemini 2.5 implicit caching keys on
common request prefixes, so the precondition is met; what's missing is measurement:

- `cachedTokens` now recorded on every path (§3.2) into the ledger (§3.3).
- **Hit rate** = `Σ cachedTokens / Σ inputTokens` over a window (null when no input
  tokens). Computed per workspace and per pipeline in the spend rollup, shown on
  `/billing`.
- The audit's known identity-breakers are documented, not fixed here (budget-ladder
  demotions rewriting prefix sections under volatile load, per-taskType matrix cells,
  async outline enrichment double-write). They lower the hit rate; the metric this
  sprint ships is how we'll see by how much.

Acceptance's ">60% on repeat generations" is a runtime property of live Gemini: tests
prove the *metric* (recording + math); the founder verifies the rate on `/billing`
after a few repeat drafts in a real workspace (manual test step).

### 3.5 Entitlements re-denominated (D6: cost)

`Entitlements` (contracts): `monthlyGenerations` **replaced** by `monthlyLlmCents`
(-1 = unlimited). Plan values — **founder-tunable constants, flagged for review**:

| Plan | old | new `monthlyLlmCents` | rationale |
|---|---|---|---|
| free | 50 generations | **50** (¢/mo) | a typical draft ≈ 0.4¢ at Flash pricing → ~2× old capacity |
| pro | 1000 generations | **1000** (¢ = $10/mo) | ~2.5× old capacity at Flash; headroom for agentic runs |
| scale | -1 | **-1** | unchanged |

- `getUsage` returns `{seats, connectors, monthlyLlmCents}` where the spend figure is
  `sumLlmSpendCents(db, workspaceId, since)` over the ledger, same rolling 30-day
  window as before (`Date.now() - 30d`).
- **Hard stop:** `assertWithinLimit(db, ws, "monthlyLlmCents", spent)` — unchanged
  machinery, same `EntitlementError` → 402 `{error: "upgrade_required", key, limit}`.
  A new app-level Fastify `setErrorHandler` maps any uncaught `EntitlementError` to
  that 402 shape (existing per-route catches stay; new gates need no new catches).
- **Soft warning:** `usageMeter(spent, budget)` already yields `"near"` at 80%; the
  spend block carries `state`, `/billing` renders the warning. No new threshold logic.
- Gates fire **before** the model call, per the existing draft-revision convention.
  Denomination switch on the five existing gate sites (generate, angles, carousel,
  revision, ad-image) **plus new gates** on the previously ungated interactive LLM
  routes: outbound draft, PR pitch, press kit, ad-creatives, manual signal draft,
  launches, learning synthesize, brand-profile run, brain-autodraft run, and the
  copilot chat turn (`routes/chat.ts` — up to 6 model calls/turn, and the PRD's D9 row
  says chat doesn't GA before 59).

### 3.6 Graceful degradation (worker paths)

`llmBudgetExhausted(db, workspaceId): boolean` in `entitlements.ts` (shares the
test/`BILLING_ENFORCED` bypasses with `assertWithinLimit`). Checked at the top of each
per-workspace worker batch:

- `automation.ts` — over-budget workspace short-circuits its campaign work with the
  existing structured-refusal idiom: result `blocked: "llm_budget_exhausted"`,
  `generated: 0` (contract field is `z.string().nullable()` — no vocabulary change).
- `discovery-matching.ts` (batch scoring), `mailbox-inbox.ts` (labeling), inbox
  auto-reply, `outreach-engine.ts` (step generation), `launch-sequences.ts` (cadence
  fill) — skip the LLM work for that workspace this tick and return. Items stay
  pending/unlabeled and are naturally picked up by a later tick: the pending state *is*
  the queue; nothing fails mid-run, nothing is dropped.

This is deliberately a **pre-batch check**, not a mid-run abort — same philosophy as the
AgentRunner's pre-call bound checks (Sprint 56 §3.5).

### 3.7 `/billing` surface

`GET /workspaces/:id/billing` response gains:

```ts
spend: {
  periodStart: string;          // ISO, now-30d
  budgetCents: number;          // -1 = unlimited
  spentCents: number;
  state: UsageMeterState;       // ok | near | over | unlimited
  cacheHitRate: number | null;  // Σcached/Σinput over the window
  byPipeline: Array<{ pipeline, calls, inputTokens, outputTokens,
                      cachedTokens, costCents }>;   // desc by cost
}
```

Zod schema `workspaceSpendSchema` in contracts. Web `/billing`: the "Monthly
generations" meter becomes **AI usage** (`$0.13 / $0.50` via the Inspector's
`formatCost`), a spend-by-pipeline table, and a cache-hit-rate stat with the soft
warning shown in the `near` state. `upgrade-modal.tsx` gets a key→label map (`seats` →
"team seats", `monthlyLlmCents` → "monthly AI budget") and formats cost limits as
dollars. Checkout success/cancel URLs fixed to `/workspaces/:id/billing`.

## 4. Per-site inventory (tier + pipeline)

Frontier (default, no tier param): generation `routes/generations.ts:177`; angles
(inline + route) → `angles.ts`; review `review.ts` (pipeline `review`); revision
`draft-editor.ts`; outbound `routes/outbound.ts`; PR pitch + press kit `routes/pr.ts`;
ad creatives `routes/ad-creatives.ts`; signal draft `signal-drafting.ts`; engagement
reply `engagement-reply.ts`; launches `launches.ts`; sequence step
`launch-sequences.ts`; outreach step `outreach-engine.ts`; copilot loop `copilot.ts` +
copilot actions `copilot-actions.ts`; brand profile `brand-profile.ts`; brain autodraft
`brain-autodraft.ts`; learning synthesis `learning.ts`; agent runs
`routes/agent-runs.ts`.

Cheap (`tier: "cheap"`): signal matching `matching.ts:545`; discovery batch scoring
`discovery-matching.ts:435`; mailbox labeling `mailbox-inbox.ts:97`; outline summaries
`brain.ts:194`; source suggestions `discovery.ts:1865`.

Every site wraps its gateway in `meteredLlm(...)` with its pipeline;
`routes/generations.ts` and other campaign-aware sites pass `campaignId`.

## 5. Testing

- `pricing.test` additions: flash-lite rates, OpenRouter id normalization, cached-token
  discounting.
- `llm/metered` unit tests: ledger row per successful call (generate + agentStep),
  cost/cached fields, no row on thrown call, unknown-model warning once.
- Gateway: tier resolves the cheap model on the request URL (Gemini) / body model
  (OpenRouter); `generate` returns mapped usage; ScriptedGateway tier capture;
  structured tier pass-through on both transports.
- Entitlements: `getUsage().monthlyLlmCents` sums the ledger inside the window only;
  gate throws at cap, passes under, -1 unlimited, `BILLING_ENFORCED=false` bypass —
  mirrored from the existing suites onto the new key.
- Routes: generate/chat/outbound/PR/etc. return 402 `{error:"upgrade_required",
  key:"monthlyLlmCents"}` **before** any provider call (assert zero prompts, per the
  draft-revision precedent). Carousel/ad-image flat `design_render` event asserted
  (replacing the "draws down one generation" assertions).
- Worker degradation: automation result carries `blocked:"llm_budget_exhausted"` with
  zero LLM calls; a matching batch under exhaustion leaves items pending and untouched;
  a later tick with budget available processes them (the "queues" acceptance).
- Billing route: spend block totals, byPipeline grouping, cacheHitRate math, `near`
  state at 80%.
- Contracts: plans/entitlement schema updates; existing usage-meter tests unchanged.
- Web copy: upgrade-modal label mapping (if a lib-level test exists; otherwise manual).

## 6. Step-by-step plan

1. Contracts: `MODEL_TIERS`, `LLM_PIPELINES`, `Entitlements.monthlyLlmCents`,
   `entitlementUsageSchema`, `workspaceSpendSchema`; update contracts tests; typecheck.
2. Gateway layer: tier params + `modelFor`, generate-path usage (Gemini, OpenRouter),
   pricing entries + normalization, ScriptedGateway capture, structured/runner tier
   pass-through; gateway tests.
3. Schema: `llm_usage_events` + `db:generate` migration; `services/usage-ledger.ts`
   (`recordLlmUsage`, `sumLlmSpendCents`, `spendByPipeline`); `llm/metered.ts`; tests.
4. Wrap all call sites (pipeline + tier per §4); design-render flat events in
   carousels/ad-images.
5. Entitlements re-denomination + `llmBudgetExhausted` + global `EntitlementError`
   handler + interactive gates; update existing billing/entitlement/carousel/revision
   tests; new gate tests.
6. Worker degradation (§3.6) + tests.
7. Billing API spend block + web `/billing` + upgrade modal + checkout URL fix.
8. Full `npm test` + `npm run typecheck`; grep sweep (no direct `deps.llm` call left
   unmetered in services/routes); Progress log; push; sync Plane TAP Sprint 59.

## 7. Acceptance (from PRD)

- [x] Per-step model routing: a call site declares `tier`, the gateway resolves it from
      configuration (`GEMINI_MODEL_CHEAP` / `OPENROUTER_MODEL_CHEAP`); the five cheap
      sites (signal matching, discovery scoring, mailbox labeling, outline summaries,
      source suggestions) declare `tier: "cheap"` — proven by gateway + structured
      pass-through tests (`test/model-routing-budgets.test.ts`).
- [x] Prompt-cache measurement: `cachedTokens` recorded on every path (generate now
      maps `usageMetadata` like agentStep), hit rate = Σcached/Σinput per workspace and
      per pipeline on `/billing`. The >60% target is founder-verified live; the metric
      machinery is test-proven.
- [x] Cost accounting surfaced per run (Inspector, existing), per pipeline and per
      campaign (ledger columns), per workspace (billing spend block).
- [x] Entitlements denominated in cost (`monthlyLlmCents`, D6) via the unchanged
      `assertWithinLimit` machinery; soft warning at 80% (usageMeter "near" on
      /billing), hard stop = 402 `upgrade_required` before any model call; plan values
      flagged for founder tuning (§8.1).
- [x] Graceful degradation at cap: interactive routes 402 pre-call (proven for
      generate + revision); discovery items go retryable with
      `llm_budget_exhausted`, mailbox items stay unlabeled, sequences/outreach keep
      their due state, automation reports `blocked: "llm_budget_exhausted"` with zero
      model calls (test-proven); nothing fails mid-run.
- [x] `/billing` shows spend by pipeline + cache hit rate; checkout URLs fixed.

## 8. Founder-review items

1. **Plan budget values** (§3.5 table) — shipped as 50¢ free / $10 pro; one-line change
   in `packages/contracts` to tune.
2. `DESIGN_RENDER_FLAT_CENTS = 1` for design-daemon generations.
3. Keeping the rolling 30-day window (vs. Stripe billing period) — consistent with the
   old `monthlyGenerations` semantics; Stripe-period alignment is a clean later change.
4. Explicit Gemini context caching deferred until the measured implicit hit rate says
   we need it.

## 9. Progress log

- 2026-08-03 — Branch created off `sprint-58` tip @ `0a5fd2b`. Code audit complete
  (gateway/usage, entitlements/billing, resolver prefix + 25-call-site inventory).
  Spec written. Implementation starting.
- 2026-08-03 — Implemented in full. `tier` on Generate/AgentStep/Structured/RunParams
  with per-call resolution in Gemini + OpenRouter (cheap defaults flash-lite);
  `GenerateResult.usage` on both providers; pricing entries + id normalization +
  `hasPricing`; `llm_usage_events` (migration `0063_hesitant_jackal.sql`) with
  `services/usage-ledger.ts` (record / sum / rollup) and the `meteredLlm` proxy; all
  25 call sites + the AgentRunner route wrapped with pipeline (+campaign) attribution;
  carousels/ad-images meter flat `design_render` events. Entitlements re-denominated
  (`monthlyLlmCents`: free 50¢ / pro $10 / scale -1), `assertLlmBudget` +
  `llmBudgetExhausted`, app-level EntitlementError→402 handler, new gates on outbound/
  PR/ad-creatives/signals/launches/learning/brand-profile/brain-autodraft/chat +
  manual sequence run + manual reply draft; worker degradation in automation
  (`blocked: "llm_budget_exhausted"`), discovery matching (retryable), mailbox
  labeling, inbox auto-reply, outreach + launch-sequence ticks. Billing GET gains the
  `spend` block; web /billing shows the $-denominated AI-usage meter, near-warning,
  spend-by-pipeline table and cache hit rate; upgrade modal humanizes keys; checkout
  URL fix. Full suite green: 2213/2213 across 204 files; typecheck clean. Awaiting
  founder review/merge (merge order 56 → 57 → 58 → 59).
