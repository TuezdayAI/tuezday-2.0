# Sprint 71 — Show the work

**Branch:** `sprint-71-show-the-work`, forked from `sprint-70-agent-inbox` (de408b0).
**Merge order:** 61 → 62 → 63 → 64 → 65 → 66 → 67 → 68 → 69 → 70 → 71. This branch contains Sprints 61–70; none are on `main` yet.
**PRD:** `docs/plans/prd-agentic-platform.md` §8, Sprint 71 (direction doc Move 7b; atlas conflict #4 🟡; deferred items #22–#24). Plane epic TAP-30.
**Depends on:** Sprint 66 (prior examples + grounded critic), Sprint 68 (preference memory). Both are on this chain.

---

## 1. Problem

The platform computes a complete reasoning trace on every generation and throws almost all of it away at the UI boundary.

**(a) The trace is real but unreachable.** `generations.sections_json` holds the full `ContextSection[]` — every section, its layer, its tier, its token cost, and a written reason for why it was in or out. `context_snapshots.resolved_context_json` holds the same for every deliverable variant. `draft_revision_turns.sections_json` holds it per revision. Today exactly two surfaces read any of it: `/sandbox` (a raw dump) and the conversational editor's Guidance region (sections + excluded + revision list). A **deliverable**, a **publication**, and a **proposed external action** have no "why" at all — and the editor's version is missing the things a founder actually asks about: what triggered this, which plan pillar it serves, which prior posts it learned from, which learned rules steered it, what the critic said, what changed on revision, and what it cost.

**(b) Nine knobs, no inventory.** Context customization is spread across nine mechanisms — brain docs, built-in channel guidance, workspace guidance overrides, scoped (persona/campaign) guidance, the context matrix, generation settings, the campaign overlay, zoom, and design overlays. Each was added for a good reason; nobody can see them together, and nobody knows which ones real workspaces actually set. That is atlas conflict #4, and it cannot be resolved by argument — only by data.

## 2. What this sprint delivers

### (a) One trace assembler, four artifact kinds

New leaf service `apps/api/src/services/artifact-trace.ts`:

```ts
buildArtifactTrace(db, workspaceId, kind: TraceSubjectKind, id: string): ArtifactTrace | undefined
```

`TRACE_SUBJECT_KINDS = ["draft", "deliverable", "publication", "external_action"]`. Every kind resolves to the same `ArtifactTrace` shape. The three non-draft kinds resolve **through** their artifact to the resolve that produced the words:

| Subject | Route to the resolve | Root |
|---|---|---|
| `draft` | itself | latest completed `draft_revision_turns.sections_json`, else `generations.sections_json` |
| `publication` | `publications.draft_id` | that draft's trace |
| `external_action` | `external_actions.draft_id` (null for non-content actions) | that draft's trace, or a trace with no context when the action has no draft |
| `deliverable` | latest `variants` → `context_snapshots.resolved_context_json` | that snapshot |

That table is the whole design: **one panel, one shape, four entry points.** Nothing is re-resolved and no LLM call is made — every block is read out of state the platform already wrote.

### (b) The blocks the panel shows

| Block | Source | Link target |
|---|---|---|
| `origin` | `drafts.source_signal_id` → `signals`; deliverable → `content_packages` / opportunity; else `manual` | `/discovery`, `/packages`, `/opportunities` |
| `context` | the resolved sections, with layer / tier / mode / zoom score / tokens / included / reason | per-layer: `/brain`, `/guidance`, `/campaigns/:id`, `/personas`, `/evidence`, `/preferences`, `/review?draft=` |
| `plan` | `getCurrentCampaignPlan` → objective, KPI, pillars, plus a **closest-pillar match** | `/campaigns/:id` |
| `examples` | the `examples`-layer section's parsed entries (Sprint 66) | `/review?draft=<id>` per example |
| `preferences` | the `preferences`-layer section's rules, joined back to `preference_rules` by normalized text | `/preferences` |
| `critic` | engine: the `critique` step's `findingsOutput` (score + findings + citations); legacy: `generations.review_json` | `/pipelines?run=` |
| `revisions` | `draft_revision_turns`, with `normalizedEditDistance` per turn | in place |
| `cost` | engine: the `pipeline_runs` row; legacy: `costCents(model, estimated usage)` marked `estimated` | `/billing` |
| `knobs` | the nine, evaluated **for this resolve** | each knob's own surface |

### (c) The nine knobs, named once

New contracts constant `CONTEXT_KNOBS` — nine entries in **precedence order**, each `{key, label, question, surface}`:

1. `brain_docs` — the five brain documents
2. `channel_guidance_builtin` — the shipped per-channel guidance
3. `channel_guidance_workspace` — a workspace override of it
4. `scoped_guidance` — persona- or campaign-scoped guidance (most-specific-wins)
5. `context_matrix` — how each brain doc enters each task type
6. `generation_settings` — review / angle / flag threshold
7. `campaign_overlay` — the campaign's own guidance layer
8. `zoom` — Tier-3 section retrieval
9. `design_overlays` — design-system overlays

For a given resolve each knob reports a `state`: `"absent"` (nothing configured, nothing applied), `"configured"` (set in this workspace but it did not touch this resolve), or `"applied"` (it demonstrably shaped this bundle), plus a one-line `detail` and an `href`. This is what makes "and their interaction" legible: nine rows in precedence order, and you can see the override that beat the built-in.

### (d) Knob-usage instrumentation

New service `apps/api/src/services/knob-usage.ts`:

```ts
buildKnobUsageReport(db, workspaceId, { sampleLimit? }): KnobUsageReport
```

Per knob: `configured`, `configuredCount`, `lastConfiguredAt`, `appliedResolves`, `sampledResolves`, `appliedShare`. `configured*` come from the knob's own table; `applied*` come from replaying the last N persisted generation traces through the same `knobStatesForResolve` the panel uses. Exposed at `GET /workspaces/:id/knob-usage`.

**No new table and no new counter.** See D-71.6.

### (e) Web

- `apps/web/lib/artifact-trace-view.ts` — pure presentation helpers (block ordering, layer copy, knob-state copy, cost formatting, "nothing recorded" states), unit-tested.
- `apps/web/components/why-this-panel.tsx` — the shared panel, driven entirely by one `ArtifactTrace`.
- Mounted on all four artifact kinds: the conversational editor (draft), `/deliverables`, `/content` (publication), and the authorizations queue (proposed action).
- `/resolver` gains the **knob board**: all nine, in precedence order, for the resolve just run.

### (f) Founder note — what this sprint does *not* do

- It does not **delete** a knob. The PRD is explicit: instrument, then propose deletions in a follow-up. Deleting on this sprint's first day of data would be guessing with extra steps.
- It does not record *intent*. The plan-pillar match is a **wording match**, labelled as such in the UI. The platform has never recorded which pillar a draft was written to serve; pretending otherwise would put a fabricated fact inside the one panel whose entire job is to be trustworthy.
- It does not make cost exact on the legacy path. Engine runs carry a metered cost; legacy generations never wrote one, so their cost is priced from the model and an estimated token count and is flagged `estimated`.
- Deferred items #22 (zoom is lexical-only), #23 (outline summaries not editable) and #24 (zoomed rows duplicate their outline) are **surfaced, not fixed**: the knob board says zoom ranks lexically and the trace shows the duplicate rows, which is what makes the case for fixing them. Fixing them is a resolver change, not a transparency change.

## 3. Decisions

- **D-71.1 — one assembler, not four panels.** The panel is driven by a single `ArtifactTrace`, assembled server-side. Four surfaces rendering four ad-hoc "why" views is how the platform ended up with two ranking engines (Sprint 70). The shape is the contract; the surfaces are dumb.
- **D-71.2 — the trace is read, never recomputed.** `buildArtifactTrace` makes no LLM call and does not re-resolve context. A "why" panel that re-runs the resolver would show you *a* bundle, not *the* bundle — and would silently drift from what the model actually saw as the workspace changes. Read-only also means the endpoint is safe to hit from a queue at scroll speed.
- **D-71.3 — the panel is honest about absence.** Every block is nullable and every null carries a written reason (`"This draft predates trace capture."`, `"No campaign — nothing to serve a pillar of."`). A blank block and a "nothing here" block look identical to a founder; only one of them is trustworthy.
- **D-71.4 — the plan pillar is a match, not a claim.** Attribution is `rankTexts` (the deterministic BM25 already used by zoom and few-shot) over the plan's pillars against the artifact text, top 1, rendered as "closest pillar by wording". No LLM, no stored guess.
- **D-71.5 — knob state is derived from the bundle, not asserted by the caller.** `knobStatesForResolve(db, workspaceId, sections, meta)` inspects the actual sections (layer, `mode`, `source`, `zoom`, `scope`) plus the knob tables. A knob that claims to be applied while contributing nothing to the bundle is exactly the knob the follow-up should delete, and only the bundle can prove it.
- **D-71.6 — instrumentation reads existing state; it does not add a counter.** A new `knob_applied` counter table would start empty on deploy and take months to say anything. The knob tables already hold the entire configuration history, and `generations.sections_json` already holds the entire *application* history. The report is a read. This sprint therefore ships **no migration**.
- **D-71.7 — the report samples, and says so.** `appliedShare` is over the last `sampleLimit` (default 200) generations, not all of them, and `sampledResolves` is returned so the denominator is visible. An unqualified percentage over an unbounded scan is both slow and misleading.
- **D-71.8 — the editor's Guidance region becomes the shared panel.** The existing bespoke sections/excluded/revision markup in `conversational-editor.tsx` is replaced by `<WhyThisPanel>`; the revision *composer* stays where it is. Keeping both would leave two "why" renderers on the same screen — the thing this sprint exists to stop.
- **D-71.9 — `external_action` traces content actions only.** A budget change or a targeting change has no draft and therefore no resolve; its trace carries origin, cost `null`, and an explicit `contextReason` saying the action is not generated content. This is a real gap in the platform, not in the panel, and the panel names it.
- **D-71.10 — the endpoint is workspace-scoped and read-only.** `GET /workspaces/:id/trace/:kind/:id` and `GET /workspaces/:id/knob-usage`. No cross-workspace aggregate route this sprint: the deletion decision is made by us reading these per workspace, and a system-actor aggregate route is new attack surface for a report we can assemble by hand.

## 4. Contracts

`packages/contracts/src/index.ts`:

```ts
export const TRACE_SUBJECT_KINDS = ["draft", "deliverable", "publication", "external_action"] as const;
export const TRACE_KNOB_STATES = ["absent", "configured", "applied"] as const;
export const CONTEXT_KNOB_KEYS = [
  "brain_docs", "channel_guidance_builtin", "channel_guidance_workspace",
  "scoped_guidance", "context_matrix", "generation_settings",
  "campaign_overlay", "zoom", "design_overlays",
] as const;
export const CONTEXT_KNOBS: readonly ContextKnob[];   // nine, in precedence order
export const KNOB_USAGE_SAMPLE_LIMIT = 200;

export const traceLinkSchema        = z.object({ label, href: z.string().nullable() });
export const traceOriginSchema      = z.object({ kind, id, label, detail, href, at });
export const traceContextSectionSchema = z.object({ key, layer, title, reason, tokens, included, tier, mode, zoomScore, zoomRank, excerpt, href });
export const traceExampleSchema     = z.object({ kind: "approved"|"rejected", label, excerpt, why, href });
export const tracePreferenceSchema  = z.object({ ruleId, rule, polarity, confidence, href });
export const traceCriticSchema      = z.object({ score, findings: [{issue, citation}], iterations, source: "engine"|"legacy", href });
export const traceRevisionSchema    = z.object({ id, instruction, status, at, changedShare, model, provider });
export const traceCostSchema        = z.object({ inputTokens, outputTokens, costCents, model, provider, durationMs, estimated, href });
export const tracePlanSchema        = z.object({ campaignId, campaignName, objective, kpi, pillars, closestPillar, href });
export const traceKnobSchema        = z.object({ key, label, question, state, detail, href });
export const artifactTraceSchema    = z.object({
  subject: { kind, id, title, state, href, createdAt },
  origin, plan, context, contextReason, examples, preferences,
  critic, revisions, cost, knobs, generatedAt,
});

export const knobUsageSchema = z.object({ key, label, question, href, configured, configuredCount, lastConfiguredAt, appliedResolves, appliedShare });
export const knobUsageReportSchema = z.object({ knobs, sampledResolves, sampleLimit, generatedAt });
```

## 5. API surface

- `GET /workspaces/:id/trace/:subjectKind/:subjectId` → `artifactTraceSchema`; `400 invalid_subject_kind`, `404 subject_not_found`.
- `GET /workspaces/:id/knob-usage?sampleLimit=` → `knobUsageReportSchema`.

Both registered by `registerTraceRoutes(app, db)` from `apps/api/src/routes/trace.ts`.

## 6. Implementation plan

1. **Contracts** — the vocabulary and schemas above, plus `CONTEXT_KNOBS`. Tests: nine knobs, unique keys, precedence order stable, every knob has a surface, schema round-trips.
2. **`services/knob-usage.ts`** — `knobStatesForResolve`, `buildKnobUsageReport`. Leaf: drizzle + contracts + brain types only.
3. **`services/artifact-trace.ts`** — the four resolution routes and the nine blocks. Leaf.
4. **`routes/trace.ts`** + registration in `app.ts`.
5. **Web lib** — `artifact-trace-view.ts` + tests.
6. **Web component** — `why-this-panel.tsx`; mount on the four surfaces; replace the editor's bespoke Guidance markup (D-71.8).
7. **`/resolver`** — the knob board for the resolve just run.
8. **Tests** — contracts, knob-usage service, artifact-trace service (all four kinds + the empty cases), the route, the web view helpers, and shell contracts for the four mount points.

## 7. Acceptance (PRD)

- *"A founder can answer 'why did it write this?' without leaving the draft."* — the draft's panel renders origin, context sections with reasons, plan pillar, prior examples, preference rules, critic findings with citations, revision deltas, and cost, each linked to the thing that produced it. Covered by the trace-service and route tests plus the editor shell contract.
- *"Knob usage data exists for a deletion decision."* — `GET /workspaces/:id/knob-usage` returns all nine knobs with configured counts, last-configured timestamps, and applied share over a stated sample. Covered by the knob-usage tests.

## 8. Out of scope

- Deleting any knob (follow-up, per the PRD).
- Fixing deferred #22/#23/#24 — surfaced only.
- A cross-workspace aggregate route (D-71.10).
- Recording pillar *intent* at generation time (a generation-path change, not a transparency change).
- Overriding a knob from inside the panel: every knob links to its own surface. An override control that writes from a read-only diagnostic panel is a second write path to nine settings, and this sprint is not buying that.

## 9. Progress log

- 2026-08-06 — Implemented and verified green. `npm run typecheck` clean; `npm test` 284 files / 2,861 tests passing (Sprint 70 baseline was 278 / 2,803 — +6 files, +58 tests); `npm run eval` → "✓ No regression" (hard checks 20%, reject recall 100%, approve pass rate 100%, agreement 100%). **No migration** — the sprint ships zero schema change (D-71.6).
  - **Contracts:** `TRACE_SUBJECT_KINDS`, `TRACE_ORIGIN_KINDS`, `TRACE_KNOB_STATES`, `CONTEXT_KNOB_KEYS`, `CONTEXT_KNOBS` (nine, in precedence order, each with a founder-phrased question and a surface), `contextKnob()`, `KNOB_USAGE_SAMPLE_LIMIT`, `TRACE_EXCERPT_MAX_CHARS`, and the schema set: `traceOrigin`, `traceContextSection`, `tracePlan`, `traceExample`, `tracePreference`, `traceCritic`, `traceRevision`, `traceCost`, `traceKnob`, `artifactTrace`, `knobUsage`, `knobUsageReport`.
  - **`services/knob-usage.ts`** (leaf): `readKnobConfiguration` (one read of six knob tables, hoisted so the report does not re-query per sampled bundle), `knobStatesForResolve`, `buildKnobUsageReport`. Generation settings that match the shipped defaults count as unturned; the two always-on knobs (built-in guidance, zoom) report `configured: true` with a zero count rather than reading as unused.
  - **`services/artifact-trace.ts`** (leaf): `buildArtifactTrace` for all four kinds, plus `parseExamplesSection` / `parsePreferencesSection`, which mirror `renderExamples` / `renderPreferences` in `packages/brain` — parsing what was rendered is what keeps D-71.2 intact, since re-retrieving would surface today's nearest neighbours instead of the ones the draft actually saw. Preference rule text is joined back to `preference_rules` through `normalizeRule`, so a retired rule is reported as retired rather than linked to nothing.
  - **`routes/trace.ts`:** `GET /workspaces/:id/trace/:subjectKind/:subjectId` and `GET /workspaces/:id/knob-usage`, registered in `app.ts`. `POST /workspaces/:id/resolve` additionally returns `knobs` alongside the bundle (additive field) so the inspector shows knob state for *that* resolve.
  - **Web:** `lib/artifact-trace-view.ts` (block ordering, layer copy, knob-state copy, cost formatting, the pillar caveat); `components/why-this-panel.tsx` + its CSS module, fetching on first open so a forty-draft queue does not fire forty trace calls. Mounted on the conversational editor (draft), `/deliverables`, `/content` (publication) and the authorizations queue (proposed action). The editor's bespoke sections/excluded/revision markup is deleted per D-71.8 — the composer stays. `/resolver` gained the nine-row knob board.
  - **Tests:** `packages/contracts/test/show-the-work.test.ts` (8), `apps/api/test/knob-usage.test.ts` (14 — knob verdicts driven by *real* `resolveContext` output, not fixtures), `apps/api/test/artifact-trace.test.ts` (12 — all four kinds, the acceptance case, retired rules, revision-over-generation precedence, the no-prompt action), `apps/api/test/trace-route.test.ts` (7), `apps/web/lib/artifact-trace-view.test.ts` (11), `apps/web/lib/why-this-shell-contract.test.ts` (6).
  - **Note for the reviewer — one detector was rewritten mid-sprint.** The context-matrix knob was first detected structurally, by comparing each org section's effective `mode` against `DEFAULT_TASK_DOC_MATRIX`. That is wrong: the resolver legitimately promotes an outline to full when there is budget headroom, so a default-matrix resolve routinely ends up with a mode the default matrix never asked for — the test caught it reporting the matrix as "applied" on five resolves that never touched it. Detection now reads the resolver's own `task matrix — workspace override` marker, which is written exactly when the winning cell came from the workspace. The knob tests resolve real bundles rather than hand-written sections precisely so this class of drift keeps failing loudly.
  - **Note for the reviewer — nothing was deleted.** Per the PRD, this sprint instruments and stops. `GET /workspaces/:id/knob-usage` is the dataset the deletion decision needs; the follow-up reads it per workspace.
- 2026-08-06 — Spec written. Branch created off `sprint-70-agent-inbox` (de408b0). Surveyed: `generations.sections_json` / `context_snapshots.resolved_context_json` / `draft_revision_turns.sections_json` as the three trace stores; `pipeline_runs.draft_id` + `cost_cents` as the only metered cost link; `publications.draft_id` and `external_actions.draft_id` as the two artifact→draft routes; the nine knob tables (`guidance_overrides`, `context_matrix_overrides`, `generation_settings`, `design_overlays`, campaign overlay on plan revisions, brain docs, zoom sections) all confirmed present; the existing bespoke "Why Tuezday made this" region in `conversational-editor.tsx` as the thing to replace.
