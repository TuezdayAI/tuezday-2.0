# Sprint 33 — Dashboard UX redesign v2

- **Status:** planned (branch not yet cut — awaiting founder go-ahead, per one-sprint-at-a-time)
- **Roadmap item:** U4 — `docs/plans/sprint-guide-21-onward.md`, "Sprint 33"
- **Branch:** `sprint-33-dashboard-redesign-v2`, cut from `main`
- **Merge order:** none for the built scope. "Builds on: Sprint 18 (redesign v1) + `docs/research/ui-audit.md`" — both on `main`; the surfaces it houses, calendar (S27) and inbox (S29), are on `main` (Sprints 24–30 merged). **Insights (S34) is NOT on `main`** → its housing is **deferred behind a capability flag** (nav slot reserved, lit up when S34 merges — no faked dependency, mirroring the Sprint 40 `fetch-insights` gating).
- **Size:** M–L.
- **Do NOT merge into `main`.** Push the branch; the founder reviews, accepts, and merges. End commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

> **For agentic workers:** this spec is self-contained. The web workspace has **no test runner**, so UI verification is `typecheck` + `next build` + a manual walkthrough; keep real automated coverage by extracting pure decision logic into `packages/contracts` (Vitest) and one small API endpoint (api Vitest). REQUIRED SUB-SKILL: superpowers:executing-plans.

---

## Status check (why this sprint exists)

Sprint 33 has **not** been executed as a slice: no `docs/specs/sprint-33-*.md`, no `sprint-33-*` branch, and no commit anywhere (`git log --all` for "sprint 33"/"redesign v2"/"ux redesign" is empty). The redesign's input doc `docs/research/ui-audit.md` exists; Sprint 18 (redesign **v1**) was done (`ab411ef`).

Some of what this sprint covers already exists **incidentally** from Sprint 18 v1 + feature accretion (activity-named grouped nav in `apps/web/app/workspaces/[id]/layout.tsx`; a partial `page-header` CSS pattern; an attention-style Home with an `OnboardingChecklist`). The items below are what remains.

### Not-yet-executed checklist (vs. `ui-audit.md` + roadmap)
- [ ] **"Why this output?" trace disclosure** on every generated draft (resolver bundle + trace behind a one-click expander) — §3.1/§3.6. None in `apps/web` today.
- [ ] **Systematic onboarding empty states** ("what will appear here + first action") on list/queue pages — §3.3. No shared `EmptyState` exists.
- [ ] **Hide nav items for modules not yet enabled** (e.g. no Ads nav before an ad account) — §3.7. Nav renders every item unconditionally.
- [ ] **Dense forms (>5 fields) → stepped wizard with defaults** — §3.7.
- [ ] **Shared page-header component applied everywhere** (plain title + one-line "what this is for" + primary action), not ad-hoc CSS — §3.2.
- [ ] **Cohesively house calendar (S27) + inbox (S29)**; reserve the Insights slot for S34 — roadmap.
- [ ] **AI-in-outcome-language copy pass** — §3.6.
- [ ] **Founder acceptance walkthrough** (redesigned nav/home; fewer clicks).

> §3.4 first-run checklist overlaps Sprint 38 (onboarding) and is **out of scope here** — Sprint 33 consumes the existing `OnboardingChecklist`, it does not rebuild it.

---

## Goal

Act on `ui-audit.md` to give Tuezday a cohesive information architecture that houses the new calendar/inbox surfaces and cuts clutter, so a user with zero context can navigate and act.

Founder acceptance (from the roadmap):

> Walkthrough of the redesigned nav/home; key flows take fewer clicks.

---

## Decisions locked (confirmed with the founder/operator)

