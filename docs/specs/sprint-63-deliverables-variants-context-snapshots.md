# Sprint 63 — Deliverables, Variants & Context Snapshots

**Branch:** `sprint-63-deliverables` · **Size:** XL

Implements §8.10 (+ §9.5's fan-out/caps half) of the approved design
`docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
(the design doc is the model authority — this spec is the delivery plan). PRD
reference: `docs/plans/prd-agentic-platform.md` §6, Phase K, Sprint 63.
Activates `DELIVERABLE_PRODUCTION_STATUSES` (reserved vocabulary with a
machine since the orchestration foundation; until now nothing writes it) and
gives Sprint 62's `ready` packages their first consumer. Still **shadow**
(Phase 3): no change to legacy generation/automation/cadence/publish flows,
no drafts, no external actions — variant → approval-gate/dispatch handoff is
the Sprint 64 pipeline engine's `propose` step.

## 0. Branch and merge order

Sprint 63 "Depends on: 62". Sprint 62 (`sprint-62-content-packages`, HEAD
`25f427c`) is **not yet merged to `main`**, so per the workflow's dependency
caveat this branch forks off that branch. **Merge order: 61 → 62 → 63.**
Next migration index on this lineage is **0069** (last:
`0068_sprint_62_content_packages`); if another branch lands on `main` first,
renumber (Sprint 60/61/62 convention).

## 1. Scope in one paragraph

A `ready` package currently dead-ends: sufficiency and lane eligibility are
recorded, but nothing commits the campaign to producing anything. This sprint
adds the execution unit and its immutable lineage: (1) **`deliverables`** —
one campaign commitment for one lane and time (§8.10), in two kinds:
*planned* slots materialized from a lane revision's recurrence schedule
(unique on `(lane_revision_id, original_scheduled_for)`) and *reactive*
commitments created by package fan-out (unique on `(package_id,
lane_revision_id)`), with the §9.5 assignment arithmetic — oldest compatible
planned slot first, reactive only when the lane supports it and its period
cap allows, all transactional; (2) **`variants`** — one candidate execution
each, generated single-shot through the Central Brain context resolver and
the metered gateway; regeneration appends a new version and never overwrites
lineage; (3) **`context_snapshots`** — the full resolved context (sections +
trace + prompt) plus the identity inputs (plan/lane/persona/account/
guidance/package sources/model) captured immutably per variant, so every
candidate is replayable and auditable; and (4) the **deliverable lifecycle**
driven exclusively through the contracts machine (`canTransitionDeliverable`)
with an audit event per change. Producers: a slot-materialization +
fan-out + generation + staleness phase in the discovery tick, plus
synchronous founder-triggered routes so everything is demonstrable without
the worker.

### Invariants (design §1.3, §8.10, §9.5)

1. A deliverable belongs to exactly one lane (and its exact lane revision)
   and one campaign; a planned deliverable additionally owns one immutable
   `originalScheduledFor` slot; a reactive deliverable additionally owns
   exactly one package per lane revision.
2. Planned-slot assignment and reactive-cap enforcement are **transactional**
   (§9.5 rule 4): the partial uniques plus status-fenced updates make
   concurrent fan-outs lose cleanly, never double-book.
3. A package never produces two deliverables on the same lane thread
   (§9.5 rule 5, service-enforced across kinds on top of the reactive
   unique).
4. Regeneration creates a new variant version; no variant row or context
   snapshot is ever mutated or deleted by application code. Lineage is
   append-only.
5. Fulfilled history is immutable: `fulfilled` is terminal in the machine
   (as is `cancelled`); a selected variant and its snapshot cannot be
   altered; `cancel` of a fulfilled deliverable is an illegal transition.
6. Every variant carries a context snapshot capturing what the model
   actually saw (resolved sections with include/exclude trace, final prompt,
   token accounting) plus the identity inputs — replayable and inspectable
   before and after the call (core resolver contract).
7. Generation is fenced exactly like Sprint 62 assessment: infrastructure
   failure is retryable queue state (`pending`/`failed`), never a stored
   result; business blocks are domain statuses (`blocked`, `stale`).
8. Only lane revisions holding an **eligible** Sprint 62 lane-eligibility
   decision (from the package's latest assessment) receive fan-out; the
   deliverable layer never re-derives eligibility.
9. All new tables are workspace-scoped behind the standard membership guard.
10. Shadow: no drafts, no external actions, no publications, no change to
    legacy automation/cadence flows. `posting_cadences` remains the only
    publish scheduler until dispatch integrates (Sprint 64+).

## 2. Founder decisions recorded

- **D-63.1 Two deliverable kinds, one table.** `kind: planned | reactive`.
  Planned deliverables are materialized ahead of demand from the lane
  revision's `schedule` and wait (status `planned`) for a package; reactive
  deliverables are born at fan-out with a package already attached (status
  `ready`). The §8.10 uniqueness keys are partial indexes per kind.
- **D-63.2 Slot materialization is deterministic and horizon-bounded.**
  For every *active* lane revision of an *active* plan revision whose
  `deliveryMode` includes planned, walk the recurrence schedule
  (`daysOfWeek`/`timeOfDay`/`timezone`, the same DST-aware walk as cadence
  fill) from now through `DELIVERABLE_SLOT_HORIZON_DAYS = 14`, materializing
  at most `plannedQuantity` slots per calendar week in the lane's timezone
  (the lane model pairs "planned quantity and recurrence schedule" — the
  quantity is the weekly commitment). The `(laneRevisionId,
  originalScheduledFor)` unique makes re-runs no-ops. Slots are only
  materialized while the plan revision is the campaign's active revision;
  existing slots survive plan changes as history.
- **D-63.3 Fan-out consumes eligibility, never re-derives it.** For a
  `ready` package: take lane revisions with `eligible = true` decisions from
  the **latest** assessment; per lane, prefer the oldest unassigned planned
  slot (assign the package to it: `planned → ready`), else create a reactive
  deliverable when `deliveryMode` includes reactive and the rolling
  reactive-period cap (`reactiveCap` per `day | week | month`, rolling
  window) has room. A lane thread that already has any deliverable for this
  package is skipped (invariant 3). One transaction per package; a fan-out
  producing zero deliverables leaves the package `ready` with the reasons in
  the run report (capacity may free up later — not a `blocked` fact about
  the package's evidence).
- **D-63.4 Fan-out due-ness is `fannedOutAt IS NULL`.** A single nullable
  timestamp on `content_packages` (migration 0069 adds it) marks the §9.5
  fan-out as attempted; re-running after capacity changes is an operator
  action (the fan-out route), not an automatic loop. Deterministic — no
  queue states, no retries needed; the fence is the null check inside the
  transaction.
- **D-63.5 Variant generation is one metered single-shot `generate` per
  variant** through the real Central Brain path: `resolveContext` with the
  lane's task type (from `CHANNEL_FORMAT_REGISTRY`), channel, lane persona,
  campaign + active-plan inputs, resolved account, channel guidance, the
  package angle, and the package's trigger story as the signal input with
  supported claims appended as grounding (source text stays data). Pipeline
  `variant_generation`, budget-gated via `llmBudgetExhausted`. No
  `generations`/`drafts` rows — the deliverable layer is the §8.10 record;
  metering still lands in `llm_usage_events`. The agentic multi-step path
  replaces this single-shot internals in Sprint 64 without changing the
  domain model.
- **D-63.6 Generation queue mirrors the Sprint 62 assessment queue.**
  `generationState: pending | in_progress | complete | failed` + attempts
  (cap `GENERATION_MAX_ATTEMPTS = 3` → `failed`, waiting for operator
  regenerate) + lease. Claim requires status `ready` (first variant) or
  `candidate_ready` (regeneration) and moves the deliverable to `generating`
  through the machine; failure returns it to the pre-claim status
  (`generating → ready` edge; regeneration failures land on `ready` too —
  the candidate list is unchanged and the machine has no `generating →
  candidate_ready` edge without a new variant… see §5.3 for the exact
  disposition). Timeouts, gateway errors, and budget aborts are retryable —
  never a stored variant.
- **D-63.7 Operator actions are `regenerate | select | cancel`.**
  `regenerate` re-queues generation (resets the queue; legal while `ready`
  with a failed queue or `candidate_ready`); `select` picks one candidate
  variant → variant `selected`, sibling candidates `superseded`, deliverable
  `candidate_ready → fulfilled` (v1 fulfillment = the founder chose the
  winning execution; gate/dispatch handoff is Sprint 64); `cancel` requires
  a reason and is terminal. Every change goes through
  `canTransitionDeliverable` with an event row.
- **D-63.8 Variant statuses are `candidate | selected | superseded`.**
  Append-only rows; `candidate → selected | superseded` are the only
  transitions (`canTransitionVariant`), both terminal. No `discarded` —
  vocabulary without a producer is an atlas conflict, and superseding covers
  the v1 need.
- **D-63.9 Package cancellation blocks its undelivered work.** `decidePackage
  cancel` now also moves the package's `ready` deliverables to `blocked`
  (evented, "package cancelled"); `generating` ones finish their in-flight
  variant and land `candidate_ready` for the operator to judge;
  `candidate_ready`/`fulfilled` ones keep their content. `blocked → cancelled`
  is the operator exit.
- **D-63.10 Staleness sweep, planned kind only.** A planned-slot deliverable
  still unfulfilled `DELIVERABLE_STALE_GRACE_MS = 24h` after its
  `originalScheduledFor` moves to `stale` (from `planned`, `ready`, or
  `candidate_ready`; `generating` is left to finish first — no machine
  edge). Deterministic, evented, runs in the tick phase. Reactive
  deliverables have no slot and never go stale in v1 (opportunity expiry
  governs upstream).
- **D-63.11 Statuses without v1 producers stay honestly documented.**
  `assessing` and `research_needed` (deliverable-level re-assessment
  propagation) activate when package re-assessment flows through to
  deliverables in a later sprint — the machine keeps their edges, the
  contracts comment names them as awaiting producers (the Sprint 62
  `PACKAGE_SOURCE_ROLES` precedent).

## 3. Domain model

Migration **0069** (`0069_sprint_63_deliverables.sql`, generated via
`db:generate` then renamed + journal-tagged, per convention). Also adds
`content_packages.fanned_out_at` (nullable integer, D-63.4).

### 3.1 `deliverables` (§8.10)

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `campaignId` | text NOT NULL → campaigns cascade | |
| `planRevisionId` | text NOT NULL → campaign_plan_revisions cascade | pinned |
| `laneId` | text NOT NULL → campaign_lanes cascade | stable thread |
| `laneRevisionId` | text NOT NULL → campaign_lane_revisions cascade | exact revision (§8.10) |
| `kind` | text NOT NULL | `DELIVERABLE_KINDS = planned \| reactive` |
| `originalScheduledFor` | integer nullable | NOT NULL for planned (immutable slot identity); null for reactive |
| `packageId` | text nullable → content_packages **set null** | survives package deletion; angle snapshot stays |
| `angle` | text NOT NULL default `""` | copied at assignment/creation (survival snapshot) |
| `angleHash` | text NOT NULL default `""` | idem |
| `status` | text NOT NULL default `"planned"` | `DELIVERABLE_PRODUCTION_STATUSES` — **activated** |
| `generationState` | text NOT NULL default `"pending"` | `DELIVERABLE_GENERATION_STATES` — infra queue, separate from lifecycle |
| `generationAttempts` | integer NOT NULL default 0 | cap 3 → `failed` |
| `generationLeaseExpiresAt` | integer nullable | claim lease (Sprint 61/62 pattern) |
| `generatedAt` | integer nullable | last committed variant |
| `createdByUserId` | text nullable → users set null | null = system |
| `createdAt` / `updatedAt` | integer NOT NULL | |

Partial uniques (§8.10 verbatim):
`(laneRevisionId, originalScheduledFor) WHERE original_scheduled_for IS NOT NULL`;
`(packageId, laneRevisionId) WHERE kind = 'reactive' AND package_id IS NOT NULL`.
Indexes: `(workspaceId, status, createdAt)`, `(laneRevisionId, status)`,
`(packageId)`, `(campaignId, status)`, queue
`(workspaceId, generationState, generationLeaseExpiresAt)`.

### 3.2 `context_snapshots` (§8.10)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `deliverableId` | text NOT NULL → deliverables cascade | |
| `packageId` | text nullable → content_packages set null | provenance display; grounding is snapshotted |
| `resolvedContextJson` | text NOT NULL | the **entire** `ResolvedContext` (sections w/ trace, prompt, includedTokens, tokenBudget, overBudget, resolveMode) |
| `inputsJson` | text NOT NULL | identity + grounding inputs: planRevisionId, laneRevisionId, personaId, channel, format, taskType, guidance source, angle, package source snapshots (id/role/title/url/excerpt), supported claims |
| `model` / `provider` | text NOT NULL | what generated from this snapshot |
| `createdAt` | integer NOT NULL | |

Append-only; never updated. Index `(deliverableId, createdAt)`.

### 3.3 `variants` (§8.10)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `deliverableId` | text NOT NULL → deliverables cascade | |
| `variantVersion` | integer NOT NULL | per-deliverable monotonic; unique `(deliverableId, variantVersion)` |
| `contextSnapshotId` | text NOT NULL → context_snapshots | 1:1 — every variant is replayable (invariant 6) |
| `status` | text NOT NULL default `"candidate"` | `VARIANT_STATUSES` |
| `content` | text NOT NULL | the candidate execution — immutable |
| `model` / `provider` | text NOT NULL | |
| `durationMs` | integer NOT NULL | |
| `createdByUserId` | text nullable → users set null | null = system tick; set = operator generate/regenerate |
| `selectedAt` | integer nullable | |
| `createdAt` | integer NOT NULL | |

Append-only rows; only `status`/`selectedAt` ever change, and only through
`canTransitionVariant`. Index `(deliverableId, variantVersion)` (unique),
`(deliverableId, status)`.

### 3.4 `deliverable_events` (audit, §12.1)

Mirror of `content_package_events`: `id`, `workspaceId` (cascade),
`deliverableId` (cascade), `fromStatus` nullable (null = creation),
`toStatus`, `actorUserId` nullable, `reason` nullable, `createdAt`. Index
`(deliverableId, createdAt)`.

## 4. Lifecycle (contracts state machine)

`DELIVERABLE_PRODUCTION_STATUSES` and its transition table already exist in
`packages/contracts` (reserved). This sprint **activates** them: the table is
exported as `DELIVERABLE_TRANSITIONS`, gains `transitionDeliverable()` for
parity with the package machine, and every producer/route goes through it.

```text
planned         → assessing | ready | stale | blocked | cancelled
assessing       → research_needed | ready | blocked | cancelled     (producers later — D-63.11)
research_needed → assessing | ready | stale | cancelled             (producers later — D-63.11)
ready           → generating | stale | blocked | cancelled
generating      → candidate_ready | ready | blocked | cancelled
candidate_ready → fulfilled | generating | stale | cancelled
fulfilled       → (terminal — published/fulfilled history is immutable)
stale           → assessing | cancelled
blocked         → assessing | cancelled
cancelled       → (terminal)
```

v1 producers: `planned` (slot materialization), `ready` (package assignment /
reactive creation / generation failure return), `generating` (queue claim),
`candidate_ready` (variant commit), `fulfilled` (operator select), `stale`
(sweep, D-63.10), `blocked` (package cancelled, D-63.9), `cancelled`
(operator).

Variant machine (new): `candidate → selected | superseded`; both terminal.

Operator actions (`DELIVERABLE_DECISION_ACTIONS = regenerate | select |
cancel`): see D-63.7. `select` requires `variantId` (schema-enforced);
`cancel` requires `reason`. Every status change writes a `deliverable_events`
row with actor attribution.

## 5. Producers and evaluation design

### 5.1 Slot materialization (deterministic)

`materializePlannedSlots(db, { workspaceId, now })` — for each active
campaign's **active** plan revision, each active lane revision (parent lane
active) with planned delivery and a schedule: compute slots via the shared
DST-aware walker (reuse/extract `slotsBetween` from `services/cadences.ts` —
`LaneSchedule` and `posting_cadences` share the three fields) over `[now,
now + 14d]`, group by calendar week in the lane timezone, keep the first
`plannedQuantity` per week, and insert missing `deliverables` rows (`kind
planned`, status `planned`, `originalScheduledFor` = slot, creation event).
`onConflictDoNothing` on the partial unique = idempotent.

### 5.2 Package fan-out (§9.5, transactional)

`fanOutPackage(db, workspaceId, packageId, actor)` — one transaction:

1. Load the package; require status `ready` and `fannedOutAt IS NULL`
   (fenced update sets it; a concurrent fan-out loses on the fence). The
   operator route may re-run fan-out on a `ready` package that already
   fanned out (D-63.4) — same arithmetic, fence on `updatedAt`.
2. Latest assessment → its `eligible = true` lane decisions (invariant 8).
3. Per eligible lane revision, in lane-name order:
   a. Skip if any deliverable already links this package to this lane
      thread (invariant 3).
   b. **Planned first:** oldest `planned`-status, package-less planned slot
      for this lane revision → fenced update assigns `packageId`, copies
      `angle`/`angleHash`, `planned → ready` + event
      ("package assigned").
   c. **Else reactive** when `deliveryMode ∈ {reactive,
      planned_and_reactive}`: count this lane revision's reactive
      deliverables inside the rolling `reactivePeriod` window (day 24h /
      week 7d / month 30d); if `< reactiveCap`, insert a reactive
      deliverable (status `ready`, generation pending, creation event). The
      reactive partial unique backstops races.
   d. Otherwise record the reason (`no_planned_slot`, `reactive_cap`,
      `no_reactive_mode`) in the run report.
4. Set `fannedOutAt`.

### 5.3 Variant generation (LLM, queue-fenced)

Queue mirrors Sprint 62: due = status ∈ {`ready`, `candidate_ready`} with
`packageId` set and `generationState = 'pending'`, or `in_progress` with an
expired lease; claim moves status → `generating` through the machine (+
event) and stamps the lease. `markGenerationRetryable` returns the
deliverable to `ready` (machine edge; also from failed regenerations — the
existing candidates are unaffected and remain selectable via the machine's
`ready → generating` on the next attempt), increments attempts, cap 3 →
`failed` awaiting operator regenerate. `failed` is infra-terminal, never
content (invariant 7).

Per claim: build the resolver input —

- brain docs (`getBrain`), `selectiveContextInputs`, workspace name;
- `taskType` from `formatCapability(channel, format)` (eligible lanes are
  registered by construction), `channel`;
- lane persona → `toResolvePersona`; account → `resolveDraftAccount`;
- campaign + plan → `campaignResolveInputs` (same-plan invariant respected);
- channel guidance → `resolveChannelGuidance(db, ws, channel, { personaId,
  campaignId })`;
- `angle` = package angle;
- `signal` = the package's `trigger` source (`content` = excerpt +
  "Supported claims (grounded in package sources):" + claims list, `source`
  = source title, `sourceUrl`) — grounding rides the signal seam as data,
  traced like any section.

`resolveContext(...)` → snapshot-before-call is inspectable; then one
`meteredLlm(llm, db, { workspaceId, pipeline: "variant_generation",
campaignId }).generate({ prompt: resolved.prompt, signal })` under
`AbortSignal.any([timeout, tick signal])`.

Commit (one transaction, lease-fenced): re-check `generating` + lease;
insert the `context_snapshots` row (full `ResolvedContext` + inputs +
model/provider); insert the `variants` row (next `variantVersion`,
`candidate`); `generating → candidate_ready` + event; queue `complete`,
attempts reset, `generatedAt` set.

### 5.4 Selection (operator)

`select` (D-63.7), one transaction: deliverable must be `candidate_ready`
and own the variant; variant must be `candidate`. Variant → `selected`
(`selectedAt`), sibling candidates → `superseded`, deliverable →
`fulfilled` + event naming the variant version. Terminal (invariant 5).

### 5.5 Staleness sweep (deterministic)

`sweepStaleDeliverables(db, { workspaceId, now })` — D-63.10. Planned-kind,
status ∈ {`planned`, `ready`, `candidate_ready`},
`originalScheduledFor + 24h < now` → `stale` + event ("slot passed
unfulfilled"). Counted in the run report.

### 5.6 Triggers

- **Discovery tick** (`runDiscoveryScheduler`, after the Sprint 62 package
  phase, same lease): per workspace, `runDeliverablePipeline(db, llm, {
  workspaceId, limit, leaseMs, timeoutMs, signal })` = materialize slots →
  fan out due packages → generate due variants → stale sweep. The
  deterministic phases always run; generation is skipped when
  `llmBudgetExhausted` (deliverables stay pending). New operator-policy
  bounds: `maxDeliverablesPerTick` (default 10, env
  `DISCOVERY_DELIVERABLE_MAX_ITEMS`, 1–100; one shared budget across
  fan-outs + generations) and `variantTimeoutMs` (default 60_000, env
  `DISCOVERY_VARIANT_TIMEOUT_MS`, 5_000–120_000, `< tickTimeoutMs` guard).
  `discoveryRunSummarySchema` gains `deliverablesCreated` /
  `variantsGenerated` (default 0).
- **Founder-triggered synchronous routes** (D-60.5 precedent): fan out one
  package, generate one deliverable, and a bounded
  `POST /workspaces/:id/deliverables/run` — all demonstrable without the
  worker.

## 6. Contracts additions (`packages/contracts/src/index.ts`)

- `DELIVERABLE_KINDS`, `DELIVERABLE_GENERATION_STATES`,
  `DELIVERABLE_DECISION_ACTIONS`, `VARIANT_STATUSES` +
  `VARIANT_TRANSITIONS`/`canTransitionVariant`/`transitionVariant`,
  `GENERATION_MAX_ATTEMPTS`-adjacent constants live API-side; contracts get
  `DELIVERABLE_SLOT_HORIZON_DAYS = 14`, `DELIVERABLE_STALE_GRACE_MS`.
- Export `DELIVERABLE_TRANSITIONS`; add `transitionDeliverable()`
  (activation — the machine itself already exists; comment updated from
  "reserved" to activated, with D-63.11's awaiting-producer note).
- Zod: `deliverableSchema` (list projection incl. `laneName`, `channel`,
  `format`, `campaignName`, `packageAngle`, `variantCount`,
  `latestVariantStatus`), `variantSchema`, `contextSnapshotSchema`
  (`{ id, deliverableId, packageId, resolvedContext, inputs, model,
  provider, createdAt }` — `resolvedContext`/`inputs` stay
  `z.unknown()`-tolerant projections of the stored JSON),
  `deliverableDetailSchema` (`{ deliverable, variants, events }`),
  `listDeliverablesResponseSchema`, `deliverableDecisionInputSchema`
  (superRefine: `select` requires `variantId`, `cancel` requires `reason`),
  `deliverableEventSchema`, `deliverableRunResultSchema`
  (`{ slotsMaterialized, packagesFannedOut, deliverablesCreated,
  variantsGenerated, staled, failures }`), `fanOutResultSchema`
  (`{ deliverablesCreated, skipped: [{ laneRevisionId, reason }] }`).
- `LLM_PIPELINES` gains `"variant_generation"`.
- Nav: child `{ label: "Deliverables", path: "/deliverables" }` under
  **Discover**, after Packages (inbox → opportunities → packages →
  deliverables → stories).
- `discoveryRunSummarySchema` gains `deliverablesCreated` /
  `variantsGenerated`.

## 7. API surface — `apps/api/src/routes/deliverables.ts`

`registerDeliverableRoutes(app, db, llm)`, workspace-guarded:

| Method | Path | Behavior |
|---|---|---|
| GET | `/workspaces/:id/deliverables?status=&campaignId=&laneId=&limit=&offset=` | paginated `{ deliverables, total }` |
| GET | `/workspaces/:id/deliverables/:deliverableId` | detail: deliverable + variants + events |
| GET | `/workspaces/:id/deliverables/:deliverableId/variants/:variantId/snapshot` | the full context snapshot (replay/audit view) |
| POST | `/workspaces/:id/packages/:packageId/fan-out` | operator fan-out (re-runnable, D-63.4) → `fanOutResultSchema`; 400 `invalid_state` unless the package is `ready` |
| POST | `/workspaces/:id/deliverables/:deliverableId/generate` | synchronous single generation (claims if due; 409 `not_due`) |
| POST | `/workspaces/:id/deliverables/:deliverableId/decision` | `{ action, variantId?, reason? }` → machine transition + event |
| POST | `/workspaces/:id/deliverables/run` | bounded synchronous pipeline run → `deliverableRunResultSchema` |

Errors: 400 `invalid_input` / `invalid_transition` / `invalid_state`, 404
`workspace_not_found` / `deliverable_not_found` / `package_not_found` /
`variant_not_found` / `snapshot_not_found`, 409 `not_due`.

## 8. Services

- `apps/api/src/services/deliverables.ts` — slot materialization, fan-out,
  stale sweep, list/detail/decide (+ select), event insert, row→DTO
  mappers.
- `apps/api/src/services/variant-generation.ts` — generation queue
  (claim/retryable/commit, Sprint 62 lease pattern), resolver-input build,
  snapshot capture, `runVariantGeneration`, `runDeliverablePipeline` shared
  by tick and route.
- `services/cadences.ts` — export the slot walker for reuse (no behavior
  change).
- `services/content-packages.ts` — `decidePackage` cancel blocks `ready`
  deliverables (D-63.9).
- `discovery-scheduler.ts` — deliverable phase after the package phase.
- `runtime/operator-policy.ts` — `maxDeliverablesPerTick`,
  `variantTimeoutMs` (+ `< tickTimeoutMs` guard; env overrides
  `DISCOVERY_DELIVERABLE_MAX_ITEMS` / `DISCOVERY_VARIANT_TIMEOUT_MS`,
  documented here — `.env.example` carries none of the 61–63 discovery
  bounds, matching how those sprints shipped).
- `app.ts` — `registerDeliverableRoutes(app, db, llm)` next to
  `registerPackageRoutes`.

## 9. Web — Deliverables page (+ package tie-in)

`apps/web/app/workspaces/[id]/deliverables/page.tsx` + module CSS, following
the packages-page pattern (client component, `apiFetch`, contracts types,
`canTransitionDeliverable`-gated buttons): status filter, deliverable cards
showing lane/channel/format, campaign, kind + scheduled slot, status +
generation-queue state, package angle; expandable detail with the variant
list (content, version, model, candidate/selected/superseded badges), a
context-snapshot inspector (per-section include/exclude trace — the "why
this" precursor), and events; actions Generate now (409-aware), Regenerate,
Select variant, Cancel (reason required); a "Run pipeline" button drives
`POST .../deliverables/run`. Pure derivation (latest variant, selectable
set, slot labels) in `apps/web/lib/deliverable-view.ts` with node-env unit
tests. The Packages page gains a **Fan out** button on `ready` packages.

## 10. Out of scope (Sprint 64+)

Draft/approval-gate handoff and external-action proposal from variants
(`variant.propose_action`); pipeline definitions and the multi-step agentic
generation loop; deliverable-level re-assessment propagation (`assessing`/
`research_needed` producers, D-63.11); media attachment and
`requiresMedia` formats (still blocked at eligibility); reschedule/
slot-editing UI; retiring `posting_cadences`; campaign package caps beyond
Sprint 61's routing policy; embedding-based novelty; Postgres.

## 11. Implementation plan

- **Task 1 — Contracts.** §6 vocabularies, machines, zod, pipeline, nav;
  contracts tests (`deliverables.test.ts`, nav test update).
- **Task 2 — Schema + migration 0069.** §3 tables + `fanned_out_at`,
  `db:generate`, rename + journal tag, `sprint63-migrations.test.ts`
  (partial uniques, set-null survival, defaults, journal idx 69).
- **Task 3 — Deliverables service.** Materialization, fan-out, sweep,
  list/detail/decision/select, package-cancel hook;
  `deliverables.test.ts`.
- **Task 4 — Variant generation.** Queue, resolver-input build, snapshot,
  commit, pipeline runner; `variant-generation.test.ts` with generate-only
  fakes (happy path, lineage on regenerate, retry cap → failed, select →
  fulfilled + superseded, budget skip, fence races).
- **Task 5 — Routes + app wiring.** `deliverables.test.ts` route suite via
  `buildAuthedApp` (membership 404s, decision validation, 409s, run).
- **Task 6 — Tick integration.** Scheduler phase + bounds; operator policy
  test rows; sprint49-acceptance literal update; summary schema fields.
- **Task 7 — Web.** Deliverables page + lib helper + tests; packages page
  Fan-out button; nav.
- **Task 8 — Verify + docs.** `npm test`, `npm run typecheck`, progress
  log, push, Plane sync.

## 12. Acceptance criteria

1. Materialization creates at most `plannedQuantity` slots per week per
   planned lane within the 14-day horizon, is idempotent, and only targets
   active lane revisions of active plan revisions.
2. Fan-out of a `ready` package fills the oldest compatible planned slot
   first, falls back to reactive only when the lane supports it and the
   rolling cap has room, never gives one package two deliverables on one
   lane thread, and is race-safe (fences + partial uniques).
3. Generating a variant stores a context snapshot capturing the full
   resolved trace + prompt + identity inputs; the snapshot route returns
   it; regeneration appends version 2 and leaves version 1 untouched.
4. A malformed/aborted/timeout generation leaves the deliverable retryable
   (`pending`, attempts+1; cap 3 → `failed`) with **no** variant and no
   snapshot; operator regenerate resets the queue.
5. Select fulfills the deliverable, marks the chosen variant `selected` and
   siblings `superseded`; no transition out of `fulfilled` exists; cancel
   of a fulfilled deliverable is rejected `invalid_transition`.
6. Package cancel blocks its `ready` deliverables with events; the stale
   sweep moves passed planned slots to `stale` with events.
7. All lifecycle changes go through `canTransitionDeliverable` /
   `canTransitionVariant` with event rows and actor attribution; `select`
   without `variantId` and `cancel` without reason are schema-rejected.
8. All routes 404 for non-members; two workspaces never see each other's
   deliverables/variants/snapshots.
9. The tick runs the deliverable phase under its bounds; deterministic
   phases run even when the LLM budget is exhausted, generation does not.
10. Legacy suites pass unmodified (additive-only changes documented in the
    progress log). `npm test` and `npm run typecheck` green.

## 13. Risks

- **Tick cost.** One full-context `generate` per variant is the priciest
  call in the discovery tick so far — bounded (10/tick shared with
  fan-outs), budget-gated, and lazy (only `ready` deliverables with
  packages).
- **Weekly-quantity interpretation.** D-63.2 reads `plannedQuantity` as a
  weekly cap (matching the paired recurrence schedule); if the founder
  meant per-plan-timeframe totals, materialization narrows to a cap change
  in one function.
- **Single-shot quality.** v1 variants are single-shot resolver output — no
  critique loop; that is exactly Sprint 64/66's job, and the domain model
  (variant versions + snapshots) is built for it.
- **Migration adjacency.** 0069 assumes Sprint 62's 0068; whichever branch
  merges second renumbers.

## 14. Progress log

- 2026-08-05 — Spec written; branch `sprint-63-deliverables` forked off
  `sprint-62-content-packages` (`25f427c`). Merge order: 61 → 62 → 63.
- 2026-08-05 — Tasks 1–6 implemented. Contracts: deliverable machine
  activated (`DELIVERABLE_TRANSITIONS` exported, `transitionDeliverable`
  added, comment updated per D-63.11), `DELIVERABLE_KINDS`,
  `DELIVERABLE_GENERATION_STATES`, `DELIVERABLE_DECISION_ACTIONS`,
  `VARIANT_STATUSES` + machine, horizon/grace constants, all §6 zod schemas
  (`FAN_OUT_SKIP_REASONS` shipped with three members — `no_reactive_mode`
  was cut as unreachable), `variant_generation` pipeline member,
  Deliverables nav child, summary-schema fields. Migration
  `0069_sprint_63_deliverables` (both §8.10 partial uniques, set-null
  package provenance, snapshot-cascade variants FK) +
  `sprint63-migrations.test.ts` (6). Services: `deliverables.ts`
  (weekly-capped DST-aware slot materialization reusing the exported
  cadence walker, §9.5 fenced fan-out with rolling reactive caps and
  per-lane skip reasons, stale sweep, decide/select/cancel, D-63.9 hook in
  `decidePackage`), `variant-generation.ts` (lease-fenced claim →
  brain-resolved single-shot generate → snapshot + variant commit,
  retry cap 3 → failed, `runDeliverablePipeline`). Routes
  `registerDeliverableRoutes` (7 endpoints incl. the snapshot replay view
  and re-runnable fan-out); scheduler deliverable phase behind
  `maxDeliverablesPerTick`/`variantTimeoutMs`. Suites: contracts
  `deliverables.test.ts` (8), api `deliverables.test.ts` (11),
  `variant-generation.test.ts` (5), `deliverables-routes.test.ts` (5).
- 2026-08-05 — Pre-existing/additive test changes: `operator-policy.test.ts`
  (two new bound rows + variant-timeout guard), `sprint49-acceptance.test.ts`
  (two new policy fields on its literal), contracts `nav-entry.test.ts`
  (`/deliverables` assertion), and `sufficiency.test.ts` — its lane-channel
  literal was **already failing typecheck at Sprint 62 HEAD** (`"instagram"`
  not assignable to `"linkedin"`); widened to `Channel`, no behavior change.
- 2026-08-05 — Task 7 (web): `/deliverables` page (status filter, variant
  list with per-variant "Why this" context-snapshot inspector, machine-gated
  regenerate/select/cancel incl. the failed-queue regenerate, "Generate now"
  with 409 handling, "Run pipeline"), `lib/deliverable-view.ts` + 5 node
  tests, Packages page gained a "Fan out" button on ready packages.
- 2026-08-05 — Task 8 verified: `npm run typecheck` clean, `npm test`
  2476/2476 green (236 files; 2432 at Sprint 62 + 35 new + the widened
  sufficiency literal + 8 policy-row expansions). `.env.example` untouched
  (carries unrelated uncommitted work; see §8 note).
