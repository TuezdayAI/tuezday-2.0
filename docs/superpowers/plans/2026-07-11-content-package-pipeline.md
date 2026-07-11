# Content Package Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert campaign opportunities into source-grounded content packages and coordinated lane deliverables without drafting unsupported content.

**Architecture:** Discovery continues matching campaign opportunities. A package planner chooses a campaign-specific angle, attaches typed immutable sources, runs structured sufficiency, and fans a ready package into eligible planned or reactive lane deliverables.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM, existing LLM/evidence gateways, Next.js, Vitest.

## Global Constraints

- Raw signals match campaigns/opportunities, not final lanes.
- One signal may create multiple packages.
- Insufficient packages never reach generation.
- Source roles are explicit enums.
- Reactive fan-out respects lane eligibility and period caps.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: packages, sources, sufficiency, opportunities, and format registry DTOs.
- Modify `apps/api/src/db/schema.ts`: `campaign_opportunities`, `content_packages`, `package_sources` and deliverable package link.
- Create generated migration.
- Create `apps/api/src/services/campaign-opportunities.ts`.
- Create `apps/api/src/services/content-packages.ts`.
- Create `apps/api/src/services/content-sufficiency.ts`.
- Create `apps/api/src/services/format-registry.ts`.
- Create `apps/api/src/services/package-planner.ts`.
- Modify `apps/api/src/services/matching.ts` and `automation.ts` to stop direct drafting when control plane is enabled.
- Create `apps/api/src/routes/content-packages.ts`.
- Modify `apps/api/src/app.ts` and `apps/worker/src/index.ts`.
- Create `apps/api/test/content-packages.test.ts` and `content-sufficiency.test.ts`.
- Modify `apps/api/test/automation.test.ts` and `discovery.test.ts`.
- Create `apps/web/app/workspaces/[id]/packages/page.tsx` or integrate package view into campaign detail.

### Task 1: Package Contracts And Persistence

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/orchestration.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: generated migration
- Test: `apps/api/test/content-packages.test.ts`

**Interfaces:**
- Produces `CampaignOpportunity`, `ContentPackage`, `PackageSource`, `SufficiencyAssessment`.
- Produces source roles `trigger | evidence | inspiration | instruction | repurposed_from`.

- [ ] **Step 1: Write failing tests**

Assert a signal can back two packages, a package accepts several source roles, source snapshots remain after the source record changes, and every package belongs to one campaign/plan revision.

- [ ] **Step 2: Run tests**

Run: `npm test -- content-packages.test.ts orchestration.test.ts`

Expected: FAIL with missing contracts/tables.

- [ ] **Step 3: Add schemas, tables, and indexes**

Use unique opportunity key `(signalId, campaignId, proposedAngleHash)` and unique package-source edge `(packageId, role, sourceType, sourceRef)`.

- [ ] **Step 4: Generate migration and run tests**

Run: `npm run db:generate -w apps/api && npm test -- content-packages.test.ts orchestration.test.ts`

Expected: persistence tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/content-packages.test.ts
git commit -m "feat: add content packages and typed provenance"
```

### Task 2: Campaign Opportunity Matching

**Files:**
- Create: `apps/api/src/services/campaign-opportunities.ts`
- Modify: `apps/api/src/services/matching.ts`
- Modify: `apps/api/test/discovery.test.ts`
- Modify: `apps/api/test/automation.test.ts`

**Interfaces:**
- Produces: `createOpportunitiesForSignal(db, llm, workspaceId, signalId): Promise<CampaignOpportunity[]>`.
- Consumes existing `signal_matches` as candidate input during migration.

- [ ] **Step 1: Add failing tests**

Test two campaign opportunities from one signal, distinct angles for the same campaign, persona as a suggestion rather than a lane decision, inactive campaign exclusion, and idempotent rerun.

- [ ] **Step 2: Run tests**

Run: `npm test -- discovery.test.ts automation.test.ts -t "opportunity"`

Expected: FAIL.

- [ ] **Step 3: Implement opportunity creation**

Reuse the Brain digest and matching context, but request `{campaignId, suggestedPersonaId, angle, score, reason, supportedClaims[]}`. Validate IDs defensively and persist immutable opportunity snapshots.

- [ ] **Step 4: Change control-plane automation behavior**

When a campaign has an active plan revision, `runAutomation` creates opportunities and enqueues package planning; it must not call `generateSignalDraft` directly. Legacy campaigns keep current behavior until cutover.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- discovery.test.ts automation.test.ts content-packages.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/campaign-opportunities.ts apps/api/src/services/matching.ts apps/api/src/services/automation.ts apps/api/test
git commit -m "feat: route signals into campaign opportunities"
```

### Task 3: Format Registry

**Files:**
- Create: `apps/api/src/services/format-registry.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/test/format-registry.test.ts`

