# Unified Execution Results — Plan

Date: 2026-07-13
Branch: `ui-revamp/execution-results` (off `ui-revamp/calendar-workspace@1289d53`; merge order: foundations → campaign control plane → review workspace → calendar workspace → this branch)
Design source: `docs/superpowers/specs/2026-07-12-consolidated-ui-ux-revamp-design.md` §6 (golden loop terminal step "Execution result"), §5.3 (campaign workspace `Results` tab), §7 (status system). Capability registry row: "Unified execution results — publication, launch, and orchestration result contracts — dispersed across execution routes — required states: running, completed, partially failed, failed."

## Goal

One place where a user sees what Tuezday actually executed on their behalf and how it went — across social publications, targeted launches, and ad launches — speaking the canonical status vocabulary, listing successful and failed destinations separately, and offering recovery. Delivered as a unified API projection plus its first consumer: the campaign workspace's **Results** tab (design §5.3), scoped to the campaign, with a workspace-wide view model other surfaces (editor, Home, Calendar) can consume in later slices.

## What exists today

Execution outcomes are dispersed across three families, each with its own page, vocabulary, and shape:

- **Publications** (social posts): `scheduled | published | failed` + `lastError` + `externalUrl`. Listed on `/content` (with retry/cancel) and projected onto the Calendar. `GET /workspaces/:id/publications` exists.
- **Targeted launches** (Sprint 26/30): coarse launch status `draft | generating | ready | completed`; real dispatch outcomes live per-recipient on `launch_messages` (`pending | sent | failed | skipped`, `lastError`, `externalUrl`, `sentAt`). Shown only inside `/launches` (inline detail, local state — no deep link).
- **Ad launches** (Sprint 20): approval machine ends at `launched`; runtime `platformStatus` (Meta effective_status) + `lastError` on failed launch attempts. Shown only on `/ad-launches`.
- **External actions** (orchestration contracts, `dispatching | succeeded | failed`): contracts only — **no table or routes exist yet**. They join this projection when the authorization-queue slice builds their API foundation.

Nothing computes a cross-family rollup ("this launch partially failed: 3 sent, 1 failed"), and no surface shows a campaign's execution outcomes together. `WORKFLOW_STATUS_META` already defines `publishing/sending/launching` (progress), `completed` (ready), and `partially_failed/failed` (blocked) — the exact states the registry requires; nothing needs inventing.

## Scope decisions

