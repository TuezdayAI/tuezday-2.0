# Sprint 53 — One Campaign Strategy, One Signal Mapping

> **Phase:** I (Architectural Convergence) · **Workstream:** W2
> **Closes:** Atlas conflict #6 (campaign strategy in two places) and #3 (dual signal mapping)
> **PRD:** `prd-agentic-platform.md` §4, Sprint 53
> **Size:** L · **Risk:** Medium (resolver change — the trace is persisted and pinned by tests)
> **Status:** Delivered on `sprint-53-campaign-strategy-signal-mapping` — Tasks 1–8 complete, plus one
> post-review fix round. `npm test` and `npm run typecheck` green. Awaiting founder review and merge
> (after Sprint 52). See §7 for what actually happened, task by task.

---

## 0. Branch and merge order

**Branch `sprint-53-campaign-strategy-signal-mapping` off `sprint-52-collapse-double-gate`, not off
`main`. Required merge order: Sprint 52 → Sprint 53.**

Sprint 53 has no *functional* dependency on Sprint 52, but Sprint 52 (unmerged) already claims
migrations `0060` and `0061`. `origin/main`'s journal ends at `0059`. If Sprint 53 branched off
`main`, drizzle-kit would generate `0060` and produce a journal/snapshot conflict at merge. Branching
off Sprint 52 makes drizzle generate `0062` naturally.

---

## 1. Founder decisions recorded

| ID | Decision | Answer |
|---|---|---|
| **D3a** | Campaign strategy has three homes. What becomes the single source of truth for the LLM? | **Backfill plans; the plan wins.** Run the existing plan backfill for every campaign, then the resolver reads the **active plan revision**, and `composeCampaignOverlay` stops emitting the legacy `campaigns.*` structured columns. The overlay becomes pure free-text "additional instruction". This genuinely closes the conflict rather than documenting it. |
| **D3b** | What happens to `suggestedPersonaId` / `suggestedCampaignId` on the public API? | **Keep as intent; derive storage.** Both fields keep being accepted on input, but they now express explicit human intent that synthesizes a score-100 `signal_matches` row (what `createSignalWithMatching` already does) instead of writing standalone columns. Non-breaking for API consumers, preserves the "skip the LLM" path, and still kills the dual mapping because the stored value becomes derived from `matches[]`. |

---

## 2. The problem

### 2.1 Problem A — campaign strategy lives in **three** places, not two

The PRD describes plan-vs-overlay. The code is worse:

1. **`campaigns.*` row columns** — `objective`, `kpi`, `timeframe`, `audience`, `pillars`.
   `composeCampaignOverlay` (`apps/api/src/services/campaigns.ts:250-260`) concatenates these into a
   block (`Objective:`, `KPI:`, `Timeframe:`, `Audience:`, `Messaging pillars:`) **and then appends
   the free text**. The resolver reads this.
2. **`campaign_plan_revisions.*`** (`apps/api/src/db/schema.ts:575-606`) — the curated plan:
   `objective`, `kpi`, `timeframe`, `audienceIdsJson`, `pillarsJson`, `offersJson`, `ctasJson`,
   `guidance`. **The resolver never reads this.** Its only consumers are the plan routes,
   `orchestration-backfill.ts`, and `draft-editor.ts:280` — which reads it *only* for an
   `activatedAt` staleness timestamp.
3. **`campaigns.overlay`** (`schema.ts:555`) — free text, capped at `CAMPAIGN_OVERLAY_MAX_CHARS`
   (10,000).

So what the founder curates in the plan form and what the LLM actually sees can drift apart silently
and permanently.

### 2.2 Problem B — two signal→routing mappings

- **Legacy (Sprint 31):** `signals.suggestedPersonaId` / `.suggestedCampaignId`
  (`schema.ts:371-372`) and the same pair on `discovered_items` (`schema.ts:502-503`). **No FK, no
  index** on either.
- **Current (Sprint 45):** scored `signal_matches` / `discovered_item_matches` rows
  (`schema.ts:673-729`).