**Interfaces:**
- Produces: `FORMAT_REGISTRY: Record<OrganicFormat, FormatDefinition>`.
- Produces: `getFormatDefinition(format)` and `validateFormatCompatibility(channel, format)`.

- [ ] **Step 1: Write failing registry tests**

Cover LinkedIn post/carousel, Instagram post/carousel, X post, media requirements, task type mapping, text limits, renderer requirements, and unsupported combinations.

- [ ] **Step 2: Run tests**

Run: `npm test -- format-registry.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement registry and add `x_post` task type**

Every definition includes channel, taskType, text validator, media policy, generation mode, publication adapter key, and supported metric set. Update resolver defaults/matrix tests for `x_post`.

- [ ] **Step 4: Run affected tests and commit**

Run: `npm test -- format-registry.test.ts selective-context.test.ts contracts.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/format-registry.ts packages/contracts apps/api/test/format-registry.test.ts
git commit -m "feat: register organic content formats"
```

### Task 4: Structured Sufficiency Assessment

**Files:**
- Create: `apps/api/src/services/content-sufficiency.ts`
- Create: `apps/api/test/content-sufficiency.test.ts`

**Interfaces:**
- Produces: `assessPackageSufficiency(db, llm, evidence, workspaceId, packageId, laneRevisionIds): Promise<SufficiencyAssessment>`.

- [ ] **Step 1: Write failing tests with a fake LLM**

Cover sufficient multi-format source, thin source, missing carousel media/evidence, unsupported claim, malformed LLM JSON, no sources, and one lane eligible while another is not.

- [ ] **Step 2: Run tests**

Run: `npm test -- content-sufficiency.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement deterministic prechecks plus structured LLM judgment**

Prechecks enforce nonempty sources, role semantics, format constraints, and duplicate risk. The LLM returns supported claims, gaps, lane decisions, confidence, and research queries. Parse defensively; malformed output yields `research_needed`, never `ready`.

- [ ] **Step 4: Persist assessment and package status**

Status becomes `ready` only when at least one lane is eligible and every selected claim cites an evidence/trigger source snapshot.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- content-sufficiency.test.ts content-packages.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/content-sufficiency.ts apps/api/test/content-sufficiency.test.ts apps/api/src/services/content-packages.ts
git commit -m "feat: block unsupported content packages"
```

### Task 5: Package Planner And Reactive Capacity

**Files:**
- Create: `apps/api/src/services/package-planner.ts`
- Modify: `apps/api/src/services/deliverables.ts`
- Modify: `apps/api/test/content-packages.test.ts`

**Interfaces:**
- Produces: `planPackageDeliverables(db, workspaceId, packageId, laneRevisionIds?): PackagePlanResult`.

- [ ] **Step 1: Write failing fan-out tests**

Assert planned empty slots are filled before reactive deliverables are created; reactive-only lanes create new deliverables; period caps are enforced; insufficient lanes are skipped with reasons; and reruns do not duplicate work.

- [ ] **Step 2: Run tests**

Run: `npm test -- content-packages.test.ts -t "fan-out"`

Expected: FAIL.

- [ ] **Step 3: Implement planner transaction**

Pair packages with the oldest compatible unfilled planned deliverables. Then create reactive deliverables only for eligible lanes under cap. Store package ID and sufficiency lane decision on each deliverable.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- content-packages.test.ts deliverables.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services/package-planner.ts apps/api/src/services/deliverables.ts apps/api/test
git commit -m "feat: fan packages into bounded campaign lanes"
```

### Task 6: Package API, Worker, And UI

**Files:**
- Create: `apps/api/src/routes/content-packages.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/web/app/workspaces/[id]/campaigns/page.tsx`
- Create: `apps/web/app/workspaces/[id]/packages/[packageId]/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/api/test/content-packages.test.ts`

- [ ] **Step 1: Add failing API tests**

Cover opportunity listing, package creation, attach source, assess, plan, skip, research-needed response, workspace isolation, and repurpose-from-draft.

- [ ] **Step 2: Implement routes and package task tick**

The worker processes queued opportunity/package assessments through the durable ledger introduced later only after that plan lands; until then these endpoints support explicit run-now calls and the existing worker calls them idempotently.

- [ ] **Step 3: Implement campaign package board and package workspace**

Show angle, source roles, sufficiency, gaps, lane eligibility, planned deliverables, and a repurpose command. Keep technical resolver details behind inspection controls.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`

Expected: both exit 0.

- [ ] **Step 5: Manual acceptance and commit**

Accept one signal into two campaigns, create two angles, verify one thin package becomes research-needed and one sufficient package fills LinkedIn/Instagram lanes without drafting yet.

```bash
git add apps/api/src/routes/content-packages.ts apps/api/src/app.ts apps/worker/src/index.ts apps/web apps/api/test/content-packages.test.ts
git commit -m "feat: expose campaign content package pipeline"
```
