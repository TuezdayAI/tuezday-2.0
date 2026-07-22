# Unified Execution Results Acceptance

Date: 2026-07-13
Branch: `ui-revamp/execution-results`
Baseline: `ui-revamp/calendar-workspace@1289d53` (merge order: foundations → campaign control plane → review workspace → calendar workspace → this branch)

## Outcome

The unified-execution-results slice is accepted at the implementation and automated-verification level. Tuezday now has one contract, one API projection, and one first-consumer surface for "what did Tuezday actually execute, and how did it go" — across social publications, targeted launches, and ad launches — in exactly the registry's required states: running, completed, partially failed, failed.

This acceptance covers contracts, compilation, production build output, and source-level behavior. An authenticated visual walkthrough at the target viewport widths remains a pre-release QA item.

## Delivered surface

- **Contract** (`packages/contracts`): `EXECUTION_RESULT_KINDS` (`publication | launch | ad_launch`), `EXECUTION_RESULT_STATUSES` (`running | completed | partially_failed | failed`), and `executionResultSchema` — including a `destinations {total, succeeded, failed, skipped, pending}` rollup so partial failure always lists successes and failures separately (design §7.2).
- **API (additive)**: `GET /workspaces/:id/executions?campaign=&limit=` (`apps/api/src/services/executions.ts`). Read-only projection over existing rows — no schema or migration changes. Inclusion rule is *results, not intentions*: scheduled publications, draft/ready launches, and gate-state ad launches are excluded. Launch rollups group `launch_messages`: pending remaining → `running`; failures alongside sends → `partially_failed`; only failures → `failed`; otherwise `completed`. The first failed message's error surfaces as the result's failure detail.
- **Web view model** (`apps/web/lib/execution-results.ts`): maps `running` onto the canonical per-kind progress state (`publishing` / `sending` / `launching`) and terminal states 1:1, builds the destination summary ("3 sent · 2 failed · 1 skipped"), labels kinds in user language (Post / Targeted send / Ad launch), and links each result to the surface owning its recovery.
- **Campaign workspace Results tab** (design §5.3 tab set): campaign-scoped execution results with `WorkflowStatusBadge`, destination summary, failure detail, platform status for launched ads, **Retry now** for failed publications (existing route), external **View post** links, and per-kind deep links — including a new `?launch=<id>` deep link on `/launches` that opens the launch detail on arrival.
- Shell-contract test pins the tab to the shared view model, the canonical badge, the unified projection endpoint, and the recovery routes.

## Preserved architecture and behavior

- No existing route, page, or vocabulary changed meaning; the three source surfaces (`/content`, `/launches`, `/ad-launches`) behave as before (the launches page additionally honors `?launch=`).
- Publication retry reuses the existing `POST /publications/:id/retry`; no new mutation surface.
- Enum vocabularies come only from `@tuezday/contracts`; login/auth/onboarding/dev-bootstrap/env files untouched.

## Deferred (with reasons)

- **External-action results**: `EXTERNAL_ACTION_STATUSES` exist only as contracts — no table or routes. They join this projection when the authorization-queue slice builds its API foundation.
- **Live in-flight states for publications and ad launches**: neither model persists an in-flight row (attempts are synchronous), so only launches can genuinely report `running`.
- **Calendar executing/partial chips**: the calendar projects publications, which persist no such states — the registry note for Calendar stays accurate.
- **Home "execution failures" priority and the editor's Execution region**: later consumers of this same contract (editor slice, Home wave).
- **Results-tab analytics depth** (outcome comparisons, learning suggestions per design §5.3): Insights journey-wave scope.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Contract vocabulary + schema | `npm test -- execution-results` | Passed: 14 tests (contracts 4, web view model 5, shell contract 5) |
| Unified projection (API) | `npm test -- executions` | Passed: 5 tests incl. rollups, campaign filter, limit, workspace isolation |
| Full repository suite | `npm test -- --maxWorkers=2` | Passed: 116 files, 1,242 tests |
| Workspace typecheck | `npm run typecheck` | Passed across all configured workspaces |
| Production web build | `npm run build -w apps/web` | Passed |

## Known non-blocking notes

- The Results tab loads once per visit; running launches refresh with the page, not live.
- A fresh worktree needs `npm install` before tests — without it, `@tuezday/contracts` resolves up the tree to the main checkout's stale copy (hit and fixed during this slice).
- Remaining Stage 3 slices per the design: the **conversational editor**, and the **external-action authorization queue** (API foundation first).
