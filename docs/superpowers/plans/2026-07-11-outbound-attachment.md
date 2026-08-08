# Outbound Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach outbound email and DMs to the control plane using campaign packages, audience targeting, governed send/reply actions, sequence guardrails, and CRM-linked outcomes.

**Architecture:** Outbound lane revisions define audience/list, sender, channel, sequence, and sending window. Existing launches, sequence steps/recipients, inbox, and exporter services remain operational adapters created by shared external actions.

**Tech Stack:** Existing TypeScript/Fastify/Drizzle launch/sequence/inbox/export services, Zod, Next.js, Vitest.

## Global Constraints

- Begin after organic acceptance and after shared action governance is stable.
- Tuezday does not build mailbox warmup or deliverability infrastructure.
- Send and automated reply policies resolve independently.
- Stop-on-reply is mandatory where configured, regardless of autonomy.
- Recipient personalization retains package/source/Brain lineage without duplicating campaign strategy.

---

## File Structure

- Extend orchestration contracts/format registry with outbound lane configuration.
- Create `apps/api/src/services/outbound-action-adapter.ts` and `outbound-deliverable-generation.ts`.
- Modify launches, sequences, inbox, outbound exporter, CRM outcomes, and schema links.
- Create outbound attachment/migration/outcome tests.
- Modify campaign lane editor, package workspace, action queue, outbound, inbox, and insights UI.

### Task 1: Outbound Lane And Deliverable Model

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/format-registry.ts`
- Modify: `packages/contracts/test/orchestration.test.ts`
- Create: `apps/api/test/outbound-lanes.test.ts`

- [ ] **Step 1: Write failing tests**

Cover audience/list, sender connection, email/X/LinkedIn DM channel, sequence template, sending window/timezone, stop-on-reply, export provider, recipient-specific versus broadcast deliverable mode, and invalid combinations.

- [ ] **Step 2: Implement outbound discriminated configuration**

Map email to `outbound_email`, X DM to `x_dm`, and add a first-class LinkedIn DM task only if the current connector can dispatch it; otherwise expose it as export-only capability.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- outbound-lanes.test.ts orchestration.test.ts launch-sequences.test.ts`

Expected: PASS.

```bash
git add packages/contracts apps/api/src/services/format-registry.ts apps/api/test/outbound-lanes.test.ts
git commit -m "feat: define outbound campaign lanes"
```

### Task 2: Package-To-Recipient Generation

**Files:**
- Create: `apps/api/src/services/outbound-deliverable-generation.ts`
- Modify: `apps/api/src/services/deliverable-generation.ts`
- Modify: `apps/api/src/services/launches.ts`
- Create: `apps/api/test/outbound-deliverable-generation.test.ts`

- [ ] **Step 1: Write failing tests**

Cover shared package angle, per-recipient lead context, audience snapshot, several sequence steps, persona/sender resolution, no recipient data leak, partial recipient failure, and context snapshots.

- [ ] **Step 2: Implement recipient generation strategy**

Create a broadcast deliverable for the lane/step and recipient variants/actions when personalization is required. Snapshot the audience membership used so later list changes do not rewrite the send cohort.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- outbound-deliverable-generation.test.ts launches.test.ts launch-sequences.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/outbound-deliverable-generation.test.ts
git commit -m "feat: generate outbound variants from campaign packages"
```

### Task 3: Send And Reply Action Adapter

**Files:**
- Create: `apps/api/src/services/outbound-action-adapter.ts`
- Modify: `apps/api/src/services/action-adapters.ts`
- Modify: `apps/api/src/services/launches.ts`
- Modify: `apps/api/src/services/launch-sequences.ts`
- Modify: `apps/api/src/services/engagement-reply.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/test/outbound-action-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

Cover independent send/reply authorization, sender health, sending window, recipient cap, idempotent launch/message creation, scheduled-auto, export-only email, reply detected before next step, stop-on-reply, and retry without duplicate sends.

- [ ] **Step 2: Add external-action links and adapter**

Link `launch_messages.externalActionId`; for grouped export use one parent action plus recipient receipt children. Dispatch through existing social adapter or exporter. Never mark exported CSV as delivered; use `exported` provider receipt status.

- [ ] **Step 3: Route automated replies through `reply` actions**

Inbox reply generation stays automatic; dispatch waits for its independently resolved reply policy. Stop-on-reply updates sequence readiness before any due send task leases.

- [ ] **Step 4: Run tests and commit**

Run: `npm run db:generate -w apps/api && npm test -- outbound-action-adapter.test.ts launches.test.ts launch-sequences.test.ts inbox.test.ts outbound.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/outbound-action-adapter.test.ts
git commit -m "feat: govern outbound sends and replies"
```

### Task 4: Outbound And CRM Outcomes

**Files:**
- Modify: `apps/api/src/services/inbox.ts`
- Modify: `apps/api/src/services/crm.ts`
- Modify: `apps/api/src/services/action-outcomes.ts`
- Modify: `apps/api/src/services/insights.ts`
- Create: `apps/api/test/outbound-outcomes.test.ts`

- [ ] **Step 1: Write failing tests**

Cover exported, sent, delivered where provider supports it, replied, positive reply, meeting booked, stopped, bounced, CRM conversion, and exact variant/recipient/package/campaign attribution.

- [ ] **Step 2: Implement normalized outcome mapping**

Do not infer delivery from export or send acceptance. CRM outcomes reference external contact/opportunity IDs and retain source/provider timestamps.

- [ ] **Step 3: Run tests and commit**

Run: `npm test -- outbound-outcomes.test.ts inbox.test.ts crm.test.ts insights.test.ts`

Expected: PASS.

```bash
git add apps/api/src/services apps/api/test/outbound-outcomes.test.ts
git commit -m "feat: attribute outbound and CRM outcomes"
```

### Task 5: Outbound UX, Migration, And Acceptance

**Files:**
- Modify campaign lane editor, package workspace, action queue, outbound, inbox, and insights pages
- Create `apps/api/src/services/outbound-orchestration-backfill.ts`
- Create `apps/api/test/outbound-orchestration-backfill.test.ts`
- Modify `docs/founder-acceptance-tests.md`

- [ ] **Step 1: Backfill legacy launches conservatively**

Link launches/messages to synthetic packages/deliverables/actions only when campaign, persona, audience, and message lineage are unambiguous. Keep other launches as labeled legacy history.

- [ ] **Step 2: Implement outbound lane and queue UI**

Show audience size/snapshot time, sender, sequence, send/reply effective policy, window, stop-on-reply, recipient progress, and clear exported-versus-sent status.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: all exit 0.

- [ ] **Step 4: Manual acceptance and commit**

Create one package shared by organic and outbound lanes, generate a two-step sequence for a test audience, require send approval but allow reply automation, approve/send once, simulate a reply before step two, verify stop-on-reply, record CRM outcome, and trace everything to the shared package.

```bash
git add apps/api/src/services/outbound-orchestration-backfill.ts apps/api/test/outbound-orchestration-backfill.test.ts apps/web docs/founder-acceptance-tests.md
git commit -m "feat: attach outbound to campaign orchestration"
```
