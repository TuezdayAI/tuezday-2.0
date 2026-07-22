# UI/UX Revamp Foundation Acceptance

Date: 2026-07-12  
Branch: `integration/gtm-foundation`  
Foundation baseline: `1e38c14`

## Outcome

The engineering foundation for the consolidated Tuezday/Blaze revamp is accepted. The merged GTM orchestration capabilities remain intact while the application now has a canonical design-token layer, workflow-status vocabulary, approved navigation hierarchy, shared status badge, sectioned workspace shell, global Create entry point, and a stable Content Preferences anchor.

This acceptance covers contracts, compilation, build output, and source-level responsive behavior. An authenticated visual walkthrough at the target viewport widths remains a pre-release QA item.

## Delivered foundation

- Experience contract artifacts: capability registry, route migration map, and golden-loop state map.
- Tuezday website-derived typography, color, semantic state, geometry, and motion tokens.
- Canonical workflow status contracts and golden-loop analytics vocabulary.
- Shared icon-and-text workflow badges, adopted first by Home and Review.
- Approved information architecture grouped into Operate, Grow, Foundations, Work, and Workspace.
- Sectioned responsive workspace navigation, global Create New action, and `/brain#content-preferences` anchor.
- Preserved carousel generation/media behavior and ad-image generation introduced by the foundation merge.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Contract foundation | `npm test -w packages/contracts -- workflow-status.test.ts nav-visibility.test.ts nav-entry.test.ts nav-icons.test.ts` | Passed: 4 files, 20 tests |
| Web foundation | `npm exec --prefix apps/web vitest -- run lib/design-tokens.test.ts lib/workflow-status.test.ts lib/icon-registry.test.ts lib/shell-contract.test.ts` | Passed: 4 files, 11 tests |
| Analytics compatibility | `npm test -w packages/contracts -- analytics.test.ts workflow-status.test.ts` | Passed: 2 files, 6 tests |
| Full repository suite | `npm test -- --maxWorkers=2` | Passed: 103 files, 1,175 tests |
| Workspace typecheck | `npm run typecheck` | Passed across all configured workspaces |
| Production web build | `npm run build -w apps/web` | Passed; all application routes compiled |

## Responsive acceptance

Automated shell contracts verify the section-label hooks, global Create destination, Content Preferences anchor, and sticky-anchor offset. CSS defines the approved shell transitions at `860px`, `720px`, and `560px`, covering the planned desktop, tablet, and compact layouts without changing route behavior.

The authenticated visual walkthrough at `1440px`, `1024px`, `768px`, and `390px` was not performed in this non-interactive validation pass. It should be completed with representative workspace data before release and should check navigation overflow, top-bar action density, focus order, and the carousel/review presentation.

## Preserved architecture and deferred UI

The campaign plan, plan-revision, and campaign-lane APIs from the GTM orchestration foundation were not replaced or duplicated. Their UI, along with authorization review and unified execution results, is explicitly assigned to the golden-loop implementation phase. See the capability registry for the complete status boundary.

## Known non-blocking notes

- Next.js reports the pre-existing multiple-lockfile workspace-root warning during builds.
- The dependency audit findings reported at baseline were not changed by this foundation slice.
