# Onboarding Flow V2 — Implementation Roadmap

> **Status:** roadmap for founder review (2026-07-06). This decomposes the
> single deferred **Sprint 36 — Onboarding flow** into a sequenced program
> (36.1 → 36.6). Each sub-sprint is its own branch + self-contained
> `docs/specs/sprint-36-N-*.md`, written just before it is built, per the
> Sprint Delivery Workflow in `CLAUDE.md`. **This file is a planning doc; it
> is not a build spec.** No code is written from this file directly.

## The locked flow (founder, 2026-07-06)

1. **Name** — capture the user's name; greet them through the flow and in-app.
2. **Website URL** — background scrape starts the moment the URL is submitted.
3. **Social connect** — at least one of LinkedIn / X / Instagram (Instagram =
   Meta connector under the hood). Blaze-style "reading your site + socials"
   animation runs while the scrape + social read complete.
4. **Verification layer** — the user sees what Tuezday extracted (brand
   guidelines, target age, tone, voice dimensions, pillars) and edits it.
5. **"Meet your Brain"** — reveal the five finished brain docs, drafted from
   the corpus + the verified profile, after edits are saved.
6. **Campaign setup** — lightweight: goal, channels, posting frequency.
7. **First draft** — one generated draft lands in the approval queue; the
   user is dropped on the Review page with something real to act on.

## What already exists vs. what is net-new

Grounding for effort estimates (verified against the codebase 2026-07-06):

| Capability | State today | Sprint |
|---|---|---|
| Workspace create + empty brain docs | `createWorkspace` → `ensureBrainDocs` (docs created **empty**); UI is the bare form on `apps/web/app/page.tsx` | 36.1 rework |
| User name | `users` table has `name` (nullable), surfaced in header only | 36.1 use |
| LLM gateway | `LlmGateway` interface + `GeminiGateway`, injected as `llm` in `apps/api/src/app.ts`; services call `llm.generate({prompt})` | reused |
| Website scraper | **Does not exist** | 36.2 net-new |
| Structured brand-profile extraction | **Does not exist** | 36.2 net-new |
| OAuth connect fabric (Nango) | **Built + generic** — `connectProvider`/`registerOAuthConnection` handle the popup flow; adding a platform = a `CONNECTOR_PROVIDERS` entry + `.env` creds + a read adapter | 36.3 reused |
| Social **read** adapters (LinkedIn/X/Instagram) | Provider entries + read adapters missing (`connectors/social/` has only `reddit.ts`); **OAuth apps + read scopes already exist** (founder, 2026-07-06 — content-discovery scopes included) | 36.3 |
| Brain **auto-draft** from a corpus | **Does not exist** — `brain.ts` has `ensureBrainDocs`/`updateBrainDoc` only | 36.4 net-new |
| Campaigns CRUD | Full: `createCampaign`, `upsertCampaignInputSchema` (objective/kpi/audience/channels/pillars); `CHANNELS = linkedin,x,email,ads,web,pr` | 36.6 reused |
| Generation → draft → approval gate | Full: `storeGeneration`, `draftForGeneration`, `submitDraft`, approval states, Review page | 36.6 reused |
| RAG / evidence corpus | Exists (Sprint 9, R2R); scraped text can flow into evidence | 36.2/36.4 optional sink |

**Sprint 27 is NOT a blocker (resolved 2026-07-06).** The OAuth connect fabric is
already built and generic (`connectProvider`), and the founder confirms the
LinkedIn/X/Meta OAuth apps exist **with content-discovery (read) scopes
included**. So 36.3 does not depend on Sprint 27 — it adds three provider entries,
their `.env` creds (same `REDDIT_*` pattern), and one read adapter per platform on
the existing fabric. 36.3 branches off 36.2 and can ship independently.

## Sprint sequence & dependency order

```
36.1 Wizard shell + identity + workspace bootstrap   (off main)
  └─ 36.2 Website scraper + brand-profile extraction   (off 36.1)
       ├─ 36.3 Social read-connectors + corpus read     (off 36.2; no Sprint 27 dependency)
       └─ 36.4 Brain auto-draft engine                  (off 36.2; consumes 36.3 corpus if present)
            └─ 36.5 Verification UI (Step 4) + scrape animation (Step 3)  (off 36.4)
                 └─ 36.6 Campaign quick-setup + first draft to gate (Steps 6–7)  (off 36.5)
```

Each merges to `main` (founder-reviewed) before the next branches, per workflow.
36.3 and 36.4 both branch off 36.2 and can proceed in either order; 36.4 uses the
social corpus if 36.3 is merged, otherwise drafts from the website corpus alone.

---

## Sprint 36.1 — Onboarding wizard shell + identity + workspace bootstrap

