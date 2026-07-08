# Sprint 36.5 — Onboarding wizard: connect cards, reading animation, verification & "Meet your Brain"

**Part of:** the Onboarding V2 program — `docs/plans/onboarding-v2-roadmap.md`,
sprint **36.5 of 6**.

**Branch:** `sprint-36-5-verify-ui`, stacked on `sprint-36-4-brain-autodraft`
(**merge order: 36.1 → 36.2 → 36.3 → 36.4 → 36.5**). Do NOT merge into `main`.

**Goal:** Replace the wizard's placeholder panels (Steps 3–5) with the real
experience: three social connect cards with the min-1 gate, the Blaze-style
"Tuezday is reading your website + socials" animation, the editable
verification screen bound to the brand profile, and the "Meet your Brain"
reveal of the five auto-drafted docs with their honest completeness score.
Also: the wizard resumes from the workspace's `onboardingStep` cursor.

## Research basis (verified on this branch, 2026-07-07)

Every API this sprint consumes already exists — 36.5 is a **pure `apps/web`
sprint** plus one testable helper in contracts (web has no test runner):

- **Wizard shell (36.1):** `apps/web/app/onboarding/page.tsx` — step state
  machine over `ONBOARDING_STEPS`, greeting, `workspaceId` in state; `connect…
  draft` render "Coming up" placeholders. `PATCH /workspaces/:id/onboarding`
  moves the cursor (now 409s `needs_social_connection` past `connect` — 36.3).
- **Brand profile (36.2):** `GET /workspaces/:id/brand-profile` →
  `{ status: scraping|extracting|ready|failed|none, profile, error }`;
  `PATCH` partial edits (`updateBrandProfileInputSchema`); `POST …/refresh`.
- **Social (36.3):** `GET /workspaces/:id/social-corpus`; OAuth popup flow
  already built and used by the connectors page
  (`apps/web/app/workspaces/[id]/connectors/page.tsx:157` — session token from
  `POST /workspaces/:id/connectors/:key/oauth/session` → Nango popup via
  `@/lib/nango-oauth` helpers → `POST …/oauth/register`). The three providers
  (`linkedin`, `twitter`, `instagram`) surface `oauthConfigured` on
  `GET /workspaces/:id/connectors`.
- **Brain (36.4):** `POST /workspaces/:id/brain/auto-draft` →
  `{ insufficient, drafted, skipped, brain: { docs, completeness } }`.
- **Design system:** native oklch tokens + `onboarding.css` (36.1); no Tailwind.
  `BRAIN_DOC_META` titles/descriptions render the reveal cards.

## Key design decisions

1. **Reuse the connectors page's OAuth popup flow verbatim** (session → popup →
   register) — extract nothing server-side; the wizard imports the same
   `@/lib/nango-oauth` helpers. Instagram/LinkedIn/X cards show a "needs OAuth
   app" hint when `oauthConfigured` is false (same as the connectors page).
2. **The reading animation is driven by real status, not theater.** A pure
   helper `onboardingReadingProgress(profileStatus, connectedCount)` →
   `{ percent, label }` lives in `packages/contracts` (unit-testable), mapping
   e.g. scraping→35% "Reading your website…", extracting→70% "Understanding your
   brand…", ready→100% "Done". The connect panel polls `GET …/brand-profile`
   every ~2.5s while scraping/extracting. Failed → a visible "couldn't read your
   site" state with a Retry (`POST …/refresh`) — never silently stuck.
