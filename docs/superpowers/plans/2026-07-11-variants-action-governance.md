# Variants And Action Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every generated candidate, snapshot its exact context, govern publication at the external-action boundary, and dispatch through the existing publication adapter exactly once.

**Architecture:** Deliverables generate immutable variants linked to drafts/generations. Selected variants propose external actions. A deny-wins policy resolver decides whether authorization is required; a database-backed task ledger runs generation and dispatch durably.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle ORM, existing resolver/LLM/connector fabric, Next.js, Vitest.

## Global Constraints

- Drafting is not human-gated.
- Content review and external-action authorization are separate.
- Every action references the exact selected variant.
- `human_required` wins across all applicable policy scopes.
- Connector dispatch uses the external action ID as its idempotency key.
- The control plane creates publication rows; publication services never reverse-create actions.

---

## File Structure

- Modify `packages/contracts/src/index.ts`: variants, context snapshots, policies, actions, decisions, task ledger.
- Modify `apps/api/src/db/schema.ts`: `content_variants`, `variant_context_snapshots`, `autonomy_policy_rules`, `external_actions`, `external_action_decisions`, `orchestration_tasks`.
- Create generated migration.
- Create `apps/api/src/services/content-variants.ts`.
- Create `apps/api/src/services/context-snapshots.ts`.
- Create `apps/api/src/services/autonomy-policy.ts`.
- Create `apps/api/src/services/external-actions.ts`.
- Create `apps/api/src/services/orchestration-tasks.ts`.
- Create `apps/api/src/services/action-adapters.ts` and `publication-action-adapter.ts`.
- Modify `apps/api/src/services/generations.ts`, `drafts.ts`, `publications.ts`, `signal-drafting.ts`, and carousel services.
- Create `apps/api/src/routes/variants.ts`, `external-actions.ts`, and `autonomy-policy.ts`.
- Modify `apps/api/src/app.ts` and `apps/worker/src/index.ts`.
- Create API tests for variants, policy, tasks, and action dispatch.
- Create/update web package, action queue, persona, connector, and campaign policy UI.

### Task 1: Variant And Context Snapshot Persistence

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: generated migration
- Create: `apps/api/src/services/content-variants.ts`
- Create: `apps/api/src/services/context-snapshots.ts`
- Create: `apps/api/test/content-variants.test.ts`

**Interfaces:**
- `createVariantFromGeneration(db, input): ContentVariant`.
- `selectVariant(db, workspaceId, deliverableId, variantId, actor): ContentVariant`.
- `captureContextSnapshot(db, input): VariantContextSnapshot`.

- [ ] **Step 1: Write failing tests**

Cover two regenerations retained, one selected variant, selection audit, generation/draft link, media snapshot, exact plan/lane IDs, brain version IDs, guidance IDs/content, account profile, resolver trace, prompt/model/provider, and immutable snapshots after source edits.

- [ ] **Step 2: Run tests**

Run: `npm test -- content-variants.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add contracts, tables, migration, and services**

Use one transaction to clear previous selection and select a new variant. Snapshot structured dependencies as JSON plus explicit plan/lane/generation foreign keys for high-value joins.

- [ ] **Step 4: Run tests and commit**

Run: `npm run db:generate -w apps/api && npm test -- content-variants.test.ts`

Expected: PASS.

```bash
git add packages/contracts apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/content-variants.ts apps/api/src/services/context-snapshots.ts apps/api/test/content-variants.test.ts
git commit -m "feat: preserve content variants and context snapshots"
```

### Task 2: Deliverable Generation Integration

**Files:**
- Modify: `apps/api/src/services/signal-drafting.ts`
- Modify: `apps/api/src/services/generations.ts`
- Modify: `apps/api/src/services/drafts.ts`
- Modify: `apps/api/src/services/carousels.ts`
- Create: `apps/api/src/services/deliverable-generation.ts`
- Create: `apps/api/test/deliverable-generation.test.ts`

**Interfaces:**
- `generateDeliverableVariants(deps, workspaceId, deliverableId, options): Promise<ContentVariant[]>`.

- [ ] **Step 1: Write failing integration tests**

Assert shared package brief but independent channel resolver calls, persona/account scoping, format constraints, multiple candidates, partial lane failure isolation, carousel media preservation, and package sources in snapshot.

- [ ] **Step 2: Run tests**

Run: `npm test -- deliverable-generation.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement generator**

Reuse existing generation/review/draft helpers. Add optional orchestration references to `StoreGenerationInput` and `SubmitDraftInput`; legacy callers remain valid. A successful candidate creates generation -> draft -> context snapshot -> variant and advances the deliverable to `candidate_ready`.

- [ ] **Step 4: Run affected tests and commit**

Run: `npm test -- deliverable-generation.test.ts drafts.test.ts generations.test.ts carousels.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/deliverable-generation.test.ts
git commit -m "feat: generate traceable deliverable variants"
```

### Task 3: Deny-Wins Autonomy Policy Resolver

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/services/autonomy-policy.ts`
- Create: `apps/api/test/autonomy-policy.test.ts`

**Interfaces:**
- `resolveActionPolicy(db, workspaceId, context): ResolvedActionPolicy`.
- `upsertPolicyRule(db, workspaceId, input, actor): AutonomyPolicyRule`.

- [ ] **Step 1: Write the policy matrix tests**

Cover workspace human/campaign autonomous, campaign autonomous/persona human, connection human/lane autonomous, all inherit, unrelated action kind, paused/deleted scope, and contributing-rule trace.

- [ ] **Step 2: Run tests**

Run: `npm test -- autonomy-policy.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement contracts, table, and pure resolution**

