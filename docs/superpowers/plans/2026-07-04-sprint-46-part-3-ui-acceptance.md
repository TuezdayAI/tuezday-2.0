# Sprint 46 Part 3 - UI, Acceptance, And Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose connected discovery sources and tracked competitors in the product UI, add founder acceptance coverage, and finish Sprint 46 with full verification.

**Architecture:** This part builds on Parts 1 and 2. It adds no new backend capabilities unless UI work uncovers a missing read shape; the web page consumes the source, tracked-account, run, and triage APIs already created. The acceptance docs explain provider permission limitations clearly so missing LinkedIn/Instagram approval is not mistaken for a broken sprint.

**Tech Stack:** Next.js App Router, TypeScript, existing web API helper, CSS in `apps/web/app/globals.css`, Vitest/typecheck/build verification.

---

## Branch And Context

- Branch: `sprint-46c-connected-discovery-ui`
- Base: Part 2 branch after it passes verification.
- Read first:
  - `docs/specs/sprint-46-connected-account-competitor-sourcing.md`
  - Part 1 and Part 2 plan files
  - `apps/web/app/workspaces/[id]/discovery/page.tsx`
  - `apps/web/lib/api.ts`
  - `apps/web/app/globals.css`

## File Map

- Modify: `apps/web/lib/api.ts`
  - add client helpers/types for tracked accounts and source run status if needed.
- Modify: `apps/web/app/workspaces/[id]/discovery/page.tsx`
  - connected source form;
  - tracked accounts management;
  - source/job status badges;
  - source badges on triage cards.
- Modify: `apps/web/app/globals.css`
  - compact styling for connected discovery controls/status.
- Modify: `docs/founder-acceptance-tests.md`
  - add Sprint 46 acceptance section.
- Modify: `.env.example`
  - provider scope/app-review notes.
- Modify: `docs/specs/sprint-46-connected-account-competitor-sourcing.md`
  - progress log and any implementation notes.

---

## Tasks

### Task 1: Web API Helpers

- [ ] Inspect existing `apps/web/lib/api.ts` patterns before adding helpers.
- [ ] Add typed functions only if the page is not already doing generic `fetch` calls:
  - `listTrackedSocialAccounts(workspaceId)`;
  - `createTrackedSocialAccount(workspaceId, input)`;
  - `updateTrackedSocialAccount(workspaceId, accountId, input)`;
  - `deleteTrackedSocialAccount(workspaceId, accountId)`;
  - source create/update functions including `connectionId`.
- [ ] Run `npm run typecheck -w @tuezday/web`.
- [ ] Commit: `feat(web): API helpers for connected discovery`.

### Task 2: Tracked Accounts Card

- [ ] On the Discovery page, add a compact "Tracked accounts" section.
- [ ] Let users add platform + handle + optional display name/notes.
- [ ] Show normalized handle, platform, enabled state, and last error.
- [ ] Allow disable/delete.
- [ ] Keep empty state concise: tracked accounts are optional shortcuts for competitor/source handles.
- [ ] Avoid nested cards; use the page's existing section/list style.
- [ ] Run `npm run typecheck -w @tuezday/web`.
- [ ] Commit: `feat(web): tracked competitor accounts on discovery page`.

### Task 3: Connected Source Form

- [ ] Extend the source form:
  - include `instagram`;
  - show connection dropdown for connected source types;
  - filter connections by provider (`twitter`, `linkedin`, `instagram`, `reddit`);
  - show mode fields for query/account/list/subreddit/hashtag;
  - allow selecting a tracked account for account modes.
- [ ] Keep existing keyless RSS/Google News/Reddit source creation intact.
- [ ] Disable submit with a clear inline message when a connected mode has no matching connected account.
- [ ] Run `npm run typecheck -w @tuezday/web`.
- [ ] Commit: `feat(web): connected discovery source form`.

### Task 4: Source And Job Status Display

- [ ] In the source list, add badges:
  - keyless;
  - connected;
  - permission required;
  - backoff;
  - error.
- [ ] Show connection display name where available.
- [ ] Show `lastAttemptedAt`, `lastFetchedAt`, and `lastError` when present.
- [ ] After "Run discovery now", show `queued`, `processed`, per-source `fetched/new/error`, and `scored`.
- [ ] Run `npm run typecheck -w @tuezday/web`.
- [ ] Commit: `feat(web): discovery job and source status`.

### Task 5: Triage Source Badges

- [ ] On triage item cards, add platform/source badges using source type/name.
- [ ] Preserve Sprint 45 candidate chips and duplicate expansion.
- [ ] If the item came from a connected source, show a connected/account indicator without crowding the title.
- [ ] Verify long source names do not overflow on mobile.
- [ ] Run `npm run typecheck -w @tuezday/web`.
- [ ] Commit: `feat(web): connected source badges in triage`.

### Task 6: Acceptance Docs And Env Notes

- [ ] Add `## Sprint 46 - Connected-account & competitor sourcing` to `docs/founder-acceptance-tests.md`.
- [ ] Include these manual checks:
  - X query source produces triage items;
  - tracked competitor X handle source dedupes with query source;
  - authenticated Reddit source works;
  - LinkedIn/Instagram missing approval shows permission error while other sources continue;
  - accepted connected item routes through Sprint 45 automation;
  - job batch limit leaves excess work queued for the next run.
- [ ] Update `.env.example` with notes:
  - Reddit needs `read`;
  - X list sources need `list.read`;
  - LinkedIn read scopes/app approval may require reconnect;
  - Instagram discovery needs professional account/app review.
- [ ] Update Sprint 46 spec progress log with Part 3 notes.
- [ ] Commit: `docs: add Sprint 46 acceptance and provider notes`.

### Task 7: Full Verification

- [ ] Run `npm test -- connected-discovery discovery discovery-jobs`.
- [ ] Run `npm test -- contracts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build -w @tuezday/web`.
- [ ] Fix failures within this slice only.
- [ ] Commit final fixes if needed.
- [ ] Push branch for founder review.

## Completion Gate

Part 3 is complete when:

- the Discovery page can manage tracked accounts and connected sources;
- source/job states are visible enough for founder acceptance;
- docs include a Sprint 46 acceptance script;
- provider permission constraints are documented;
- the targeted tests, full typecheck, and web build pass.