**Goal:** A real, walkable multi-step wizard that replaces the bare "create
workspace" form: capture the user's name, capture the website URL, create the
workspace, and land in the app. No scraping yet — the URL is *stored* and the
later steps are visible placeholders. This is the frame every later sprint fills.

**Branch:** `sprint-36-1-onboarding-shell` off `main`.

**Why first / demo:** It is independently shippable — a new user gets a guided,
greeted first-run that creates a workspace from name + URL, instead of typing a
bare workspace name. Everything downstream mounts into this frame.

### Scope
- New route group `apps/web/app/onboarding/` — a client wizard with a step
  state machine (`name → website → connect → verify → brain → campaign → draft`),
  a progress rail, and a persistent greeting once the name is entered. In 36.1
  only `name` and `website` are functional; `connect…draft` render "Coming up"
  placeholder panels so the whole rail is visible and honest.
- Persist the user's name: `PATCH /auth/me` (new) → `users.name`. Greeting reads
  from `/auth/me`.
- Extend workspace creation to carry the URL and an onboarding cursor:
  - Schema: add `websiteUrl TEXT` and `onboardingStep TEXT` (nullable) to
    `workspaces` (`apps/api/src/db/schema.ts`); `npm run db:generate`.
  - Contract: extend `createWorkspaceInputSchema` with
    `websiteUrl: z.string().url().optional()`; add `websiteUrl`/`onboardingStep`
    to `workspaceSchema`.
  - `createWorkspace` stores both; add `advanceOnboarding(db, id, step)` +
    `PATCH /workspaces/:id/onboarding`.
- New-workspace entry point on `app/page.tsx` routes to `/onboarding` instead of
  the inline form (the inline form stays as a "quick create, skip onboarding"
  escape hatch so existing tests/flows keep working).

### Contracts / interfaces produced (later sprints depend on these names)
- `workspaceSchema.websiteUrl: string | null`, `.onboardingStep: string | null`
- `PATCH /auth/me { name }` → updated user
- `PATCH /workspaces/:id/onboarding { step }` → updated workspace
- `ONBOARDING_STEPS` const in `packages/contracts` (the 7 step keys) — single
  source of truth for the rail and the cursor.

### Tests (before implementation)
- contracts: `createWorkspaceInputSchema` accepts a valid `websiteUrl`, rejects a
  non-URL; `ONBOARDING_STEPS` has the 7 expected keys in order.
- api: `POST /workspaces { name, websiteUrl }` persists both; `PATCH /auth/me`
  updates the name; `PATCH /workspaces/:id/onboarding` advances the cursor and
  rejects an unknown step.
- api: existing workspace-create tests still pass with `websiteUrl` omitted
  (back-compat).

### Founder acceptance
Sign in → guided wizard greets you by name → enter website URL → workspace is
created with the URL stored → you land in the app with the onboarding rail
showing the remaining steps as "coming up."

**Size:** S–M. **Net-new external deps:** none.

---

## Sprint 36.2 — Website scraper + brand-profile extraction

**Goal:** The moment a URL is submitted (Step 2), a background job fetches the
site, extracts readable text, and an LLM call turns it into a structured,
inspectable **brand profile** (the data Step 4 will let the user edit).

**Branch:** `sprint-36-2-website-scrape` off `sprint-36-1`.

### Scope
- New service `apps/api/src/services/scrape.ts`: fetch the URL (+ a small set of
  obvious pages — `/about`, `/`, sitemap top links), strip HTML to text, cap
  size. No headless browser — plain `fetch` + HTML-to-text; JS-only sites are a
  documented limitation, revisited only if needed (YAGNI).
- New service `apps/api/src/services/brand-profile.ts`: `extractBrandProfile(llm,
  corpusText)` → validated `BrandProfile` (see contract) via one `llm.generate`
  call with a JSON-shaped prompt + zod parse + repair-retry once.
- New contract `brandProfileSchema` in `packages/contracts`: `{ businessName,
  tagline, targetAgeRange, tone, voiceDimensions[], pillars[], summary,
  sourceNotes }`. Voice dimensions use a **fixed named vocabulary** (Purpose,
  Audience, Tone, Emotions, Character, Syntax, Language) — the Blaze-proven,
  auditable set that maps onto the `voice` brain doc.
- Storage: new `brand_profiles` table (one draft per workspace, versioned-lite:
  overwrite the draft, keep it editable). Scrape run + extraction run as a worker
  job triggered on URL submit; expose `GET /workspaces/:id/brand-profile` and a
  `status` (`scraping | extracting | ready | failed`).
- Optional sink: push scraped text into the evidence/RAG corpus (Sprint 9) so it
  is reusable — behind a flag, not required for the flow.

### Interfaces produced
- `brandProfileSchema` / `BrandProfile`
- `GET /workspaces/:id/brand-profile` → `{ status, profile | null }`
- `POST /workspaces/:id/brand-profile/refresh` (re-run) for Step 4 "re-read".