**Automation already reads only `matches[]`** — `getBestSignalMatchForCampaign`
(`services/matching.ts:474-541`), called from `runAutomation`. `automation.ts:264-266` says so
explicitly. The legacy fields are UI-prefill and accept-path baggage.

**Two write paths already derive the legacy fields from `matches[0]`** —
`services/signals.ts:121-127` (behind a hook literally named `afterProjectionUpdate`) and
`services/discovery-matching.ts:328-329`. So this half of the sprint is smaller than the PRD implies:
it is removing the *stored* column in favour of a computed read, plus killing four write paths.

---

## 3. Design

### 3.1 The plan context section

A new traced resolver section carrying the active plan revision. Adding one requires **all seven** of:

| Step | Where |
|---|---|
| New `ContextLayer` member (`plan`) | `packages/brain/src/resolver.ts:214-228` (closed union) |
| New `ResolveInput` field | `resolver.ts:316-378` |
| `sections.push({...})` at the right ordering point | `resolver.ts:592-605` region, immediately after `campaign` |
| Sacrifice-ladder entry | `resolver.ts:884-938` |
| Input plumbing across **14** `resolveContext` call sites | mirror `services/resolve-input.ts:16` |
| Update **3** pinned key-order assertions | `packages/brain/test/resolver.test.ts:63, 223, 269` |
| `.layer-plan` CSS rule | `apps/web/app/globals.css:986-993` |

**Ordering:** the plan section goes immediately **after** `campaign` and before `persona`, keeping it
inside the stable cacheable prefix (the resolver is deliberately ordered so Gemini can cache the
prefix).

**Content:** composed from `getCurrentCampaignPlan(db, workspaceId, campaignId)`
(`services/campaign-plans.ts:256`) — objective, KPI, timeframe, pillars, offers, CTAs, guidance.
Returns `undefined` when a campaign has no plan; the section is then pushed **excluded** with a
reason, exactly as `campaign` and `lead` already do.

### 3.2 The token budget — new machinery, and load-bearing

**There is no per-section token budget today.** There is one global `tokenBudget`
(`DEFAULT_TOKEN_BUDGET = 8_000`) and a three-step sacrifice ladder: drop evidence chunks → drop
`zoom` sections → demote `history`/`icp` to outlines. Everything else is **never cut**; the bundle
just reports `overBudget: true`.

This matters because a maximal plan is enormous: `guidance` alone shares the 10,000-char cap
(≈2,500 tokens against an 8,000 budget), plus 20 pillars × 200, 20 offers × 300, 20 CTAs × 300. **A
worst-case plan section could exceed the entire budget with no recovery.**

Therefore, both:

- **A hard cap while composing** the section content (`PLAN_SECTION_TOKEN_CAP`, defined in
  `packages/contracts` per the enum/constant rule). Compose in priority order — objective, KPI,
  pillars, offers, CTAs, then guidance — and truncate at the cap, recording the truncation in the
  section's `reason` so the trace never lies about what the model saw.
- **A fourth ladder rung**: when still over budget, demote the plan section to a compact form
  (objective + KPI + pillars only) before the bundle ships `overBudget`.

Tier: **1** (constitutional — it is campaign strategy). Do **not** widen `MATRIX_DOC_TYPES`; Sprint
43 explicitly declared that out of scope.

### 3.3 Re-scoping the overlay — and the sequencing that makes it safe

`composeCampaignOverlay` stops prepending the `campaigns.*` structured block; the overlay becomes the
free text alone, re-labelled in the UI as "additional instruction".

**The plan is optional and the overlay is not.** Campaigns exist today with an overlay and **no plan
at all** (the campaign page still shows an "Initialize campaign plan" CTA). If the structured block
is removed before those campaigns have plans, they lose objective/KPI/pillars from their prompts
entirely.

**So the order is not negotiable: backfill every campaign's plan first (Task 3), then re-scope the
overlay (Task 4).** The backfill route already exists: `POST .../plan/backfill`
(`routes/campaign-plans.ts:166`), with `services/orchestration-backfill.ts` behind it.

