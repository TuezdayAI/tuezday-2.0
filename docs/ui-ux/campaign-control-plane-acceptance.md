# Campaign Control Plane UI Acceptance

Date: 2026-07-13  
Branch: `ui-revamp/campaign-control-plane`  
Foundation baseline: `main@df5a314`

## Outcome

The campaign control plane slice is accepted at the implementation and automated-verification level. Campaigns now open into a campaign-first workspace with Overview, Plan history, and Channels surfaces, backed by the merged orchestration architecture rather than a parallel UI-only model.

This acceptance covers contracts, API behavior, compilation, production build output, and source-level responsive behavior. An authenticated visual walkthrough at the target viewport widths remains a pre-release QA item.

## Delivered surface

- Campaign inventory cards at `/workspaces/[id]/campaigns`, preserving campaign creation, editing, automation, caps, cadence, guardrails, insights export, settings, and archive/unarchive behavior.
- Campaign workspace at `/workspaces/[id]/campaigns/[campaignId]` with URL-addressable Overview, Plan, and Channels tabs.
- Contract-backed campaign-plan workspace read model with newest-first plan history, stable named lanes, and deterministic configuration issues.
- Overview panels for attention, plan status, channel readiness, work/results, and degraded connector recovery.
- Immutable active and superseded plan history, editable draft creation, structured activation blockers, and activation.
- Draft channel configuration for persona, audience, connection, destination, schedule, reactive limits, quantity, delivery mode, and status.
- New plan revisions clone the active lane configuration while retaining stable lane identities.
- Narrow-screen continuation guidance for dense channel editing rather than hidden or inaccessible controls.

## Preserved architecture and behavior

- The campaign, campaign-plan, plan-revision, and campaign-lane domain model remains canonical; the UI consumes and extends the orchestration foundation APIs.
- Existing campaign management and export capabilities remain available from the redesigned inventory.
- Content approval and external-action authorization remain separate workflows and are not conflated by this slice.
- Login, authentication, onboarding, dev-admin bootstrap, and environment-loading files were not changed because they are owned by the parallel session.
- Review, Calendar, authorization review, and unified execution-result redesigns remain separate implementation waves.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Campaign workspace contracts | `npm test -w packages/contracts -- campaign-workspace.test.ts orchestration.test.ts workflow-status.test.ts` | Passed: 3 files, 17 tests |
| Campaign orchestration API | `npm exec vitest -- run apps/api/test/orchestration-foundation.test.ts apps/api/test/campaigns.test.ts` | Passed: 2 files, 24 tests |
| Campaign web contracts | `npm exec --prefix apps/web vitest -- run lib/campaign-control-plane.test.ts lib/campaign-workspace-contract.test.ts lib/design-tokens.test.ts lib/workflow-status.test.ts lib/icon-registry.test.ts` | Passed: 5 files, 17 tests |
| Full repository suite | `npm test -- --maxWorkers=2` | Passed: 106 files, 1,187 tests |
| Workspace typecheck | `npm run typecheck` | Passed across all configured workspaces |
| Production web build | `npm run build -w apps/web` | Passed; all application routes compiled, including the campaign workspace |

The full suite was run outside the restricted filesystem sandbox because Playwright's Chromium renderer requires macOS Mach-port access. The isolated renderer failure inside the sandbox was environmental; the unrestricted full run passed all 1,187 tests.

## Responsive acceptance

The campaign inventory and workspace use shared layout tokens and responsive stacking rules. Overview and Plan remain functional at compact widths. Channels retains its controls and presents an explicit desktop-continuation notice for dense editing on narrow screens.

The authenticated visual walkthrough at `1440px`, `1024px`, `768px`, and `390px` was not performed in this non-interactive validation pass. Before release, it should be completed with representative campaign, revision, lane, connector, and error-state data, checking overflow, tab navigation, keyboard order, focus visibility, and editing density.

## Known non-blocking notes

- Next.js reports the pre-existing multiple-lockfile workspace-root warning during builds.
- The next UI/UX revamp slice is the unified Review workspace; Calendar and unified execution results follow in later waves.
