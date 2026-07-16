# UX Audit B — Screen-by-screen heuristic sweep

**Date:** 2026-07-11 · **Build:** `main` @ 63bc999 · **Coverage:** all 28 routes + login/invite +
onboarding, desktop 1440×900; mobile smoke at 390×844 on login/home/approvals. Rubric per screen:
comprehension (does a stranger get it), feedback (does every action answer), error/empty states,
click depth, copy, basic a11y. **Verification level** per row: `V` = visually audited this session
(screenshot on file), `C` = code-audited (screen went through the revamp sweep this week; structure
reviewed in source, no new screenshot).

Journey-level findings live in Audit A; this file is per-screen. IDs continue as S-numbers.

---

## Route-by-route

| Route | Lvl | State coverage | Verdict + findings |
|---|---|---|---|
| `/login` (+ register) | V | filled, mobile | Clean, brand-right. **S1:** no submit progress/inline validation (=A3). Google button present; no "what is Tuezday" reassurance link for cold arrivals. |
| `/onboarding` (7 steps) | V | all steps, real run | Strong spine; **A1/A2/A7** live here. **S2:** rail steps aren't clickable to go back (only some panels have a ghost back); mis-typed website URL discovered at Verify forces retry-by-refresh. |
| `/` (workspace list) | V | 1 + n workspaces | **S3:** unlabeled count chip (=A8); workspace cards show onboarding-resume state well. |
| Home | V | fresh + populated | Hero of the revamp; needs-you-now queue works. **A4, A5, A8** (checklist credit, "Live" truth, Command Center naming). **S4:** "Set up your GTM engine 2/6" has no dismiss for teams who finished setup another way. |
| Brain (docs) | V | populated | Dense but the best "system explains itself" screen in the app. **B5** ("Saved" state-as-button ×8). **S5:** doc completeness chips say "complete" based on non-empty content — a 1-line soul reads "complete"; misleading quality signal. |
| Brain / Evidence library | C | empty, candidates, offline | **S6:** offline banner still says "R2R … `npm run r2r:up`" — stale once Sprint 47 merges; must say "evidence store" generically. Candidate accept/dismiss flow is clear. |
| Brain / Context inspector (resolver) | V | populated | Persona cards + routing + matrix are power-user gold. **S7:** page assumes vocabulary ("resolve", "overlay", "org voice") with no one-line primer for new teammates; matrix cells (full/outline/zoom) unexplained until hover. |
| Campaigns home | V | 2 active | **B2, B3** (kill-switch truth, inline-save ambiguity). **S8:** no per-campaign "what shipped lately" — cards are configuration-only; the hub answers "how is it configured" but not "is it working". [needs-backend] |
| Calendar | V | populated + empty week | Post-fix: chrome rows, counts, empty state all good. **S9:** entries aren't clickable through to the draft/publication they represent — a calendar of dead ends. |
| Cadence | C | manager extracted | Fine; shares manager with campaign modal. **S10:** "cadence" naming vs calendar "open slots" copy — one concept, two words. |
| Automation | C | guardrails | Same content as modal — good consistency. **S11:** kill switch lives here AND in modal; state mismatch risk is B2's root. |
| Ads | V | disconnected, sample preview | ConnectPrompt + blurred sample rows = right pattern. **S12:** date-range inputs allow until<since with no validation message (silent empty result). |
| Launch ads | C | guardrails, empty | Meter + kill chip good. **S13:** "New launch" form is long with no draft persistence — an accidental nav loses everything. |
| Ad creatives | C | empty + sets | Preview empty state added in sweep. **S14:** export CSV state/taskType pickers are unlabeled selects in the header — cryptic until clicked. |
| Discover | V | sources, tracked, 23 triage items | **B7** (score opacity). **S15:** triage list has no bulk actions — 23 items × one decision each; operators will want "skip all below 40". [needs-backend] |
| Create / Content | V | signals + publish + published | PreviewCard gallery strong. **S16:** H1 "Create" vs nav "Content" vs sibling "Playground" — naming drift (=A8 family). **S17:** publish form appears inline per-draft deep in the chain — after publishing, success is only a badge swap; no toast/confirmation with link. |
| Create / Playground (sandbox) | V | populated | Task-first flow with preview-gate is good discipline. **S18:** "Preview context first" gate is enforced but the disabled Generate button doesn't say *why* it's disabled (tooltip). |
| Create / Ad creatives | — | — | (see Ad creatives above; appears under two nav groups — **S19:** duplicate entry points with different breadcrumbs confuse "where am I". [IA]) |
| Review / Approval queue | V | pending ×2, clear | Gallery + Approve-all good. **B4** (bare empty state). **S20:** Reject has no confirm and no undo — one mis-click discards work with only the decision log as recourse. |
| Review / Inbox | V | empty | Exemplary empty state; duplicate CTA (=B7). |
| Review / Learning | V | stats + proposals | **B7** (insider copy). **S21:** "Synthesize now" fires a real LLM job with zero progress affordance beyond button disable. |
| Audience / Outbound | C | leads + drafts | CSV paste import is founder-friendly; column-mapping errors are inline and specific (good). **S22:** no lead detail view — the row is all you get. [needs-backend] |
| Audience / Lists & segments | C | lists + rules | Rule builder minimal but labeled. |
| Audience / Launches | C | empty preview + detail | Sample-launch empty state good. **S23:** launch detail is a long single column mixing config, recipients, and messages — needs sectioning/tabs at populated scale. |
| Audience / CRM | V | error (Nango down) | **S24:** with the connector down the page leads with a raw red error; should degrade to the ConnectPrompt pattern with the error as detail, not headline. |
| Audience / PR & media | V | contacts + pitches | **S25:** contact rows render "Name <email>" where name IS the email — duplicated string when no display name; parse/fallback bug class. |
| Insights | V | populated | **B6** (nav orphan). **S26:** "Ads $931.50 / 79,000 impressions" with Published 0 — cross-module numbers without links to their source pages. |
| Settings / Integrations | V | grouped hub | Strongest settings surface; per-connection errors now render cleanly (fixed this week). **S27:** "needs OAuth app" chip is operator-language on a user-facing page (=A2 family). |
| Settings / Team | V | solo + invite | Invite flow clear; **S28:** role select exists only at invite; no post-hoc role change visible. [needs-backend?] |
| Settings / Billing | C | plans | Razorpay flow untested in audit (no test creds) — flagged as **untested surface**, not clean. |
| Settings / Activity | C | events | Fine; filter by actor absent at scale. |
| Notifications | C | prefs | Telegram/email routing clear. |
| Invite accept (`/invites/:token`) | C | valid/expired | Copy fine. |
| Google OAuth callback | C | success/error | Spinner + fallback link present. |