### 3.4 Accepted invariant break

Sprints 43 and 44 went to visible lengths to keep prompts **byte-identical** for unchanged inputs
(`resolver.ts:576-577, 611-612, 648-649`). **Sprint 53 deliberately breaks that** for every
campaign-scoped generation, on all 14 call sites. This is the intended effect — the LLM finally sees
the curated plan — but it must be stated so it is not later mistaken for a regression.

### 3.5 The signal projection

- **Reads become derived.** `suggestedPersonaId` / `suggestedCampaignId` are computed from the
  top-scoring match. `listSignals` already batch-loads matches via `listSignalMatchesForSignals`
  (`matching.ts:338`), so the projection costs **zero new queries** — compute it in memory.
- **Input stays, storage goes (D3b).** `createSignalInputSchema` keeps accepting both fields. When
  supplied they synthesize a score-100 match — which is what `createSignalWithMatching:156-161`
  already does — instead of writing columns. This preserves the "explicit human intent, skip the
  LLM" branch at `services/signals.ts:108` and `:154`, which is **not** a pure deletion.
- **The public API is fixed by this, not broken by it.** `POST /api/v1/ideas`
  (`routes/public-api.ts:25`) currently calls `createSignal`, which persists the legacy fields with
  **no `signal_matches` row at all**. Routing it through the intent path gives those signals a real
  backing match for the first time.
- **The accept path needs care.** `services/discovery.ts:769-783` synthesizes a pseudo-match from the
  stored fields when they are absent from `itemMatches`. That is a real behavioural dependency, not
  cosmetic — it must read the derived projection instead.
- **Migration: null the columns, do not drop them.** SQLite `DROP COLUMN` triggers a table recreate,
  which this codebase already avoids (see the `currentPlanRevisionId` comment at `schema.ts:564-566`).
  Neither column has an FK or index, so nulling costs nothing structurally. Physical removal is a
  follow-up sprint once the projection has proven itself.

### 3.6 Out of scope

Widening `MATRIX_DOC_TYPES`; changing the ten-state action lifecycle; touching `zoom` scoring;
physically dropping the legacy columns; and any change to `campaigns.*` column *storage* (only their
use in prompt composition changes).

---

## 4. Implementation plan

> TDD throughout. `npm test` and `npm run typecheck` green before each commit.

### Task 1 — Plan section composer (pure, no DB, no resolver)
**Files:** create `packages/brain/src/campaign-plan-section.ts`; constant in
`packages/contracts/src/index.ts`; test `packages/brain/test/campaign-plan-section.test.ts`.
- [ ] Test: composes objective/KPI/timeframe/pillars/offers/CTAs/guidance in priority order; a
      maximal plan is truncated at `PLAN_SECTION_TOKEN_CAP` and reports that it truncated; an empty
      plan composes to empty; a compact form (objective + KPI + pillars) is available for the ladder.
- [ ] Run; confirm failure. Implement. Run; green. Commit.

### Task 2 — Wire the section into the resolver
**Files:** `packages/brain/src/resolver.ts` (layer union, `ResolveInput`, push site, ladder);
`packages/brain/test/resolver.test.ts`; `apps/web/app/globals.css`.
- [ ] Test: with a plan present, a `plan` section appears **immediately after `campaign`**, `tier: 1`,
      `included: true`, non-empty content, correct token count.
- [ ] Test: with no plan, the section is present but `included: false` with an explanatory reason and
      `tokens: 0` (matching how `campaign`/`lead` handle exclusion).
- [ ] Test: an oversized plan trips the new ladder rung — demoted to compact form before
      `overBudget` is reported.
- [ ] Test: determinism still holds (`resolveContext(input)` deep-equals itself).
- [ ] Update the **three** pinned key-order assertions (`:63, :223, :269`). Verify the new key landed
      at the intended index rather than rubber-stamping the list.
- [ ] Add `.layer-plan` to `globals.css` — there is **no fallback**, so a missing rule renders
      unstyled in three surfaces (resolver inspector, `ContextSectionsTrace`, sandbox).
