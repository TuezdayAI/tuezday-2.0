# Sprint 66 — Grounded critic & retrieval few-shot

**Branch:** `sprint-66-grounded-critic-fewshot`, forked from `sprint-65-engine-shadow-ab` (82ea06c).
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66. This branch contains Sprints 61–65; none are on `main` yet.
**PRD:** `docs/plans/prd-agentic-platform.md` §7, Sprint 66 (direction doc Move 4). Plane epic TAP-25.
**Depends on:** Sprint 57 (agent tool registry), Sprint 64 (pipeline engine), Sprint 65 (shadow A/B — the measurement rig this sprint's improvement is judged with).

> **Sequencing caution (PRD, verbatim intent):** the Sprint 67 eval harness baseline should be captured *before* this sprint's changes take effect in production, or the improvement is unmeasurable. Building 66 now on its own branch is safe — nothing lands until the founder merges. Recommendation: before merging 66, either (a) record a Sprint 65 rollout-decision snapshot (it freezes approval rate / edit distance / cost per path), or (b) build Sprint 67 first and capture the full baseline. This spec makes no attempt to relax that caution.

## Problem

Two blind spots, both called out in the PRD:

1. **The critic judges blind where it matters least, and the legacy scorer is blind everywhere.** The engine's `critique` step (reference spec) may call 3 tools but is not required to ground its findings; its `citation` field is optional and usually empty. `services/review.ts` (legacy path) scores voice/channel fit with no additional evidence at all. Ungrounded self-critique produces confident hedging.
2. **`approval_decisions` has accumulated a labelled preference dataset since Sprint 5 and is never used at generation time** — worse, when a founder rejects a draft, *why* is recorded nowhere: the table has no reason column. The `find_instructive_rejections` tool (Sprint 57) explicitly documents reconstructing "why" from content deltas and editor instructions because no written rationale exists.

## What this sprint delivers

### (a) Grounded critic — engine `critique` step, not `review.ts` (D-66.1)

- **Citations become the contract.** `findingsOutputSchema` findings change from `{issue, citation?}` to `{issue, citation}` with `citation` a **required, non-empty string** naming the specific retrieved artifact the finding rests on (a guardrail line, a prior post, a voice-doc passage, a plan pillar). The `score` stays — it is the engine's deterministic revise-loop control signal (D-64.7), not the human-facing product; the findings+citations are.
- **The reference spec's critique step retrieves before it judges.** Tools grow from 3 to 6: `find_similar_approved_drafts`, `find_instructive_rejections`, `list_channel_guardrails`, `get_campaign_plan`, `list_recent_publications_with_metrics` (last ten posts on the channel), `get_brain_section` (the voice doc's actual examples). `maxSteps` 4 → 6 to afford the retrieval calls. Goal text rewritten to demand retrieval-first judging and a citation on every finding.
- **Bounded revise loop already exists** (engine-owned, `loop: {scoreFrom: "critique", threshold: 70, maxIterations: 2}`) — unchanged; max 2 iterations is already the PRD bound.
- `review.ts` is **left frozen** (see D-66.1 rationale below).

### (b) Retrieval few-shot from approval history

