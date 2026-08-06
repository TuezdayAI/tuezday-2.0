# Sprint 68 — Preference memory

**Branch:** `sprint-68-preference-memory`, forked from `sprint-67-eval-replay-harness` (28a8e49).
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66 → 67 → 68. This branch contains Sprints 61–67; none are on `main` yet.
**PRD:** `docs/plans/prd-agentic-platform.md` §7, Sprint 68 (direction doc Move 5). Plane epic TAP-27.
**Depends on:** Sprint 57 (tool registry / agent runtime), Sprint 65 (`edit-distance.ts`), Sprint 66 (retrieval few-shot — the resolver seam this sprint copies, and the section it sits next to), Sprint 67 (the harness that can prove a rule changed the output).

> **PRD requirement, verbatim.** Every founder edit to a draft produces a diff; an extraction step turns the delta into a candidate rule ("never open with a rhetorical question", "always name the segment, not the persona") with provenance, confidence, and a hit count. Top-N *relevant* rules injected as a traced resolver section with their own budget. Weekly synthesis changes job: it **promotes** rules that proved stable into `voice`/`now` and **retires** ones that stopped firing. Nothing bypasses the founder-accepts gate. Rules are visible, attributable, and individually reversible in the UI.
>
> **Acceptance.** An edit this morning demonstrably changes this afternoon's generation, and the founder can see exactly which learned rule caused it and switch it off.

## 1. Problem

The learning loop's governance is right and its latency is wrong.

- Today the *only* path from a founder correction back into generation is `synthesizeNow` → a `now`-doc proposal → the founder accepts → the `now` doc changes. The worker proposes one synthesis per `LEARNING_INTERVAL` (a week by default) and refuses to propose while one is open. A correction made on Monday cannot influence Tuesday.
- The corrections themselves are already durable and already ignored. `drafts.originalContent` vs `drafts.content` is a diff. `approval_decisions` rows with `action = "edit"` carry `contentSnapshot`. `draft_revision_turns` carries the founder's *own words* for the correction (`instruction`) alongside `sourceContent` and `resultContent`. Sprint 66 reads some of this as few-shot *examples*; nothing has ever read it as a *rule*.
- An example teaches by imitation and costs 600 characters. A rule teaches by instruction and costs one line. A workspace that has rejected six openings in a row does not need six more examples; it needs one sentence saying "never open with a rhetorical question," and it needs it today.
- `synthesizeNow` is asked to do a job it is structurally bad at: infer durable style law from twenty raw examples in one pass, weekly, with no memory of what it inferred last time. It has no notion of a rule that has been observed three times versus once, and no way to retire one.

## 2. What this sprint delivers

### (a) Capture — a founder edit becomes a durable, digestible row

`services/preference-edits.ts` (leaf) writes one `preference_edits` row per **human** correction, at exactly one choke point: `applyDraftActionInTransaction` with `action === "edit"` and `actor.human`. The conversational editor turns out to land through the same transition (`draft-editor.ts` calls it inside its own transaction), so one hook covers both surfaces and there is no way for a future edit path to bypass capture. The two sources are distinguished by what the founder gave us:

| source | how it arrives | before / after | the founder's words |
|---|---|---|---|
| `draft_edit` | a hand edit at the approval gate | draft content before → submitted content | none |
| `editor_turn` | the conversational editor, which passes its `instruction` down through a new `ApplyDraftActionOptions` | same | `instruction` |

`sourceId` is the `approval_decisions` row id — unique per edit and already written in the same transaction — which makes capture idempotent under a retry without a second identity scheme. No LLM runs in the request path. Capture is deterministic, cheap, and skipped when the normalized edit distance is below `PREFERENCE_MIN_EDIT_DISTANCE` (2.0) — a whitespace fix is not a preference. Rows carry `taskType`, `channel`, `draftId`, and `digestedAt` (null until extraction has read them).

### (b) Extraction — a diff becomes a candidate rule with provenance

`services/preference-extraction.ts` runs off the request path (worker tick + a manual route). It takes undigested edits **grouped by `(taskType, channel)`** — up to `EXTRACTION_GROUP_SIZE` (8) edits per group, `EXTRACTION_MAX_GROUPS` (4) groups per pass — and makes one `generateStructured` call per group returning at most `EXTRACTION_MAX_RULES` (3) rules of:

```ts
{ rule: string /* imperative, ≤160 chars */, polarity: "do" | "avoid",
  confidence: 0–100, evidence: string /* ≤300 chars, quoted from the diff */ }
```