- [ ] Run; green. Commit.

### Task 3 — Plumb the plan into all 14 call sites, and backfill
**Files:** `apps/api/src/services/resolve-input.ts` (new campaign-scoped helper, mirroring
`selectiveContextInputs`); the 14 `resolveContext` call sites; `apps/api/test/resolve.test.ts`,
`apps/api/test/selective-context.test.ts`.
- [ ] Test: `POST /workspaces/:id/resolve` with a `campaignId` whose campaign has an active plan
      returns a populated `plan` section in the trace.
- [ ] Test: the tiered trace persisted on a generation includes the plan section
      (`selective-context.test.ts:256` is the existing guard for trace persistence).
- [ ] Implement `campaignPlanInput(db, workspaceId, campaignId)`. Note `selectiveContextInputs` is
      **workspace**-scoped while a plan is **campaign**-scoped, so it cannot simply be folded in.
- [ ] **Backfill every existing campaign's plan** using the existing backfill service, so no campaign
      is left without one before Task 4 removes the legacy composition.
- [ ] Run; green. Commit.

### Task 4 — Re-scope the overlay to free text only
**Files:** `apps/api/src/services/campaigns.ts:250-273`; `apps/api/test/campaigns.test.ts`; the
campaign form copy in `apps/web`.
- [ ] Test: `composeCampaignOverlay` returns **only** the free text — no `Objective:` / `KPI:` /
      `Timeframe:` / `Audience:` / `Messaging pillars:` block.
- [ ] Test: a campaign-scoped resolve now carries strategy in the `plan` section and instruction in
      the `campaign` section, with no duplication between them.
- [ ] Keep `composeResolveCampaign`'s `objective`/`pillars` for the **zoom query** (`zoom.ts:57-61`)
      — that is a separate consumer and must not regress.
- [ ] Update the stale exclusion string at `resolver.ts:602` ("campaigns arrive in a later slice") and
      any test asserting on it.
- [ ] UI copy: the overlay field is "additional instruction", not strategy.
- [ ] Run; green. Commit.

### Task 5 — "What the LLM will see" preview in the plan form
**Files:** `apps/web/.../campaign-plan-form.tsx`; reuse `ContextSectionsTrace` / `SectionBadges` from
`apps/web/components/why-this-output.tsx`; possibly `resolveRequestSchema`.
- [ ] The preview must show the **in-progress draft revision**, not just the active one. `/resolve`
      takes `campaignId` and resolves the *active* plan, so this needs either a `planRevisionId`
      parameter or an inline plan override on the resolve request.
- [ ] **If an inline override is chosen, treat it as an untrusted-input surface on a route that
      composes prompts** — validate it through the same schema as a stored revision, and never let it
      widen limits. Prefer `planRevisionId` if it is sufficient.
- [ ] Pick a sensible default taskType/channel for the preview and let the founder change it.
- [ ] Extend `apps/web/lib/campaign-workspace-contract.test.ts`.
- [ ] Run; green. Commit.

### Task 6 — Signal projection: derive the legacy fields
**Files:** `apps/api/src/services/signals.ts`; `services/discovery.ts`;
`services/discovery-dedupe.ts`; `services/matching.ts`; `routes/public-api.ts`;
`apps/api/test/signals.test.ts`, `discovery.test.ts`, `public-api.test.ts`.
- [ ] Test: a signal created with `suggestedPersonaId`/`suggestedCampaignId` gets a **score-100
      `signal_matches` row**, and reading the signal returns those values as a derived projection.
- [ ] Test: `POST /api/v1/ideas` with those fields now produces a real backing match (today it
      produces none) — the public API contract is unchanged for callers.
- [ ] Test: the "explicit human intent skips the LLM" branch still works (`signals.ts:108`, `:154`).
- [ ] Test: the discovery accept path (`discovery.ts:769-783`) routes correctly from the projection.
- [ ] Test: dedupe (`discovery-dedupe.ts:51-52`) carries routing across a collapse.
- [ ] Kill the standalone column writes; compute the projection in memory in `listSignals` (matches
      are already batch-loaded — **no new queries**).
