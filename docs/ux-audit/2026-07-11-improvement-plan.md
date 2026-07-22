# UX Improvement Plan — synthesized from Audits A + B

**Date:** 2026-07-11 · **Ranked against:** overall launch readiness (founder decision) ·
**Constraints:** Editorial identity locked; IA challengeable · **Inputs:**
`2026-07-11-journey-audit.md` (A/B findings), `2026-07-11-screen-sweep.md` (S findings).

The audit's one-line verdict: **the product's spine — onboarding narrative, the approval gate,
the brain surfaces — is already launch-grade; what's not launch-ready is the front door (a
hard-blocked signup step) and a handful of places where the UI can tell the user something
false.** Fix those two classes and the rest is polish velocity.

Waves are ordered by launch risk. Each item: finding refs · why · flags
(`[UI]` frontend-only, `[BE]` needs backend, `[IA]` challenges information architecture,
`[FOUNDER]` needs a product decision first).

---

## Wave 1 — Unblock the front door *(without this, no unassisted signup survives)*

1. **Give the Socials step a way through.** (A1) `[BE][FOUNDER]`
   Options, in order of recommendation: (a) "Skip for now — Tuezday will learn your voice from
   your website" ghost action that records the skip and re-prompts via the Home checklist;
   (b) make the gate conditional on at least one provider actually being configured in the
   deployment; (c) keep the gate only for invited/managed betas via a flag. The founder's
   voice-quality rationale survives all three — the *brain autodraft already succeeded from the
   website alone* in the audited run.
2. **Purge deployment language from user-facing copy.** (A2, S27) `[UI]`
   "OAuth app not configured in .env" → hide unconfigured providers in onboarding entirely;
   Integrations page keeps a quieter "Not available on this workspace yet".
3. **Make sign-up feel alive.** (A3, S1) `[UI]`
   Progress state on submit, inline validation, and a failure message that names the fix.
4. **Make the first-draft step idempotent.** (A6) `[BE]`
   Guard double-submits server-side; the wizard's draft step should reuse an in-flight/completed
   generation. Verify the duplicate-draft repro while doing it.
5. **Credit onboarding in the Home checklist.** (A4) `[BE — small]`
   Wizard verify/save events should tick "Review your Brain" (and any other step the wizard
   already satisfied). The first thing a fresh user sees must acknowledge what they just did.

**Exit criterion:** a stranger with only an email can go register → first draft → approve with
zero operator help, and nothing on the way says something untrue.

---

## Wave 2 — Never lie to the operator *(trust is the product; these are the truth bugs)*

6. **Surface the kill switch wherever automation is promised.** (B2, S11) `[UI]`
   Campaign cards showing an automated mode while the global kill switch blocks posting must show
   a "paused — auto-posting off" chip linking to guardrails. One source of truth, surfaced at the
   point of expectation.
7. **Fix the "Live" stat (and make every stat falsifiable-safe).** (A5) `[BE — small]`
   The strip must count what its label says. While there: wire the two stubbed next-action inputs
   (`insights_live`, `generatingCount`) so the guide dot reacts to reality — same class of truth.
8. **Explain the smart landing.** (B1) `[UI]`
   One line under the TopBar when the guide redirects: "You're here because 2 drafts need review"
   / "…this campaign's cadence has open slots". The engine already knows the reason string.
9. **Settle the inline-edit model on campaign cards.** (B3) `[UI]`
   Either controls autosave with a toast ("Automation → Scheduled-auto saved") or they move
   behind Edit. Recommendation: autosave + toast; it matches the settings-modal behavior.
10. **Confirm discard-class actions, only those.** (S20, S32) `[UI]`
    Reject gets an undo-toast (decision log already records it — surface "Undo" for 10s);
    codify the rule: confirm/undo when work is discarded, never for recoverable state changes.

---

## Wave 3 — Say it in one language *(comprehension debt; cheap, high compounding value)*