Rules have scope type/id, optional channel, action kind, value `inherit | autonomous | human_required`, actor, and timestamps. Default unresolved external behavior is `human_required`. Filter applicable rules, then choose human if any human rule exists, else autonomous if any autonomous rule exists, else default human.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- autonomy-policy.test.ts`

Expected: PASS.

```bash
git add packages/contracts/src/index.ts apps/api/src/db/schema.ts apps/api/src/services/autonomy-policy.ts apps/api/test/autonomy-policy.test.ts apps/api/drizzle
git commit -m "feat: resolve external action autonomy policies"
```

### Task 4: External Action State Machine And Authorization

**Files:**
- Create: `apps/api/src/services/external-actions.ts`
- Create: `apps/api/test/external-actions.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`

**Interfaces:**
- `proposeExternalAction(db, workspaceId, variantId, input): ExternalAction`.
- `authorizeExternalAction(db, workspaceId, actionId, decision, actor): ExternalAction`.
- `revalidateExternalAction(db, workspaceId, actionId): ExternalAction`.

- [ ] **Step 1: Write failing tests**

Cover selected-variant requirement, stale variant block, policy snapshot, human queue, autonomous authorization, decision audit, schedule change, cancellation, illegal transitions, and policy changes not rewriting prior decisions.

- [ ] **Step 2: Run tests**

Run: `npm test -- external-actions.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement state machine and tables**

Store resolved policy JSON and content/destination snapshot on proposal. Authorization decisions record actor, from/to state, and reason. Revalidation checks current guardrails/dependencies but never replaces the original policy explanation.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- external-actions.test.ts autonomy-policy.test.ts`

Expected: PASS.

```bash
git add packages/contracts/src/index.ts apps/api/src/db/schema.ts apps/api/src/services/external-actions.ts apps/api/test/external-actions.test.ts apps/api/drizzle
git commit -m "feat: govern external actions separately from content"
```

### Task 5: Durable Task Ledger

**Files:**
- Create: `apps/api/src/services/orchestration-tasks.ts`
- Create: `apps/api/test/orchestration-tasks.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- `enqueueTask(db, input): OrchestrationTask`.
- `leaseTasks(db, workerId, nowMs, limit): OrchestrationTask[]`.
- `completeTask`, `retryTask`, `deadTask`, `recoverExpiredLeases`.

- [ ] **Step 1: Write failing queue tests**

Cover idempotency key uniqueness, lease exclusion, expired lease recovery, bounded exponential backoff, max-attempt dead state, business block not retried, workspace isolation, and worker restart.

- [ ] **Step 2: Run tests**

Run: `npm test -- orchestration-tasks.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement database-backed ledger**

Use an atomic update inside a transaction to lease queued/due retryable tasks. Backoff is `min(60_000 * 2 ** (attempt - 1), 3_600_000)`. Default max attempts is 5. Store structured error code/message JSON.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- orchestration-tasks.test.ts`

Expected: PASS.

```bash
git add packages/contracts/src/index.ts apps/api/src/db/schema.ts apps/api/src/services/orchestration-tasks.ts apps/api/test/orchestration-tasks.test.ts apps/api/drizzle
git commit -m "feat: add durable orchestration task ledger"
```

### Task 6: Publication Action Adapter And Idempotent Dispatch

**Files:**
- Create: `apps/api/src/services/action-adapters.ts`
- Create: `apps/api/src/services/publication-action-adapter.ts`
- Modify: `apps/api/src/services/publications.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/test/publication-action-adapter.test.ts`

**Interfaces:**
- Implements `ExternalActionAdapter` for `publish`.
- Adds nullable `externalActionId` unique link on `publications`.

- [ ] **Step 1: Write failing adapter tests**

Cover missing connection, persona-account mismatch, format violation, kill switch/caps, scheduled creation, immediate dispatch, retry reusing one publication, existing receipt refresh, and external action ID idempotency.

- [ ] **Step 2: Run tests**

Run: `npm test -- publication-action-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement preflight/dispatch/refresh**

Preflight resolves the stored destination and current safety guardrails. Dispatch creates one publication with `externalActionId`; if it already exists, call refresh/attempt rather than insert. Publication events include action/variant/deliverable/package IDs.

- [ ] **Step 4: Run affected tests and commit**

Run: `npm test -- publication-action-adapter.test.ts publish.test.ts cadences.test.ts automation.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/publication-action-adapter.test.ts
git commit -m "feat: dispatch governed publication actions"
```

### Task 7: Routes, Worker, Policy UI, And Action Queue

**Files:**
- Create: `apps/api/src/routes/variants.ts`
- Create: `apps/api/src/routes/external-actions.ts`
- Create: `apps/api/src/routes/autonomy-policy.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/web/app/workspaces/[id]/approvals/page.tsx`
- Modify: persona, connector, and campaign pages for policy controls
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add failing route tests**

Test generate/regenerate/select, propose action, approve/reject/cancel/retry, policy CRUD, effective-policy preview, task run, and workspace isolation.

- [ ] **Step 2: Implement routes and task handlers**

Worker order is lease tasks -> generate variants -> propose actions -> dispatch due authorized actions -> refresh receipts. Per-task errors never abort the batch.

- [ ] **Step 3: Replace Approvals with a unified queue view**

Provide tabs for external actions and optional editorial review. Each action shows exact variant, destination, time, effective policy, blocking rule, and guardrail status.

- [ ] **Step 4: Add scoped policy controls**

Campaign, persona, and connected-account pages use segmented controls for inherit/autonomous/human-required by supported action kind. Campaign lane editor previews the effective policy.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

Expected: both exit 0.

```bash
git add apps/api/src/routes apps/api/src/app.ts apps/worker/src/index.ts apps/web apps/api/test
git commit -m "feat: operate governed content actions end to end"
```