- [ ] Rewrite `signals.test.ts:553-554` ("the best match is patched onto the convenience fields") and
      `discovery.test.ts:657-658` to assert the projection instead.
- [ ] Run; green. Commit.

### Task 7 — Migration and UI read sites
**Files:** migration via `npm run db:generate -w apps/api` (expect `0062`); `apps/web/.../content/page.tsx:671-672`; `apps/web/.../discovery/page.tsx:1063-1064`.
- [ ] Data migration nulls `signals.suggested_*` and `discovered_items.suggested_*` (hand-written
      sprint-named data migration, following the `0059_sprint_50_reserved_vocabulary.sql` precedent —
      a plain `UPDATE`). **Do not `DROP COLUMN`.**
- [ ] Write it size-independent and idempotent — production row counts are unknown from the repo
      (the checked-in dev DB is empty).
- [ ] Web read sites consume the derived projection; the "Draft response" pre-fill still works.
- [ ] Run; green. Commit.

### Task 8 — Verify, document, push
- [ ] Full `npm test` + `npm run typecheck` green.
- [ ] `docs/deferred-improvements.md`: record the physical column drop as a follow-up.
- [ ] Progress log below updated with what actually happened.
- [ ] Push. **Do not merge** — founder merges, after Sprint 52.

---

## 5. Acceptance criteria

- [x] Editing a campaign plan pillar visibly changes the next generation's resolved context, in the
      trace. (`apps/api/test/resolve.test.ts` — the `campaign_plan` section is composed from the
      active revision and reaches `bundle.prompt`.)
- [x] The plan form shows what the LLM will see for the revision being edited. (Task 5; the unsaved
      draft is previewed inline through `/resolve`, not the already-active revision.)
- [x] No code writes `suggestedPersonaId` / `suggestedCampaignId` as stored columns; reads are
      derived. (Task 6 killed four write paths; Task 7 removed the vestigial fifth and nulled the
      columns in migration `0062`.)
- [x] `POST /api/v1/ideas` still accepts both fields and now produces a real backing match.
- [x] A campaign with no plan degrades to an excluded-with-reason section, never a crash — and its
      legacy structured strategy is carried in the `campaign` section as a **named** fallback rather
      than being silently dropped (Task 4).
- [x] The plan section is bounded unconditionally by `PLAN_SECTION_TOKEN_CAP` while composing, and a
      plan that fits the cap but not the budget is demoted to its compact form (objective, KPI,
      pillars) by ladder rung 4 before the bundle reports `overBudget`.

      > **Corrected (post-review, M5).** This criterion used to read "a maximal plan cannot push the
      > bundle over budget without the ladder demoting it first", which is false. Rung 4 only fires
      > when the compact composition is *smaller* than the full one; for a genuinely maximal plan —
      > one whose first priority field alone overruns the cap — both compositions saturate the cap
      > and the rung is a no-op, and the bundle honestly reports `overBudget`. The **cap** is what
      > bounds this section unconditionally; the ladder is the recovery for mid-sized plans. Both
      > regimes are pinned in `packages/brain/test/resolver.test.ts`.
- [x] `npm test` and `npm run typecheck` pass.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **The trace is persisted and its shape changes.** `generations.sectionsJson` (NOT NULL) is written from the resolved sections and read back by `generations.ts:38` and `draft-editor.ts:201`. | Old rows simply lack the plan section — tolerable, since `tier`/`mode`/`zoom` are already documented as absent on pre-Sprint-43 traces. Verify both readers tolerate its absence. |
| **`draft_revision_turns.sectionsJson` is a second, differently-shaped persistence.** `normalizeContextSections` projects down to `EditorContextSection`, dropping `tier`/`mode`/`zoom`. | The plan section will show in the conversational editor without a tier badge. Decide in Task 2 whether that contract needs widening; record the choice either way. |
| Three pinned key-order assertions fail by design. | Intended guard working. Reviewers must verify the new key landed at the right index, not rubber-stamp the list. |
| `ContextLayer` is a closed union with **no UI fallback**. | Task 2 adds `.layer-plan`; three surfaces render it. |
| Campaigns without plans lose strategy from prompts. | Sequencing is mandatory: backfill (Task 3) strictly before re-scoping (Task 4). |
| A maximal plan blows the 8k budget with no recovery (Tier 1 is never cut). | §3.2: hard compose cap **and** a fourth ladder rung. Directly tested. |
| Legacy-field removal is not a pure deletion — two behavioural dependencies. | §3.5; both are explicitly tested in Task 6. |
| Prompt bytes change for every campaign-scoped generation. | §3.4 — accepted and stated, so it is not mistaken for a regression. |
| Migration numbering collides with unmerged Sprint 52. | §0 — branch off Sprint 52; merge order 52 → 53. |