1. **Server-side unified projection (new route, additive).** `GET /workspaces/:id/executions?campaign=&limit=` returns `ExecutionResult[]`, newest first. Computing launch rollups requires grouping `launch_messages`; doing it in a service keeps the logic in one tested place (same reasoning as the calendar projection). No schema/table changes — this is a read-only projection over existing rows.
2. **Contracts own the vocabulary.** `EXECUTION_RESULT_KINDS = ["publication", "launch", "ad_launch"]`, `EXECUTION_RESULT_STATUSES = ["running", "completed", "partially_failed", "failed"]`, and `executionResultSchema` live in `packages/contracts` (the registry's required states, verbatim).
3. **Inclusion rule: results, not intentions.** Scheduled publications, draft/ready launches, and unlaunched ad launches are *upcoming work* (Calendar/Review territory), not results. Included are: publications with status `published|failed`; launches with ≥1 dispatched message (`sent+failed+skipped > 0`); ad launches with status `launched` or a non-null `lastError`.
4. **Rollup rules** (per-destination truth, design §7.2 "Partially failed lists successful and failed destinations separately"):
   - Publication (single destination): `published → completed`, `failed → failed`; `destinations` = 1/1 accordingly.
   - Launch (counts over its messages): dispatched-but-incomplete (`pending > 0`) → `running`; else `failed > 0 && sent > 0 → partially_failed`; `failed > 0 && sent === 0 → failed`; else `completed`. `destinations = { total, succeeded: sent, failed, skipped, pending }`.
   - Ad launch: `launched → completed` (with `platformStatus` carried for display), else (has `lastError`) → `failed`.
5. **Canonical status mapping happens in the web view model.** `running` maps per kind to the canonical progress state — `publication → publishing`, `launch → sending`, `ad_launch → launching`; terminal states map 1:1 (`completed`, `partially_failed`, `failed`). Badges via the shared `WorkflowStatusBadge`.
6. **First consumer: campaign workspace Results tab.** `CAMPAIGN_TABS` gains `results` (design §5.3 tab set). The tab lists campaign-scoped execution results with status badge, destination summary ("3 sent · 1 failed · 2 skipped"), failure detail, external link, inline **Retry** for failed publications (existing route), and links into the owning surface (`/content`, `/launches?launch=<id>`, `/ad-launches`) for deeper recovery. Design §5.3's fuller Results ambitions (outcome comparisons, learning suggestions) belong to the Insights journey wave, not this slice.
7. **Deep link into a launch.** The `/launches` page opens detail from local state only; the Results tab needs to land a user on a specific launch. Add `?launch=<id>` support to the launches page (open detail on mount). Smallest change that makes recovery navigable; ad launches page is a single flat list and needs no equivalent.
8. **Deferred, with reasons.**
   - External-action results: no table/routes yet — joins the projection with the authorization-queue slice.
   - Live in-flight states for publications and ad launches: neither model persists an in-flight row (publish attempts are synchronous); only launches can genuinely be `running`.
   - Calendar `executing/partial` chips: calendar projects publications, which have no such persisted states — unchanged this slice (registry note stays accurate).
   - Home "execution failures" priority and editor Execution region: later consumers of this same contract.

## Global constraints

- TDD; one commit per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- `npm test`, `npm run typecheck`, `npm run build -w apps/web` green before push (check exit codes unpiped).
- Enum vocabularies only in `packages/contracts`; badges via `WorkflowStatusBadge`; no changes to login/auth/onboarding/dev-bootstrap/env loading.
- Push branch; **never merge to main** (founder reviews).
- Mind `noUncheckedIndexedAccess` in apps/web (production build enforces it).

## Tasks

- [x] 1. Plan doc (this file).
- [x] 2. Contracts: `EXECUTION_RESULT_KINDS`, `EXECUTION_RESULT_STATUSES`, `executionResultSchema` (+ types). Fields: `kind`, `id`, `title`, `channel` (nullable), `campaignId`/`campaignName` (nullable), `status`, `at`, `url` (nullable), `error` (nullable), `platformStatus` (nullable, ads only), `destinations {total, succeeded, failed, skipped, pending}`, `draftId` (nullable).
- [x] 3. API: `apps/api/src/services/executions.ts` (`listExecutionResults(db, workspaceId, { campaignId?, limit? })`) + `routes/executions.ts` (`GET /workspaces/:id/executions`) registered in `app.ts`. Tests first in `apps/api/test/executions.test.ts`: one fixture per family incl. a partially-failed launch, campaign filter, inclusion rules, ordering, schema conformance.
- [x] 4. Web view model: `apps/web/lib/execution-results.ts` (`executionWorkflowStatus`, `destinationSummary`, `executionTargetHref`, `EXECUTION_KIND_LABELS`) + unit tests; extend `CAMPAIGN_TABS` with `results`.
- [x] 5. Web UI: `campaign-results.tsx` component on the campaign workspace Results tab (badge, summary, error, links, retry for failed publications, empty state); `?launch=` deep link on `/launches`.
- [x] 6. Shell contract test `apps/web/lib/execution-results-shell-contract.test.ts` pinning the tab to the shared view model, canonical badge, and recovery routes.
- [x] 7. Verify (full suite, typecheck, web build), acceptance doc `docs/ui-ux/execution-results-acceptance.md`, capability registry update, push.

## Progress log

- 2026-07-13: Surveyed the three result families, external-action contract gap, campaign tab set, and canonical status coverage. Plan committed (df425e5).
- 2026-07-13: Task 2 — contracts vocabulary + `executionResultSchema`, 4 tests (9a631c8).
- 2026-07-13: Task 3 — executions service + route + app wiring, 5 API tests (b7d37da). Note: fresh worktree needed `npm install`; without it `@tuezday/contracts` resolved up the tree to the main checkout's stale copy and the new schema import was undefined.
- 2026-07-13: Task 4 — web view model + 5 tests; `CAMPAIGN_TABS` gains `results` (b882d85).
- 2026-07-13: Task 5 — CampaignResults tab component, CSS, page wiring, `?launch=` deep link on /launches (78380fc).
- 2026-07-13: Task 6 — shell contract test, 5 assertions (dfe90f0).
- 2026-07-13: Task 7 — full verification green (typecheck 0; web build 0; suite 116 files / 1,242 tests). Acceptance doc + capability registry row updated; branch pushed.
