# Sprint 36.4 — Brain auto-draft engine

**Part of:** the Onboarding V2 program — `docs/plans/onboarding-v2-roadmap.md`,
sprint **36.4 of 6**.

**Branch:** `sprint-36-4-brain-autodraft`, stacked on `sprint-36-3-social-read`
(**merge order: 36.1 → 36.2 → 36.3 → 36.4**). Do NOT merge into `main` — push
the branch; the founder reviews and merges.

**Goal:** Turn the verified brand profile (36.2) + the social corpus (36.3) into
five drafted, editable brain docs (`soul`, `icp`, `voice`, `history`, `now`) —
the "Meet your Brain" payload for onboarding Step 5. Draft via
`POST /workspaces/:id/brain/auto-draft`, write each doc through the existing
versioned `updateBrainDoc`, and return the brain + its honest thinness score.

## Research basis (cite file:line, verified on this branch 2026-07-07)

- `apps/api/src/services/brain.ts:87` — `updateBrainDoc(db, workspaceId, docType,
  content, actor)` is versioned (writes a `brain_document_versions` row with the
  actor label) and rebuilds the doc outline. Auto-draft writes through it so
  history/audit + the Sprint 43 outline all work; actor = `{ userId: null,
  label: "system:onboarding" }`.
- `apps/api/src/services/brain.ts:68` — `getBrain(db, workspaceId): BrainView
  { docs: BrainDocument[]; completeness: BrainScore }`; `getBrain` calls
  `ensureBrainDocs` so the five (initially empty) docs always exist.
- `packages/brain/src/index.ts` — `BRAIN_DOC_META` (each doc's `title` +
  `description` — the drafting prompt reuses these), `scoreDoc(content)`
  (`status: "empty" | "draft" | "complete"`, `COMPLETE_WORD_THRESHOLD = 40`),
  `scoreBrain(contents): BrainScore { percent, docs[] }`. `BRAIN_DOC_TYPES =
  ["soul","icp","voice","history","now"]`.
- `apps/api/src/services/brand-profile.ts` (36.2) — `getBrandProfileView(db, id):
  BrandProfileView { status, profile: BrandProfile | null, ... }`. The profile
  carries `businessName, tagline, summary, targetAgeRange, tone, voiceDimensions
  (7 named), pillars, sourceNotes` — the founder-verified distillation of the
  website.
- `apps/api/src/services/social-corpus.ts` (36.3) — `readSocialCorpus(db, fabric,
  id): SocialCorpus { connected, entries, corpus }`, read-on-demand.
- `apps/api/src/llm/gateway.ts` — `LlmGateway.generate({ prompt, maxOutputTokens
  })`; `GatewayError`. 36.2's `brand-profile.ts` is the precedent for a
  gateway-driven service + a fake-gateway test stub
  (`apps/api/test/brand-profile.test.ts` `markerLlm`).

## Key design decisions (stated, with rationale)

1. **Draft from the verified brand profile + social corpus — NOT raw website
   HTML.** 36.2 deliberately persisted only the *derived* profile (which the
   founder edits in Step 4), not the raw scrape. The profile IS the verified
   website signal; re-scraping raw HTML here would (a) contradict the founder's
   edits and (b) re-introduce noise the extraction already removed. If a future
   sprint wants raw text, it can re-call `scrapeWebsite`. So
   `draftBrain(llm, { profile, socialCorpus })`.
2. **Five independent per-doc LLM calls.** One focused `llm.generate` per doc,
   each prompted with the profile + social corpus + that doc's `BRAIN_DOC_META`
   description. A per-doc failure (gateway error or empty output) leaves that doc
   undrafted and is retryable on re-run — it never sinks the other four. Simpler
   and more robust than one mega-call, and matches the 36.2/36.3 failure-isolation
   philosophy.
3. **Only fill currently-empty docs; never clobber edits.** Auto-draft writes a
   doc only when its current `scoreDoc(content).status === "empty"`. First-run
   onboarding (all five empty) gets all five; a re-run after the founder edited
   `voice` leaves `voice` untouched. No destructive overwrite this sprint (a
   "re-draft this doc" button is a later/UI concern). Every response returns
   `scoreBrain` so thin drafts are visible — the deliberate antidote to Blaze's
   "silently generic" failure.
4. **Insufficient input → typed no-op, not garbage.** If there is no ready
   profile AND the social corpus is empty, `draftBrain` returns
   `{ drafts: {}, insufficient: true }` and the route writes nothing.

## Scope (in)

1. **Service** `apps/api/src/services/brain-autodraft.ts`:
   - `draftBrain(llm, { profile, socialCorpus }): Promise<DraftBrainResult>` —
     five per-doc `llm.generate` calls; returns
     `{ drafts: Partial<Record<BrainDocType, string>>, insufficient: boolean }`.
     Per-doc failures/empties are simply absent from `drafts`.
   - `runBrainAutoDraft(db, llm, fabric, workspaceId): Promise<BrainAutoDraftView>`
     — orchestrates: read profile (`getBrandProfileView`) + social
     (`readSocialCorpus`); short-circuit to `insufficient` when both absent;
     `draftBrain`; write each drafted doc via `updateBrainDoc` **only when the
     current doc is empty**, actor `system:onboarding`; return
     `{ insufficient, drafted: BrainDocType[], skipped: BrainDocType[], brain:
     BrainView }`.
2. **Route** `apps/api/src/routes/brain-autodraft.ts`:
   `POST /workspaces/:id/brain/auto-draft` → `runBrainAutoDraft`. Registered in
   `app.ts` with the injected `llm` + `connectors` fabric.
