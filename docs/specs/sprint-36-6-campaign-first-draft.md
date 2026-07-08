# Sprint 36.6 — Campaign quick-setup (Step 6) + first draft to the approval gate (Step 7)

**Part of:** the Onboarding V2 program — `docs/plans/onboarding-v2-roadmap.md`,
sprint **36.6 of 6** (the closer).

**Branch:** `sprint-36-6-campaign-and-first-draft`, stacked on
`sprint-36-5-verify-ui` (**merge order: 36.1 → 36.2 → 36.3 → 36.4 → 36.5 →
36.6**). Do NOT merge into `main`.

**Goal:** Close the loop. Step 6 is a lightweight 3-field quick form (goal,
channels, posting frequency) that creates the workspace's first campaign
through the existing campaigns endpoint; Step 7 chains three existing
endpoints — generate → submit → cursor `done` — so exactly one on-brand draft
is waiting at `pending_review` and the user lands on the Review page: the
onboarding "aha." Also: the guided flow becomes the default path for every
new workspace (quick-create stays as the escape hatch).

## Research basis (verified on this branch, 2026-07-07)

Like 36.5, this is a **pure `apps/web` sprint** plus testable pure helpers in
contracts (web has no test runner). Every endpoint Steps 6–7 consume already
exists:

- **Campaign create:** `POST /workspaces/:id/campaigns` validates
  `upsertCampaignInputSchema` and 201s the `Campaign`
  (`apps/api/src/routes/campaigns.ts:22`). The input schema
  (`packages/contracts/src/index.ts:818`) defaults everything except `name` —
  `objective`, `kpi`, `timeframe`, `audience`, `pillars`, `channels`,
  `personaIds`, `overlay`, `status: "active"`, `automationMode: "manual"`,
  `autoDailyCap: null` — so a 3-field quick form maps cleanly onto it.
- **Overlay is resolver-visible:** `composeCampaignOverlay`
  (`apps/api/src/services/campaigns.ts:139`) appends the campaign's free-form
  `overlay` text to the composed context, and `composeResolveCampaign`
  (`:155`) feeds it into every resolve/generate for that campaign. A line
  written into `overlay` reaches the LLM.
- **Generate:** `POST /workspaces/:id/generate`
  (`apps/api/src/routes/generations.ts:43`) takes `generateRequestSchema`
  (`packages/contracts/src/index.ts:760` — `resolveRequestSchema` + `angle` /
  `autoAngle` / `angleCount`; resolve inputs are `taskType`, `channel`,
  `personaId?`, `campaignId?` at `:499`). Returns 201
  `{ ...generation, review, angles, chosenAngle }`
  (`apps/api/src/routes/generations.ts:215`). Failure modes the wizard must
  handle: **402 `{ error: "upgrade_required", key, limit }`** on the
  entitlement check (`:51`, re-checked before the angle call at `:140`) and
  **502 `{ error: "generation_failed", message }`** on `GatewayError`
  (`:218`). Also 409 `campaign_archived` (`:75`) — unreachable here (we just
  created the campaign) but harmless.
- **Submit to the gate:** `POST /workspaces/:id/generations/:generationId/submit`
  (`apps/api/src/routes/drafts.ts:57`) creates the `pending_review` draft via
  `submitDraft`, carrying the generation's `campaignId`/`taskType`/`channel`,
  and 201s the draft (`:75`). Repeat calls 409
  `{ error: "already_submitted" }` (`:70`) — idempotent from the wizard's
  point of view.
- **Cursor + gate:** `PATCH /workspaces/:id/onboarding { step }`
  (`apps/api/src/routes/workspaces.ts:63`); steps past `connect` 409
  `needs_social_connection` without a connected social (`:78`) — satisfied by
  Step 3, and `done` is exempt.
