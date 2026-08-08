# GTM Orchestration Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each linked plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved GTM orchestration control plane through independently testable organic, paid, and outbound milestones.

**Architecture:** Campaigns become versioned execution plans with stable lanes, packages, deliverables, variants, governed external actions, and attributed outcomes. Existing publishing, ads, and outbound services remain adapters until their control-plane cutovers are accepted.

**Tech Stack:** TypeScript, Zod contracts, Fastify, Drizzle ORM, SQLite, Next.js App Router, Vitest, existing connector fabric and worker.

## Global Constraints

- Every GTM action belongs to a campaign; always-on work uses an evergreen campaign.
- Personas are speaking identities; audiences are recipients.
- Discovery, routing, sufficiency, research proposals, and drafting are not human-gated.
- Human authorization applies only to publish/send, automated reply, paid launch, budget change, and targeting change.
- Applicable `human_required` autonomy rules override autonomous rules.
- Published/sent history is immutable; affected unpublished work becomes stale with explicit reasons.
- The control plane creates operational records in one direction; operational services do not reverse-create control-plane records.
- Organic social must pass founder acceptance before paid ads and outbound attach.
- Ads and outbound reuse the same external-action and outcome contracts.
- All new enum vocabularies live in `packages/contracts/src/index.ts`.
- All external dependencies remain injectable through `buildApp`.
- No new queue infrastructure; use a database-backed durable task ledger first.

---

## Ordered Plans

1. [Organic Foundation](./2026-07-11-organic-orchestration-foundation.md)
   Adds canonical contracts, schema, campaign/plan/lane services, backfill, and shadow reads without changing execution.
2. [Organic Planning And Calendar](./2026-07-11-organic-planning-calendar.md)
   Materializes lane-backed deliverables and makes the calendar project campaign commitments.
3. [Content Package Pipeline](./2026-07-11-content-package-pipeline.md)
   Converts campaign opportunities into evidence-sufficient packages and coordinated deliverables.
4. [Variants And Action Governance](./2026-07-11-variants-action-governance.md)
   Preserves generation lineage, snapshots context, resolves autonomy, and dispatches publication actions durably.
5. [Organic Outcomes And Cutover](./2026-07-11-organic-outcomes-cutover.md)
   Attributes outcomes, completes UI/acceptance, disables legacy direct automation, and retires cadence planning authority.
6. [Paid Ads Attachment](./2026-07-11-paid-ads-attachment.md)
   Adds ad lane configuration and paid action adapters after organic acceptance.
7. [Outbound Attachment](./2026-07-11-outbound-attachment.md)
   Adds outbound lanes, send/reply actions, sequence adapters, and CRM-linked outcomes.

## Required Merge Order

```text
organic-foundation
  -> organic-planning-calendar
  -> content-package-pipeline
  -> variants-action-governance
  -> organic-outcomes-cutover
  -> paid-ads-attachment
  -> outbound-attachment
```

Paid ads and outbound both depend on organic cutover but are otherwise separable. Build ads first per the approved rollout.

## Milestone Gates

| Gate | Evidence required |
|---|---|
| Foundation | Existing tests green; old campaigns backfill deterministically; no behavior changes |
| Planning | 14-day deliverables match lane schedules across timezone/DST tests |
| Packages | One signal creates multiple supported packages; insufficient packages never draft |
| Governance | Campaign autonomy is overridden by persona/connection human requirements; dispatch is idempotent |
| Organic acceptance | Full signal-to-outcome trace; worker restart creates no duplicates; legacy direct path disabled |
| Paid acceptance | Paid launch/budget/targeting actions use shared authorization and exact creative attribution |
| Outbound acceptance | Send/reply actions use shared authorization; stop-on-reply and CRM outcomes remain correct |

## Verification At Every Gate

Run:

```bash
npm run typecheck
npm test
```

Expected: both commands exit 0. Founder-visible milestones additionally require the manual acceptance script named in each plan.
