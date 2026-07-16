# UX Audit A — Journey-driven (new user + daily operator)

**Date:** 2026-07-11 · **Build audited:** `main` @ 63bc999 (post-UI-revamp merge) · **Method:**
real browser runs (Playwright, 1440×900), real website scrape + live Gemini generation, screenshots
+ timings + console capture at every step. Constraint set by founder: Editorial identity locked,
IA challengeable. Severity scale: **Blocker** (a user cannot proceed / would churn) · **Major**
(erodes trust or comprehension) · **Paper-cut** (friction, worth batching).

Evidence: 41 screenshots in the audit session (new-user run `journey-newuser/`, operator run
`journey-operator/`); timings from `journey-log*.json`.

---

## Journey 1 — New user, first session (register → onboarding → first draft)

Persona: "Maya", a GTM lead who found Tuezday and signs up cold. Run: fresh account,
`tuezdayai.com` as the company site, real scrape + autodraft + first-draft generation.

### What went well (keep these)

- **The wizard's spine is genuinely good.** Name → website → socials → verify → brain → campaign →
  first draft is a coherent narrative, the rail shows progress, and "Nice to meet you, Maya"
  carries through.
- **The scrape overlaps the socials step** ("Tuezday is reading…" progress line) — dead time is
  used; by the time the user finishes socials the brand profile is ready.
- **First-draft payoff lands.** "Your first draft is waiting for review, Maya" with the real
  LinkedIn draft rendered and one CTA ("Review it now →") is the right ending. Generation took
  ~10s with a visible generating state at ~4s. "Review it now" correctly lands on the approval
  queue with the draft on top.
- End-to-end a motivated user reaches a reviewable, brain-grounded draft in **under 3 minutes** of
  active time. The bones are launch-grade.

### Findings

**A1 · BLOCKER — The Socials step is a hard dead end for self-serve users.**
"Connect at least one account so Tuezday can learn your voice" is enforced server-side (409) with
**no skip path**. In the audited environment LinkedIn/X open OAuth popups that fail without
platform apps; Instagram and Reddit show **NEEDS SETUP**. A cold prospect cannot pass step 3 of 7.
Worse, the Continue button renders enabled-looking and just re-prints the inline warning — the
audit driver clicked it 16 times; a human would click it 2–3 times and leave. The min-1 gate was a
founder decision (2026-07-06) made for a hand-held beta; it is incompatible with unassisted
signup. *(Screens 09, 26.)*

**A2 · MAJOR — Ops language leaks into onboarding copy.**
The disabled provider cards say "OAuth app not configured in **.env** — see Integrations for
setup." A prospect doesn't have an `.env`. Unconfigured providers should be hidden or say
"Coming soon", not expose deployment internals. *(Screen 09.)*

**A3 · MAJOR — Sign-up gives no progress or failure feedback.**
Submitting the register form only disables the button (no spinner/progress); locally it resolves
fast, but on real latency it reads as a dead button. No inline field validation until submit.
*(Screen 04.)*

**A4 · MAJOR — First-run Home contradicts what the user just did.**
The "Set up your GTM engine" checklist shows **Review your Brain — unchecked** immediately after
the wizard's Verify step where the user just reviewed and saved the brain. The checklist doesn't
credit wizard events. First impression: "did my onboarding not count?" *(Screen 41.)*

**A5 · MAJOR — The stat strip claims "Live 1" on a workspace that has never published.**
The fresh workspace shows `Needs review 2 · Signals 0 · Brain updates 0 · Live 1`. Nothing is
live; the count appears to derive from something else (the connection or campaign). Numbers a
user can falsify on sight are trust acid. *(Screen 41.)*

**A6 · MAJOR (verify repro) — Onboarding produced two drafts from one flow.**
The queue showed "Pending review (2)" after a single wizard pass — one draft grouped under
"Today" (labelled with the workspace name) and one under the campaign. Likely a double-submit /
non-idempotent generation on repeated clicks at the draft step. Even if user-induced, the flow
must be idempotent — new users double-click. The two cards also label their origin inconsistently
("Tuezdayai" vs "Tuezdayai launch"). *(Screen 40.)*

**A7 · MINOR — Buttons without accessible names in the wizard.**
The audit driver's role-based queries repeatedly matched buttons with empty accessible names
(icon-only expanders, e.g. "Campaign name" disclosure). Screen-reader users get "button,
button…"; also brittle for any automation.

**A8 · PAPER-CUTS (batch):**
- "Pick at least one." renders as static text under Channels before the user has erred —
  pre-emptive scolding; show it only after an invalid submit attempt.