Scope is **not** asked of the model — it is the group's own `(taskType, channel)`, which is exact by construction (D-68.4). Each returned rule is merged against the workspace's existing rules by normalized similarity (`normalizedEditDistance ≤ PREFERENCE_MERGE_DISTANCE`, 20 on the 0–100 scale, same scope): a match increments `observationCount`, raises `confidence` toward the higher of the two, refreshes `lastObservedAt`, and appends an evidence row. A miss inserts a new rule. Every contributing edit is linked through `preference_rule_evidence`, so the UI can show "learned from these three edits" and link each one back to its draft.

Every processed edit is stamped `digestedAt` whether or not it produced a rule — including when the extraction call fails — so a poisonous diff cannot wedge the loop.

### (c) Injection — a traced resolver section with its own budget

A new `preferences` context layer in `packages/brain`, rendered by an exported `renderPreferences()` so the pipeline engine emits the same block it traces (exactly the Sprint 66 arrangement). The section is pushed only when the caller sets `preferences` or `preferencesExclusionReason`, so non-participating call sites keep byte-identical section lists.

`services/preference-rules.ts` (leaf) retrieves the top `PREFERENCE_RULE_LIMIT` (5) **active** rules for a `(taskType, channel)`, ranked by scope specificity then confidence then observation count (D-68.5), and returns them with the counts the trace needs. The section carries its own token ceiling, `PREFERENCE_MAX_TOKENS` (300), enforced inside the resolver by dropping the lowest-ranked rules — "their own budget," literally, and independent of the global trim ladder. In the ladder the section drops at step 1.6, after few-shot examples and before zoom: a compact instruction outlives a 600-character sample.

Wired into both drafting paths, as Sprint 66 did:
- **Legacy** `signal-drafting.ts`, through a `preferenceRuleInputs()` helper in `resolve-input.ts`, spread beside `priorExampleInputs`.
- **Engine** `pipeline-engine.ts`: retrieved once per run, injected into every `output: "draft"` step's user message, and unshifted into the propose step's provenance sections.

Applications are recorded — `appliedCount += 1`, `lastAppliedAt` — by an explicit `recordRuleApplications()` call from the two generation paths only. Retrieval itself never writes, so the resolver inspector, the eval harness, and a preview cannot inflate a rule's hit count (D-68.6).

### (d) Promotion and retirement — the weekly synthesis changes job

`synthesizeNow` now:
1. Computes the **promotable** set deterministically: `status = "active"`, `observationCount ≥ PROMOTE_MIN_OBSERVATIONS` (2), `confidence ≥ PROMOTE_MIN_CONFIDENCE` (70), `appliedCount ≥ 1` — a rule the founder's edits re-derived *and* that has actually shaped a generation.
2. Renders them into the prompt under `STABLE LEARNED PREFERENCES`, instructing the synthesis to fold them into the proposal in the founder's own voice.
3. Records their ids in `basedOnJson.promotableRuleIds`.

`acceptSynthesis` — the existing founder-accepts gate, unchanged in shape — marks exactly those rules `promoted` in the same transaction that appends the proposal to the `now` doc. Promoted rules stop being injected as fast-layer rules, because they now live in the brain doc the resolver already reads. Dismissing the synthesis leaves them active. The promotion set is deterministic and recorded at synthesis time, so nothing depends on parsing ids back out of prose (D-68.7).

Retirement is deterministic and runs in the same tick as extraction: an `active` or `candidate` rule neither re-observed nor applied within `RETIRE_AFTER_MS` (30 days) becomes `retired`. "Stopped firing" means *both* — a rule the founder stopped re-deriving but that is still being applied is a rule that is working (D-68.8).

### (e) The founder can see it and switch it off

`/workspaces/[id]/preferences`: every rule with its status, scope, confidence, observation count, applied count, when it was last observed and last applied, and its evidence — the actual before/after excerpts and instructions it was learned from, each linking to its draft. One click to activate a candidate, disable an active rule, re-enable, or delete. A manual rule can be written by hand (`origin: "manual"`) and behaves identically from there. The captured-but-undigested edits are listed too, so "nothing has been learned yet" is distinguishable from "nothing has been captured yet."

## 3. Decisions