1. **Branch from `main`; defer insights.** House calendar + inbox + the audit fixes now; reserve the Insights nav slot and enable it via a capability flag when Sprint 34 merges.
2. **Scope = IA + copy + UX, no visual restyle.** Page-header component, empty states, "Why this output?" disclosure, hide-unused nav, wizardify dense forms, attention-Home polish. The typography/spacing/color theme waits on the founder's design-reference link (audit §4) and is a separate follow-up.
3. **Pure logic is extracted and tested.** Nav-visibility predicates live in `packages/contracts` (Vitest); module-capability booleans come from one small API endpoint (api Vitest). React components stay thin consumers, so the untested web layer carries no decision logic.

---

## Out of scope (YAGNI)
- Visual theme restyle (typography/spacing/color) — waits on the founder design-reference link.
- Insights surface housing beyond reserving its nav slot — enabled when Sprint 34 merges.
- Rebuilding the first-run onboarding checklist (owned by Sprint 38; consumed, not rebuilt).
- A web test runner.

---

## Architecture & boundary

```
Web layout (apps/web/app/workspaces/[id]/layout.tsx)
  └─ GET /workspaces/:id/capabilities ──► { hasAds, hasCrm, hasConnections, hasInsights, … }
       └─ visibleNavItems(NAV, capabilities)  [pure, in packages/contracts] ──► filtered sidebar
Shared UI (apps/web/components/)
  PageHeader  → title + one-line description + optional primary action (every page)
  EmptyState  → "what appears here" + first-action CTA (every list/queue)
  WhyThisOutput → collapsible resolver bundle + trace on drafts/generations (data already present)
```

- **Native (owned):** the IA + the nav-visibility rules. No new external integration. Insights stays gated until S34 (no faked data).

### New files
- `packages/contracts` — `visibleNavItems(...)` predicate (+ `WorkspaceCapabilities` type).
- `apps/api/src/routes/capabilities.ts` (or fold into `routes/workspaces.ts`) — `GET /workspaces/:id/capabilities`.
- `apps/web/components/page-header.tsx`, `apps/web/components/empty-state.tsx`, `apps/web/components/why-this-output.tsx`.
- Tests: `packages/contracts/test/nav-visibility.test.ts`, `apps/api/test/capabilities.test.ts`.

### Modified files
- `apps/api/src/app.ts` — register the capabilities route.
- `apps/web/app/workspaces/[id]/layout.tsx` — fetch capabilities, filter `NAV`, reserve the Insights entry (gated on `hasInsights`).
- `apps/web/app/workspaces/[id]/**/page.tsx` — adopt `PageHeader`; add `EmptyState` to list/queue pages; mount `WhyThisOutput` on the draft/approval + sandbox views.
- The densest >5-field create form (likely campaign- or launch-create) → stepped wizard.

---

## Implementation plan (TDD, bite-sized)

> Baseline: `git checkout main && git pull`, `npm install`, `npm test` (record green count), `git checkout -b sprint-33-dashboard-redesign-v2`. Clear any stale `.next` cache before web typechecks.

### Task 1 — Nav visibility logic (pure + tested) + capabilities endpoint
- [ ] **Contracts test** (`packages/contracts/test/nav-visibility.test.ts`): `visibleNavItems` hides Ads without an ad account, hides Insights until `hasInsights`, always shows core items (Home/Brain/Discover/Create/Review).
- [ ] **Run red** → implement `visibleNavItems(items, capabilities)` + `WorkspaceCapabilities` in `packages/contracts`.
- [ ] **API test** (`apps/api/test/capabilities.test.ts`): `GET /workspaces/:id/capabilities` returns correct booleans for a fresh vs. populated workspace; membership enforced by the global guard.
- [ ] **Run red** → implement the endpoint deriving booleans from `listConnections` (`apps/api/src/services/connections.ts`), the ad-account query, and draft/generation counts; `hasInsights = false` constant until S34. Register in `app.ts`.
- [ ] **Run green. Commits:** `feat(contracts): nav-visibility predicate`, `feat(api): workspace capabilities endpoint`.