3. **Verify = the brand-profile form; Brain = the reveal.** Step 4 binds
   inputs to `businessName, tagline, summary, targetAgeRange, tone`, the seven
   `voiceDimensions`, and `pillars` (chip input); Save `PATCH`es then advances.
   Step 5 fires `POST …/brain/auto-draft` on entry (idempotent — empty-only),
   shows a brief drafting state, then reveals five doc cards (`BRAIN_DOC_META`
   title + first ~40 words + per-doc `empty/draft/complete` badge from
   `brain.completeness.docs`) with edit links to `/workspaces/:id/brain`.
   `insufficient: true` → honest guidance ("connect a social or check your
   website") instead of fake cards.
4. **Resume from the cursor.** On mount with `?workspace=<id>` (or after Step 2
   creates one), the wizard reads the workspace, and if `onboardingStep` is a
   later step, jumps there — closing the reload-loses-progress gap deferred from
   36.1. The home page shows "Resume setup" on workspaces whose cursor is not
   `done`/null.
5. **Steps 6–7 stay placeholders** — that's 36.6.

## Scope (in)

1. **Contracts:** `onboardingReadingProgress(profileStatus, connectedCount)` →
   `{ percent, label }` pure helper + unit tests (the only test surface — web
   has no runner).
2. **Wizard `connect` panel:** three provider cards (LinkedIn / X / Instagram)
   with connect buttons (OAuth popup flow), connected badges, the reading
   animation (poll + progress bar + rotating label), min-1 gate feedback
   (surface the 409 message when Continue is refused), Continue → `PATCH`
   cursor to `verify`.
3. **Wizard `verify` panel:** editable form over the brand profile; `failed`/
   `none` states with Retry; Save & continue → `PATCH` profile, cursor to
   `brain`.
4. **Wizard `brain` panel:** auto-draft on entry → reveal cards + completeness
   score + "thin doc" badges + edit links; Continue → cursor `campaign`
   (placeholder).
5. **Resume:** wizard accepts `?workspace=`, jumps to the cursor's step; home
   page "Resume setup" affordance on unfinished workspaces.
6. **CSS:** extend `onboarding.css` (cards, progress bar, doc-reveal grid) on
   native tokens; motion under `prefers-reduced-motion: no-preference`.

## Scope (out — YAGNI / 36.6+)

- Campaign quick-setup + first draft (Steps 6–7) — Sprint 36.6.
- Forcing onboarding for every new workspace — flipped in 36.6 when complete.
- Per-doc re-draft buttons; editing brain docs inside the wizard (links out).
- Any new backend endpoint (none needed).

## Tests (before/with implementation)

- contracts: `onboardingReadingProgress` — none+0 → 0% "Waiting…", scraping →
  35%, extracting → 70%, ready → 100%, failed → `{ percent: 100, label
  containing "couldn't" }`; connectedCount only affects the pre-scrape label.
- Manual web walkthrough (founder acceptance below) — plus `npm run build -w
  apps/web` must stay green as the automated floor.

## Founder acceptance

Start guided setup → name → website → land on Socials: three cards, connect one
(popup), watch the progress bar walk scraping→extracting→ready with live labels
→ Continue (blocked with a clear message until ≥1 connected) → Verify shows the
extracted profile, edit tone, Save → "Meet your Brain" drafts then reveals five
docs with completeness and thin-doc badges → links open the brain editor.
Reload mid-flow → the wizard resumes at the cursor's step.

## Bite-sized tasks

- **Task 1 — Contracts helper** `onboardingReadingProgress` (TDD).
- **Task 2 — Connect panel** (cards + OAuth popup + polling animation + gate).
- **Task 3 — Verify panel** (profile form + failed/retry states).
- **Task 4 — Brain panel** (auto-draft + reveal + score).
- **Task 5 — Resume** (cursor jump + home "Resume setup").
- **Task 6 — Full green + push**: `npm test`, `npm run typecheck`,
  `npm run build -w apps/web`, manual walkthrough with the dev server, progress
  log, push. Do NOT merge.

Each with failing-test-first where a runner exists; UI tasks end in a manual
verification step. Commits carry the `Co-Authored-By: Claude Opus 4.8
<noreply@anthropic.com>` trailer.

## Progress log

- 2026-07-07 — Spec drafted on branch `sprint-36-5-verify-ui` (stacked on 36.4
  tip `2e39e9d`). Pure-web sprint; every consumed API already shipped in
  36.2–36.4. Awaiting founder review; not implemented.
- 2026-07-08 — Implemented multi-agent: skeleton (panel components +
  WizardPanelProps + cursor advance with 409 surfacing + resume via
  ?workspace= + home "Resume setup") built inline; the three panels built
  by parallel agents, one file each. Note: the OAuth completion endpoint
  is POST …/oauth/complete (the spec's research line said "register" —
  the connect agent copied the working connectors page, which is why
  that instruction existed). Full suite 1022/1022 across 81 files;
  typecheck + next build green (/onboarding 7.3 kB). Founder visual
  walkthrough deferred to the batched 36.x review.