---

## 7. Progress log

- **2026-08-02** — Recon complete against the working tree (verified Sprint 52 does not touch
  campaign/resolver/signal/matching code — only `schema.ts` +4 lines, `automation.ts` +1,
  `public-api.ts` +2). Decisions D3a and D3b recorded. Plan written, awaiting founder approval.
  No code written yet.

- **2026-08-02 — Task 1 (`3070dcf`), plan section composer.** `packages/brain/src/campaign-plan-section.ts`
  composes the plan in priority order (objective → KPI → timeframe → pillars → offers → CTAs →
  guidance), capped at `PLAN_SECTION_TOKEN_CAP` (defined in `packages/contracts`), reporting
  `truncated` and the `omitted` field labels so the trace can never overstate what the model saw.
  `composeCompactCampaignPlanSection` (objective + KPI + pillars) is the ladder's demotion target.

- **2026-08-02 — Task 2 (`9081ce4`), resolver wiring.** New `plan` `ContextLayer`, new
  `ResolveInput.campaignPlan`, the `campaign_plan` section pushed immediately after `campaign` and
  before `persona` (inside the cacheable prefix), tier 1, and the fourth sacrifice-ladder rung.
  `.layer-plan` added to `apps/web/app/globals.css` — the union has no UI fallback and three
  surfaces render it. The three pinned key-order assertions were updated to **relative index
  arithmetic** (`campaign_plan` sits between `campaign` and `persona`) rather than hardcoded
  indices, which is a stronger guard than the spec asked for.

- **2026-08-02 — Task 6 (`0e2a15d`), signal projection.** `projectSuggestedRouting()` in
  `services/matching.ts`, applied in `rowToSignal` + `rowToItem`; **zero new queries** (matches were
  already batch-loaded). Four column write paths killed. The "explicit human intent skips the LLM"
  branch was factored into `hasExplicitRouting` / `explicitIntentMatches` rather than deleted, and
  `POST /api/v1/ideas` now gets a real score-100 `signal_matches` row with no route change.
  The `afterProjectionUpdate` hook was removed.
  *Bookkeeping anomaly:* this task's eight files were staged by the parallel Track A implementer and
  ride in Task 2's commit under the wrong message. Content is correct; the history is misleading.
  Lesson recorded in the ledger: parallel implementers must stage explicit paths, never `-A`.

- **2026-08-02 — Task 7 (`1e9e897`), migration and UI read sites.** The vestigial
  `discovery-matching.ts` writer removed; `0062_sprint_53_derived_signal_routing.sql` nulls
  `signals.suggested_*` and `discovered_items.suggested_*` with a plain idempotent `UPDATE` — no
  `DROP COLUMN`. The migration number is `0062`, not the `0063` the brief guessed: a **pre-existing
  duplicate `0025` prefix** in the journal explains the 62-entries/max-0061 mismatch. The journal's
  `idx` sequence itself is correct and monotonic and was deliberately left alone (logged as a
  deferred improvement).

