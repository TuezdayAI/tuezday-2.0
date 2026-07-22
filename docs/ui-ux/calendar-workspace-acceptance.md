# Calendar Workspace Rebuild Acceptance

Date: 2026-07-13
Branch: `ui-revamp/calendar-workspace`
Baseline: `ui-revamp/review-workspace@b25e8e2` (merge order: foundations → campaign control plane → review workspace → this branch)

## Outcome

The Calendar rebuild slice is accepted at the implementation and automated-verification level. `/workspaces/:id/calendar` is now the operational work surface the consolidated design's §6.4 describes: two time views, comfortable/compact densities, URL-driven campaign and channel scope, canonical workflow-status language, planned-but-unfilled commitments, a link to generated work awaiting review, and selection/preview/recovery actions — using the same item anatomy and status labels as Home, Review, and the campaign workspace.

This acceptance covers contracts, compilation, production build output, and source-level behavior. An authenticated visual walkthrough at the target viewport widths remains a pre-release QA item.

## Delivered surface

- **Week and Month views** (`?view=week|month`), both Monday-start, with prev/today/next paging that steps by the active view's period. The month grid is a fixed 6×7 layout with out-of-month cells dimmed and today outlined.
- **Densities** (`?density=comfortable|compact`): compact collapses entry cards to single-line chips with icon-only status badges — the label stays available in the detail panel.
- **URL-driven campaign + channel filters** (`?campaign=&channel=`), the same pattern Review uses. The campaign workspace's "Calendar" context link now goes through the shared `calendarHref` builder and actually scopes the calendar — previously the `?campaign=` parameter was ignored.
- **Canonical statuses**: publication entries wear `WorkflowStatusBadge` (`scheduled` → Scheduled, `published` → Completed, `failed` → Failed). Open cadence slots render as visually distinct dashed "Open slot" commitments, deliberately unbadged — there is no canonical status meaning "planned and empty", and slots are commitments rather than work items.
- **Detail panel**: clicking any entry opens a sticky side panel with title, status, time, campaign, destination, cadence, and failure detail, plus context actions — **Retry now** (failed), **Cancel** (scheduled, confirm-guarded), **View post** (external URL), **Open Review** (draft-bearing entries, campaign-scoped), and **Manage cadence** (slots). Selection resolves against the visible set, so it clears itself when filters or paging drop the entry.
- **Awaiting-review rail**: a strip above the grid counts `pending_review` drafts scoped to the active filters and links into Review — the design's "generated work awaiting review" without pretending drafts have timeline positions.
- **Empty states**: the no-work state keeps the cadence-setup guidance; a filtered-empty state offers Clear filters as the recovery action.
- **API (additive)**: `calendarEntrySchema` gained nullable `campaignId`, `campaignName`, and `error`; `buildCalendar` joins workspace campaigns (via `drafts.campaignId` for publications, `postingCadences.campaignId` for slots) and surfaces `publications.lastError` on failed receipts. No table or migration changes; nothing renamed or removed.
- One shared view model (`apps/web/lib/calendar-workspace.ts`) owns param parsing, link building, fetch windows, Monday-start date math, the status mapping, filtering, and option lists, with unit tests; a source-reading shell-contract test pins the page to it.

## Preserved architecture and behavior

- The calendar consumes the existing `GET /calendar?from&to` route; retry and cancel use the existing publication routes that the Content page already exposes — no new mutation surface.
- The client-only anchor-date initialization (SSR hydration guard) is preserved.
- Login, authentication, onboarding-flow, dev-admin bootstrap, and environment-loading files were not changed.
- Enum vocabularies come only from `@tuezday/contracts`; the ad-hoc `Badge` tone map the old page carried is gone.

## Deferred (with reasons)

- **Rescheduling**: publications are immutable receipts with no reschedule API; the manual path remains cancel + re-publish from Content.
- **Per-slot regeneration**: no slot-scoped generation API exists.
- **Live `publishing` / `partially_failed` execution states**: the publication model persists only scheduled/published/failed; these arrive with the unified-execution-results slice (still assigned to the golden-loop plan in the capability registry).
- **Agenda/list view**: nothing in the Stage 3 gate requires it; the two views cover planning and density needs.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Calendar projection (API) | `npm test -- cadences` | Passed: 14 tests, including the new campaign-identity/failure-detail projection test |
| Calendar view model + shell contract | `npm exec --prefix apps/web vitest -- run lib/calendar-workspace.test.ts lib/calendar-shell-contract.test.ts` | Passed: 14 tests |
| Full repository suite | `npm test -- --maxWorkers=2` | Passed: 112 files, 1,223 tests |
| Workspace typecheck | `npm run typecheck` | Passed across all configured workspaces |
| Production web build | `npm run build -w apps/web` | Passed; `/calendar` route compiled |

## Responsive acceptance

The toolbar wraps at narrow widths; both grids use `minmax(0, 1fr)` columns; the detail panel collapses under the grid below 900px. The authenticated visual walkthrough at `1440px`, `1024px`, `768px`, and `390px` was not performed in this non-interactive validation pass. Before release it should cover: week and month views at both densities, a failed entry's retry flow, a scheduled entry's cancel flow, slot detail, the review rail, and the campaign-scoped entry path from a campaign workspace.

## Known non-blocking notes

- Next.js reports the pre-existing multiple-lockfile workspace-root warning during builds.
- The review-rail count loads once per visit; it refreshes with the page, not live.
- Remaining Stage 3 slices per the design: **unified execution results** and the **conversational editor**; the **external-action authorization queue** additionally needs its API foundation (routes/service/table) built first.
