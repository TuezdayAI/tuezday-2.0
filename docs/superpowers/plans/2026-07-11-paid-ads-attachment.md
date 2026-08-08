# Paid Ads Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach paid ads to the accepted control plane using shared packages, variants, authorization, dispatch, and outcomes.

**Architecture:** Ad lane revisions add paid configuration. Existing creative generation/rendering and `ad_launches` remain operational adapters. Paid launch, budget change, and targeting change become shared external-action kinds with mandatory spend guardrails.

**Tech Stack:** Existing TypeScript/Fastify/Drizzle/Meta connector/design pipeline, Zod, Next.js, Vitest.

## Global Constraints

- Begin only after organic founder acceptance.
- No autonomous action bypasses spend guardrails or kill switches.
- Reuse package sources, context snapshots, variants, and outcomes.
- Do not build bid optimization or a replacement ads manager.
- Existing resumable Meta launch IDs remain authoritative operational receipts.

---

## File Structure

- Extend orchestration contracts and lane revision schema with typed paid configuration.
- Create `apps/api/src/services/ad-action-adapter.ts`.
- Modify `ad-creatives.ts`, `ad-images.ts`, `ad-launches.ts`, `ads.ts`, and related routes.
- Add external action link columns to `ad_launches` and imported `ad_campaigns` where needed.
- Create paid attachment and migration tests.
- Modify campaign lanes, package workspace, action queue, ad launch, and insights UI.

### Task 1: Paid Lane And Format Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/format-registry.ts`
- Modify: `packages/contracts/test/orchestration.test.ts`
- Modify: `apps/api/test/format-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Cover Meta static image, Meta carousel, Google RSA metadata, ad account, objective, placement, audience/targeting snapshot, budget envelope, flight dates, landing URL, and required creative fields.

- [ ] **Step 2: Implement discriminated `laneConfig` contracts**

Use `kind: organic | paid | outbound`; paid configuration is parsed only when `kind === "paid"`. Add format definitions that map to existing `meta_ad_creative` and `google_rsa` tasks.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- orchestration.test.ts format-registry.test.ts ad-creatives.test.ts`

Expected: PASS.

```bash
git add packages/contracts apps/api/src/services/format-registry.ts apps/api/test/format-registry.test.ts
git commit -m "feat: define paid campaign lanes"
```

### Task 2: Paid Variant Generation

**Files:**
- Modify: `apps/api/src/services/deliverable-generation.ts`
- Modify: `apps/api/src/services/ad-creatives.ts`
- Modify: `apps/api/src/services/ad-images.ts`
- Create: `apps/api/test/paid-deliverable-generation.test.ts`

- [ ] **Step 1: Write failing tests**

Assert package brief/source reuse, paid-specific resolver context, variant count, rendered image media, format validation, landing URL evidence, and partial creative failure isolation.

- [ ] **Step 2: Implement paid generator adapter**

Call existing ad creative and image services, then create standard content variants/context snapshots. Do not create `ad_launches` during generation.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- paid-deliverable-generation.test.ts ad-creatives.test.ts ad-image.test.ts design-pipeline.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/paid-deliverable-generation.test.ts
git commit -m "feat: generate paid variants from content packages"
```

### Task 3: Paid Action Adapter And Authorization

**Files:**
- Create: `apps/api/src/services/ad-action-adapter.ts`
- Modify: `apps/api/src/services/action-adapters.ts`
- Modify: `apps/api/src/services/ad-launches.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/test/ad-action-adapter.test.ts`

**Interfaces:**
- Implements preflight/dispatch/refresh for `paid_launch`, `budget_change`, and `targeting_change`.

- [ ] **Step 1: Write failing tests**

Cover human/autonomous policy, kill switch, daily cap, budget envelope, unsupported objective, missing image, launch idempotency, resume after each Meta step, budget change authorization, targeting change authorization, and variant link.

- [ ] **Step 2: Add `externalActionId` unique link and adapter**

`paid_launch` creates/resumes exactly one `ad_launches` row. Budget/targeting actions snapshot old/new values and call provider operations only after authorization and guardrail checks.

- [ ] **Step 3: Preserve legacy decision history**

For migrated pending launches, create external actions/decisions from `adLaunchDecisions`; do not duplicate already launched actions.

- [ ] **Step 4: Run tests and commit**

Run: `npm run db:generate -w apps/api && npm test -- ad-action-adapter.test.ts ads-execution.test.ts ad-image.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/ad-action-adapter.test.ts
git commit -m "feat: govern paid execution through external actions"
```

### Task 4: Paid Outcomes

**Files:**
- Modify: `apps/api/src/services/ads.ts`
- Modify: `apps/api/src/services/action-outcomes.ts`
- Modify: `apps/api/src/services/insights.ts`
- Create: `apps/api/test/paid-outcomes.test.ts`

- [ ] **Step 1: Write failing attribution tests**

Trace spend, impressions, clicks, conversions, and provider status from imported ad campaign -> ad launch -> external action -> exact variant/package/lane/persona/audience/campaign.

- [ ] **Step 2: Implement normalized paid outcome upserts**

Keep currency and integer cents. Do not combine spend across currencies without explicit conversion data.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- paid-outcomes.test.ts ads.test.ts insights.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/paid-outcomes.test.ts
git commit -m "feat: attribute paid outcomes to campaign variants"
```

### Task 5: Paid UX And Acceptance

**Files:**
- Modify campaign lane editor, package workspace, action queue, ad launch, and insights pages
- Modify `docs/founder-acceptance-tests.md`

- [ ] **Step 1: Add paid lane editor and package fan-out**

Use account/audience/format selectors, money inputs in account currency, date controls, and explicit effective authorization preview.

- [ ] **Step 2: Unify paid action review**

Show creative, destination, targeting, budget, flight, policy reason, spend guardrails, and previous/new values for changes.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: all exit 0.

- [ ] **Step 4: Manual acceptance and commit**

Generate organic and paid variants from one package, require launch authorization but allow organic autonomous publishing, launch once, simulate restart/resume, sync metrics, and trace paid/organic outcomes to the shared package.

```bash
git add apps/web docs/founder-acceptance-tests.md
git commit -m "feat: attach paid ads to campaign orchestration"
```