### Task 2 — Shared PageHeader + EmptyState, applied
- [ ] Create `page-header.tsx` (title + one-liner + optional primary action) and `empty-state.tsx` (message + first-action CTA).
- [ ] Replace ad-hoc `page-header` CSS usage across `workspaces/[id]/**/page.tsx`; add `EmptyState` to discovery, approvals/drafts, signals/content, audience/leads, campaigns, calendar, inbox.
- [ ] **Verify:** `npm run typecheck -w @tuezday/web && npm run build -w @tuezday/web`. **Commit:** `feat(web): shared PageHeader + EmptyState across surfaces`.

### Task 3 — "Why this output?" trace disclosure
- [ ] Add `why-this-output.tsx`: a collapsible panel rendering the resolved bundle + trace already carried on a generation/draft (`review`/`reviewJson`; resolver output) — no new API. Frame as a trust feature ("see exactly what Tuezday used").
- [ ] Surface on the draft/approval view and the sandbox/generation result.
- [ ] **Verify** typecheck/build + manual. **Commit:** `feat(web): 'Why this output?' resolver-trace disclosure`.

### Task 4 — Consume nav visibility + reserve Insights slot
- [ ] In `layout.tsx`, fetch `/capabilities` and filter `NAV` via the Task-1 predicate; add the **Insights** entry gated on `hasInsights` (off until S34); hide Ads children until an ad account exists.
- [ ] **Verify** typecheck/build + manual (fresh workspace shows fewer items). **Commit:** `feat(web): capability-driven nav (hide unused, reserve Insights)`.

### Task 5 — Wizardify the densest form
- [ ] Convert the worst >5-field create form (campaign- or launch-create) to a 2–3 step wizard with defaults; keep the existing submit endpoint/contract unchanged.
- [ ] **Verify** typecheck/build + manual. **Commit:** `feat(web): stepped wizard for the densest create form`.

### Task 6 — Copy pass + Home polish + verify + push
- [ ] AI-in-outcome-language copy across Create/Review headers and CTAs (§3.6); confirm Home meets the "act within 5 seconds" bar (§3.5) using existing attention data.
- [ ] `npm test && npm run typecheck` green; `npm run build -w @tuezday/web` clean. Update the Progress log. **Commit:** `feat(web): outcome-language copy + Home polish`. Then `git push -u origin sprint-33-dashboard-redesign-v2` (**do not merge**).

---

## Automated verification
- **Contracts:** `visibleNavItems` unit tests (Ads/Insights hidden appropriately; core always shown).
- **API:** `GET /workspaces/:id/capabilities` correct for fresh vs. populated; membership enforced by the guard.
- **Web:** `npm run typecheck -w @tuezday/web` + `npm run build -w @tuezday/web` clean (clear stale `.next` first).
- **Whole repo:** `npm test && npm run typecheck` green.

## Founder acceptance checklist
- [ ] A fresh workspace shows a de-cluttered nav (no Ads/Insights yet) and an onboarding Home.
- [ ] Every page has a plain title + one-liner + primary action.
- [ ] Empty queues explain themselves and offer a first action.
- [ ] A generated draft shows "Why this output?" with the real resolved bundle/trace.
- [ ] The densest create form is now a stepped wizard.
- [ ] Key flows take fewer clicks; calendar + inbox are housed cohesively; the Insights slot appears once S34 merges.

## Known limitations
- No visual theme change yet (waits on the design-reference link).
- Insights nav is reserved but inert until Sprint 34 is on `main`.
- UI has no automated tests beyond typecheck/build; decision logic is pushed to contracts/api to compensate.

## Progress log
- 2026-06-27 — Spec drafted against `main` (HEAD Sprint 31). Confirmed Sprint 33 unbuilt (no spec/branch/commit); `docs/research/ui-audit.md` present; calendar (S27)/inbox (S29) on `main`, insights (S34) unmerged → deferred behind a capability flag. Decisions confirmed: branch from main + defer insights; IA/copy/UX scope, no visual restyle. Branch not yet cut (awaiting founder go-ahead).
