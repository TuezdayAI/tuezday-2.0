# Organic Planning And Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn active lane schedules into concrete 14-day campaign deliverables and a calendar that shows planned work before content exists.

**Architecture:** Deliverables are materialized idempotently from lane revisions. The calendar becomes a projection over deliverables and external receipts while legacy cadence execution continues unchanged in this milestone.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM, Next.js, Vitest.

## Global Constraints

- Lane revision plus slot time is the idempotency boundary.
- Calendar is a read projection, never a second scheduling authority.
- Rescheduling creates an override; it does not mutate recurrence silently.
- Use the existing timezone/DST slot math from `services/cadences.ts` before extracting it.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: deliverable and calendar DTOs.
- Create `apps/api/src/services/schedule-slots.ts`: extracted timezone slot math.
- Create `apps/api/src/services/deliverables.ts`: materialization, overrides, transitions.
- Modify `apps/api/src/services/calendar.ts`: deliverable-first projection.
- Create `apps/api/src/routes/deliverables.ts`: list/reschedule/cancel/materialize routes.
- Modify `apps/api/src/app.ts`: route registration.
- Modify `apps/worker/src/index.ts`: materialization tick.
- Modify `apps/web/app/workspaces/[id]/calendar/page.tsx`: campaign calendar statuses and filters.
- Create `apps/api/test/deliverables.test.ts`.
- Modify `apps/api/test/cadences.test.ts` and add/modify calendar route tests.

### Task 1: Deliverable Contracts And Schema

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/orchestration.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: generated migration under `apps/api/drizzle/`
- Test: `apps/api/test/deliverables.test.ts`

**Interfaces:**
- Produces table `deliverables` with campaign/plan/lane references, planned time, schedule override, origin, status, dependency fingerprint, stale reasons, blocking reason, and selected variant ID nullable.
- Produces `deliverableSchema`, `rescheduleDeliverableInputSchema`, and `DeliverableProductionStatus` transitions.

- [ ] **Step 1: Write failing schema and persistence tests**

```ts
it("uniquely materializes one deliverable per lane revision and slot", () => {
  materializeLaneDeliverables(db, workspaceId, laneRevision, from, to);
  materializeLaneDeliverables(db, workspaceId, laneRevision, from, to);
  expect(listDeliverables(db, workspaceId)).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- deliverables.test.ts orchestration.test.ts`

Expected: FAIL with missing schema/service.

- [ ] **Step 3: Add contracts, table, and unique index**

Use `uniqueIndex("deliverable_lane_slot").on(t.laneRevisionId, t.originalScheduledFor)` and keep `scheduledFor` separately editable.

- [ ] **Step 4: Generate migration and rerun tests**

Run: `npm run db:generate -w apps/api && npm test -- deliverables.test.ts orchestration.test.ts`

Expected: persistence test still fails only because materialization is not implemented; contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/deliverables.test.ts
git commit -m "feat: add planned deliverable model"
```

### Task 2: Extract Slot Math And Materialize Deliverables

**Files:**
- Create: `apps/api/src/services/schedule-slots.ts`
- Modify: `apps/api/src/services/cadences.ts`
- Create: `apps/api/src/services/deliverables.ts`
- Modify: `apps/api/test/cadences.test.ts`
- Modify: `apps/api/test/deliverables.test.ts`

**Interfaces:**
- Produces: `slotsBetween(schedule, fromMs, toMs): number[]`.
- Produces: `materializeCampaignDeliverables(db, workspaceId, campaignId, nowMs, horizonDays = 14): MaterializationResult`.

- [ ] **Step 1: Move existing slot tests to the shared service without changing assertions**

Run: `npm test -- cadences.test.ts`

Expected before implementation: FAIL due to missing import.

- [ ] **Step 2: Extract slot functions byte-for-byte and update cadence imports**

Run: `npm test -- cadences.test.ts`

Expected: PASS, proving no timezone behavior changed.

- [ ] **Step 3: Add failing materialization tests**

Cover DST, paused lanes, future plan start, plan end clipping, rerun idempotency, two lanes at the same time, and `planned_and_reactive` still creating planned slots.

- [ ] **Step 4: Implement materialization in a transaction**

Insert only missing `(laneRevisionId, originalScheduledFor)` rows. Store a dependency fingerprint from plan revision ID, lane revision ID, persona updatedAt, account updatedAt, and scoped guidance updatedAt.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- deliverables.test.ts cadences.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/schedule-slots.ts apps/api/src/services/cadences.ts apps/api/src/services/deliverables.ts apps/api/test
git commit -m "feat: materialize lane-backed campaign deliverables"
```