**D-68.1 — Capture is edits only; rejections stay Sprint 66's job.** A reject-with-reason is a strong preference signal, and Sprint 66 already injects it — as the "why" attached to a rejected few-shot example. Reading it a second time here would double-count the same event in two sections of the same bundle. The PRD says *edit*; this sprint captures edits.

**D-68.2 — Only human edits are captured.** `applyDraftActionInTransaction` is also the path for system approvals, the automation tick, and the public API. A machine edit is not a preference, so capture is gated on `actor.human` — the same predicate Sprint 52 already trusts for the approval fingerprint.

**D-68.3 — Extraction is asynchronous, capture is synchronous.** An LLM call inside `POST /drafts/:id/actions` would put a multi-second, failure-prone dependency in the founder's approval path. The durable `preference_edits` row is the queue; the tick is the consumer. The rule is available minutes later, not days — which is the entire point of the sprint, and still nowhere near a request path.

**D-68.4 — Scope is derived from the edit group, never asked of the model.** Extraction batches by `(taskType, channel)`, so the scope of a rule is a fact about its inputs rather than a judgment call the model can get wrong. A rule learned from LinkedIn edits does not silently start governing cold email.

**D-68.5 — Relevance is scope + confidence, not BM25.** Sprint 66 ranks examples with `rankTexts` because an example shares vocabulary with the signal it should be retrieved for. A rule does not: "never open with a rhetorical question" has zero lexical overlap with any signal about pricing, and BM25 would starve exactly the rules that generalize. Ranking is: exact `(taskType, channel)` match, then channel-only, then task-only, then global; ties broken by confidence, then observation count, then recency.

**D-68.6 — Retrieval never writes; generation records the hit.** `appliedCount` is a claim that a rule shaped real output. If retrieval incremented it, the resolver inspector, the eval harness replaying eighty historical cases, and every preview would inflate it — and `appliedCount` is an input to both promotion and retirement, so the inflation would be load-bearing. Recording is one explicit call from each of the two real generation paths.

**D-68.7 — Promotion is a deterministic set chosen before the LLM runs.** The alternative — asking the synthesis to name which rules it promoted and parsing that back — makes a founder-visible state transition depend on prose parsing. The set is computed by rule, passed to the prompt, stored in `basedOnJson`, and applied on accept.

**D-68.8 — A rule retires only when it is both unobserved and unapplied.** Retiring on "not re-observed" alone would delete every rule that is working, since a followed rule generates no further corrections. Retiring on "not applied" alone would delete correct rules for channels the workspace paused.

**D-68.9 — Extracted rules become `active` above a confidence threshold and `candidate` below it.** Auto-activation is what buys same-day latency; the PRD's fast layer is explicitly meant to apply without a gate, being ephemeral, traced, and individually reversible. But a 40%-confidence guess from one ambiguous diff should not silently steer generation, so it lands as a `candidate` the founder can promote in one click. The founder-accepts gate that this does *not* bypass is the one that matters — the one on the **brain docs**, which only `acceptSynthesis` can open.

**D-68.10 — Leaf modules, again.** `preference-edits.ts`, `preference-rules.ts` and `edit-distance.ts` import only drizzle, contracts, and each other, because `drafts.ts` and the resolver seam both reach them and the Sprint 65 import cycle is still one careless import away. `preference-extraction.ts` may import the LLM gateway because nothing in `agents/tools/` reaches it.

## 4. Domain model

```
preference_edits            one human correction, captured verbatim
  id, workspace_id, source ∈ PREFERENCE_EDIT_SOURCES, source_id (unique per workspace+source),
  draft_id → drafts (set null), task_type, channel,
  before_content, after_content, instruction (nullable),
  edit_distance (real, 0–100), digested_at (nullable), created_at

preference_rules            one learned instruction
  id, workspace_id, rule, polarity ∈ PREFERENCE_POLARITIES,
  scope_task_type (nullable), scope_channel (nullable),
  status ∈ PREFERENCE_RULE_STATUSES, origin ∈ PREFERENCE_RULE_ORIGINS,
  confidence (int 0–100), observation_count, applied_count,
  last_observed_at, last_applied_at, promoted_at, retired_at,
  created_at, updated_at

preference_rule_evidence    why a rule exists, and what it came from
  id, rule_id → preference_rules (cascade), edit_id → preference_edits (cascade),
  excerpt, created_at            unique (rule_id, edit_id)
```

`preference_edits.draft_id` is `set null`, so deleting a draft removes the link but never the captured correction — the same freeze rule Sprint 67 applied to eval cases. `preference_rule_evidence` cascades from both sides: a rule's evidence is meaningless without the rule, and an edit deleted (only ever by workspace deletion) takes its evidence with it.