- Draft cards show an empty grey circle avatar for "org voice" — use the workspace mark/initial.
- The top-right TopBar shows an unlabeled "2" chip next to the workspace name — no tooltip, no
  meaning. (It is the workspace count; nobody can know that.)
- The scrape progress line reads "Tuezday is reading…" next to "Done — brand profile ready" —
  state copy contradicting itself.
- H1 says "Command Center" while the nav item says "Home" — one name per place.

---

## Journey 2 — Daily operator (populated GIGI workspace, read-only pass)

Persona: the founder running the morning loop. Route: land → triage → create → review → campaigns
→ calendar → inbox → learning → brain → insights → integrations. Page loads all 0.8–1.8s (dev).

### What went well

- The loop is coherent and fast; nav grouping (Campaigns/Discover/Create/Review/Audience/Settings)
  matches how the work actually flows.
- The **campaign settings modal** (§6.6) is the strongest settings surface in the app — left
  subnav, plain-language explanations of kill switch/auto-reply/caps.
- Inbox empty state is exemplary (blurred sample conversation behind a clear explanation + CTA).
- Brain page is a real control room: DocTiles with freshness, the resolve FlowStrip, per-channel
  guidance with per-card save state, scoped guidance below.

### Findings

**B1 · MAJOR — Smart landing drops you somewhere without saying why.**
Landing on the workspace root redirected to **Campaign home** (the guide dot's current target).
The page gives no cue about *why* you're here or *what* needs attention — the dot lit the nav
item, the redirect fired, and then the page is just… the campaigns list. The next-action engine
knows the reason; the destination page never states it. One "You're here because: X" line (guide
context) would convert confusion into the intended magic. *(Operator screen 01.)*

**B2 · MAJOR (trust) — Automation status can silently lie on campaign cards.**
Both campaigns show mode **Scheduled-auto**, while the global guardrail "Auto-posting is allowed"
is **unchecked** (kill switch engaged) — so nothing will actually post. The only place this
tension is visible is inside the settings modal. The campaign card — the surface the operator
scans daily — shows no "paused by kill switch" state. An operator believing content is shipping
when it is not is the single worst trust failure this product can have. *(Operator screens 06–07.)*

**B3 · MAJOR — Inline controls with unclear persistence on campaign cards.**
The Automation `<select>` and "Daily cap" input sit directly on each card next to an `Edit`
button. Does changing the select save immediately? Does the cap save on blur? There is no
feedback either way, and the adjacent Edit button implies editing happens elsewhere. Mixed
editing models on one card. *(Operator screen 06.)*

**B4 · MINOR — Review's empty state is the only bare one in the loop.**
"Nothing in this state." in a dashed box — on the page the revamp holds to the highest
preview-value standard elsewhere. Also true for state-filtered tabs (Edited (0) etc.).
*(Operator screen 05.)*

**B5 · MINOR — "Saved" as a button label reads as an action that does nothing.**
Brain doc editor and every channel-guidance card show a button labelled **Saved** (state) beside
**History**/**Default** (actions). Buttons should be verbs; states should be chips. Eight
instances on one screen. *(Operator screen 12.)*

**B6 · MINOR — Insights is an orphan page.**
Breadcrumb says "Campaigns / Insights" but the Campaigns subnav (Campaign home, Calendar, Cadence,
Automation, Ads, Launch ads) has no Insights entry. It is reachable only by URL or stray links.
Either it earns a nav slot or its numbers belong on Campaign home. *(Operator screen 13.)* [IA]

**B7 · PAPER-CUTS (batch):**
- Workspace card chips "Review clear / **11 outputs**" — "outputs" is internal vocabulary, and the
  same number appears on Insights as "Total Generations: 11"; one concept, two names.
- Inbox renders two "Run inbox now" buttons (TopBar + empty state) on one screen.
- Discovery triage scores ("70/100") have no tooltip or legend explaining what the brain scored.
- Learning page's "Proposed now updates" heading + `doc-now` icon is insider shorthand — "Proposed
  brain updates" reads human.

---

## Cross-journey timing notes

| Moment | Measured | Verdict |
|---|---|---|
| Register submit → usable | <1s local | fine; needs visible progress for real latency (A3) |
| Website scrape (tuezdayai.com) | ~3s, overlapped with socials step | excellent pattern |
| Brain autodraft | completed during socials/verify dwell | excellent |
| Campaign create → first draft ready | ~10s, generating state at ~4s | good; add "usually ~15s" copy so the wait has a promise |
| Operator page loads | 0.8–1.8s (dev) | fine |