### Task 3: Deliverable API And Rescheduling

**Files:**
- Create: `apps/api/src/routes/deliverables.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/deliverables.test.ts`

**Interfaces:**
- `GET /workspaces/:id/deliverables?from=&to=&campaignId=&personaId=&channel=&status=`.
- `POST /workspaces/:id/campaigns/:campaignId/deliverables/materialize`.
- `PATCH /workspaces/:id/deliverables/:deliverableId/schedule`.
- `POST /workspaces/:id/deliverables/:deliverableId/cancel`.

- [ ] **Step 1: Write failing route tests**

Assert workspace isolation, filter combinations, reschedule audit fields, cancellation transition, invalid timezone-independent timestamps, and idempotent materialize response.

- [ ] **Step 2: Run tests**

Run: `npm test -- deliverables.test.ts -t "routes"`

Expected: FAIL with 404.

- [ ] **Step 3: Implement routes using deliverable services**

Return `409 deliverable_transition_invalid` for illegal state changes and include the current status.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- deliverables.test.ts`

Expected: PASS.

```bash
git add apps/api/src/routes/deliverables.ts apps/api/src/app.ts apps/api/test/deliverables.test.ts
git commit -m "feat: expose planned deliverables API"
```

### Task 4: Calendar Projection And Worker Tick

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/calendar.ts`
- Modify: `apps/api/src/routes/cadences.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/api/test/deliverables.test.ts`

**Interfaces:**
- Produces calendar entries with `kind: deliverable | action`, campaign/persona/lane/format/status, and legacy receipt fields when present.

- [ ] **Step 1: Write failing calendar projection tests**

Create one empty deliverable, one legacy scheduled publication, and one fulfilled deliverable linked to that publication. Assert no duplicate calendar cells and that the empty deliverable remains visible.

- [ ] **Step 2: Run test**

Run: `npm test -- deliverables.test.ts -t "calendar"`

Expected: FAIL against the cadence-only projection.

- [ ] **Step 3: Implement deliverable-first projection**

Keep unmatched legacy publications as `action` entries during migration. Do not compute new open cadence slots when a campaign has an active plan revision.

- [ ] **Step 4: Add worker materialization tick**

Add `MATERIALIZE_INTERVAL_MIN`, default 60, calling the materialize endpoint for each workspace. The endpoint materializes every active campaign and stays quiet when zero rows are created.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run typecheck && npm test -- deliverables.test.ts cadences.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/services/calendar.ts apps/api/src/routes/cadences.ts apps/worker/src/index.ts apps/api/test/deliverables.test.ts
git commit -m "feat: project campaign commitments on calendar"
```

### Task 5: Calendar UI

**Files:**
- Modify: `apps/web/app/workspaces/[id]/calendar/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/api/test/deliverables.test.ts` for the calendar DTO; this repository has no React component-test harness, so browser behavior is covered by the explicit manual acceptance step.

**Interfaces:**
- Consumes the new calendar DTO.

- [ ] **Step 1: Extend the failing calendar DTO tests**

Assert the API returns planned empty slots, production state, campaign/persona filter fields, reschedule metadata, and legacy receipt fallback required by the page.

- [ ] **Step 2: Implement the calendar view**

Use a compact week/list switch, stable slot dimensions, channel icons, status badges, and accessible reschedule dialog. Do not nest cards or add explanatory feature copy.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`

Expected: both exit 0.

- [ ] **Step 4: Manual acceptance**

Create a twice-weekly lane in `Asia/Kolkata`; activate it; materialize; verify four planned cells over 14 days; drag one; refresh; verify the override persists and the recurrence remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/calendar/page.tsx apps/web/app/globals.css apps/api/test/deliverables.test.ts
git commit -m "feat: show campaign plan on calendar"
```