3. **Contracts** (`packages/contracts`): a small `brainAutoDraftViewSchema` for
   the response shape (`insufficient`, `drafted`, `skipped` — arrays of
   `BrainDocType`; the brain itself is the existing `BrainView`, returned as-is).

## Scope (out — YAGNI / later sprints)

- Any web UI — the "Meet your Brain" reveal screen is Sprint 36.5.
- Destructive re-draft / per-doc regenerate button (36.5+).
- Re-scraping raw website text (decision #1).
- Drafting the `history`/`now` docs from campaign/analytics data — onboarding has
  none yet; they draft from profile+social like the others (often thin, honestly
  scored).
- New event types, worker involvement (user-triggered, inline like 36.2).

## Contracts (exact shapes — 36.5 depends on these)

```ts
export const brainAutoDraftViewSchema = z.object({
  insufficient: z.boolean(),
  drafted: z.array(z.enum(BRAIN_DOC_TYPES)),
  skipped: z.array(z.enum(BRAIN_DOC_TYPES)),
});
export type BrainAutoDraftView = z.infer<typeof brainAutoDraftViewSchema> & {
  brain: import("./index").BrainView; // service BrainView, returned as-is
};
```

(If importing `BrainView` into contracts is awkward, keep the contract to the
three scalar/array fields and let the route spread the `BrainView` in — the web
already types `getBrain`'s response locally. Decide at implement-time; prefer not
to move `BrainView` into contracts.)

## Service signatures (produced)

```ts
export interface DraftBrainInput {
  profile: BrandProfile | null;
  socialCorpus: SocialCorpus;
}
export interface DraftBrainResult {
  drafts: Partial<Record<BrainDocType, string>>;
  insufficient: boolean;
}
export function draftBrain(llm: LlmGateway, input: DraftBrainInput): Promise<DraftBrainResult>;

export interface BrainAutoDraftView {
  insufficient: boolean;
  drafted: BrainDocType[];
  skipped: BrainDocType[];
  brain: BrainView;
}
export function runBrainAutoDraft(
  db: Db,
  llm: LlmGateway,
  fabric: ConnectorFabric,
  workspaceId: string,
): Promise<BrainAutoDraftView>;
```

## Prompt design (per doc)

One prompt per `docType`, built from `BRAIN_DOC_META` + the profile + a trimmed
social corpus:

```
You are drafting the "{title}" brain document for {businessName}.
{description}   // from BRAIN_DOC_META
Write it as concise markdown (headings + short bullets), grounded ONLY in the
material below. Do not invent facts; if the material is thin, write what is
supported and stop. 120-250 words.

BRAND PROFILE:
- Business: {businessName} — {tagline}
- Summary: {summary}
- Target age: {targetAgeRange}
- Tone: {tone}
- Voice (purpose/audience/tone/emotions/character/syntax/language): {…}
- Pillars: {pillars}

RECENT SOCIAL ACTIVITY:
{socialCorpus.corpus (trimmed to ~6000 chars)}
```

Output is trimmed; an empty/whitespace result is treated as "not drafted" (doc
left empty). No JSON, no repair retry — brain docs are prose (mirrors the
`learning.ts` prose-parsing precedent, not the 36.2 JSON path).

## Tests (before/with implementation — stub gateway + fake fabric)

- contracts: `brainAutoDraftViewSchema` accepts arrays of valid doc types,
  rejects an unknown one.
- api unit `draftBrain`: stub `llm` returns a marker text per doc (keyed on the
  title in the prompt) → `drafts` has all five; a stub that throws on the `voice`
  prompt → `drafts` omits `voice`, keeps the other four; profile null + empty
  social corpus → `{ drafts: {}, insufficient: true }`.
- api `runBrainAutoDraft` / route: seed a ready `brand_profiles` row + fake
  fabric; `POST …/brain/auto-draft` → all five docs populated (`getBrain` shows
  non-empty), `completeness.percent > 0`, `drafted` has five; a workspace with a
  pre-edited non-empty `soul` → `soul` in `skipped`, its content unchanged; no
  profile + no social → `insufficient: true`, docs stay empty.

## Founder acceptance

With a real `GEMINI_API_KEY`, a workspace that has a ready brand profile (and
optionally a connected social): `POST /workspaces/:id/brain/auto-draft` →
`GET /workspaces/:id/brain` shows all five docs populated, on-brand, editable,
and the completeness score honestly reflects thin docs (e.g. `now` may be
sparse). Re-running after editing a doc does not overwrite the edit.

## Bite-sized tasks

- **Task 1 — Contracts**: `brainAutoDraftViewSchema` + type; TDD.
- **Task 2 — `draftBrain`** (service, no DB): per-doc prompt builder + five
  `llm.generate` calls + failure isolation + insufficient short-circuit. TDD with
  a marker/throwing stub gateway.
- **Task 3 — `runBrainAutoDraft`** (orchestrator): profile + social read,
  empty-only write via `updateBrainDoc`, `drafted`/`skipped` accounting, returns
  `BrainView`. TDD.
- **Task 4 — Route + wiring**: `POST /workspaces/:id/brain/auto-draft`; register
  in `app.ts` with `llm` + `connectors`. TDD (api).
- **Task 5 — Full green + push**: `npm test`, `npm run typecheck`, `npm run build
  -w apps/web`; live Gemini smoke (draft a real workspace's brain, eyeball the
  five docs + score); update Progress log; push. Do NOT merge.

Each task: failing test → run (fail) → implement → run (pass) → commit with the
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

## Progress log

- 2026-07-07 — Spec drafted on branch `sprint-36-4-brain-autodraft` (stacked on
  36.3 tip `a3203d5`). Key call: draft from the verified brand profile + social
  corpus, not raw website HTML (36.2 persists only the derived profile, which the
  founder edits in Step 4). Awaiting founder review; not implemented.
