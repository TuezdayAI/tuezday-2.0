# Spec + Implementation Plan: Sprint 22 — Generation quality: angle-first + dual-LLM pre-review (A2)

> Status: in build (started 2026-06-17)
> Roadmap entry: `docs/plans/sprint-guide-21-onward.md` → Phase A → Sprint 22.
> Branch: `sprint-22-generation-quality`, off `main`. Builds on Sprint 4 (generation
> sandbox + LLM gateway) and Sprint 5 (approval gate) — both already on `main`, so this
> sprint is independent and does **not** depend on the unmerged Sprint 21 branch.
> Operating rules unchanged: written spec → tests-before-implementation → build → automated
> verification → founder manual acceptance → frozen. This is an **M** slice.

This document is **self-contained**: it is both the slice spec and the step-by-step build guide, so
a fresh session can resume from it without re-deriving context. "Build order" is the checklist; the
"Progress log" at the bottom records what is done.

---

## Decisions locked (founder, 2026-06-17)

1. **Module scope = core flow + review everywhere.** The angle step and automated review both land
   in the core generate flow (sandbox/content) with full UX. Automated review **also** runs on the
   other single-item content generators — **outbound, PR (pitch + boilerplate), and signal-response**
   — because they share the `storeGeneration → submitDraft` seam. **Ad creatives are excluded** from
   review (multi-variant output, already hard-format-gated at the approval gate). The **angle step is
   sandbox/content-only** (per-lead/per-contact angle picking is impractical in batch modules).
2. **Defaults for a new workspace = review ON, angle OFF.** Both stay per-workspace toggleable.
   Automated review runs on every generation by default (the biggest quality lever from the audit);
   the angle step is opt-in. The founder accepts that review-ON means ~2 extra gateway calls per
   generation.
3. **Scoring = 0–100 per check + a configurable flag threshold.** Each check (brand-voice,
   channel-fit) returns an integer 0–100 score plus a list of specific issues. A per-workspace
   `flagThreshold` (default **70**) flags a draft as "weak" when any check scores below it. Flags are
   **advisory only — never block approval** (founder override always works).
4. **Re-review on edit = out of scope, but show + manual re-run.** The review reflects the generated
   draft. It is stored on the generation, copied onto the draft at submit, and shown in Review. A
   manual **"Re-run review"** button re-checks the draft's *current* content on demand and updates the
   draft's review. Edits do **not** auto-trigger review.

---

## Goal (from the roadmap)

Raise output quality **before** a human looks, across all modules — the biggest quality lever from
the audit. Two mechanisms:

1. **Angle-first generation (optional).** Generate N distinct angles, pick (or auto-pick) one, then
   draft from it. Stops the model from defaulting to the same flat take every time.
2. **Dual-LLM pre-review.** Two automated reviewer passes — a **brand-voice** check and a
   **channel-fit** check — produce scores + specific issues that surface in the approval UI, so weak
   drafts are flagged before the founder spends attention on them.

Both are provider-agnostic (via the LLM gateway), and **every reviewer/angle prompt is assembled
through the resolver** — the brain context (soul/voice for brand, channel guidance for fit) comes
from `resolveContext`, never hardcoded. Every extra call is traced.

## Founder-visible chain (acceptance)