### Tests
- unit: HTML-to-text strips tags/scripts, caps length.
- unit: `extractBrandProfile` with a **stub `llm`** returning canned JSON →
  validated profile; malformed JSON → one repair retry → parse or typed failure.
- api: submit URL → job runs (inline in tests via the injected gateway) →
  `GET …/brand-profile` returns `ready` with the profile.

### Founder acceptance
Enter a real URL → within seconds `GET …/brand-profile` returns a populated,
correct-ish profile you could show on a verification screen.

**Size:** M. **Net-new:** an HTML-to-text dependency (or a ~30-line native
stripper — decide in spec, prefer native to avoid a dep).

---

## Sprint 36.3 — Social read-connectors + social corpus

**Goal:** Step 3's real substance: connect at least one of LinkedIn / X /
Instagram(Meta), read the profile + recent posts, and add them to the corpus the
brain drafts from.

**Branch:** `sprint-36-3-social-read` off `sprint-36-2`. **No Sprint 27
dependency** (fabric + OAuth apps + read scopes already exist).

### Scope
- Add `CONNECTOR_PROVIDERS` entries for `linkedin`, `x` (Twitter/X), and
  `instagram` (Nango provider `facebook`/Instagram Graph), `categories:
  ["social"]`, `authMode: "oauth"`. Reuse the Nango connect-session flow already
  in `connections.ts` (`connectProvider`, `registerOAuthConnection`).
- Add the three OAuth apps to `OAUTH_ENV` in `connections.ts` (today only
  `reddit`): `LINKEDIN_CLIENT_ID`/`_SECRET`, `X_CLIENT_ID`/`_SECRET`,
  `META_CLIENT_ID`/`_SECRET` in root `.env`. Founder confirms these apps exist
  with read/content-discovery scopes; each app's redirect URL must whitelist the
  Nango callback.
- Read adapters: `readSocialProfile(connection)` → `{ handle, bio, recentPosts[]
  }` per provider, behind one interface. Instagram requires a linked FB Page —
  surface it as a single "Instagram" card that uses the Meta connection.
- The onboarding "connect" step enforces **min-1** before advancing; the UI shows
  three cards, one connection satisfies the gate.
- Feed the social text into the same corpus consumed by 36.2/36.4.

### Interfaces produced
- three new provider keys; `readSocialProfile` interface + `SocialCorpus` type.
- `GET /workspaces/:id/social-corpus` → aggregated read for 36.4.

### Tests
- contracts: new providers present with correct `authMode`/`categories`.
- api: with a **stubbed Nango/read layer**, connecting a provider then reading
  returns a normalized profile; the min-1 gate rejects advancing with zero
  social connections.

### Founder acceptance
Connect one social account in onboarding → its recent posts are readable via the
corpus endpoint → the step unlocks.

**Size:** M. The connect button is nearly free (generic fabric already built);
the real work is the three per-platform **read adapters** (each API's
profile/recent-posts shape differs). **Net-new:** three `.env` cred pairs
(apps already exist) — no from-scratch OAuth setup.

---

## Sprint 36.4 — Brain auto-draft engine

**Goal:** Turn the corpus (website + social) + the verified brand profile into
five drafted, editable brain docs — the "Meet your Brain" payload (Step 5).

**Branch:** `sprint-36-4-brain-autodraft` off `sprint-36-2` (consumes 36.3's
social corpus when merged; degrades to website-only otherwise).

### Scope
- New service `apps/api/src/services/brain-autodraft.ts`:
  `draftBrain(llm, { profile, websiteCorpus, socialCorpus })` → `{ soul, icp,
  voice, history, now }` markdown, one focused `llm.generate` per doc (five
  calls) using the existing brain-doc rendering conventions in `packages/brain`.
- Write drafts through the existing versioned `updateBrainDoc` (so history/audit
  work and the docs remain hand-editable) with an actor of `system:onboarding`.
- Endpoint `POST /workspaces/:id/brain/auto-draft` (idempotent-ish: re-draft
  overwrites via a new version, never silently trusted — the user still reviews).
- Guardrail from Blaze's #1 criticism: the "Meet your Brain" screen must show
  **what was captured and what's thin** (reuse `scoreBrain` from `packages/brain`)
  so shallow drafts are visible, not hidden.

### Interfaces produced
- `POST /workspaces/:id/brain/auto-draft` → `{ docs, score }`
- `draftBrain(...)` service signature for reuse (e.g. a later "re-draft" button).

### Tests
- unit: `draftBrain` with a stub `llm` → five non-empty docs mapped to the right
  types; empty corpus → typed "insufficient input" rather than garbage.
- api: auto-draft populates all five docs as new versions; `getBrain` returns them.

### Founder acceptance
After verification, hit auto-draft → all five brain docs are populated, on-brand,
editable, and the thinness score is honest.

