# Sprint 62 — Content Packages, Sufficiency & Lane Eligibility

**Branch:** `sprint-62-content-packages` · **Plane epic:** TAP-21 · **Size:** XL

Implements §8.7–§8.9 (+ §9.5's sufficiency/eligibility half) of the approved
design `docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
(the design doc is the model authority — this spec is the delivery plan). PRD
reference: `docs/plans/prd-agentic-platform.md` §6, Phase K, Sprint 62.
Activates `PACKAGE_SOURCE_ROLES` (currently dead vocabulary, atlas conflict
#9) and gives `package_created` its first producer. Still **shadow** (Phase
3): no change to legacy triage/accept→signal/automation, and no deliverables —
fan-out to deliverables/variants is Sprint 63.

## 0. Branch and merge order

Sprint 62 "Depends on: 61". Sprint 61 (`sprint-61-campaign-opportunities`,
HEAD `e6e11ad`) is **not yet merged to `main`**, so per the workflow's
dependency caveat this branch forks off that branch. **Merge order: Sprint 61
first, then Sprint 62.** Next migration index on this lineage is **0068**
(last: `0067_sprint_61_campaign_opportunities`); if another branch lands on
`main` first, renumber (Sprint 60/61 convention).

## 1. Scope in one paragraph

A qualified campaign opportunity currently dead-ends: `package_created` is a
reserved status nothing writes. This sprint adds the narrative unit between
opportunity and deliverable: (1) **`content_packages`** — one campaign- and
plan-revision-pinned, source-grounded package per consumed opportunity, with
the chosen angle, a deterministic novelty score (D-61.3's deferred dimension),
and an event-audited lifecycle; (2) **`package_sources`** — typed, snapshotted
source rows (`trigger | evidence | inspiration | instruction |
repurposed_from`) that survive later story/occurrence mutation or deletion;
(3) **`sufficiency_assessments`** — a versioned, validated structured-output
LLM judgment of which claims and formats the sources can support, enforcing
the grounding invariant *every generated claim is supported by package
sources, or the package remains `research_needed`*; (4)
**`lane_eligibility_decisions`** — deterministic per-lane-revision allow/block
evaluations with every reason recorded; and (5) a **channel/format registry**
in contracts that finally gives lane `format` (today an unvalidated free
string) a declared identity, capability flags, and operational state.
Producers: an operator "create package" action on qualified opportunities, an
auto-package tick phase for `auto_package`-band campaigns, and a bounded
sufficiency-assessment phase in the discovery tick — plus synchronous
founder-triggered routes so everything is demonstrable without the worker.

### Invariants (design §1.3, §8.7–§8.9, §9.5)

1. A package belongs to exactly one campaign and plan revision, but may
   reference many source snapshots.
2. Every generated claim is supported by package sources, or the package
   remains `research_needed`. An assessment whose claims cite unknown source
   IDs is a **retryable infrastructure failure**, never a stored judgment;
   an assessment with zero supported claims is stored but can never yield
   `sufficient` (service-enforced, whatever the model says).
3. Source archival never destroys packages or provenance: `package_sources`
   keep their snapshot when the referenced story/occurrence/signal goes away
   (FKs `set null`, snapshot columns stay).
4. Sufficiency and eligibility are versioned, append-only records; the
   package's `status` is a projection of the latest assessment + evaluation,
   moved only through the contracts transition machine with audit events.
5. Business blocks (insufficient evidence, no eligible lane) are **domain
   states** (`research_needed`, `blocked`); infrastructure failures are
   retryable queue states — the two never mix (§8.11 principle).
6. Lane eligibility is evaluated against the package's pinned plan revision's
   lane revisions (immutable once active), so the same (package, assessment,
   lane revision) evaluation is deterministic and idempotent.
7. A package must not target the same angle at the same lane twice (§9.5
   rule 5) — recorded as a blocking eligibility rule against the lane thread.
8. A channel/format is *operational* only when its execution path exists —
   appearing in an enum is not enough (§8.9). The registry states this
   explicitly per entry.
9. All new tables are workspace-scoped behind the standard membership guard.
10. Shadow: no deliverables, no generation, no dispatch, no change to legacy
    discovery/automation flows.

## 2. Founder decisions recorded

- **D-62.1 Packages are opportunity-born.** The only producers are the
  operator action on a `qualified | auto_qualified` opportunity and the
  auto-package phase for `auto_package`-band campaigns (§7 flow: CO → CP).
  `opportunityId` is nullable-with-partial-unique anyway because packages
  must **survive** opportunity/story cascade-deletion (invariant 3); a
  standalone/manual package producer is deferred with the manual-signal
  producer (D-61.2).
- **D-62.2 One package per opportunity.** Consuming an opportunity
  transitions it `→ package_created` (terminal) in the same transaction that
  inserts the package; the partial unique on `opportunityId` makes the pairing
  1:1. "Change angle" (a second package for the same story×campaign) stays
  deferred with the change-angle action (D-61.7).
- **D-62.3 Novelty v1 is deterministic** (D-61.3 completion): novelty = 100
  minus the highest token-overlap percentage between the package's normalized
  angle and the angles of packages created in the same campaign within the
  last `PACKAGE_NOVELTY_WINDOW_DAYS = 30` days. 100 = fully novel. Stored on
  the package at creation; recorded in checks, not used to auto-dismiss (the
  §9.4 novelty gate joins the auto-package policy when the eval set exists,
  D-61.9).
- **D-62.4 Sufficiency is one `cheap`-tier structured call** per package,
  pipeline `sufficiency_assessment`, mirroring the Sprint 61 matcher: metered,
  untrusted-content delimiters, hard ID validation (claim `sourceIds` ⊆ the
  package's source rows; formats ∩ the offered candidate set), retry cap 3 →
  `failed` queue state awaiting operator reassess. The **verdict is derived,
  not trusted**: `sufficient` requires the model's verdict *and* ≥1 validated
  supported claim; otherwise `research_needed` is stored.
- **D-62.5 Lane eligibility is deterministic service code, no LLM.** Rules
  v1 (each recorded `{rule, passed, detail?}`): lane + revision active,
  revision ∈ package's plan revision, format registered for the channel,
  format supported by the assessment, media availability for
  media-requiring formats (v1: packages carry no media sources, so
  `requiresMedia` formats block honestly), angle-repetition against the lane
  thread (§9.5 rule 5, blocking), persona-suggestion recorded non-blocking
  (§7: lane revision is execution authority). Account health, planned-slot
  and reactive-cap arithmetic are Sprint 63 (transactional at deliverable
  creation, §9.5 rule 4).
- **D-62.6 Registry lives in contracts, enforcement starts at eligibility.**
  `CHANNEL_FORMAT_REGISTRY` v1 registers the formats with existing native
  generation/publish paths and their capability flags; unregistered lane
  formats are an eligibility **block**, but lane upsert/validation is
  untouched this sprint (legacy free-string lanes keep working; hard
  registry validation arrives with the §8.9 cutover). `instagram_carousel` is
  registered `requiresMedia: true` — the honest state.
- **D-62.7 Auto-packaging ships gated by the band.** The tick auto-creates
  packages only from `auto_qualified` opportunities of campaigns whose band
  is currently `auto_package`. The band defaults to `review` and D-61.9's
  eval-set exit gate (auto precision ≥95%) remains the governance rule for
  the founder to flip any campaign to `auto_package` — the code path ships,
  the enablement decision does not.
- **D-62.8 Package statuses are their own vocabulary.**
  `assessing | research_needed | ready | blocked | cancelled`, distinct from
  `DELIVERABLE_PRODUCTION_STATUSES` (Sprint 63's deliverable-level lifecycle
  keeps its reserved vocabulary; the name overlap of `assessing`/
  `research_needed` is intentional layering, not reuse).
- **D-62.9 Research queue is representational.** `research_needed` packages
  list `researchActions` + `missingFacts`/`missingMedia` from the assessment
  and support operator `reassess` (e.g. after new corroborating occurrences
  arrive); an automated research/evidence-fetch loop is later phase work.

## 3. Domain model

Migration **0068** (`0068_sprint_62_content_packages.sql`, generated via
`db:generate` then renamed + journal-tagged, per convention).

### 3.1 `content_packages` (§8.7)

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `campaignId` | text NOT NULL → campaigns cascade | pinned (invariant 1) |
| `planRevisionId` | text NOT NULL → campaign_plan_revisions cascade | pinned (invariant 1) |
| `opportunityId` | text nullable → campaign_opportunities **set null** | survives deletion (D-62.1); partial unique below |
| `canonicalStoryId` | text nullable → canonical_external_stories **set null** | display provenance; snapshot lives in the trigger source |
| `angle` | text NOT NULL | chosen angle, copied from the opportunity |
| `angleHash` | text NOT NULL | sha256 of normalized angle (Sprint 61 helper) |
| `novelty` | integer NOT NULL | 0–100, deterministic (D-62.3) |
| `status` | text NOT NULL default `"assessing"` | `PACKAGE_STATUSES` |
| `assessmentState` | text NOT NULL default `"pending"` | `PACKAGE_ASSESSMENT_STATES = pending \| in_progress \| complete \| failed` — infra queue, separate from lifecycle (invariant 5) |
| `assessmentAttempts` | integer NOT NULL default 0 | cap 3 → `failed` |
| `assessmentLeaseExpiresAt` | integer nullable | claim lease (Sprint 61 pattern) |
| `assessedAt` | integer nullable | last completed assessment |
| `createdByUserId` | text nullable → users set null | null = system/auto-package |
| `createdAt` / `updatedAt` | integer NOT NULL | |

Partial unique: `(opportunityId) WHERE opportunity_id IS NOT NULL` (D-62.2).
Indexes: `(workspaceId, status, createdAt)`, `(campaignId, status)`,
`(campaignId, angleHash)` (novelty/repetition lookups), queue index
`(workspaceId, assessmentState, assessmentLeaseExpiresAt)`.

### 3.2 `package_sources` (§8.7)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `packageId` | text NOT NULL → content_packages cascade | |
| `role` | text NOT NULL | `PACKAGE_SOURCE_ROLES` — **activated** |
| `canonicalStoryId` | text nullable → canonical_external_stories set null | |
| `occurrenceId` | text nullable → discovery_source_occurrences set null | |
| `signalId` | text nullable → signals set null | manual-signal path, producer deferred |
| `title` | text NOT NULL default `""` | snapshot |
| `url` | text nullable | snapshot |
| `excerpt` | text NOT NULL default `""` | bounded snapshot (≤2000 chars) |
| `snapshotJson` | text NOT NULL default `"{}"` | full capture (occurrence excerpt, corroboration, captured-at) — snapshot only, never joined |
| `createdAt` | integer NOT NULL | |

Index `(packageId)`. v1 producers write one `trigger` row (the canonical
story) and one `evidence` row per occurrence cited by the opportunity's
supported claims (deduped). `inspiration | instruction | repurposed_from`
are active vocabulary with producers in later sprints.

### 3.3 `sufficiency_assessments` (§8.8)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `packageId` | text NOT NULL → content_packages cascade | |
| `assessmentVersion` | integer NOT NULL | per-package monotonic; unique `(packageId, assessmentVersion)` |
| `verdict` | text NOT NULL | `SUFFICIENCY_VERDICTS = sufficient \| research_needed` (derived, D-62.4) |
| `confidence` | integer NOT NULL | 0–100 |
| `supportedClaimsJson` | text NOT NULL default `"[]"` | `[{ claim, sourceIds[] }]`, sourceIds validated ⊆ package sources |
| `missingFactsJson` | text NOT NULL default `"[]"` | string[] |
| `missingMediaJson` | text NOT NULL default `"[]"` | string[] |
| `eligibleFormatsJson` | text NOT NULL default `"[]"` | string[] ⊆ offered candidate formats |
| `ineligibleFormatsJson` | text NOT NULL default `"[]"` | `[{ format, reason }]` |
| `researchActionsJson` | text NOT NULL default `"[]"` | string[] (D-62.9) |
| `assessorVersion` | integer NOT NULL | `SUFFICIENCY_ASSESSOR_VERSION = 1` |
| `createdAt` | integer NOT NULL | |

Index `(packageId, createdAt)`. Append-only; latest = max
`assessmentVersion`.

### 3.4 `lane_eligibility_decisions` (§8.8)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `packageId` | text NOT NULL → content_packages cascade | |
| `assessmentId` | text NOT NULL → sufficiency_assessments cascade | the exact assessment evaluated against |
| `laneId` | text NOT NULL → campaign_lanes cascade | stable thread (repetition rule) |
| `laneRevisionId` | text NOT NULL → campaign_lane_revisions cascade | the exact revision (§8.8 verbatim) |
| `eligible` | integer (bool) NOT NULL | |
| `checksJson` | text NOT NULL | `[{ rule, passed, detail? }]` — every allow/block reason |
| `evaluatorVersion` | integer NOT NULL | `LANE_ELIGIBILITY_EVALUATOR_VERSION = 1` |
| `createdAt` | integer NOT NULL | |

Unique `(packageId, assessmentId, laneRevisionId)` (invariant 6 idempotency).
Index `(packageId, createdAt)`.

### 3.5 `content_package_events` (audit, §12.1)

Mirror of `campaign_opportunity_events`: `id`, `workspaceId` (cascade),
`packageId` (cascade), `fromStatus` nullable (null = creation), `toStatus`,
`actorUserId` nullable (null = system), `reason` nullable, `createdAt`.
Index `(packageId, createdAt)`. Covers §12.1's package
created/research-needed/blocked events; lane allow/block reasons live on the
decision rows.

## 4. Lifecycle (contracts state machine)

`PACKAGE_STATUSES = assessing | research_needed | ready | blocked |
cancelled` (D-62.8). Defined once in `packages/contracts` as
`PACKAGE_TRANSITIONS` + `canTransitionPackage()` / `transitionPackage()`:

```text
assessing       → ready | research_needed | blocked | cancelled   (system: assessment commit; operator: cancel)
research_needed → assessing | cancelled                           (operator: reassess / cancel)
ready           → assessing | blocked | cancelled                 (operator: reassess; system: re-eval)
blocked         → assessing | ready | cancelled                   (operator: reassess; system: re-eval)
cancelled       → (terminal)
```

Status semantics: `assessing` = awaiting/undergoing sufficiency;
`research_needed` = latest assessment insufficient (domain state, lists
research actions); `ready` = sufficient with ≥1 eligible lane, awaiting
Sprint 63 fan-out; `blocked` = sufficient but zero eligible lanes (every
block reason recorded); `cancelled` = operator withdrawal.

Operator actions (`PACKAGE_DECISION_ACTIONS = reassess | cancel`):
`reassess` → `assessing` (resets `assessmentState` to `pending`, attempts to
0 — the D-62.9 loop); `cancel` → `cancelled` (reason required). Every status
change writes an event row with actor attribution.

Assessment disposition (system, inside the commit transaction):
- verdict `research_needed` → status `research_needed`.
- verdict `sufficient` → evaluate lane eligibility (§5.3) in the same
  transaction → `ready` if any lane eligible, else `blocked` (reason lists
  the blocking rules).

## 5. Producers and evaluation design

### 5.1 Package creation (operator + auto)

`createPackageFromOpportunity(db, workspaceId, opportunityId, actor)` — one
transaction:

1. Load the opportunity; require status ∈ `{qualified, auto_qualified}` and
   `canTransitionOpportunity(status, "package_created")` (else
   `invalid_transition`).
2. Transition the opportunity → `package_created` + opportunity event
   (actor = operator user or system for auto).
3. Compute novelty (D-62.3) against the campaign's recent package angles.
4. Insert the package (`assessing`/`pending`), pinned to the opportunity's
   `campaignId` + `planRevisionId`, angle/angleHash copied.
5. Insert sources: `trigger` (canonical story snapshot: title, canonical
   URL, founding excerpt, corroboration count) + one `evidence` row per
   distinct occurrence cited in the opportunity's supported claims
   (occurrence provider/url/excerpt snapshot).
6. Package creation event (`null → assessing`).

The partial unique on `opportunityId` plus the terminal opportunity status
make double-creation impossible (a concurrent race loses on the unique).

Auto phase (`runAutoPackaging`): for campaigns whose **current** band is
`auto_package`, consume `auto_qualified` opportunities (oldest first, bounded
by the tick budget) through the same function with a system actor. Band
`review`/`off` campaigns are never touched (D-62.7).

### 5.2 Sufficiency assessment (LLM, queue-fenced)

Queue mirrors Sprint 61 story routing: due = `assessmentState = 'pending'`,
or `in_progress` with an expired lease; claim marks `in_progress` + lease;
`markAssessmentRetryable` increments attempts (cap
`ASSESSMENT_MAX_ATTEMPTS = 3` → `failed`, waiting for operator reassess).
`failed` is infra-terminal, never a verdict (invariant 5).

One `generateStructured(meteredLlm(llm, db, { workspaceId, pipeline:
"sufficiency_assessment" }), sufficiencyResponseSchema, { prompt, tier:
"cheap", signal })` call per package. Prompt contains: the campaign profile
context (objective/KPI/pillars/audiences from the routing-profile payload or
plan revision), the package angle, the candidate formats (the plan revision's
active lanes' formats with registry capability notes, e.g. `requiresMedia`),
and the package sources (`id`, `role`, `title`, `excerpt`) inside
untrusted-content delimiters (source text is data, not instructions).

Response per schema: `{ sufficient, confidence, supportedClaims: [{ claim,
sourceIds[] }], missingFacts[], missingMedia[], eligibleFormats[],
ineligibleFormats: [{ format, reason }], researchActions[] }`.

Validation (service, after zod): every `sourceIds` entry ∈ the package's
source-row IDs — an unknown ID is a **retryable failure** (invariant 2), the
§9.2 convention; format lists are intersected with the offered candidate set
(unknown formats dropped, not fatal — they are advisory, unlike claim
grounding). Derived verdict: `sufficient` iff model `sufficient` ∧ ≥1
validated claim.

Commit (one transaction, lease-fenced): re-check `in_progress` + lease
ownership; insert the assessment row (next `assessmentVersion`); if
sufficient, evaluate lane eligibility (§5.3) and insert decision rows;
transition the package (`canTransitionPackage`-guarded) + event;
`assessmentState = 'complete'`, `assessedAt` set, attempts reset.

### 5.3 Lane eligibility (deterministic, D-62.5)

Input: the package, its assessment, and the pinned plan revision's lane
revisions (via `listLaneRevisionsForPlan`). Per lane revision, checks (each
`{ rule, passed, detail? }`):

| rule | blocking | passes when |
|---|---|---|
| `lane_active` | yes | lane revision status `active` ∧ parent lane status `active` |
| `format_registered` | yes | `(channel, format)` ∈ `CHANNEL_FORMAT_REGISTRY` with state `active` |
| `format_supported` | yes | format ∈ assessment `eligibleFormats` (and ∉ `ineligibleFormats`) |
| `media_available` | yes | ¬capability.requiresMedia (v1: no media sources exist — D-62.6) |
| `angle_novel_for_lane` | yes | no prior package in the campaign with the same `angleHash` holds an *eligible* decision on the same `laneId` (§9.5 rule 5) |
| `persona_alignment` | no | always passes; detail notes when the opportunity's suggested persona differs from the lane persona (§7: lane is execution authority) |

`eligible` = all blocking rules pass. Deterministic ⇒ the unique key makes
re-evaluation a no-op. Package `ready` iff ≥1 eligible lane, else `blocked`
with the union of blocking rules in the event reason.

### 5.4 Triggers

- **Discovery tick** (`runDiscoveryScheduler`, after the Sprint 61 routing
  phase, same lease): per workspace, `runPackagePipeline(db, llm, ...)` =
  auto-packaging (D-62.7) + claim/assess due packages. New operator-policy
  bounds: `maxPackagesPerTick` (default 10, env
  `DISCOVERY_PACKAGE_MAX_PACKAGES`, 1–100) shared across auto-creations +
  assessments, and `packageTimeoutMs` (default 45_000, env
  `DISCOVERY_PACKAGE_TIMEOUT_MS`, 5_000–120_000, must stay below
  `tickTimeoutMs`). Skips the LLM stage when `llmBudgetExhausted` (packages
  stay pending). `discoveryRunSummarySchema` gains `packagesCreated` /
  `packagesAssessed` (default 0).
- **Founder-triggered synchronous routes** (D-60.5 precedent): create
  package from an opportunity, assess one package, and a bounded
  `POST /workspaces/:id/packages/run` batch — all demonstrable without the
  worker.

## 6. Channel/format registry (§8.9, contracts)

`CHANNEL_FORMAT_REGISTRY: readonly ChannelFormatCapability[]` where
`ChannelFormatCapability = { channel: Channel, format: string, label,
taskType: TaskType, requiresMedia: boolean, state: "active" | "deprecated" }`.
v1 entries (formats with existing native generation and an execution path —
§8.9's operational-honesty rule):

| channel | format | taskType | requiresMedia |
|---|---|---|---|
| linkedin | `linkedin_post` | `linkedin_post` | no |
| instagram | `instagram_post` | `instagram_post` | no |
| instagram | `instagram_carousel` | `instagram_carousel` | **yes** |
| x | `x_dm` | `x_dm` | no |
| email | `outbound_email` | `outbound_email` | no |
| ads | `meta_ad_creative` | `meta_ad_creative` | no |
| ads | `google_rsa` | `google_rsa` | no |
| pr | `pr_pitch` | `pr_pitch` | no |
| web | `landing_page_hero` | `landing_page_hero` | no |

Helpers: `formatCapability(channel, format)`, `formatsForChannel(channel)`,
`isRegisteredFormat(channel, format)`. Unique `(channel, format)` asserted by
a contracts test. Consumed by lane eligibility only this sprint (D-62.6);
preview/renderer/adapter/outcome columns join when dispatch integrates
(Sprint 63+).

## 7. Contracts additions (`packages/contracts/src/index.ts`)

- `PACKAGE_STATUSES`, `PACKAGE_ASSESSMENT_STATES`,
  `PACKAGE_DECISION_ACTIONS` (+ `PACKAGE_DECISION_TARGETS`),
  `SUFFICIENCY_VERDICTS`, `SUFFICIENCY_ASSESSOR_VERSION = 1`,
  `LANE_ELIGIBILITY_EVALUATOR_VERSION = 1`,
  `PACKAGE_NOVELTY_WINDOW_DAYS = 30`, `ELIGIBILITY_RULES` (the §5.3 rule
  ids).
- `PACKAGE_TRANSITIONS`, `canTransitionPackage`, `transitionPackage` — the
  canonical machine (same pattern as opportunities; no service rolls its
  own).
- `CHANNEL_FORMAT_REGISTRY` + helpers (§6). `PACKAGE_SOURCE_ROLES` keeps its
  declaration (now-active comment updated).
- Zod: `packageSourceSchema`, `sufficiencyClaimSchema`,
  `sufficiencyAssessmentSchema`, `laneEligibilityCheckSchema`,
  `laneEligibilityDecisionSchema` (+ lane name/channel/format projection),
  `contentPackageSchema` (list projection incl. `campaignName`,
  `storyTitle`, latest verdict), `packageDetailSchema` (`{ package, sources,
  assessments, eligibility, events }`), `listPackagesResponseSchema`,
  `packageDecisionInputSchema` (superRefine: `cancel` requires reason),
  `packageEventSchema`, `sufficiencyResponseSchema` (structured output,
  shape-tolerant per Sprint 58 convention), `packageRunResultSchema`
  (`{ packagesCreated, packagesAssessed, failures }`).
- `LLM_PIPELINES` gains `"sufficiency_assessment"`.
- Nav: child `{ label: "Packages", path: "/packages" }` under **Discover**,
  after Opportunities (the shadow-layer trio: inbox → opportunities →
  packages → stories).
- `discoveryRunSummarySchema` gains `packagesCreated` / `packagesAssessed`.

## 8. API surface — `apps/api/src/routes/packages.ts`

`registerPackageRoutes(app, db, llm)`, workspace-guarded:

| Method | Path | Behavior |
|---|---|---|
| GET | `/workspaces/:id/packages?status=&campaignId=&limit=&offset=` | paginated `{ packages, total }` (validated limit/offset) |
| GET | `/workspaces/:id/packages/:packageId` | detail: package + sources + assessments + eligibility + events |
| POST | `/workspaces/:id/opportunities/:opportunityId/package` | operator create (D-62.2) → 201 detail; 400 `invalid_transition` when not qualified/auto_qualified |
| POST | `/workspaces/:id/packages/:packageId/assess` | synchronous single assessment (claims if due; 409 `not_due` when not pending/failed-lease state) |
| POST | `/workspaces/:id/packages/:packageId/decision` | `{ action: reassess \| cancel, reason? }` → contracts transition + event |
| POST | `/workspaces/:id/packages/run` | bounded synchronous pipeline run → `packageRunResultSchema` |

Errors: 400 `invalid_input` / `invalid_transition`, 404
`workspace_not_found` / `package_not_found` / `opportunity_not_found`, 409
`not_due`.

## 9. Services

- `apps/api/src/services/content-packages.ts` — creation (operator + the
  novelty computation), list/detail projections, `decidePackage`
  (transition + event), shared row→DTO mappers.
- `apps/api/src/services/sufficiency.ts` — assessment queue
  (claim/retryable/commit, Sprint 61 lease pattern), prompt build,
  response validation, `runPackageAssessments`, `runAutoPackaging`,
  `runPackagePipeline(db, llm, { workspaceId, limit, leaseMs, timeoutMs,
  signal? })` shared by tick and route.
- `apps/api/src/services/lane-eligibility.ts` — the §5.3 evaluator (pure
  rule evaluation + persistence), registry-backed.
- `discovery-scheduler.ts` — package phase after the routing phase.
- `runtime/operator-policy.ts` — `maxPackagesPerTick`, `packageTimeoutMs`
  (+ `< tickTimeoutMs` guard, `.env.example` entries).
- `app.ts` — `registerPackageRoutes(app, db, llm)` next to
  `registerOpportunityRoutes`.

## 10. Web — Packages page (+ opportunity tie-in)

`apps/web/app/workspaces/[id]/packages/page.tsx` + module CSS, following the
opportunities-page pattern (client component, `apiFetch`, contracts types,
`canTransitionPackage` gating buttons): status/campaign filters, package
cards showing angle, novelty, status, latest verdict + confidence, supported
claims with source titles, missing facts/media, research actions, and the
lane eligibility table with per-rule check chips; actions reassess (with
optional reason) / cancel (reason required); a "Run pipeline" button drives
`POST .../packages/run`. Pure derivation (blocking-reason summary, latest
assessment selection) factored into `apps/web/lib/package-view.ts` with a
node-env unit test (Sprint 61 convention). The Opportunities page gains a
**Create package** button on `qualified | auto_qualified` rows.

## 11. Out of scope (Sprint 63+)

Deliverables, variants, context snapshots and the §9.5 fan-out/caps
arithmetic; generation from packages; media sources and asset attachment;
automated research execution (D-62.9); `inspiration | instruction |
repurposed_from` producers; manual-signal/standalone packages; change-angle;
registry enforcement in lane validation and the renderer/adapter/outcome
registry columns; sensitive-topic rules; retiring legacy flows; Postgres.

## 12. Implementation plan

- **Task 1 — Contracts.** §7 vocabularies, machine + registry + zod +
  pipeline + nav; contracts tests (`packages.test.ts`, nav test update).
- **Task 2 — Schema + migration 0068.** §3 tables, `db:generate`, rename +
  journal tag, `sprint62-migrations.test.ts` (uniques, partial unique,
  set-null survival, defaults, journal idx 68).
- **Task 3 — Package service.** Creation (transition + sources + novelty),
  list/detail/decision; `content-packages.test.ts`.
- **Task 4 — Sufficiency + eligibility.** Queue, prompt, validation, commit,
  evaluator, auto-packaging, pipeline runner; `sufficiency.test.ts` with
  generate-only fakes (happy path → `ready`, research_needed, invented
  source IDs retryable, attempts cap → failed, zero-claims override,
  media-block, repetition-block, blocked-no-lanes, reassess loop,
  idempotency).
- **Task 5 — Routes + app wiring.** `packages.test.ts` route suite via
  `buildAuthedApp` (membership 404s, pagination validation, create/assess/
  decision/run, outsider 403/404).
- **Task 6 — Tick integration.** Scheduler package phase + bounds; operator
  policy test rows; sprint49-acceptance stub branch for the new prompt
  marker (Sprint 61 lesson).
- **Task 7 — Web.** Packages page + lib helper + test; opportunities page
  Create-package button; nav.
- **Task 8 — Verify + docs.** `npm test`, `npm run typecheck`, progress log,
  push, Plane sync.

## 13. Acceptance criteria

1. Creating a package from a `qualified`/`auto_qualified` opportunity
   transitions it to `package_created` with an event, snapshots trigger +
   evidence sources, computes novelty, and is 1:1-idempotent (second attempt
   → `invalid_transition`; concurrent race loses on the partial unique).
2. Deleting the canonical story (or its occurrences) leaves the package and
   its source snapshots intact (invariant 3).
3. An assessment with zero validated supported claims can never store
   `sufficient` — the package lands in `research_needed` regardless of the
   model's verdict (invariant 2).
4. A claim citing an unknown source ID, malformed output, timeout, or budget
   abort leaves the package retryable (`pending`, attempts+1; cap 3 →
   `failed`) with **no** assessment row — never a stored judgment.
5. A sufficient assessment evaluates every active lane revision of the
   pinned plan revision, records every allow/block reason, and lands the
   package `ready` (≥1 eligible) or `blocked` (0 eligible); re-evaluating
   the same (package, assessment) is a no-op.
6. `requiresMedia` formats (instagram_carousel) and unregistered formats
   block with the correct rule; the same angle aimed at the same lane twice
   blocks on `angle_novel_for_lane`.
7. Auto-packaging consumes `auto_qualified` opportunities only for
   campaigns currently banded `auto_package`; `review`-band campaigns are
   untouched.
8. All lifecycle changes go through `canTransitionPackage` with event rows
   and actor attribution; illegal transitions return 400
   `invalid_transition`; `cancel` requires a reason.
9. All routes 404 for non-members; two workspaces never see each other's
   packages.
10. Legacy suites pass unmodified (additive-only test changes documented in
    the progress log). `npm test` and `npm run typecheck` green.

## 14. Risks

- **Tick cost.** One cheap LLM call per package, bounded (10/tick shared
  with auto-creation), budget-gated, lazy.
- **Registry conservatism.** Lanes using unregistered free-string formats
  block at eligibility — visible and honest in shadow, but founders with
  exotic lane formats will see `format_registered` blocks; the registry list
  is easy to extend.
- **Novelty is lexical.** Token overlap misses semantic repetition;
  acceptable for v1, embedding-based novelty is later phase work.
- **Migration adjacency.** 0068 assumes Sprint 61's 0067; whichever branch
  merges second renumbers.

## 15. Progress log

- 2026-08-05 — Spec written; branch `sprint-62-content-packages` forked off
  `sprint-61-campaign-opportunities` (`e6e11ad`). Merge order: 61 → 62.
- 2026-08-05 — Tasks 1–6 implemented. Contracts: `PACKAGE_STATUSES` +
  `canTransitionPackage`/`transitionPackage` machine, assessment queue
  states, decision actions/targets, sufficiency verdicts, eligibility rules,
  `CHANNEL_FORMAT_REGISTRY` + helpers, all §7 zod schemas,
  `sufficiency_assessment` pipeline member, Packages nav child;
  `PACKAGE_SOURCE_ROLES` comment updated to "activated". Migration
  `0068_sprint_62_content_packages` (partial unique on `opportunity_id`,
  set-null provenance FKs) + `sprint62-migrations.test.ts` (5 tests incl.
  story-graph-deletion survival). Services: `content-packages.ts`
  (fenced opportunity consumption, trigger/evidence snapshots, deterministic
  Jaccard novelty, list/detail/decide incl. the failed-queue reassess reset),
  `lane-eligibility.ts` (six-rule deterministic evaluator, §9.5 lane-angle
  repetition via prior eligible decisions), `sufficiency.ts` (lease-fenced
  claim/retry/commit, untrusted-source prompt, hard sourceId validation with
  derived verdict, auto-packaging, `runPackagePipeline`). Routes
  `registerPackageRoutes` (+ targeted single-package assess via a
  `packageId` claim filter, 409 `not_due`); scheduler package phase with new
  `maxPackagesPerTick`/`packageTimeoutMs` bounds;
  `discoveryRunSummarySchema` gained `packagesCreated`/`packagesAssessed`.
  Suites: contracts `packages.test.ts` (6), api `content-packages.test.ts`
  (6), `sufficiency.test.ts` (10), `packages.test.ts` routes (7).
- 2026-08-05 — Three pre-existing tests updated for additive reasons:
  `operator-policy.test.ts` (two new bound rows),
  `sprint49-acceptance.test.ts` (two new policy fields on its literal;
  no LLM-stub branch needed — the package phase makes no calls in that
  choreography since no packages exist), `nav-entry.test.ts` (contracts,
  `/packages` assertion). `sprint53-suggested-columns.test.ts` needed no new
  allowlist entry — Sprint 62 code avoids the guarded name pattern.
- 2026-08-05 — Task 7 (web): `/packages` page (status filter, expandable
  detail with sources/assessment/eligibility-table/events, machine-gated
  reassess+cancel incl. the failed-queue reset, "Assess now" with 409
  handling, "Run pipeline"), `lib/package-view.ts` helpers + 7 node tests,
  and the Opportunities page gained a gated "Create package" button.
- 2026-08-05 — Task 8 verified: `npm run typecheck` clean, `npm test`
  2432/2432 green (227 files). Branch pushed; Plane TAP-21 synced.