11. **One name per concept, one pass, whole app.** (A8, S16, S31, B7) `[UI]`
    The offenders list is finite: Home/Command Center · Create/Content/Playground ·
    outputs/generations · cadence/open slots · "org voice" (needs a first-use explainer).
    Deliverable is a tiny vocabulary table in the spec + a copy sweep commit.
12. **Label every number, link every number.** (S3, A8, S33, S26) `[UI]`
    The unlabeled "2" chip gets a tooltip or dies; "11 outputs" becomes "11 drafts created";
    stat-strip and insights numbers become links to their filtered views.
13. **Explain the scores.** (B7/S15-adjacent) `[UI]`
    Triage score chip gets a tooltip ("Brain relevance vs your ICP and campaigns — 0–100") and the
    doc-completeness chips stop claiming "complete" for one-liners (S5: switch to length-aware
    copy like "drafted / needs depth" — `[BE — small]` for the threshold).
14. **Empty-state parity for Review + a11y names.** (B4, A7) `[UI]`
    Review's bare "Nothing in this state." gets the preview-value treatment ("This is where drafts
    wait for you — blurred sample"); sweep the wizard's unnamed icon buttons with aria-labels.
15. **Small fit-and-finish batch.** (A8 avatars, S25 PR name dedup, B7 duplicate CTA, S18 disabled-
    button tooltip, S14 export-picker labels) `[UI]`

---

## Wave 4 — Structural (IA) decisions *(challengeable per founder; each needs a call)*

16. **Insights needs a home.** (B6) `[IA][FOUNDER]`
    Recommendation: Campaigns subnav entry (it's campaign/channel math today) + Home stat-strip
    numbers deep-linking into it.
17. **Ad creatives' two front doors.** (S19) `[IA]`
    It lives under Create and under Campaigns→Ads adjacency. Pick Create as canonical; the other
    becomes a link, not a route.
18. **Calendar entries become doors, not tiles.** (S9) `[UI]`
    Click-through to the draft/publication behind every entry. (IA-adjacent: it makes Calendar a
    real hub rather than a report.)
19. **Campaign home answers "is it working", not only "how is it set".** (S8) `[BE]`
    Per-card: last shipped, next scheduled, 7-day counts. This is the deferred "contribution
    stats on hub cards" — the audit independently re-derived its need; schedule it.

---

## Wave 5 — Reach & resilience *(post-launch fast-follows unless the audience changes)*

20. **Mobile: collapse the nav, wrap the TopBar.** (S29, S30) `[UI]` Only if prospects will
    genuinely open the web app on phones; Sprint 39's Telegram approvals already cover the
    highest-value mobile moment.
21. **Connector-down pages degrade to ConnectPrompt, not error headlines.** (S24) `[UI]`
    CRM first; same pattern anywhere a provider outage currently leads with red text.
22. **Draft persistence on long forms.** (S13) `[UI]` Launch-ads form first.
23. **Bulk triage actions.** (S15) `[BE]` "Skip all below N" once real discovery volume arrives.
24. **Evidence-store copy** (S6) — already handled by Sprint 47's sweep; verify after that branch
    merges. Billing remains an **untested surface** (needs a test-mode audit pass before launch).

---

## Suggested execution shape

- **Wave 1 + item 6/7** = one sprint-sized slice ("launch-blockers"), spec-first per the workflow;
  everything in it is small except the socials-gate decision, which needs the founder's call on
  option (a)/(b)/(c) up front.
- **Waves 2–3 remainder** = a second slice of ~15 small findings; almost all `[UI]`, perfect for
  parallel agents with the per-finding acceptance lines above.
- **Wave 4** items go through the founder as three explicit IA decisions before any build.
- Re-run Journey 1 (the new-user script is preserved in the audit session) after Wave 1 as the
  acceptance test: it must reach the first draft with zero manual DB intervention.
