# Calendar Workspace Rebuild

Date: 2026-07-13
Branch: `ui-revamp/calendar-workspace` (off `ui-revamp/review-workspace@b25e8e2`)
Merge order: foundations → `ui-revamp/campaign-control-plane` → `ui-revamp/review-workspace` → this branch.
Design authority: `docs/superpowers/specs/2026-07-12-consolidated-ui-ux-revamp-design.md` §6.4 (Calendar), §7 (status system), §12 Stage 3.

## Goal

Rebuild `/workspaces/:id/calendar` from a single-week receipt grid into the operational work surface the design describes: multiple time views, campaign and channel filters, comfortable/compact densities, planned-but-unfilled commitments, generated work awaiting review, scheduled/executed work with canonical status language, and preview/selection/recovery actions — using the same item anatomy and status labels as Home, Review, and campaign Work.

## What exists today

- `GET /workspaces/:id/calendar?from&to` (`apps/api/src/routes/cadences.ts`) → `buildCalendar` (`apps/api/src/services/calendar.ts`): publications (scheduled/published/failed) joined to drafts + cadences, plus open slots from active cadences. `calendarEntrySchema` in contracts has no campaign identity and no failure detail.
- Recovery routes already exist and are already user-facing on the Content page: `POST /publications/:id/retry` (failed only) and `DELETE /publications/:id` (scheduled only).
- The current page (`apps/web/app/workspaces/[id]/calendar/page.tsx`, 263 lines): week view only, local channel filter, ad-hoc `Badge` tones (`draft/pending/approved/rejected`), no campaign filter, no entry actions, no detail view.
- Drafts API supports `?state=pending_review` (used by Review) — enough to surface "generated work awaiting review".

## Scope decisions

1. **Additive API change, no schema migration.** `calendarEntrySchema` gains `campaignId`, `campaignName`, and `error` (all nullable). `buildCalendar` sources campaign identity from `drafts.campaignId` (publications) and `postingCadences.campaignId` (slots) — both columns exist — and `error` from `publications.lastError`. Nothing existing is renamed or removed.
2. **Two time views: Week and Month**, URL-driven (`?view=week|month`, default week). Month renders a Monday-start 6-row grid; the fetch window covers the visible grid, not the calendar month. An agenda/list view is deferred — nothing in the gate requires it.
3. **Densities** via `?density=comfortable|compact` (default comfortable). Compact collapses entry cards to one-line chips (CSS-driven, same DOM).
4. **URL-driven campaign + channel filters** (`?campaign=&channel=`), same pattern as Review. Campaign options come from the loaded entries plus the workspace campaign list so an empty week can still be scoped.
5. **Canonical statuses.** Publication entries use `WorkflowStatusBadge`: `scheduled → scheduled`, `published → completed`, `failed → failed`. Open slots are planned-but-unfilled *commitments*, not work items — they render as visually distinct "Open slot" chips (calendar icon + cadence name), not with a workflow-status badge; there is no canonical status meaning "planned and empty" and inventing one is forbidden.
6. **Detail panel** (selection + preview): clicking an entry opens a side panel with title, time, channel, campaign, cadence, destination, status, failure detail, and actions — Retry (failed), Cancel (scheduled, confirm-guarded), View post (external URL), Open in Review (draft-bearing entries, via `reviewHref` with the campaign filter). Slot detail links to the cadence and to Review scoped to the slot's campaign.
7. **Awaiting-review rail.** A slim strip above the grid showing the count of `pending_review` drafts scoped to the active campaign/channel filters, linking into Review — the design's "generated work awaiting review" without pretending drafts have timeline positions.
8. **Deferred with reasons.** Rescheduling (no API — publications are immutable receipts; the manual path is cancel + re-publish from Content), per-slot regeneration (no slot-scoped generation API), and live `publishing`/`partially_failed` execution states (the publication model persists only scheduled/published/failed; these arrive with the unified-execution-results slice). The capability registry keeps "Unified execution results" assigned to the golden-loop plan.

## Global constraints

- No changes to login/auth/onboarding/dev-admin-bootstrap/environment loading.
- Enum vocabularies only from `@tuezday/contracts`; no local status vocabularies.
- View logic lives in a pure, tested view model (`apps/web/lib/calendar-workspace.ts`); the page stays presentational.
- Preserve the client-only anchor-date initialization (SSR hydration guard) from the current page.
- `npm test`, `npm run typecheck`, and `npm run build -w apps/web` green before push; commit per task; do not merge to main.

## Tasks

- [ ] **Task 1 — API: campaign identity + failure detail on calendar entries.** Extend `calendarEntrySchema` (contracts) with nullable `campaignId`, `campaignName`, `error`; join campaigns in `buildCalendar`; extend `apps/api/test/cadences.test.ts` to assert a publication entry carries its draft's campaign and a failed entry carries `lastError`, and a slot carries its cadence's campaign. Commit: `feat(api): expose campaign identity and failure detail on calendar entries`.
- [ ] **Task 2 — Web view model.** `apps/web/lib/calendar-workspace.ts` + `calendar-workspace.test.ts`: `calendarView()`/`calendarDensity()` param parsing with defaults, `calendarHref()` link builder, `rangeFor(view, anchor)` fetch windows, `weekDays()`/`monthGrid()` pure date helpers (Monday start), `entryWorkflowStatus()` mapping, `filterCalendarEntries()`, `entryCampaigns()`/`entryChannels()` distinct option lists. Commit: `feat(web): define calendar workspace view model`.
- [ ] **Task 3 — Page rebuild: toolbar + week/month grids.** Rebuild the page around the view model: toolbar with view toggle, density toggle, prev/today/next, campaign + channel filters, status counts; week and month grids with canonical `WorkflowStatusBadge` on publication entries and slot chips; empty and filtered-empty (with clear-filters recovery) states. Commit: `feat(web): rebuild calendar with month view, densities, and canonical statuses`.
- [ ] **Task 4 — Detail panel, recovery actions, awaiting-review rail.** Entry selection opens the detail panel with retry/cancel/view-post/open-in-review actions wired to the existing routes; awaiting-review rail fetches scoped `pending_review` drafts and links to Review. Commit: `feat(web): add calendar detail panel with recovery actions and review rail`.
- [ ] **Task 5 — Shell contract test.** Source-reading test (`apps/web/lib/calendar-shell-contract.test.ts`) asserting the page consumes `calendarView(`/`calendarDensity(`, builds links with `calendarHref`, mounts the detail panel, and uses `WorkflowStatusBadge`. Commit: `test(web): pin calendar workspace shell contract`.
- [ ] **Task 6 — Docs + verification.** Update `docs/ui-ux/capability-registry.md` (Calendar row → implemented), write `docs/ui-ux/calendar-workspace-acceptance.md`, run full suite + typecheck + web build, push. Commit: `docs: accept calendar workspace rebuild`.

## Progress log

- 2026-07-13: Plan written after surveying the calendar service/routes, publication recovery routes, contracts, and the current page.