## 5. Contracts (`packages/contracts`)

```ts
PREFERENCE_EDIT_SOURCES   = ["draft_edit", "editor_turn"]
PREFERENCE_POLARITIES     = ["do", "avoid"]
PREFERENCE_RULE_STATUSES  = ["candidate", "active", "disabled", "promoted", "retired"]
PREFERENCE_RULE_ORIGINS   = ["extracted", "manual"]

PREFERENCE_RULE_MAX_CHARS      = 160
PREFERENCE_RULE_LIMIT          = 5     // top-N injected
PREFERENCE_MAX_TOKENS          = 300   // the section's own budget
PREFERENCE_MIN_EDIT_DISTANCE   = 2     // below this a "correction" is whitespace
PREFERENCE_MERGE_DISTANCE      = 20    // ≤ this ⇒ the same rule, restated
PREFERENCE_ACTIVATE_CONFIDENCE = 65    // ≥ this ⇒ active on extraction, else candidate
PROMOTE_MIN_OBSERVATIONS       = 2
PROMOTE_MIN_CONFIDENCE         = 70
RETIRE_AFTER_MS                = 30 days
```

Schemas: `preferenceEditSchema`, `preferenceRuleSchema`, `preferenceRuleEvidenceSchema`, `preferenceRuleDetailSchema` (rule + evidence), `createPreferenceRuleInputSchema` (manual), `updatePreferenceRuleInputSchema` (`{status}`), `extractedPreferenceRuleSchema` + `preferenceExtractionSchema` (the structured-output contract), `preferenceExtractionResultSchema` (`{groups, edits, created, merged, retired}`).

## 6. API surface

```
GET    /workspaces/:id/preferences/rules                    ?status=
POST   /workspaces/:id/preferences/rules                    manual rule
PATCH  /workspaces/:id/preferences/rules/:ruleId            {status}
DELETE /workspaces/:id/preferences/rules/:ruleId
GET    /workspaces/:id/preferences/rules/:ruleId            rule + evidence
GET    /workspaces/:id/preferences/edits                    ?digested=
POST   /workspaces/:id/preferences/extract                  run a pass now
POST   /internal/preferences/tick                           worker, leased
```

## 7. Worker

A `preferences` loop at `PREFERENCES_INTERVAL_MIN` (default 10 minutes, the "inside a day" requirement met with room to spare) calling `/internal/preferences/tick`, which takes the `preferences:extraction` lease and runs extraction + the retirement sweep across every workspace.

## 8. Tests

- `packages/contracts/test/preferences.test.ts` — vocabularies, bounds, the extraction schema's caps.
- `apps/api/test/preference-capture.test.ts` — a human edit captures; a system edit does not; a whitespace edit does not; an editor turn captures its instruction; capture is idempotent per source id.
- `apps/api/test/preference-extraction.test.ts` — grouping by scope, merge-on-restatement bumps the count instead of duplicating, low confidence lands `candidate`, a failing extraction still stamps `digestedAt`, retirement needs both conditions.
- `apps/api/test/preference-injection.test.ts` — the section renders and traces, respects its own token budget, is dropped in ladder order, only `active` rules appear, and `appliedCount` moves on generation but not on retrieval.
- `apps/api/test/preference-promotion.test.ts` — the promotable set reaches the prompt, `basedOnJson` records it, accept promotes, dismiss does not.
- `apps/api/test/preferences-routes.test.ts` — the founder-facing surface end to end, including switch-off.
- `apps/api/test/sprint68-migrations.test.ts` — journal pinned by index, set-null and cascade behaviour.
- `apps/web/lib/preferences-view.test.ts` — the presentation helpers.
- **The acceptance test**, in `preference-injection.test.ts`: an edit is captured, extracted, and the very next engine draft step's context contains the learned rule; disabling the rule removes it from the next context. That is "this morning's edit changes this afternoon's generation, and the founder can switch it off," expressed as an assertion.
- **Sprint 67's golden gate covers this layer.** The fixture workspace gains one active rule (`GOLDEN_PREFERENCE_RULE`), the clean case's `mustContain` names both the block heading and the rule text, and the recorded context digest moves. Without that, a future change to `renderPreferences` or to the injection order would move nothing in CI and pass silently — and the PRD requires the harness to run on any change to a prompt or the resolver.

