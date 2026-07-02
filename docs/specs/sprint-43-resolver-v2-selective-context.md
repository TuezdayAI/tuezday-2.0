# Spec + Implementation Plan: Sprint 43 — Resolver v2: tiered selective context

> Status: in build (started 2026-07-02)
> Roadmap entry: this is **"Sprint A"** from `docs/plans/context-discovery-gap-assessment.md`
> (2026-07-02 gap assessment, committed on this branch). Follow-ons: B=44 scoped guidance &
> topics, C=45 discovery routing, D=46 connected-account sourcing, E=47 own-the-evidence-store.
> Branch: `sprint-43-resolver-v2-selective-context`, off `main`. Everything through Sprint 40
> is already merged into `main`, so this sprint is **independent — no merge-order caveats**.
> Operating rules unchanged: written spec → tests-before-implementation → build → automated
> verification → founder manual acceptance → frozen. This is an **L** slice.

This document is **self-contained**: it is both the slice spec and the step-by-step build guide, so
a fresh session can resume from it without re-deriving context. "Build order" is the checklist; the
"Progress log" at the bottom records what is done.

---

## Decisions locked (2026-07-02)

Founder said "cook Sprint A" and was away for the two open sub-decisions; both were taken with the
gap assessment's recommendation and are cheap to reverse — **flagging them for founder review**:

1. **Numbering: Sprint A = Sprint 43** (guide already reserves 41 = design layer, 42 = chat).
   Numbering ≠ execution order (Sprint 25 precedent). B–E become 44–47 when they run.
2. **Outline summaries are LLM-composed at doc save, with a deterministic fallback** (first
   sentence, truncated) whenever no gateway is available or the call fails. Saves never block on
   the LLM; summaries are stored, inspectable data — not runtime magic.
3. From the gap assessment (founder-reviewed research, recommendation adopted): three-tier
   deterministic resolver, **BM25 lexical zoom in-process — no embeddings, no vector store, no
   agentic retrieval**. Add embeddings later only if lexical recall measurably fails (logged in
   `docs/deferred-improvements.md`).
4. **The five brain docs stay untouched canonical markdown.** Selection changes what a prompt
   *includes*, never what the founder wrote.

## Goal

Stop sending the whole brain with every prompt. Today `resolveContext()`
(`packages/brain/src/resolver.ts`) concatenates all five docs verbatim; the 8k token budget can
only trim evidence chunks, then drop `org:history` and `channel` whole; anything else over budget
is flagged and **sent anyway**. Five mature docs ≈ 60k+ tokens: cost balloons, relevant needles get
buried (context-rot literature in the gap assessment), and `history` silently vanishes every time.

Resolver v2 makes inclusion **selective, deterministic, and fully traced**:

- **Tier 1 — Constitutional (always in, never scored):** `soul`, `voice`, `now`, the target
  channel's guidance, the persona overlay, the campaign overlay, the task payload (lead / media
  contact / signal / conversation / angle / review subject), and the task instruction. Identity is
  not information — it never competes on a relevance score.
- **Tier 2 — Task matrix (editable data, shipped defaults):** `taskType × {icp, history} →
  {full | outline | omit}` with a human-readable reason per cell. Contracts ship defaults; a
  workspace can override any cell in the UI. The policy itself is inspectable data.
- **Tier 3 — Map-then-zoom:** docs in `outline` mode always contribute their outline (headings +
  one-line summaries, maintained at save time) — nothing is invisible — and their **full sections**
  are pulled only when they score (BM25) against a composed query built from what we already know
  before drafting: task type, channel, campaign objective/pillars, signal, lead/contact facts,
  chosen angle.
- **Stable-prefix ordering:** constitutional identity first (Gemini context caching makes repeated
  drafts near-free on that block), volatile task/signal/zoom material last.
- **Real budget enforcement:** a graded sacrifice ladder (evidence chunks → zoomed sections →
  degrade `full` matrix docs to outline) instead of "drop history, then hope".
- **Angle-first doubles as the brief:** when the Sprint-22 angle step is on, the angle call runs
  against a cheap brief bundle (Tier 1 + outlines, no zoom, no evidence), and the chosen angle
  feeds the zoom query of the real draft resolve.

Expected effect (gap assessment): typical mature-brain bundle ~60k → ~6–12k tokens, quality up
(distractors removed), every inclusion/exclusion carries a reason, docs stay canonical markdown.

## Founder-visible chain (acceptance)