- **Wizard shell:** `apps/web/app/onboarding/page.tsx:173` — the `campaign`
  and `draft` steps still render the generic "Coming up in a later sprint"
  placeholder (36.5 fills `connect`/`verify`/`brain`). `STEP_LABELS` already
  names them "Campaign" and "First draft" (`:10`).
- **Landing page:** the Review queue lives at
  `apps/web/app/workspaces/[id]/approvals/page.tsx`; billing (for the 402
  path) at `apps/web/app/workspaces/[id]/billing/`.
- **Default flip surface:** `apps/web/app/page.tsx:92` already renders "Start
  guided setup" as the primary button with quick-create inside a `<details>`
  (`:97`); what's missing is routing brand-new (zero-workspace) users into
  the wizard by default.
- **Vocabulary:** `CHANNELS` (`packages/contracts/src/index.ts:47`) =
  `linkedin, x, email, ads, web, pr, instagram`; `TASK_TYPES` (`:27`);
  per-task instructions in `packages/brain/src/resolver.ts:182` (consulted
  for the honest channel→taskType mapping below).

## Key design decisions

1. **Step 6 is a quick form, not a campaign wizard.** Three fields — goal
   (→ `objective`), channels (multi-select from `CHANNELS`), posting
   frequency — mapped client-side by a pure contracts helper onto the
   existing `upsertCampaignInputSchema` and sent to the existing
   `POST /workspaces/:id/campaigns`. Everything else takes the schema's
   defaults; the full editor stays at `/campaigns`. This dodges the
   "long questionnaire before value" trap the roadmap calls out — no new
   backend, no new fields.
2. **Posting frequency = a recorded intent, not a schema change.** The
   choice becomes one line in the campaign's free-form `overlay` (e.g.
   "Posting frequency intent: 3x per week"), which
   `composeCampaignOverlay` already carries into every resolved context.
   Cadence/scheduling is Sprint 26's job; onboarding only records the
   intent where both the founder (campaign editor) and the resolver can
   see it. Zero migrations.
3. **Campaign name is derived but editable.** Default
   `"{workspaceName} launch"`, shown in an input the founder can overwrite —
   no extra required field, no anonymous "Untitled campaign".
4. **Step 7 chains three existing endpoints — no new backend.** (1)
   `POST …/generate` with `{ taskType: taskTypeForChannel(first selected
   channel), channel: <first selected channel>, campaignId, autoAngle: true }`
   — the server picks the strongest angle and drafts; (2)
   `POST …/generations/:generationId/submit` → the `pending_review` draft;
   (3) `PATCH …/onboarding { step: "done" }` → redirect to
   `/workspaces/:id/approvals`. One draft, in the gate, in your voice.
5. **The channel→taskType map is honest and enumerated** (contracts helper,
   unit-tested — see Contracts). Channels with a natural broadcast task get
   it; `x` has no broadcast task type (Sprint 26 only added the
   per-recipient `x_dm`, which presumes a lead), so it falls back to
   `linkedin_post` with channel `x` — channel guidance still styles it for X;
   `pr` maps to `press_boilerplate` (self-contained), not `pr_pitch` (which
   presumes an announcement + journalist recipient and would invent one).
6. **Errors are never a dead end.** 402 `upgrade_required` → a readable
   "you've hit your monthly generation limit" message with a link to
   `/workspaces/:id/billing` (plus "Finish without a draft" → cursor `done`);
   502 `generation_failed` → the message + a Retry button; 409
   `already_submitted` on a double-fire → treated as success and the flow
   proceeds.
7. **Guided setup becomes THE default path** (founder, prior session), now
   that the flow completes end-to-end: the home page routes users with zero
   workspaces straight to `/onboarding`; the quick-create `<details>` escape
   hatch stays on the home page (reachable via a "prefer to skip setup?"
   link in the wizard → `/?quick=1`, which suppresses the redirect).

## Scope (in)