## 9. Out of scope

- Retrofitting preference rules onto the sandbox `/generate` path, the conversational editor, or ads/PR/outbound. Rules learned from draft edits govern drafting; the two drafting paths are the two Sprint 66 wired, and they are the two wired here.
- Promotion into `voice` specifically. `acceptSynthesis` appends to `now`, which is where the existing gate writes; splitting learnings between two docs is a brain-authoring change, not a memory change.
- Cross-workspace or cross-tenant rule sharing. A preference is a property of one workspace's taste.
- Embedding-based rule similarity. Normalized edit distance over a 160-character imperative is enough to catch a restatement, and it is a leaf with no gateway dependency.

## 10. Progress log

### 2026-08-06 — delivered on `sprint-68-preference-memory`

**Contracts.** `PREFERENCE_EDIT_SOURCES`, `PREFERENCE_POLARITIES`, `PREFERENCE_RULE_STATUSES`, `PREFERENCE_RULE_ORIGINS` plus the ten tuning constants and the schemas listed in §5. `LLM_PIPELINES` gains `preference_extraction`, so the extraction spend shows up in `/billing` beside every other pipeline rather than hiding inside "other".

**Database.** Migration `0074_sprint_68_preference_memory` adds `preference_edits`, `preference_rules`, `preference_rule_evidence`. `preference_edits.draft_id` is set-null; the evidence pair is unique and cascades from both sides; a workspace deletion takes all three with it.

**Capture.** One hook, in `applyDraftActionInTransaction`. `logDecision` now returns the decision id, which becomes the edit's `sourceId` — so capture is idempotent under a retry without inventing a second identity scheme. `ApplyDraftActionOptions.instruction` carries the conversational editor's wording down through the same call, which is what makes `editor_turn` distinguishable from `draft_edit` without a second capture site.

**Extraction.** `runPreferenceExtraction` groups undigested edits by `(taskType, channel)`, makes one `generateStructured` call per group, and merges each returned rule against the existing set by normalized edit distance. Evidence is attributed to the edit whose text best matches the model's own quote, not to whichever edit happened to be first in the batch. Every touched edit is stamped digested — including on a thrown gateway call.

**Injection.** New `preferences` context layer with `renderPreferences()` exported for the engine, its own 300-token ceiling applied before the global ladder, and ladder step 1.6 (after few-shot, before zoom). Wired into `signal-drafting.ts` via `preferenceRuleInputs()` and into the engine's draft steps and propose-step provenance. `recordRuleApplications` is called from exactly two places — after a legacy generation and after a *live* engine generation — so a dry run, a shadow run, an eval replay, and the resolver inspector all leave the hit count alone.

**Promotion.** `synthesizeNow` computes the promotable set before the model runs, renders it into the prompt under `STABLE LEARNED PREFERENCES`, and records the ids in `basedOnJson`. `acceptSynthesis` marks exactly those rules promoted, inside the existing gate. A pre-Sprint-68 synthesis has no such key and accepts fine.

**Worker and API.** `/internal/preferences/tick` under the `preferences:extraction` lease; a worker loop at `PREFERENCES_INTERVAL_MIN` (default 10 minutes); eight founder-facing routes including the on-demand `POST …/preferences/extract`.

**Web.** `/workspaces/[id]/preferences` — rules grouped by status with scope, confidence, and both counts; "Why?" opens the evidence excerpts; activate / switch off / delete; a hand-written-rule form; and the captured-corrections list so "nothing learned yet" is visibly different from "nothing captured yet". The Learning page now names the two halves and links across.

**Verification.** `npm run typecheck` clean. `npm test` → 265 files / 2,706 tests passing (Sprint 67 was 257 / 2,648). `npm run eval` → no regression, after re-recording the golden fixture: the context digest moved to `a8e93d95…` because the fixture now carries a learned rule, and the four headline metrics and the resolver digest are unchanged. The worker config test gained the new interval.

**Notes for the founder.**
- The gate caught this sprint's own context change and refused to pass until it was re-recorded deliberately. That is the Sprint 67 mechanism doing its job on the first sprint that touched injected context after it shipped.
- A rule goes `active` on extraction above 65 confidence. If that turns out to be too eager on real edits, the constant is one line in `packages/contracts` and the founder-facing effect is visible and reversible on the Preferences page the same minute.
- Nothing about the brain-doc gate changed. The only new way into `voice`/`now` is still an accepted synthesis.