- **Rejection reasons become data (D-66.2).** New nullable `reason` column on `approval_decisions`. The reject route accepts an optional `{reason}` body; `applyDraftAction`/`logDecision` thread it through; `ApprovalDecision` contract gains `reason: string | null`. The approvals-queue UI gains an optional "Why? (optional)" input next to Reject. Nothing is backfilled; old decisions stay reason-less.
- **New leaf service `services/prior-examples.ts`.** `retrievePriorExamples(db, workspaceId, {query, channel, taskType})` → `{approved: [3], rejected: [2]}`: BM25 (`rankTexts`) over `listTrainingExamples`, recency fallback, exactly the ranking the two Sprint 57 tools use. Rejected examples carry the best available "why", in order of preference: the stored `approval_decisions.reason` → the human's `draft_revision_turns.instruction`s → the original-vs-final edit delta marker.
- **New traced resolver section (D-66.4).** `packages/brain`: new `ContextLayer` member `"examples"`, new `ResolveInput` fields `examples?: ResolveExamples` + `examplesExclusionReason?: string` (mirroring the evidence pattern), rendered as one section — "Prior examples from your approval history" — pushed between `evidence` and `angle`. New budget-ladder rung: when over budget, the examples section is dropped (with a traced reason) after evidence chunks and before zoom sections.
- **Wired into the legacy signal→draft path**: `resolve-input.ts` gains `priorExampleInputs(...)` (the established spreadable-seam pattern); `signal-drafting.ts` spreads it into `resolveContext`. The section appears in the generation's persisted trace, hence the "why this" panel (Sprint 69) for free.
- **Wired into the engine draft step deterministically (D-66.5).** The engine computes prior examples once per run (from the signal content + run channel) and injects a "## Prior examples from approval history" block into the user message of every draft-output agent step — guaranteed context, not tool-optional. `executePropose` records it as a `pipeline:examples` provenance section (layer `"examples"`) so live engine drafts trace it too.
- **`find_instructive_rejections` surfaces the stored reason** (`rejectionReason` field) now that one can exist.

## Decisions

- **D-66.1 — the grounded critic is the engine critique step; `review.ts` stays frozen.** `review.ts` is imported by legacy surfaces only (six sites, none in the engine). Sprint 65's A/B contract preserved the legacy path to be *measured against*, not improved in place; rewiring its reviewer mid-experiment would corrupt the comparison. The engine critique is the thing that replaces it; `review.ts` is deleted when the engine wins (Sprint 65 rollout decision), not rewritten now.
- **D-66.2 — reasons are captured at the gate, optionally.** A required reason would tax every rejection; optional costs nothing and every provided reason compounds (few-shot, critique retrieval, future preference memory — Sprint 68).
- **D-66.3 — `score` survives in `findingsOutput`.** "Findings with citations, not a score" is about what the critic *produces for humans and the reviser*; the score remains the deterministic loop-control signal the engine already owns. Removing it would move loop control into prompts — forbidden by D-64.7.
- **D-66.4 — few-shot is resolver input, not post-resolve mutation.** No call site mutates `resolved.sections`; sections enter through `ResolveInput` only. The resolver stays DB-free: the API side retrieves, the resolver traces.
- **D-66.5 — the engine injects few-shot deterministically rather than relying on the draft step's tools.** "Retrieve … into context" is a guarantee; a tool allowlist is an option the model may skip. The angle step keeps `find_similar_approved_drafts` as a tool for deeper digging; the draft step *always* sees the examples.
- **D-66.6 — required citations are a forward-compatible break.** Old stored findings outputs (citation-less) fail `findingsOutputSchema.safeParse` → `latestScore` returns null → the revise loop treats the draft as unscored and re-critiques. Only in-flight runs across the upgrade are affected; they self-heal on resume.
- **D-66.7 — scope of the resolver section is signal-response drafting.** Other resolver call sites (outbound, PR, ad creatives, personas) don't get the examples section this sprint; the measured surface is the signal→social-post path both Sprint 65 paths share.

## Implementation plan

1. **Contracts** (`packages/contracts/src/index.ts` + tests)
   - `approvalDecisionSchema` (or the `ApprovalDecision` type) + `reason: string | null`.
   - New `rejectDraftInputSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() })`.
   - `findingsOutputSchema`: `citation: z.string().min(1)` required on each finding.
   - `REFERENCE_SIGNAL_SOCIAL_POST_SPEC`: critique step tools/goal/maxSteps as above; draft step goal notes the provided prior-examples block.
2. **DB** (`apps/api/src/db/schema.ts` → `npm run db:generate -w apps/api`, migration 0072)
   - `approvalDecisions.reason: text("reason")` (nullable).