**Size:** M. **Net-new:** none beyond LLM calls.

---

## Sprint 36.5 — Verification UI (Step 4) + scrape animation (Step 3)

**Goal:** The two UX-heavy screens: the Blaze-style "reading your site +
socials" progress animation (Step 3, driven by the 36.2/36.3 `status` fields)
and the editable verification screen (Step 4) that saves edits back to the brand
profile and then triggers 36.4's auto-draft to produce Step 5.

**Branch:** `sprint-36-5-verify-ui` off `sprint-36-4`.

### Scope
- Wire the wizard's `connect`/`verify`/`brain` placeholder panels to real data:
  - progress animation polls `GET …/brand-profile` + `…/social-corpus` status.
  - verification form binds to `brandProfileSchema` fields (brand guidelines,
    target age, tone, named voice dimensions, pillars), `PATCH`es edits.
  - "Meet your Brain" reveal renders the five docs from 36.4 with the thinness
    score and inline edit links to `/brain`.
- All on the native design system (oklch tokens in `globals.css`), reusing the
  motion primitives from the UI-polish branch (`module-in`, reduced-motion
  guards). No Tailwind (not installed in `apps/web`).

### Tests
- contracts/logic: a pure `onboardingProgress(profileStatus, socialStatus)` →
  `{ percent, label }` helper, unit-tested (web workspace has no test runner, so
  logic lives in `packages/contracts`).

### Founder acceptance
Drop URL + connect a social → watch the read animation → land on an editable
verification screen with real extracted values → save → see the finished Brain.

**Size:** M. **Net-new:** none.

---

## Sprint 36.6 — Campaign quick-setup (Step 6) + first draft to the gate (Step 7)

**Goal:** Close the loop: a lightweight campaign step creates the first campaign,
then one generation is drafted into `pending_review` and the user is dropped on
the Review page — the onboarding "aha."

**Branch:** `sprint-36-6-campaign-and-first-draft` off `sprint-36-5`.

### Scope
- **Step 6 (lightweight):** a 3-field quick form — goal (→ `objective`),
  channels (multi-select from `CHANNELS`), posting frequency — mapped onto the
  existing `upsertCampaignInputSchema` → `createCampaign`. Everything else on the
  campaign defaults; the full campaign editor remains at `/campaigns`. Explicitly
  **not** a full campaign wizard (avoids the "long questionnaire before value"
  trap).
- **Step 7:** on finish, run one generation via the existing gateway →
  `storeGeneration` → `draftForGeneration` → `submitDraft` to `pending_review`,
  attached to the new campaign, then mark `onboardingStep = done` and redirect to
  `/workspaces/:id/approvals`.
- Frequency: stored on the campaign for now (no scheduler in onboarding — cadence
  is Sprint 26's job; onboarding only records the intent).

### Tests
- api: quick-setup payload → `createCampaign` with correct mapping; finishing
  onboarding produces exactly one `pending_review` draft linked to the campaign
  and sets the cursor to `done`.

### Founder acceptance
Finish onboarding → a campaign exists → exactly one draft is waiting on the
Review page in your voice → the whole 7-step flow completes end-to-end for a
brand-new user with no docs.

**Size:** M. **Net-new:** none.

---

## Cross-cutting decisions (locked)
- **Every new workspace** runs this flow (founder, prior session); the inline
  "quick create" stays only as a dev/escape hatch.
- **Instagram = the Meta connector**, surfaced as its own card (one OAuth
  connection under the hood).
- **Named voice vocabulary** (Purpose/Audience/Tone/Emotions/Character/Syntax/
  Language) is fixed and shared by extraction (36.2), the brain `voice` doc, and
  the verification UI (36.5).
- **Never silently trust the auto-draft** — Step 4 verification + the thinness
  score are the deliberate antidote to Blaze's "generic output" criticism.
- Palette/design system stays Tuezday's (founder, prior session).

## Out of scope for the whole program (YAGNI)
- Headless-browser scraping of JS-only sites (plain fetch + text; revisit only if
  real sites fail).
- Posting/scheduling cadence (Sprint 26) — onboarding records frequency intent
  only.
- Re-onboarding / editing the flow after completion beyond the normal `/brain`,
  `/campaigns`, `/connectors` surfaces.
- Brand-kit visual assets (colors/logo/fonts as a design system) — 36.2 may
  capture colors into the profile, but the visual pipeline is Sprint 39.

## What to do next
1. Founder reviews this decomposition. (Sprint 27 dependency resolved — none.)
2. On approval, write the self-contained `docs/specs/sprint-36-1-*.md` (spec +
   bite-sized plan + progress log) on branch `sprint-36-1-onboarding-shell`, and
   build 36.1 TDD-first. One sprint at a time; do not start 36.2 until 36.1 is
   accepted.