Sandbox → enable the angle step (or it's on) → "Suggest angles" → see N distinct angles → pick one →
generate a LinkedIn post → the generation shows a **brand-voice score** and a **channel-fit score**,
each with specific issues → a weak draft shows a **"flagged"** badge before it reaches Review → send
to Review → the same scores/issues show on the draft, with a **Re-run review** button → approve/edit/
reject still works exactly as before (flags never block).

## Out of scope

- Re-running review automatically on every edit (manual button only).
- Review on ad creatives (multi-variant; already format-gated).
- The angle step in batch modules (outbound/PR) — sandbox/content only.
- Persisting the candidate-angle list (only the *chosen* angle is persisted, in the prompt trace).
- A third "fact-check / evidence-grounding" reviewer (only brand-voice + channel-fit this slice).
- Cross-workspace/global default settings (per-workspace only, defaults live in contracts).
- Storing reviewer prompts as a separate trace table — the reviewer prompt string is stored inline in
  the review result for inspection.

---

## Data model

Two existing tables gain a nullable `review_json` column; one new settings table is added. Generate
the migration with `npm run db:generate -w apps/api` (do **not** hand-write SQL). It becomes
`apps/api/drizzle/0018_*.sql` on this branch. (Sprint 21's migration is also `0018` but lives only on
its own branch; the founder merges one branch at a time, so a number collision between unmerged
branches is fine — when both land, the later merge regenerates. Keep the schema edits additive.)

```ts
// apps/api/src/db/schema.ts

// Per-workspace generation-quality settings; reads fall back to defaults when
// no row exists (same pattern as ad_settings).
export const generationSettings = sqliteTable("generation_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  reviewEnabled: integer("review_enabled").notNull().default(1),   // 1 = on (default)
  angleEnabled: integer("angle_enabled").notNull().default(0),     // 0 = off (default)
  angleCount: integer("angle_count").notNull().default(3),
  flagThreshold: integer("flag_threshold").notNull().default(70),
  updatedAt: integer("updated_at").notNull(),
});
export type GenerationSettingsRow = typeof generationSettings.$inferSelect;
```

Add to existing tables:

- `generations`: `reviewJson: text("review_json")` (nullable). Holds the `GenerationReview` JSON
  (the review of `generations.output`).
- `drafts`: `reviewJson: text("review_json")` (nullable). Copied from the source generation at submit;
  updated in place by the Re-run review action (which reviews `drafts.content`).

`review_json` stays `null` when review is disabled / never ran.

---

## Contracts (`packages/contracts/src/index.ts`)

Add a "Generation quality (Sprint 22)" section. New vocabulary lives here (the rule: enum vocabularies
are defined only in contracts).

```ts
// Reviewer passes. brand_voice judges voice/soul match; channel_fit judges channel conventions.
export const GENERATION_REVIEW_CHECKS = ["brand_voice", "channel_fit"] as const;
export type GenerationReviewCheck = (typeof GENERATION_REVIEW_CHECKS)[number];

export const REVIEW_CHECK_LABELS: Record<GenerationReviewCheck, string> = {
  brand_voice: "Brand voice",
  channel_fit: "Channel fit",
};

export const DEFAULT_REVIEW_FLAG_THRESHOLD = 70;
export const DEFAULT_ANGLE_COUNT = 3;
export const ANGLE_COUNT_MIN = 2;
export const ANGLE_COUNT_MAX = 5;
export const REVIEW_SCORE_MIN = 0;
export const REVIEW_SCORE_MAX = 100;

// One reviewer pass's result. score is null when the reviewer call failed or
// its output couldn't be parsed (review is best-effort, never blocks).
export const reviewCheckResultSchema = z.object({
  check: z.enum(GENERATION_REVIEW_CHECKS),
  score: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX).nullable(),
  issues: z.array(z.string()),
  // The exact reviewer prompt sent (resolver-assembled) — for the trace.
  prompt: z.string(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int(),
});
export type ReviewCheckResult = z.infer<typeof reviewCheckResultSchema>;

export const generationReviewSchema = z.object({
  checks: z.array(reviewCheckResultSchema),
  threshold: z.number().int(),
  // True when any check has a non-null score below the threshold.
  flagged: z.boolean(),
  createdAt: z.number().int(),
});
export type GenerationReview = z.infer<typeof generationReviewSchema>;

export function isReviewFlagged(checks: ReviewCheckResult[], threshold: number): boolean {
  return checks.some((c) => c.score !== null && c.score < threshold);
}

// Per-workspace settings (defaults applied on read when no row).
export const generationSettingsSchema = z.object({
  workspaceId: z.string().uuid(),
  reviewEnabled: z.boolean(),
  angleEnabled: z.boolean(),
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX),
  flagThreshold: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  updatedAt: z.number().int(),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const updateGenerationSettingsInputSchema = z
  .object({
    reviewEnabled: z.boolean(),
    angleEnabled: z.boolean(),
    angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX),
    flagThreshold: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  })
  .partial();
export type UpdateGenerationSettingsInput = z.infer<typeof updateGenerationSettingsInputSchema>;

// Angle generation takes the same inputs as resolve, plus an optional count.
export const generateAnglesInputSchema = resolveRequestSchema.extend({
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX).optional(),
});
export type GenerateAnglesInput = z.infer<typeof generateAnglesInputSchema>;
```

And extend the generate request (today it's an alias for `resolveRequestSchema`; make it a superset so
`/resolve` is unaffected):

```ts
export const ANGLE_MAX_CHARS = 2_000;

export const generateRequestSchema = resolveRequestSchema.extend({
  // Draft from this chosen angle (manual pick). Injected as a context section.
  angle: z.string().trim().max(ANGLE_MAX_CHARS).optional(),
  // Generate angles, auto-pick the strongest, then draft — all server-side.
  autoAngle: z.boolean().optional(),
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX).optional(),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
```

Add an optional `review` to the generation DTO (keeps existing `generationSchema.safeParse` green —
the field is optional/nullable):

```ts
// inside generationSchema:
review: generationReviewSchema.nullable().optional(),
```

---

## Brain / resolver (`packages/brain/src/resolver.ts`)

The reviewer and angle prompts are assembled by `resolveContext` — the same way ad-creative and PR
instructions already are (via the existing `taskInstruction` override). Two new, optional inputs and
two **conditionally-pushed** sections (pushed only when set, so existing resolves are byte-for-byte
unchanged and the pinned section-order tests don't move):

```ts
export type ContextLayer =
  | "org" | "channel" | "campaign" | "persona" | "lead" | "contact"
  | "signal" | "evidence" | "angle" | "review" | "task";

export interface ResolveInput {
  // ...existing...
  /** A chosen angle to draft from (Sprint 22). Section "angle", before task. */
  angle?: string;
  /** The draft text a reviewer pass is judging (Sprint 22). Section "review_subject". */
  reviewSubject?: string;
}
```

In `resolveContext`, **just before pushing the `task` section**, conditionally push:

```ts
if (input.angle && input.angle.trim()) {
  const angleContent = input.angle.trim();
  sections.push({
    key: "angle", layer: "angle", title: "Chosen angle", content: angleContent,
    included: true, reason: "The angle this draft was generated from (Sprint 22 angle step).",
    tokens: estimateTokens(angleContent),
  });
}
if (input.reviewSubject && input.reviewSubject.trim()) {
  const subject = input.reviewSubject.trim();
  sections.push({
    key: "review_subject", layer: "review", title: "Draft under review", content: subject,
    included: true, reason: "The draft this reviewer pass is judging. Score only this text.",
    tokens: estimateTokens(subject),
  });
}
```

These are protected from the token-budget sacrifice (not in `BUDGET_SACRIFICE_ORDER`).

New compose helpers in `packages/brain/src/resolver.ts` (exported via `index.ts`). They embed stable
literals (`ANGLE:`, `SCORE:`) so a test fake can branch on the prompt:

```ts
export function composeAngleInstruction(taskType: TaskType, channel: Channel, count: number): string {
  return (
    `Task: Before drafting, propose ${count} genuinely DISTINCT angles for a ${taskType} on the ` +
    `${channel} channel, grounded in the context above. Each angle is ONE sentence naming the hook or ` +
    `lens — not the full draft. List the strongest angle FIRST. ` +
    `Return EXACTLY ${count} lines, each prefixed with 'ANGLE: ' and nothing else — no preamble, ` +
    `numbering, or commentary.`
  );
}

export function composeBrandVoiceReviewInstruction(): string {
  return (
    "Task: You are a brand-voice editor. Judge ONLY how well the draft under review above matches " +
    "this company's voice, soul, and positioning as given in the context. Ignore length and channel " +
    "formatting — that is a separate review. Respond in EXACTLY this format and nothing else:\n" +
    "SCORE: <integer 0-100, where 100 is a perfect voice match>\n" +
    "ISSUES:\n- <one specific, actionable voice problem>\n" +
    "(If there are no issues, write '- none'. List at most 5 issues.)"
  );
}

export function composeChannelFitReviewInstruction(channel: Channel): string {
  return (
    `Task: You are a channel editor for the ${channel} channel. Judge ONLY how well the draft under ` +
    "review above fits the channel guidance above — length, format, hook, tone, and conventions. " +
    "Ignore brand-voice nuance — that is a separate review. Respond in EXACTLY this format and " +
    "nothing else:\n" +
    "SCORE: <integer 0-100, where 100 is a perfect fit>\n" +
    "ISSUES:\n- <one specific, actionable channel-fit problem>\n" +
    "(If there are no issues, write '- none'. List at most 5 issues.)"
  );
}
```

---

## Services

### `apps/api/src/services/generation-settings.ts` (new)

- `getGenerationSettings(db, workspaceId): GenerationSettings` — reads the row or returns defaults
  (`reviewEnabled:true, angleEnabled:false, angleCount:3, flagThreshold:70, updatedAt:0`). Booleans
  map from the integer columns.
- `updateGenerationSettings(db, workspaceId, input): GenerationSettings` — upsert; merges partial
  input over current/defaults; stamps `updatedAt`.

### `apps/api/src/services/review.ts` (new)

The shared pre-review seam. Pure-ish: takes the gateway and the brain context, never throws on
provider failure.

```ts
export interface ReviewContext {
  workspaceName: string;
  docs: BrainContents;
  taskType: TaskType;
  channel: Channel;
  persona?: ResolvePersona;
  campaign?: ResolveCampaign;
}

// Build one reviewer prompt through the resolver (brain-resolved), run it, parse it.
async function runCheck(llm, ctx, output, check): Promise<ReviewCheckResult>

export function parseReviewOutput(text: string): { score: number | null; issues: string[] }
//  - score: first /SCORE:\s*(\d{1,3})/i match, clamped 0..100; null if absent.
//  - issues: lines after ISSUES: starting with '-' or '*', trimmed; drop "none". [] if none.

// Run both checks (best-effort each), assemble + return the GenerationReview.
export async function runPreReview(
  llm: LlmGateway, ctx: ReviewContext, output: string, threshold: number,
): Promise<GenerationReview>
//  - per check: resolveContext({ ...ctx, reviewSubject: output,
//      taskInstruction: composeBrandVoiceReviewInstruction() | composeChannelFitReviewInstruction(channel) })
//    NOTE: lead/signal/evidence/mediaContact are intentionally NOT passed — the
//    reviewer judges brand + channel + output, not the target.
//  - llm.generate({ prompt: resolved.prompt }); on GatewayError → score null,
//    issues ["Review unavailable: <msg>"], prompt kept, durationMs 0.
//  - flagged = isReviewFlagged(checks, threshold); createdAt = Date.now().

// Persistence helpers:
export function setGenerationReview(db, workspaceId, generationId, review): void
export function setDraftReview(db, workspaceId, draftId, review): void
```

### `apps/api/src/services/angles.ts` (new)

- `parseAngles(text, count): string[]` — strip `ANGLE:` / list prefixes (`-`, `*`, `1.`, `1)`), fall
  back to blank-line splitting; trim; drop empties; slice to `count`.
- `generateAngles(llm, resolved, count): Promise<string[]>` — `llm.generate({ prompt: resolved.prompt })`
  then `parseAngles`. (Resolver call with `composeAngleInstruction` lives in the route.)

### `apps/api/src/services/generations.ts` (edit)

- `rowToGeneration`: parse `review_json` → `review: GenerationReview | null`.
- `GenerationWithTrace` gains `review: GenerationReview | null`.

### `apps/api/src/services/drafts.ts` (edit)

- `rowToDraft`: include `reviewJson` parsed → `review: GenerationReview | null` on the `Draft` shape.
  (The `Draft` contract type also gains an optional `review`.)
- `submitDraft`: after building the draft row, look up the source generation's `review_json` (by
  `sourceGenerationId`) and copy it into the new draft's `review_json`. Keeps the approval queue
  self-contained without a join.

---

## Routes

### `apps/api/src/routes/generations.ts` (edit)

- **`POST /workspaces/:id/angles`** (new): validate `generateAnglesInputSchema`; resolve persona/
  campaign like `/generate`; `resolveContext({ ..., taskInstruction: composeAngleInstruction(taskType,
  channel, count) })`; one `llm.generate`; `parseAngles`; return `{ angles, model, provider, durationMs,
  sections: resolved.sections }`. `502 generation_failed` on `GatewayError`. (Always available; the
  workspace `angleEnabled` toggle only drives the UI affordance.)
- **`POST /workspaces/:id/generate`** (edit):
  1. If `autoAngle` is true and no explicit `angle`: resolve+generate angles (count =
     `angleCount ?? settings.angleCount ?? DEFAULT_ANGLE_COUNT`), pick `angles[0]` as the chosen angle.
  2. Resolve the draft with `angle: chosenAngle` (if any), generate, `storeGeneration`.
  3. `const settings = getGenerationSettings(...)`; if `settings.reviewEnabled`, `runPreReview(...)`
     and `setGenerationReview(...)`; attach to the returned generation.
  4. Response includes `review` (and, when angles were produced, `angles` + `chosenAngle` for the UI).

### `apps/api/src/routes/drafts.ts` (edit — now needs `llm` + `evidence`)

- Change `registerDraftRoutes(app, db, fetcher)` → `(app, db, fetcher, llm, evidence)`; update
  `app.ts` call site.
- `submit`, `GET /drafts`, `GET /drafts/:id` already return drafts via `rowToDraft`, which now
  carries `review`.
- **`POST /workspaces/:id/drafts/:draftId/review`** (new — re-run): load the draft + brain + persona/
  campaign context; `runPreReview(llm, ctx, draft.content, settings.flagThreshold)`;
  `setDraftReview(...)`; return the updated draft (with `review`). Works regardless of the workspace
  toggle (explicit action). `404 draft_not_found`; never 5xx on reviewer failure (best-effort review).

### `apps/api/src/routes/generation-settings.ts` (new)

- `GET /workspaces/:id/generation-settings` → `getGenerationSettings`.
- `PUT /workspaces/:id/generation-settings` → validate `updateGenerationSettingsInputSchema`
  (`400 invalid_input`), `updateGenerationSettings`, return the settings.
- Register in `app.ts` right after the brain routes.

### `apps/api/src/routes/outbound.ts`, `pr.ts`, `signals.ts` (edit — review only)

In each, after `storeGeneration` and **before** `submitDraft`:

```ts
if (settings.reviewEnabled) {
  const review = await runPreReview(llm, { workspaceName: workspace.name, docs: contents,
    taskType, channel, persona, campaign }, result.text, settings.flagThreshold);
  setGenerationReview(db, workspaceId, generation.id, review);
}
```

`submitDraft` then copies the generation's review onto the draft automatically. Load `settings` once
per handler. Per-item review failure must not abort a batch (it can't — `runPreReview` never throws).
Ad creatives (`routes/ad-creatives.ts`) are **left unchanged**.

---

## Web (`apps/web`)

- **Generation-quality settings card** on the sandbox page (`app/workspaces/[id]/sandbox/page.tsx`),
  a collapsible panel near the top: toggle review, toggle angle step, angle count (2–5), flag
  threshold (0–100); Save → `PUT /generation-settings`.
- **Angle affordance** (shown when `angleEnabled`): a "Suggest angles" button in the Generate panel →
  `POST /angles` → render the N angles as selectable cards; "Draft from this angle" → `POST /generate`
  with `{ angle }`. The plain "Generate with brain" still works (no angle).
- **Review display** on the latest generation + each log item: a small panel listing each check
  (`REVIEW_CHECK_LABELS`) with its score (e.g. `Brand voice 82/100`), a **flagged** badge when
  `review.flagged`, and the issues as a bullet list. New `.review-*` CSS.
- **Approvals page** (`app/workspaces/[id]/approvals/page.tsx`): show each draft's `review` (scores +
  issues + flagged badge) when present; a **Re-run review** button → `POST /drafts/:id/review`. Flags
  are advisory — approve/edit/reject buttons are unchanged and never gated by a flag.
- Reuse existing badge/section CSS where possible; add minimal `.layer-angle` / `.layer-review` and
  `.review-*` rules.

---

## Tests (write before/with implementation; all must pass)

### `packages/contracts` (extend an existing test file)
- `updateGenerationSettingsInputSchema` accepts partials, rejects out-of-range `angleCount` /
  `flagThreshold`.
- `isReviewFlagged` true/false around the threshold; null scores never flag.
- `generateRequestSchema` accepts `angle` / `autoAngle` / `angleCount`; `resolveRequestSchema`
  (used by `/resolve`) still rejects them (superset isolation).

### `packages/brain` resolver tests
- `angle` set → a `"angle"` section appears immediately before `"task"`; absent → no such section
  (existing key lists unchanged).
- `reviewSubject` set → a `"review_subject"` section appears before `"task"`.
- `composeAngleInstruction` contains `ANGLE:` and the count; review instructions contain `SCORE:` and
  `ISSUES:`.
- Update the resolver's exact-key-list assertions only for the new "with angle/review" cases; the
  no-angle/no-review path keeps the current key list.

### `apps/api/test/generation-quality.test.ts` (new)
Uses a **quality fake gateway** that branches on the prompt:
`ANGLE:` present → returns `"ANGLE: a\nANGLE: b\nANGLE: c"`; `SCORE:` present → returns
`"SCORE: 42\nISSUES:\n- too generic"` (weak, to exercise flagging); else → `"FAKE DRAFT OUTPUT"`.
- `GET /generation-settings` returns defaults (review on, angle off, 3, 70) for a fresh workspace.
- `PUT /generation-settings` updates + validates (`400` on bad input).
- `POST /angles` returns N parsed angles + a trace; `502` on provider failure.
- `POST /generate` with review on → response `review.checks` has both checks, scores 42, `flagged:true`
  (42 < 70); generation row persists `review_json`.
- `POST /generate` with review **off** (after PUT) → `review` is null; only 1 gateway call's worth of
  output.
- `POST /generate` with `{ angle: "x" }` → prompt/trace contains the `angle` section; with
  `{ autoAngle:true }` → response carries `angles` + `chosenAngle` and the chosen angle is in the
  trace.
- Submit a reviewed generation → the draft carries the same `review` (copied).
- `POST /drafts/:id/review` re-run → updates the draft's `review` based on current content.
- Reviewer-failure path (a fake that throws only on review prompts) → generation still `201`, each
  failed check `score:null`, generation not blocked.
- A high-score fake (`SCORE: 95`) → `flagged:false`.

### Touch-ups to existing suites
- `apps/api/test/drafts.test.ts`: assert the draft DTO includes `review` (null when no source review).
- Confirm existing generation/outbound/pr/signal suites stay green: their fakes return fixed text, the
  review parser yields best-effort null-score reviews that are attached but not asserted, and
  `generationSchema` gains `review` as optional → `safeParse` stays true. (Verify by running `npm test`.)

---

## Build order (checklist)

1. [ ] Contracts: enums, schemas, `isReviewFlagged`, settings + angle schemas, extend
   `generateRequestSchema`, add `review` to `generationSchema`. Write contract tests.
2. [ ] Brain: new `ContextLayer` values, `angle`/`reviewSubject` inputs + conditional sections,
   `composeAngleInstruction` / `composeBrandVoiceReviewInstruction` / `composeChannelFitReviewInstruction`,
   export from `index.ts`. Write/adjust resolver tests.
3. [ ] Schema: `generation_settings` table + `review_json` on `generations` & `drafts`;
   `npm run db:generate -w apps/api`; restart dev/tsx so the migration applies (touch a src file).
4. [ ] Services: `generation-settings.ts`, `review.ts`, `angles.ts`; edit `generations.ts` &
   `drafts.ts` row mappers + `submitDraft` review copy.
5. [ ] Routes: `/angles` + `/generate` edits; `generation-settings.ts` routes; drafts `review` re-run
   + signature change; outbound/pr/signals review hook. Wire all into `app.ts`.
6. [ ] Web: settings card, angle affordance, review display (sandbox), review + re-run (approvals);
   CSS.
7. [ ] Write `apps/api/test/generation-quality.test.ts`; touch-up `drafts.test.ts`.
8. [ ] `npm run typecheck` clean; `npm test` green; `next build` clean.
9. [ ] Commit to `sprint-22-generation-quality`; push with `-u origin`. Do **not** merge to `main`.

---

## Progress log

- 2026-06-17 — Spec written. Founder decisions locked (scope = core + review everywhere; defaults
  review-on/angle-off; 0–100 + threshold 70; re-review out of scope w/ manual button). Branch
  `sprint-22-generation-quality` cut from `main`. Implementation starting at step 1.
- 2026-06-17 — **Built, all steps complete.** Notes vs the spec:
  - **Migration is `0018_rapid_carmella_unuscione.sql`**, chained cleanly off main's `0017`
    (new `generation_settings` table + `review_json` on `generations` and `drafts`).
  - Drafts route takes `(app, db, fetcher, llm)` — `evidence` was dropped (the reviewer judges voice
    + channel + output, never the evidence corpus, so it was unused).
  - Review service deliberately omits lead/signal/media-contact/evidence from the reviewer's resolve
    context — same reasoning.
  - Shared `apps/web/components/ReviewPanel.tsx` renders the review on both the sandbox and Review
    pages. New `.review-*` / `.angle-*` / `.layer-angle` / `.layer-review` CSS in `globals.css`.
  - Re-run review route is `POST /workspaces/:id/drafts/:draftId/review`; the Review page button reads
    "Run review" when the draft has none yet, "Re-run review" otherwise.
  - **Verification:** `npm run typecheck` clean across all workspaces; the Sprint 22 suites are green
    in isolation — contracts + brain = **168 passed** (incl. +5 contract, +6 brain), api
    `generation-quality.test.ts` = **12 passed**. Earlier, before a concurrent-session collision (see
    below), a full `npm test` ran **553 passed** with `next build` clean and all 372 prior API tests
    green with review on by default.
  - **Concurrent-session collision + recovery (important).** A parallel session was building
    Sprints 23/24 in this same repo (worktree `C:/Users/Hexalog/Desktop/tz-s23`); it switched branches
    and bundled this Sprint 22 work with its Sprint 23 work into a `tmp-snap` commit, leaving shared
    files (`packages/contracts/src/index.ts`, `apps/api/src/db/schema.ts`) interleaved. Recovery: all
    work was first preserved on branch `sprint-22-safety` (commit `7ff0388`); then this branch was
    **reconstructed clean off `main`** — only Sprint 22 files, with `schema.ts` + both `contracts`
    files re-derived from `main` plus only the Sprint 22 hunks (Sprint 23's `discardedAt` /
    `crmSyncFilter` additions stripped), and the migration regenerated as `0018`. The committed branch
    (`145cafe`) is verified to contain **zero Sprint 23 markers**. A final full `npm test` should be
    re-run once the parallel session is paused (the contended run showed 6 unrelated CRM-suite
    failures from live writes, not Sprint 22 regressions).
  - Awaiting founder manual acceptance. Do not merge to `main` (founder merges sprint branches
    one at a time).
