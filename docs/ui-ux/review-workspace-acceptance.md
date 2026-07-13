# Unified Review Workspace UI Acceptance

Date: 2026-07-13  
Branch: `ui-revamp/review-workspace`  
Baseline: `ui-revamp/campaign-control-plane@500c13f` (merge order: foundations → campaign control plane → this branch)

## Outcome

The unified Review workspace slice is accepted at the implementation and automated-verification level. Approvals and the engagement Inbox are now sibling tabs inside one Review surface at `/workspaces/:id/review`, sharing the page header, canonical workflow-status language, campaign context, and queue navigation — per §5.2 and §6.2 of the consolidated UI/UX revamp design.

This acceptance covers contracts, compilation, production build output, and source-level behavior. An authenticated visual walkthrough at the target viewport widths remains a pre-release QA item.

## Delivered surface

- `/review` workspace with URL-addressable Approvals and Inbox tabs (`?tab=approvals|inbox`) and live queue counts on each tab (pending-review drafts; unread inbox items).
- Approvals tab: the full existing approval queue plus campaign and channel scope filters. The campaign filter is URL-driven (`?campaign=`), so the campaign workspace's "Open Review" link now actually scopes the queue — previously the parameter was ignored.
- Previous/Next queue navigation in the draft detail panel, walking the filtered gallery order without closing the panel.
- Filtered-empty state with an explicit "Clear filters" recovery action.
- Inbox tab: item statuses and reply-draft chips now speak the canonical workflow vocabulary through `WorkflowStatusBadge` (`unread`/`read` → Review required, `replied` → Completed, `dismissed` → Archived) instead of ad-hoc badge tones; the status filter keeps the domain labels.
- One shared view model (`apps/web/lib/review-workspace.ts`) owns tab parsing, link building, the draft and inbox → workflow-status mappings, filtering, and queue-neighbor logic, with unit tests.
- Navigation contract: Review is a single Operate entry at `/review` (Approvals/Inbox children removed — they are in-page tabs). Next-action and setup-checklist contracts point at `/review`.
- `/approvals` and `/inbox` remain as param-preserving redirects (`?campaign=` survives), so every legacy deep link keeps working; all in-app links were migrated to the new routes.
- `chevron-left` added to the shared icon registry for queue navigation.

## Preserved architecture and behavior

- No API changes. The queues consume the existing draft and inbox routes; approval transitions still flow exclusively through `canTransition`.
- All approval behaviors preserved: approve/edit/reject/resubmit, keyboard focus-advance after approve, per-group "Approve all", carousel generation, re-run review, decision history, "Posting to" rail with inline OAuth connect, copy/download, media strips, "Why this output".
- All inbox behaviors preserved: run-now, mark read/dismiss, draft reply, approve-and-post, posted-reply links, empty-state preview, show-more pagination.
- Content approval and external-action authorization remain distinct. The external-action state machine exists only in contracts (no route, service, or table), so the authorization queue is explicitly deferred to the golden-loop plan; the Review shell accommodates a future Authorizations tab without restructuring.
- Login, authentication, onboarding-flow, dev-admin bootstrap, and environment-loading files were not changed.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Review view model + shell contract | `npm exec --prefix apps/web vitest -- run lib/review-workspace.test.ts lib/review-shell-contract.test.ts` | Passed |
| Navigation + next-action contracts | `npm test -w packages/contracts -- nav-visibility.test.ts nav-entry.test.ts nav-icons.test.ts next-action.test.ts` | Passed |
| Web lib suite | `npm exec --prefix apps/web vitest -- run lib/` | Passed: 14 files, 53 tests |
| Full repository suite | `npm test -- --maxWorkers=2` | Passed: 110 files, 1,208 tests |
| Workspace typecheck | `npm run typecheck` | Passed across all configured workspaces |
| Production web build | `npm run build -w apps/web` | Passed; `/review` route compiled |

## Responsive acceptance

The Review shell reuses the campaign-workspace tab pattern (scrollable underlined tab nav) and shared layout tokens. The filter row wraps at narrow widths; the approvals gallery and inbox list already stack responsively. Tab links, filter selects, and queue-navigation buttons preserve keyboard order and visible focus.

The authenticated visual walkthrough at `1440px`, `1024px`, `768px`, and `390px` was not performed in this non-interactive validation pass. Before release it should be completed with representative drafts (text, image, carousel), inbox items with and without reply drafts, campaign/channel filter combinations, and the legacy-redirect entry paths.

## Known non-blocking notes

- Next.js reports the pre-existing multiple-lockfile workspace-root warning during builds.
- The Review tab counts refresh when a queue reloads or the shell remounts; a cross-tab live refresh (e.g. approving from Approvals lowering the TopBar count) still relies on the existing capability polling.
- The next UI/UX revamp slices per the design's Stage 3 are the Calendar rebuild and unified execution results; the external-action authorization queue additionally needs its API foundation first.