3. **Drafts service + route** — `logDecision` + `applyDraftAction(InTransaction)` accept optional `reason` (logged on the decision row); reject route parses `rejectDraftInputSchema` and threads it; `listDecisions` returns it.
4. **`packages/brain`** — `ResolveExamples` interface, `examples`/`examplesExclusionReason` inputs, `"examples"` layer, section push (between evidence and angle), budget rung, resolver tests.
5. **`services/prior-examples.ts`** (leaf: learning + drizzle only, no agent imports — keep the Sprint 65 cycle lesson) + `priorExampleInputs` in `resolve-input.ts` + `signal-drafting.ts` wiring.
6. **Engine** — compute examples once per run; inject into draft-output step user messages; `executePropose` provenance section.
7. **`find_instructive_rejections`** — join latest reject decision's `reason` per draft; surface as `rejectionReason`.
8. **Web** — approvals-queue reject gains an optional reason input (mirrors Sprint 65's verdict-note pattern).
9. **Tests** — contracts (schema + reference spec validity), migration test, drafts reject-reason (service + route + decision log), brain resolver examples section (+ budget rung + exclusion trace), prior-examples service (ranking, fallback, reason preference order), engine injection + provenance (fake LLM), tool reason surfacing, web view helpers if any.

## Acceptance (PRD)

- A rejected draft's critique cites the specific guardrail and the specific prior example — enforced by the required citation contract + critique tool set.
- Approval-rate improvement is measured against the Sprint 67 baseline once that harness exists; until then the Sprint 65 comparison endpoint + rollout-decision snapshots are the interim measurement.
- Both features traced: the resolver section appears in the generation trace; the engine injection appears in run provenance.

## Progress log

- 2026-08-06 — Spec written. Branch created off `sprint-65-engine-shadow-ab`. Surveyed: `review.ts` legacy-only usage, engine step mechanics, both Sprint 57 retrieval tools, `approval_decisions` schema (no reason column — confirmed), resolver seam (`ResolveInput`-only section entry, budget ladder rungs).
- 2026-08-06 — Implemented and verified green. `npm run typecheck` clean; `npm test` 250 files / 2,577 tests passing (Sprint 65 baseline was 246 / 2,553 — +4 files, +24 tests).
  - **Contracts:** `ApprovalDecision.reason`, `rejectDraftInputSchema`, required `citation` on findings, critique step armed with 6 retrieval tools (`maxSteps` 4→6) and a retrieve-before-you-judge goal, draft step goal names the injected examples.
  - **DB:** migration `0072_sprint_66_reject_reason.sql` (nullable `approval_decisions.reason`, renamed from the generated slug to match the per-sprint convention; journal tag updated to match).
  - **Brain:** `"examples"` layer, `ResolveExamples`/`ResolveExampleApproved`/`ResolveExampleRejected`, `examples` + `examplesExclusionReason` inputs, section pushed between evidence and angle, exported `renderExamples` (the engine renders the same block it traces), new budget rung 1.5 — examples drop whole after evidence chunks and before zoom sections.
  - **API:** `services/prior-examples.ts` (leaf — learning + drizzle only, no agent imports, per the Sprint 65 cycle lesson); `priorExampleInputs` in `resolve-input.ts`; `signal-drafting.ts` wired; engine retrieves once per run and injects into every `output: "draft"` step, with `pipeline:examples` provenance on propose; `find_instructive_rejections` surfaces `rejectionReason`; reject route parses the optional reason and threads it through `applyDraftAction` → `logDecision`.
  - **Web:** approvals-queue Reject opens an inline optional "Why? (optional — teaches the system)" input with Confirm/Cancel; empty reason posts no body, so the old one-click path is intact.
  - **Tests:** `packages/contracts/test/grounded-critic.test.ts` (6), `packages/brain/test/examples-section.test.ts` (7), `apps/api/test/sprint66-grounded-fewshot.test.ts` (9 — reject-reason round trip incl. 400s, retrieval split, reasoned-rejection preference, tool surfacing, legacy trace before/after history, engine draft-only injection + provenance), `apps/api/test/sprint66-migrations.test.ts` (2 — journal position, pre-migration rows survive with NULL).
  - Note for the reviewer: no existing test needed changing. The examples section is pushed only when a call site opts in, so every other resolver call site's section list is byte-for-byte unchanged.
