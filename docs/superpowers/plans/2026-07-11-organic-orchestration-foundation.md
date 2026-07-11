# Organic Orchestration Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the canonical campaign-plan-lane control-plane foundation and backfill current campaigns without changing production execution.

**Architecture:** Stable campaign and lane identities point to immutable revision rows. New services own revision activation and shadow read models; current campaign, cadence, draft, and publication flows remain live until later plans cut them over.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM, SQLite, Vitest.

## Global Constraints

- This milestone is additive and behavior-preserving.
- Existing campaign IDs remain stable.
- Do not guess persona/account assignments during backfill.
- `posting_cadences` remains operational but is not extended with new planning behavior.
- All writes remain workspace-scoped and Postgres-portable.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: orchestration enums, schemas, state transitions, and DTOs.
- Modify `packages/contracts/test/contracts.test.ts`: canonical contract coverage.
- Create `packages/contracts/test/orchestration.test.ts`: state-machine and policy vocabulary tests.
- Modify `apps/api/src/db/schema.ts`: foundation tables and campaign identity fields.
- Create generated migration under `apps/api/drizzle/`.
- Create `apps/api/src/services/campaign-plans.ts`: revision creation/activation and plan reads.
- Create `apps/api/src/services/campaign-lanes.ts`: stable lane and lane-revision lifecycle.
- Create `apps/api/src/services/orchestration-backfill.ts`: deterministic legacy backfill.
- Modify `apps/api/src/services/campaigns.ts`: expose current plan summary without changing legacy writes.
- Create `apps/api/src/routes/campaign-plans.ts`: plan/lane management routes.
- Modify `apps/api/src/app.ts`: register routes.
- Create `apps/api/test/orchestration-foundation.test.ts`: service/API integration.
- Create `apps/api/test/orchestration-backfill.test.ts`: legacy migration behavior.

### Task 1: Canonical Contracts And State Machines

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/orchestration.test.ts`

**Interfaces:**
- Produces: `CampaignOrigin`, `CampaignPurpose`, `CampaignLifecycleStatus`, `PlanRevisionStatus`, `LaneStatus`, `DeliveryMode`, `PackageSourceRole`, `DeliverableProductionStatus`, `ExternalActionKind`, `ExternalActionStatus`, and their Zod schemas.
- Produces: `campaignPlanRevisionSchema`, `campaignLaneSchema`, `campaignLaneRevisionSchema` and create/update inputs.
- Produces: pure `canTransitionDeliverable` and `canTransitionExternalAction` helpers.

- [ ] **Step 1: Write failing contract tests**

```ts
it("keeps persona and audience ids separate on a lane revision", () => {
  const parsed = campaignLaneRevisionSchema.parse({
    id: UUIDS.laneRevision,
    laneId: UUIDS.lane,
    planRevisionId: UUIDS.plan,
    personaId: UUIDS.persona,
    audienceId: UUIDS.audience,
    channel: "linkedin",
    format: "linkedin_post",
    publishingConnectionId: UUIDS.connection,
    providerTarget: "feed",
    deliveryMode: "planned_and_reactive",
    plannedQuantity: 2,
    schedule: { daysOfWeek: [2, 4], timeOfDay: "10:00", timezone: "Asia/Kolkata" },
    reactivePeriod: "week",
    reactiveCap: 2,
    status: "active",
    createdAt: 1,
  });
  expect(parsed.personaId).not.toBe(parsed.audienceId);
});