---

## Mobile smoke (390×844)

No horizontal overflow on login/home/approvals (real result, better than expected). But:

- **S29 · MAJOR (if mobile matters):** No responsive navigation — the full desktop sidebar renders
  *above* the page content; the user scrolls through the entire nav + workspace card to reach any
  content. Needs a collapse/hamburger pattern.
- **S30:** TopBar at 390px overlaps — breadcrumb truncates under the primary action button
  ("+ New campaign" covers "Camp…"); actions need wrap/priority rules.
- Login at mobile: clean, usable as-is.

---

## Cross-cutting observations

- **S31 · Copy register drifts by page.** The best pages speak operator English ("Nothing ships
  without your decision"); others speak system English ("outputs", "resolve", "org voice",
  "keyless"). A one-pass vocabulary sweep (one name per concept: generation/output/draft;
  Home/Command Center; Content/Create) would lift comprehension more than any single redesign.
- **S32 · Destructive actions are uneven.** Evidence delete confirms; Reject doesn't; Disconnect
  confirms; triage Skip doesn't (probably right). Rule needed: confirm when work is discarded,
  never when it's recoverable.
- **S33 · Numbers rarely link.** Counts and stats (stat strip, insights, chips) are text, not
  links to their filtered views — every number a user wants to interrogate is a dead end.
- **A11y quick pass:** focus rings present via kit; wizard has unnamed icon buttons (A7); badge
  tone colors carry meaning without text in a few spots (triage score chips) — acceptable, watch
  contrast on the pink/rose tones.
