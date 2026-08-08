# Organic Outcomes And Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute organic outcomes to exact variants and complete the safe cutover from direct signal-to-draft/cadence automation to the orchestration control plane.

**Architecture:** Publication metrics normalize into outcome rows linked to external actions and variants. Shadow parity checks gate the removal of legacy planning writes and direct automation.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM, Next.js, Vitest.

## Global Constraints

- Never rewrite published history.
- Do not claim causal multi-touch attribution.
- Legacy execution is disabled only after parity and acceptance pass.
- Existing published rows without clear lineage remain labeled legacy.

---

## File Structure

- Modify contracts/schema for `action_outcomes`, invalidation events, and campaign fulfillment DTOs.
- Create `apps/api/src/services/action-outcomes.ts` and `dependency-invalidation.ts`.
- Modify `apps/api/src/services/insights.ts`, `learning.ts`, `inbox.ts`, `automation.ts`, `cadences.ts`, and `calendar.ts`.
- Create `apps/api/src/services/orchestration-parity.ts`.
- Create outcome/invalidation/parity tests.
- Modify campaign, insights, command center, calendar, and package web views.
- Update `docs/founder-acceptance-tests.md` with the organic script.

### Task 1: Exact Variant-Level Outcomes

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/services/action-outcomes.ts`
- Create: `apps/api/test/action-outcomes.test.ts`

- [ ] **Step 1: Write failing tests**

Cover delivery, impressions, engagements, clicks, replies, conversions, provider JSON, snapshot windows, idempotent metric upsert, and joins to variant/package/persona/audience/campaign/source.

- [ ] **Step 2: Implement contracts, table, and normalizer**

Use unique `(externalActionId, metricKey, window, observedAtBucket)` and preserve provider-specific values separately. Do not proportionally invent per-channel metrics.

- [ ] **Step 3: Run tests and commit**

Run: `npm run db:generate -w apps/api && npm test -- action-outcomes.test.ts insights.test.ts`

Expected: PASS.

```bash
git add packages/contracts apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/action-outcomes.ts apps/api/test/action-outcomes.test.ts
git commit -m "feat: attribute organic outcomes to exact variants"
```

### Task 2: Dependency Invalidation And Selective Regeneration

**Files:**
- Create: `apps/api/src/services/dependency-invalidation.ts`
- Modify: brain, guidance, persona, connection profile, campaign-plan, and package source services
- Create: `apps/api/test/dependency-invalidation.test.ts`

- [ ] **Step 1: Write failing tests**

Assert plan/lane/guidance/persona/account/source changes mark only dependent unpublished deliverables/variants stale; published variants remain unchanged; stale reasons list exact dependency keys; regeneration can target one variant, package, or campaign.

- [ ] **Step 2: Implement invalidation events and fingerprint comparison**

Each mutating service enqueues one invalidation task after its transaction. The handler compares formal snapshot dependencies and transitions affected work to stale.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- dependency-invalidation.test.ts brain.test.ts guidance.test.ts personas.test.ts connectors.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/dependency-invalidation.test.ts
git commit -m "feat: invalidate changed unpublished content"
```

### Task 3: Campaign Fulfillment And Learning

**Files:**
- Modify: `apps/api/src/services/insights.ts`
- Modify: `apps/api/src/services/learning.ts`
- Create: `apps/api/test/orchestration-insights.test.ts`
- Modify: `apps/api/test/learning.test.ts`

- [ ] **Step 1: Write failing rollup tests**

Cover plan vs actual by lane, package/variant comparison, outcome by persona/audience/source, authorization delay, action failure, and human decision plus behavioral signal in synthesis input.

- [ ] **Step 2: Implement exact rollups**

Read control-plane joins for new work and keep a clearly labeled legacy aggregate for old rows. Learning may propose Brain updates but must not silently update documents.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- orchestration-insights.test.ts learning.test.ts insights.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/insights.ts apps/api/src/services/learning.ts apps/api/test
git commit -m "feat: report campaign fulfillment and learning"
```

### Task 4: Shadow Parity And Legacy Cutover

**Files:**
- Create: `apps/api/src/services/orchestration-parity.ts`
- Modify: `apps/api/src/services/automation.ts`
- Modify: `apps/api/src/services/cadences.ts`
- Modify: campaign/cadence routes
- Create: `apps/api/test/orchestration-cutover.test.ts`

- [ ] **Step 1: Write failing parity tests**

Compare legacy cadence slots/publications with lane deliverables/actions for backfilled campaigns; cover mismatch reporting, no dual creation, control-plane campaign routing, and legacy-only campaign fallback.

- [ ] **Step 2: Implement parity report**

Return missing, extra, destination mismatch, schedule mismatch, and policy mismatch counts per campaign. Require zero critical mismatches before enabling `control_plane_execution` for that campaign.

- [ ] **Step 3: Add campaign-scoped execution switch and disable direct paths**

For enabled campaigns, `runAutomation` cannot draft directly and `fillCadence` cannot create publications. They delegate/no-op because tasks/actions own the flow. Keep read-only cadence history.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- orchestration-cutover.test.ts automation.test.ts cadences.test.ts publish.test.ts`

Expected: PASS with no duplicate publication tests.

```bash
git add apps/api/src/services apps/api/src/routes apps/api/test/orchestration-cutover.test.ts
git commit -m "feat: cut organic execution over to control plane"
```

### Task 5: Organic UX And Founder Acceptance

**Files:**
- Modify campaign, package, calendar, insights, approvals/action queue, and command center pages
- Modify `apps/web/app/globals.css`
- Modify `docs/founder-acceptance-tests.md`

- [ ] **Step 1: Implement campaign operating workspace**

Show current revision, lanes, fulfillment, package board, action attention, and results without exposing raw table terminology.

- [ ] **Step 2: Add trace navigation**

Outcome -> action -> variant -> deliverable -> package -> sources/Brain snapshot is navigable from campaign insights.

- [ ] **Step 3: Run automated verification**

Run: `npm run typecheck && npm test && npm run build`

Expected: all exit 0.

- [ ] **Step 4: Execute founder acceptance**

Use two campaigns, two personas, two social accounts, planned and reactive lanes, one signal creating two packages, one insufficiency block, one persona human gate overriding an autonomous campaign, one autonomous publication, a worker restart, one guidance change producing staleness, and one metric trace back to sources.

- [ ] **Step 5: Commit**

```bash
git add apps/web docs/founder-acceptance-tests.md
git commit -m "feat: complete organic orchestration experience"
```