- **2026-08-03 — Task 3 (`2acbae6`), plumbing and backfill.** `campaignPlanInput(db, workspaceId,
  campaignId)` in `services/resolve-input.ts`, deliberately not folded into the workspace-scoped
  `selectiveContextInputs`. **Correction to the spec:** there are **16** `resolveContext` call sites,
  not 14; 15 receive the plan and `copilot-actions.ts:104` legitimately does not (it resolves with no
  campaign at all). The backfill is `backfillMissingCampaignPlans(db)` at boot (`app.ts`), keyset-paged
  and size-independent; its candidate predicate is **"no plan revision at all"**, not "no active plan"
  — otherwise a campaign whose activation failed would mint a fresh draft on every boot.

- **2026-08-03 — Task 4 (`9412d4f`), overlay re-scope.** `composeCampaignOverlay` is now the free
  text alone and plan-blind. The legacy structured block moved to `composeLegacyCampaignStrategy`,
  invoked from `composeResolveCampaign(campaign, plan)` **only when the plan would compose to an
  empty section** — measured with the resolver's own `composeCampaignPlanSection`, so the API and the
  resolver can never disagree about whether a plan carries strategy. A new
  `ResolveCampaign.legacyStrategyFallback` flag (data, not inference) lets the resolver name the
  degradation on both the `campaign` and the excluded `campaign_plan` section.
  **Finding that widened the risk:** nothing in campaign *creation* mints a plan and the sweep only
  runs at boot, so "no active plan" is the state of **every campaign created since the last deploy**,
  not just failed activations. Dropping the block outright would have stripped strategy from every
  new campaign on day one. The fallback is therefore steady state, not transitional.

- **2026-08-03 — Task 5 (`bdda27a`), plan-form preview.** `/resolve` accepts an inline
  `campaignPlanDraft` so the founder previews the **unsaved** revision. Treated as an untrusted input
  on a prompt-composing route: it is validated through the same schema a stored revision is created
  through, and `campaignPlanPreviewInput` copies the fields out **one by one** so the body cannot
  smuggle a field the composer reads but the schema does not govern (notably `revision`, which titles
  the section — a previewed draft renders as "Campaign plan", never as an activated revision N).

- **2026-08-03 — Task 8 + final whole-branch review fix round.** Verified green, documented, and then
  fixed what the review found:
  - **C1 (critical), the sprint's own thesis failed after the backfill.** The backfill seeded
    `plan.guidance` from `campaigns.overlay`, so right after the boot sweep the overlay appeared
    **twice** in every campaign-scoped prompt — once as the `campaign` section's additional
    instruction and again as the plan's `Plan guidance:` — and nothing in any campaign write path
    ever re-synced the row into the plan, so the plan section froze at boot-time values while the
    campaign form kept accepting edits. Fixed at the source: the backfill no longer copies the
    overlay (the overlay never *moved*; only the five strategy columns did), and the campaign form
    renders objective / KPI / timeframe / audience / pillars **read-only** with a link to the plan
    once the campaign has an active plan revision — a field the founder can type into that silently
    does nothing is not an acceptable end state. Pinned by a new test that resolves a **backfilled**
    campaign (every prior test hand-built its plan, which is why the existing no-duplication guard
    missed this).
  - **I2**, the Tier-3 zoom query now takes objective/pillars from the plan when it states them,
    falling back to the row columns field by field — the prompt states the plan's strategy, so
    retrieval had been fetching evidence for an objective the model was never given.
  - **I4**, `campaignResolveInputs(db, workspaceId, campaign)` returns the `campaign` and
    `campaignPlan` resolver inputs **together**, so the 15 call sites can no longer compose them from
    different plans (which would produce a `legacyStrategyFallback` flag beside a populated plan
    section). All 15 converted to spread it.
  - **M5**, acceptance criterion above corrected — the cap, not the ladder, is the unconditional
    bound; the no-op regime is now pinned.
  - **M6**, a failed backfill activation is logged (`app.log.warn`) instead of vanishing; the sweep
    never retries it, so that campaign sits on the legacy fallback until a human finishes its plan.
  - **Deferred, recorded in `docs/deferred-improvements.md`:** the physical `suggested_*` column
    drop, campaign creation minting its plan, and the pre-existing duplicate `0025` journal prefix.