it("does not allow a succeeded action to return to scheduled", () => {
  expect(canTransitionExternalAction("succeeded", "scheduled")).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- orchestration.test.ts`

Expected: FAIL because the orchestration contracts are not exported.

- [ ] **Step 3: Add the contracts and transition maps**

Define the exact vocabularies from the design and export schemas/types. Use explicit transition maps:

```ts
export const EXTERNAL_ACTION_TRANSITIONS: Record<ExternalActionStatus, ExternalActionStatus[]> = {
  proposed: ["authorization_required", "authorized", "blocked", "cancelled"],
  authorization_required: ["authorized", "cancelled"],
  authorized: ["scheduled", "dispatching", "blocked", "cancelled"],
  scheduled: ["dispatching", "blocked", "cancelled"],
  dispatching: ["succeeded", "failed"],
  succeeded: [],
  failed: ["scheduled", "dispatching", "cancelled"],
  blocked: ["proposed", "cancelled"],
  cancelled: [],
};
```

- [ ] **Step 4: Run contract tests**

Run: `npm test -- orchestration.test.ts contracts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/orchestration.test.ts packages/contracts/test/contracts.test.ts
git commit -m "feat: add orchestration domain contracts"
```

### Task 2: Foundation Schema And Migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated `apps/api/drizzle/<next>_*.sql`
- Test: `apps/api/test/orchestration-foundation.test.ts`

**Interfaces:**
- Produces tables: `campaign_plan_revisions`, `campaign_lanes`, `campaign_lane_revisions`.
- Modifies `campaigns`: `origin`, `purpose`, `lifecycle_status`, `current_plan_revision_id`.

- [ ] **Step 1: Write a failing persistence test**

Create a workspace/campaign, insert two plan revisions and two lane revisions sharing one stable lane,
then assert the first revision remains queryable after activating the second.

- [ ] **Step 2: Run the test**

Run: `npm test -- orchestration-foundation.test.ts -t "preserves lane identity across revisions"`

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add Drizzle tables and indexes**

Use text UUIDs, integer epoch timestamps, foreign keys with cascade from workspace/campaign, and unique indexes:

```ts
uniqueIndex("campaign_plan_revision_number").on(t.campaignId, t.revision),
uniqueIndex("campaign_lane_key").on(t.campaignId, t.key),
uniqueIndex("campaign_lane_plan_revision").on(t.laneId, t.planRevisionId),
```

Do not add a circular database FK from `campaigns.currentPlanRevisionId`; enforce it in the service to keep migration generation portable.

- [ ] **Step 4: Generate and inspect the migration**

Run: `npm run db:generate -w apps/api`

Expected: one new migration adding the three tables and four campaign columns.

- [ ] **Step 5: Run persistence and existing campaign tests**

Run: `npm test -- orchestration-foundation.test.ts campaigns.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/orchestration-foundation.test.ts
git commit -m "feat: persist campaign plans and lanes"
```

### Task 3: Plan And Lane Services

**Files:**
- Create: `apps/api/src/services/campaign-plans.ts`
- Create: `apps/api/src/services/campaign-lanes.ts`
- Test: `apps/api/test/orchestration-foundation.test.ts`

**Interfaces:**
- Produces: `createPlanRevision(db, workspaceId, campaignId, input, actor): CampaignPlanRevision`.
- Produces: `activatePlanRevision(db, workspaceId, campaignId, revisionId): CampaignPlanDetail`.
- Produces: `upsertLaneRevision(db, workspaceId, campaignId, planRevisionId, input): CampaignLaneRevision`.
- Produces: `getCurrentCampaignPlan(db, workspaceId, campaignId): CampaignPlanDetail | undefined`.

- [ ] **Step 1: Add failing service tests**

Cover monotonically increasing revision numbers, draft-only editing, atomic activation, foreign-workspace rejection, stable lane reuse by key, and immutable active revisions.

- [ ] **Step 2: Run tests**

Run: `npm test -- orchestration-foundation.test.ts -t "plan service"`

Expected: FAIL with missing service imports.

- [ ] **Step 3: Implement transaction-backed services**

Activation must validate every active lane has a persona, channel-compatible format, connected publishing assignment when supplied, valid schedule, and campaign-attached audience when supplied. Return typed validation issues rather than partial activation.

- [ ] **Step 4: Run tests**

Run: `npm test -- orchestration-foundation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/campaign-plans.ts apps/api/src/services/campaign-lanes.ts apps/api/test/orchestration-foundation.test.ts
git commit -m "feat: manage immutable campaign plan revisions"
```

### Task 4: Legacy Backfill And Shadow Projection

**Files:**
- Create: `apps/api/src/services/orchestration-backfill.ts`
- Modify: `apps/api/src/services/campaigns.ts`
- Create: `apps/api/test/orchestration-backfill.test.ts`

**Interfaces:**
- Produces: `backfillCampaignControlPlane(db, workspaceId, campaignId): BackfillResult`.
- Produces: `getCampaignControlPlaneSummary(db, workspaceId, campaignId): ControlPlaneSummary`.

- [ ] **Step 1: Write failing backfill tests**

Test an empty-channel campaign, a campaign with one unambiguous cadence, multiple personas without cadence mapping, and idempotent reruns. The ambiguous case must return `needs_configuration` and must not guess a persona/connection pair.

- [ ] **Step 2: Run tests**

Run: `npm test -- orchestration-backfill.test.ts`

Expected: FAIL because the backfill service is absent.

- [ ] **Step 3: Implement deterministic backfill**

Revision 1 copies objective/KPI/timeframe/audience/pillars/overlay. Create a lane only for a unique cadence tuple `(campaign, persona, channel, connection, target, schedule)`. Campaign JSON channels without an unambiguous execution mapping are emitted as configuration issues.

- [ ] **Step 4: Add a shadow summary to campaign detail**

Expose plan revision, lane count, and configuration issue count without changing existing `Campaign` fields or automation behavior.

- [ ] **Step 5: Run tests**

Run: `npm test -- orchestration-backfill.test.ts campaigns.test.ts cadences.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/orchestration-backfill.ts apps/api/src/services/campaigns.ts apps/api/test/orchestration-backfill.test.ts
git commit -m "feat: backfill campaign control plane safely"
```

### Task 5: Plan And Lane API

**Files:**
- Create: `apps/api/src/routes/campaign-plans.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/orchestration-foundation.test.ts`

**Interfaces:**
- Produces endpoints under `/workspaces/:id/campaigns/:campaignId/plan` and `/lanes`.

- [ ] **Step 1: Add failing API tests**

Cover get current plan, create draft revision, upsert lanes, activate revision, validation response, membership isolation, and current-plan summary.

- [ ] **Step 2: Run tests**

Run: `npm test -- orchestration-foundation.test.ts -t "routes"`

Expected: FAIL with 404 routes.

- [ ] **Step 3: Implement thin routes and register them**

Use contract schemas for bodies and return `409 plan_invalid` with `{ issues: [{ path, code, message }] }` when activation validation fails.

- [ ] **Step 4: Run milestone verification**

Run: `npm run typecheck && npm test`

Expected: both exit 0; existing automation/publishing behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/campaign-plans.ts apps/api/src/app.ts apps/api/test/orchestration-foundation.test.ts
git commit -m "feat: expose campaign plan management API"
```