Brain page → each doc shows its parsed outline (headings + one-line summaries) and a token count
with a warning when a constitutional doc is heavy → Context inspector → a **task matrix card**
shows the `taskType × icp/history` grid with per-cell mode + reason, editable per workspace, reset
to default → run Resolve for `linkedin_post` → the trace shows tiers: soul/voice/now full
("constitutional"), icp/history as outlines with their zoom sections listed underneath, each with
its BM25 score and the composed query → resolve a `pr_pitch` → history is full ("task matrix:
default") → Playground with the angle step on → the angle call's trace is the cheap brief bundle;
the draft's trace shows the chosen angle inside the zoom query → generation still works end to end
and the bundle is a fraction of its old size.

## Out of scope (logged in `docs/deferred-improvements.md` where marked ⏸)

- Embedding/vector or reranker-based zoom (⏸ — trigger: lexical recall measurably fails).
- Learning-loop joins on the trace (per-section acceptance lift surfaced as suggestions) — later
  sprint; the richer trace persisted now is its raw material.
- Editable/regeneratable per-section summaries in the UI (⏸ — read-only this sprint).
- Widening the matrix beyond `icp`/`history` (soul/voice/now stay constitutional by design).
- Scoped guidance (persona×channel etc.) and persona topics — that is Sprint 44 ("B").
- Any change to evidence retrieval/policy (Sprint 47 "E" owns the store move).
- Prompt-level dedup between outline and zoomed sections (outline stays whole for prefix
  stability; a pulled section repeats its one-liner — a few tokens, deliberate).

---

## Design

### Section parser (`packages/brain/src/sections.ts`, new)

Brain docs are heading-structured markdown (verified against the reference `soul.md`: preamble +
8 H2s, nested H3s under "Operating principles").

- `parseDocSections(content: string): DocSection[]` — splits on H2 (`## `) and H3 (`### `)
  boundaries **outside fenced code blocks**. Content before the first H2 becomes a `preamble`
  section (heading = "(preamble)", level 2). An H2 with H3 children keeps only its own intro text
  (between its heading and the first child); each H3 is its own section carrying `parentId`.
- Stable IDs: slugified heading path — `operating-principles/brain-first`; duplicate slugs get
  `-2`, `-3` suffixes in document order. IDs survive unrelated edits (they derive from headings,
  not offsets); renaming a heading renames the ID — acceptable, outlines regenerate on save.
- `DocSection = { id, parentId?, heading, level (2|3), body, tokens }` where `body` includes the
  heading line (what zoom would inject verbatim).
- A doc with no headings parses to the single preamble section.
- `firstSentenceSummary(body, max = 160)` — deterministic fallback summarizer: first sentence,
  hard-truncated with `…`.

### Outlines, computed at save time

- New nullable column `brain_documents.outline_json` holding a `DocOutline`:
  `{ sections: DocOutlineSection[], generatedAt }`,
  `DocOutlineSection = { id, parentId?, heading, level, summary, summarySource: "llm"|"fallback", tokens }`.
- `updateBrainDoc(db, workspaceId, docType, content, actor, opts?: { llm?: LlmGateway })`
  (existing single write path, `apps/api/src/services/brain.ts:70`) computes the outline on every
  save. With an `llm`: **one** call per save — all section bodies in one prompt, numbered
  one-liners back (strict `SUMMARY n:` line format, parsed like the existing angle/review
  parsers); any parse/gateway failure → fallback summaries for the missing sections. Without an
  `llm` (e.g. the learning-loop write into `now`): fallback summaries. Saves never fail on the LLM.
- Reads: `getBrainOutlines(db, workspaceId)` returns stored outlines and computes fallback
  outlines **on the fly** for docs saved before this sprint (no write-on-read, no backfill
  migration needed).
- Empty docs → `outline_json` null, excluded from resolve exactly as today.

### Task matrix (Tier 2)

- Contracts ship `DEFAULT_TASK_DOC_MATRIX: Record<TaskType, Record<"icp"|"history",
  { mode: "full"|"outline"|"omit", reason: string }>>` — all 13 task types × 2 docs, every cell
  with a reason. Defaults (rationale in each cell's reason string):

  | taskType | icp | history |
  |---|---|---|
  | linkedin_post | outline | outline |
  | cold_email_opener | full | outline |
  | ad_copy_variant | full | outline |
  | landing_page_hero | full | outline |
  | signal_response | outline | outline |
  | outbound_email | full | outline |
  | meta_ad_creative | full | outline |
  | google_rsa | full | outline |
  | pr_pitch | outline | full |
  | press_boilerplate | outline | full |
  | x_dm | full | outline |
  | instagram_post | outline | outline |
  | engagement_reply | omit | omit |

  (Outreach tasks keep `icp` full — pain specificity is the task. PR keeps `history` full — the
  company story is the material. Replies carry their conversation; brain identity suffices.)
- New table `context_matrix_overrides` (id, workspaceId FK cascade, taskType, docType
  (`icp`/`history`), mode, reason nullable, updatedAt; unique `(workspaceId, taskType, docType)`).
  Overrides only; missing row = default (same pattern as `guidance_overrides`).
- Service `apps/api/src/services/context-matrix.ts`: `resolveTaskDocMatrix(db, wsId)` → merged
  matrix, each cell `{ mode, reason, source: "default"|"workspace" }`; `setMatrixCell`,
  `resetMatrixCell`.
- Routes `apps/api/src/routes/context-matrix.ts`: `GET /workspaces/:id/context-matrix`,
  `PUT .../context-matrix/:taskType/:docType`, `DELETE .../context-matrix/:taskType/:docType`.
- **Small-doc escape hatch:** a doc whose full text is ≤ `ZOOM_SMALL_DOC_TOKENS` (600) is included
  full even in `outline` mode (trace: "small enough to include whole") — outlining a 400-token doc
  loses information for no savings.

### Zoom (Tier 3, `packages/brain/src/zoom.ts`, new)

- `composeZoomQuery(input: ResolveInput): string` — deterministic concatenation of: task type,
  channel, campaign name + objective + pillars (see `ResolveCampaign` extension below), signal
  content, lead name/company/role/notes, media-contact outlet/beat, conversation inbound message,
  chosen angle. Shown verbatim in the trace.
- BM25 (k1=1.2, b=0.75) over the candidate sections of **all** outline-mode docs as one corpus
  (shared IDF); tokenizer: lowercase, split on non-alphanumerics, drop tokens < 2 chars and a
  ~40-word stopword list. No stemming (documented; dependency-free and deterministic).
- Selection per doc: sections with score > 0, descending score (tie → document order), until
  `ZOOM_MAX_SECTIONS_PER_DOC` (4) or the per-doc token cap `ZOOM_DOC_TOKEN_CAP` (1,500) is hit.
- Zero matches → outline only; the outline section's reason says so.

### Resolver v2 (`packages/brain/src/resolver.ts`, rewrite of the assembly)

`resolveContext(input)` keeps its name and its public result shape. Input gains:

```ts
interface ResolveInput {
  // ...existing fields unchanged...
  /** Merged Tier-2 matrix; omitted → DEFAULT_TASK_DOC_MATRIX (contracts). */
  matrix?: ResolvedTaskDocMatrix;
  /** Stored/derived outlines for docs the matrix puts in outline mode. */
  outlines?: Partial<Record<BrainDocType, DocOutline>>;
  /** "brief" = angle-step mode: full→outline demotion, zoom off. Default "draft". */
  resolveMode?: "draft" | "brief";
}
// ResolveCampaign gains optional objective?: string; pillars?: string[]  (zoom query material)
```

Section assembly, in bundle order (stable prefix → volatile):

1. `org:soul`, `org:icp`, `org:voice`, `org:history`, `org:now` — same five keys as today,
   canonical `BRAIN_DOC_TYPES` order. `icp`/`history` content per matrix cell: full text, rendered
   outline (`renderOutline`: heading bullets + summaries, hierarchy indented), or empty/excluded
   (`omit`). Reasons name tier, mode, source, e.g.
   `Org brain (tier 2, task matrix — workspace override): outline for linkedin_post — <cell reason>; 3 of 9 sections pulled below.`
2. `channel` — **now constitutional: never budget-dropped** (v1 dropped it whole under pressure).
3. `campaign`, `persona` — keyed overlays, as today.
4. — volatile boundary —
5. `zoom:<docType>:<sectionId>` — one section per pulled section, layer `"zoom"`, title
   `"<DocTitle> § <heading>"`, reason naming score, rank, and cap, e.g.
   `Zoomed in (tier 3): scored 4.31 (rank 1) against the composed query.` Present only in draft
   mode with outline-mode docs and a non-empty query match.
6. `lead`, `media_contact`, `signal`, `conversation`, `evidence` — unchanged semantics.
7. `angle`, `review_subject`, `task` — unchanged, task always last.

`ResolvedContext` gains `zoomQuery?: string` (set when zoom ran) and `resolveMode`.
`ContextSection` gains optional `tier?: 1|2|3`, `mode?: "full"|"outline"|"omitted"`,
`zoom?: { score: number, rank: number }` — all optional, so persisted `sectionsJson` from before
this sprint still parses and the web components type-check.

**Budget ladder** (replaces `BUDGET_SACRIFICE_ORDER`), applied in order until under budget:

1. Trim evidence chunks lowest-rank-first (unchanged v1 behavior, per-chunk trace).
2. Drop zoomed sections lowest-score-first (reason: dropped to fit the token budget).
3. Degrade matrix-`full` informational docs to outline — `history` first, then `icp` (reason
   records the demotion and the overflow).
4. Still over (constitutional identity + task payload alone exceed the budget) → `overBudget:
   true`, send anyway — identity is never truncated; the Brain-page warnings are the fix.

**Brief mode** (`resolveMode: "brief"`): matrix `full` cells demote to `outline`, zoom is skipped
entirely, reasons say `brief mode (angle step)`. Callers omit evidence themselves.

### API wiring

- `registerBrainRoutes` gains `llm` (for save-time summaries) — `app.ts` call site updated.
  `PUT /brain/:docType` response and `brainDocumentSchema` gain the outline.
- A small helper in `apps/api` (e.g. `services/resolve-input.ts`) assembles the shared v2 inputs —
  `{ matrix: resolveTaskDocMatrix(db, wsId), outlines: getBrainOutlines(db, wsId) }` — and **all
  12 `resolveContext` call sites** pass it. Call sites loading a campaign row now pass
  `objective`/`pillars` into `ResolveCampaign`.
- **Guidance-gap fix:** `engagement-reply.ts`, `launches.ts`, `launch-sequences.ts` currently omit
  `channelGuidance`, silently ignoring workspace overrides (found in the pre-spec audit). They now
  resolve it via `resolveChannelGuidance` like every other path.
- **Angle-first as brief** (`routes/generations.ts`): the angle resolve becomes
  `resolveMode: "brief"` with no evidence; the main draft resolve stays `"draft"` with
  `angle: chosenAngle`, which `composeZoomQuery` folds into the query. `/angles` route likewise
  brief. The reviewer resolve (`services/review.ts`) passes no matrix/outlines — its deliberate
  identity-only context (no icp/history informational pull) is preserved by passing an
  all-`omit`… no: reviewers today include all docs; v2 reviewers pass the merged matrix + outlines
  like other sites (review judges voice/soul; icp/history per matrix for the reviewed task type).
- `/resolve` (Context inspector) passes matrix + outlines so the founder inspects exactly what a
  generation would send; response now carries the enriched sections + `zoomQuery`.

### Migration

One generated migration (`npm run db:generate -w apps/api`, lands as `apps/api/drizzle/0030_*.sql`):
`brain_documents.outline_json` (text, nullable) + `context_matrix_overrides` table. No backfill.

### Contracts additions (`packages/contracts/src/index.ts`)

`DOC_CONTEXT_MODES = ["full","outline","omit"]` + type; `MATRIX_DOC_TYPES = ["icp","history"]` +
type; `DEFAULT_TASK_DOC_MATRIX` (complete, reasons mandatory); `matrixCellSchema`,
`updateMatrixCellInputSchema` (mode + optional reason ≤ 300 chars), merged-matrix response schema;
`docOutlineSectionSchema` / `docOutlineSchema`; constants `ZOOM_SMALL_DOC_TOKENS = 600`,
`ZOOM_DOC_TOKEN_CAP = 1_500`, `ZOOM_MAX_SECTIONS_PER_DOC = 4`, `BRAIN_DOC_TOKEN_WARNING = 2_000`;
`brainDocumentSchema` gains optional `outline`. `RESOLVE_MODES = ["draft","brief"]`.
(`DEFAULT_TOKEN_BUDGET` stays 8_000 — now actually enforceable.)

### Web (`apps/web`)

- **Brain page:** per-doc token estimate + amber warning ≥ `BRAIN_DOC_TOKEN_WARNING` on
  soul/voice/now ("counts against every prompt"); read-only outline preview (headings + summaries)
  under each doc.
- **Context inspector (`/resolver`):** task-matrix card — 13×2 grid of mode selects with the cell
  reason shown, workspace-override badge, per-cell reset; resolve output renders tier badges, the
  zoom query, and `zoom` scores (extend the section cards + `components/why-this-output.tsx`; new
  `.layer-zoom` CSS).
- **Playground:** unchanged flows; the trace panel inherits the enriched sections automatically.

---

## Tests (before/with implementation; all suites green before push)

### `packages/contracts`
- `DEFAULT_TASK_DOC_MATRIX` is total (13 × 2), every cell has a non-empty reason and valid mode.
- `updateMatrixCellInputSchema` rejects bad modes/doc types; outline schemas round-trip.

### `packages/brain` — new `sections.test.ts`, `zoom.test.ts`; extend `resolver.test.ts`
- Parser: reference-`soul.md`-shaped fixture (preamble + H2s + H3 children), duplicate headings →
  `-2` suffix, code-fence with `## ` inside not split, heading-less doc → single preamble section.
- Zoom: deterministic ranking on a fixed corpus; tie → document order; zero-match → empty; per-doc
  cap + max-sections honored; stopwords ignored.
- Resolver v2: same five `org:*` keys in canonical order; matrix modes drive full/outline/omit
  content + reasons; small-doc escape hatch; zoom sections appear between `persona` and `lead`
  with scores; `zoomQuery` set; brief mode = no zoom + full→outline + reasons; budget ladder in
  order (evidence chunks → zoom drops → history-to-outline → icp-to-outline → overBudget flag);
  `channel` never dropped; determinism (same input → identical bundle). **Pinned v1 section-order
  and budget tests are updated to the v2 contract** — the five-org-keys + task-last invariants
  stay pinned.

### `apps/api`
- `brain.test.ts` extensions: save with summary-fake gateway → outline persisted, `SUMMARY n:`
  parsed per section; gateway throws → fallback summaries, save still 200; empty doc → null.
- New `context-matrix.test.ts`: GET merged defaults; PUT override (cell source flips to
  workspace); DELETE resets; validation 400s; membership auth (non-member 403 — matches existing
  route-test conventions).
- `resolve.test.ts` updated: linkedin_post default matrix → icp/history outlines; enriched trace
  fields present; pr_pitch → history full.
- `generation-quality.test.ts` extensions: angle path resolves brief (trace shows brief reasons,
  no zoom/evidence sections), draft resolve includes angle in `zoomQuery`.
- One end-to-end assertion that a generation's persisted `sectionsJson` carries tier/zoom fields.
- Sweep: seeded-`sectionsJson: "[]"` suites and other generation suites stay green (new
  `ContextSection` fields optional; empty dev-DB docs resolve exactly as today).

---

## Build order (checklist)

1. [ ] Commit the gap-assessment doc + this spec on the branch.
2. [ ] Contracts: modes, matrix defaults + schemas, outline schemas, constants. Contract tests.
3. [ ] Brain: `sections.ts` parser + fallback summary; `zoom.ts` BM25 + `composeZoomQuery`;
   resolver v2 assembly, budget ladder, brief mode. Brain tests (new + updated pinned).
4. [ ] Schema: `outline_json` + `context_matrix_overrides`; `npm run db:generate -w apps/api`.
5. [ ] API services: brain save-time outlines (+ `llm` threading), `context-matrix.ts`,
   `resolve-input.ts` helper; update all 12 call sites (incl. guidance-gap fix + campaign
   objective/pillars threading + angle-brief). Routes: context-matrix CRUD; `app.ts` wiring.
6. [ ] API tests (new + updated), full `npm test` green, `npm run typecheck` clean.
7. [ ] Web: brain-page outlines + token warnings; matrix card + trace upgrades; `next build` clean.
8. [ ] Docs: `docs/founder-acceptance-tests.md` Sprint 43 section; `docs/deferred-improvements.md`
   entries (embeddings trigger, editable summaries, outline/zoom dedup);
   `docs/plans/sprint-guide-21-onward.md` gains the 43–47 block (Phase G, from the gap assessment).
9. [ ] Commit(s) with the `Co-Authored-By` trailer; `git push -u origin
   sprint-43-resolver-v2-selective-context`. **Do NOT merge into `main`.**

---

## Progress log

- 2026-07-02 — Spec written after a full code audit (12 `resolveContext` call sites mapped; the
  three call sites missing `channelGuidance` found and folded into scope). Branch cut off `main`
  (clean, post-Sprint-40). Founder away for the numbering + summary-mechanism sub-decisions;
  recommendations adopted and flagged above. Implementation starting at step 1.