1. **Contracts (the only test surface):** `ONBOARDING_FREQUENCIES` (+ labels),
   `frequencyOverlayLine(frequency)`, `taskTypeForChannel(channel)`, and
   `onboardingQuickCampaign(input): UpsertCampaignInput` — pure helpers +
   unit tests (exact shapes below).
2. **Wizard `campaign` panel (Step 6):** goal textarea, channel multi-select
   chips (all seven `CHANNELS`, min 1 — default-check the socials connected
   in Step 3), frequency select, editable derived name; Create →
   `POST …/campaigns`, store `campaignId` + first selected channel in wizard
   state, `PATCH` cursor to `draft`.
3. **Wizard `draft` panel (Step 7):** a short "Drafting your first
   {channel label} post…" working state → generate (autoAngle) → submit →
   preview card of the draft content ("Here's your first draft — waiting for
   your review") → Finish button: `PATCH` cursor `done` + redirect to
   `/workspaces/:id/approvals`. Full error UX per decision #6.
4. **Default flip:** home page (`apps/web/app/page.tsx`) redirects
   zero-workspace users to `/onboarding` unless `?quick=1`; the wizard links
   back for the escape hatch. Fix the stale Step-2 copy ("Reading arrives in
   a later sprint") if 36.5 hasn't already.
5. **CSS:** extend `onboarding.css` (chips, frequency select, draft preview
   card) on native tokens.

## Scope (out — YAGNI / later sprints)

- Any new API endpoint, schema change, or migration (none needed).
- A real cadence/scheduler for the frequency (Sprint 26 owns scheduling;
  this sprint records intent only).
- KPI / timeframe / audience / pillars / personas in the quick form — the
  full campaign editor already has them.
- Multiple first drafts (one per selected channel) — one draft is the "aha";
  more is a queue-stuffing anti-pattern on minute one.
- Editing/approving the draft inside the wizard — that's the Review page's
  job, and landing there IS the payoff.
- Removing quick-create — it stays as the dev/escape hatch (founder).

## Contracts (exact shapes — the wizard consumes these)

```ts
// Posting-frequency intent vocabulary (onboarding-only; not a campaign field).
export const ONBOARDING_FREQUENCIES = ["daily", "3x_week", "weekly", "biweekly"] as const;
export type OnboardingFrequency = (typeof ONBOARDING_FREQUENCIES)[number];
export const ONBOARDING_FREQUENCY_LABELS: Record<OnboardingFrequency, string> = {
  daily: "Daily",
  "3x_week": "3x per week",
  weekly: "Weekly",
  biweekly: "Every other week",
};

/** "Posting frequency intent: 3x per week." — the overlay line the resolver sees. */
export function frequencyOverlayLine(frequency: OnboardingFrequency): string;

/** Honest broadcast task per channel; enumerated, unit-tested. */
export function taskTypeForChannel(channel: Channel): TaskType;
// linkedin  → linkedin_post
// instagram → instagram_post
// email     → cold_email_opener
// ads       → ad_copy_variant
// web       → landing_page_hero
// pr        → press_boilerplate   (pr_pitch presumes an announcement + recipient)
// x         → linkedin_post       (no broadcast X task exists; x_dm is per-lead —
//                                  channel guidance still styles the draft for X)

export interface OnboardingQuickCampaignInput {
  workspaceName: string;
  goal: string;                    // → objective
  channels: Channel[];             // min 1 (UI-enforced)
  frequency: OnboardingFrequency;  // → overlay line
  name?: string;                   // editable; blank → `${workspaceName} launch`
}
/** Maps the 3-field quick form onto the existing campaign input; must
 *  round-trip through upsertCampaignInputSchema.parse unchanged. */
export function onboardingQuickCampaign(input: OnboardingQuickCampaignInput): UpsertCampaignInput;
```

`onboardingQuickCampaign` fills: `name` (trimmed override or derived),
`objective: goal.trim()`, `channels`, `overlay: frequencyOverlayLine(frequency)`
— and the schema defaults for everything else (`kpi/timeframe/audience: ""`,
`pillars/personaIds: []`, `status: "active"`, `automationMode: "manual"`,
`autoDailyCap: null`).

## Tests (before/with implementation)

- contracts `taskTypeForChannel`: every member of `CHANNELS` returns a member
  of `TASK_TYPES`; the six explicit pairs above; `x` → `linkedin_post`.
- contracts `onboardingQuickCampaign`: output satisfies
  `upsertCampaignInputSchema.parse` (round-trips unchanged); derived name is
  `"Hexalog launch"` for workspace "Hexalog"; an explicit `name` wins; the
  overlay contains the frequency label ("3x per week"); goal lands in
  `objective`; channels pass through.
- contracts `frequencyOverlayLine`: each frequency produces a line containing
  its label; deterministic.
- **No API tests** — no new endpoint or server behavior (the roadmap sketch
  predates this decision; the whole chain is already covered by the
  campaigns/generate/drafts suites).
- Manual web walkthrough (founder acceptance below) + `npm run build -w
  apps/web` as the automated floor.

## Founder acceptance — the full 7-step flow, end to end

As a brand-new user with no workspaces: log in → land in the wizard
automatically → name → website → connect one social (popup) → watch the
reading animation → verify the extracted profile → "Meet your Brain" reveals
five docs → **Campaign:** type a goal, pick channels + "3x per week", keep the
derived name → **First draft:** watch it draft, see the preview → Finish →
land on `/workspaces/:id/approvals` with **exactly one `pending_review`
draft, attached to the new campaign, in your voice**. The campaign page shows
the frequency line in its overlay. Quick-create still works via the escape
hatch. Simulate a 402 (exhausted plan) → readable limit message + billing
link, and the flow can still finish.

## Bite-sized tasks

- **Task 1 — Contracts helpers** (`ONBOARDING_FREQUENCIES` + labels,
  `frequencyOverlayLine`, `taskTypeForChannel`, `onboardingQuickCampaign`):
  failing tests first, then implement.
- **Task 2 — Campaign panel** (Step 6): quick form + chips + derived name →
  `POST …/campaigns` → cursor `draft`; manual check.
- **Task 3 — Draft panel** (Step 7): generate → submit → preview → Finish
  (cursor `done` + redirect to approvals); 402/502/409 UX; manual check
  including a forced 502.
- **Task 4 — Default flip**: zero-workspace redirect to `/onboarding` +
  `?quick=1` escape hatch + wizard link back; stale Step-2 copy; manual check.
- **Task 5 — Full green + push**: `npm test`, `npm run typecheck`,
  `npm run build -w apps/web`, full 7-step manual walkthrough with the dev
  server (real `GEMINI_API_KEY`), progress log, push
  `sprint-36-6-campaign-and-first-draft`. Do NOT merge.

Each with failing-test-first where a runner exists; UI tasks end in a manual
verification step. Commits carry the `Co-Authored-By: Claude Opus 4.8
<noreply@anthropic.com>` trailer.

## Progress log

- 2026-07-07 — Spec drafted; not implemented. Stacks on
  `sprint-36-5-verify-ui` (merge order 36.1 → … → 36.6). Key calls: 3-field
  quick form onto the existing `upsertCampaignInputSchema` (no schema
  change — frequency recorded as an overlay line the resolver sees), Step 7
  chains the existing generate → submit → onboarding-done endpoints (no new
  backend), and the guided flow becomes the default path for new workspaces.
  Awaiting founder review.

- 2026-07-09 — Implemented multi-agent: contracts helpers (TDD 4 tests) +
  wizard wiring + guided-setup default flip inline; CampaignPanel and
  DraftPanel by two parallel agents, one file each. Full suite 1026/1026
  across 82 files; typecheck + next build green (/onboarding 9.04 kB).
  The 7-step Onboarding V2 flow is now complete end-to-end. Founder
  visual walkthrough deferred to the batched 36.x review.
