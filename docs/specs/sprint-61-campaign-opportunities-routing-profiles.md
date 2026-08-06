# Sprint 61 — Campaign Opportunities & Routing Profiles

**Branch:** `sprint-61-campaign-opportunities` · **Plane epic:** TAP-20 · **Size:** XL

Implements §8.5–§8.6 and §9 (matching & routing) of the approved design
`docs/superpowers/specs/2026-07-22-discovery-intelligence-infrastructure-design.md`
(the design doc is the model authority — this spec is the delivery plan, not a
re-plan). PRD reference: `docs/plans/prd-agentic-platform.md` §6, Phase K,
Sprint 61. Replaces the flat 0–100 relevance score as the autonomy governor
(design §6.3) — **in shadow** (Phase 3): the legacy `discovered_item_matches`
scoring and accept→signal→automation flow are untouched.

## 0. Branch and merge order

Sprint 61 "Depends on: 60, 53". Both are on `main` (Sprint 60 merged in PR #26
at `f76bd80`; Sprint 53 merged earlier). This branch forks directly off
`origin/main` and has no dependency on any unmerged branch. Next migration
index on `main` is **0067** (last: `0066_sprint_60_canonical_stories`).

## 1. Scope in one paragraph

Today a discovered item gets one global 0–100 relevance score against a prompt
that reads only `campaigns.*` row columns — campaign plans and lanes are never
consulted (`buildMatchingContext`, `apps/api/src/services/matching.ts:88-126`),
which is exactly the §6.6 gap. This sprint adds, in shadow alongside that
flow: (1) **`campaign_routing_profiles`** — a compiled, versioned, fingerprinted
projection of each active campaign's current plan revision + active lane
revisions (objective, KPI, timeframe, audiences, pillars, offers, CTAs,
personas/channels/formats represented by active lanes, routing policy); and
(2) **`campaign_opportunities`** — immutable matcher decisions per
story × campaign × angle with separate score dimensions, a validated
structured-output matcher, policy-band disposition
(`off | review | auto_package`), and an independent per-campaign lifecycle
(dismissing for Campaign A never dismisses for Campaign B). Canonical stories
(Sprint 60) are routed through a two-stage matcher inside the existing
discovery tick; a server-paginated **Opportunities** page (child of Discover)
makes the shadow layer visible and operable.

### Invariants (design §1.3, §6, §9)

1. One story may create several opportunities with different angles; each
   story×campaign decision is independent.
2. The matcher's judgment fields (scores, angle, claims, reason) are immutable
   once written; only lifecycle status moves, with actor + reason audit.
3. An LLM parse failure, timeout, or invalid-evidence result is **never**
   stored as "not relevant" — it is a retryable routing failure (§9.2).
4. Separate score dimensions are real columns; a composite sort is a
   projection, never a replacement (§9.3). JSON columns hold snapshots only.
5. Profiles are derived data; the plan revision + lane revisions remain the
   authority (§7). Same inputs ⇒ same fingerprint ⇒ no new profile row.
6. Discovery matches stories to at most a few candidate campaigns (normally
   three), never directly to lanes (§6.2, §9.1).
7. All new tables are workspace-scoped behind the standard membership guard.
8. Shadow only: no change to `discovered_items` triage, accept→signal,
   `signal_matches`, or `runAutomation` routing.

## 2. Founder decisions recorded

- **D-61.1 Routing policy lives on the campaign** (new columns), not on the
  immutable plan revision — precedent: `automationMode`, `autoDailyCap`.
  Default band is **`review`**: in shadow nothing auto-packages anyway, and
  `review` produces visible needs-review volume for calibration. `off`
  excludes a campaign from routing entirely.
- **D-61.2 Manual-signal opportunities: schema now, producer later.** §8.6's
  XOR (`canonicalStoryId` ⊕ `manualSignalId`) is modeled and enforced, but the
  only producer this sprint is the story matcher. Signal-triggered
  opportunities arrive when the accept→signal path is rewired (Phase 5) —
  same "vocabulary ships once" convention as D-60.3.
- **D-61.3 Novelty deferred to Sprint 62.** §9.3's novelty/repetition
  dimension needs package/angle history that does not exist yet. The
  `angleHash` uniqueness key already prevents exact same-angle re-creation;
  a novelty column ships with packages. Stored dimensions this sprint:
  workspace relevance, campaign fit, confidence, actionability (matcher) +
  source trust (deterministic, from corroboration) + freshness as `expiresAt`.
- **D-61.4 Source trust v1 is deterministic:** `corroborationCount >= 3 → 90`,
  `= 2 → 75`, `= 1 → 60` (single-source default; no source-class registry
  yet). `routingMinTrust` defaults to 0 so it gates nothing until tuned.
- **D-61.5 `package_created` status is reserved** (no producer until
  Sprint 62), like `PACKAGE_SOURCE_ROLES`. The transition map includes it so
  the state machine ships once.
- **D-61.6 Matcher tier is `cheap`**, pipeline `opportunity_matching`,
  consistent with `discovery_matching`. Per-step tier routing is Sprint 64
  configuration.
- **D-61.7 Daily package caps, sensitive-topic rules, snooze, change-angle,
  and request-research actions are deferred** (need packages/research
  machinery). Policy v1 = band + min fit/confidence/trust + exclusion
  keywords. Operator actions v1 = qualify, dismiss, watch, reopen.
- **D-61.8 Exclusion keywords are a JSON list on the campaign**
  (`routingExclusionsJson`), applied in the compiler/stage-1 service code.
  This is policy configuration consumed as a value blob — never joined or
  SQL-filtered — so it does not violate the no-JSON-for-filterable-fields
  invariant (the *filterable* outputs — band, thresholds, scores, status —
  are all real columns).
- **D-61.9 Labeled evaluation set (Phase 3 exit gate: recall ≥90%, auto
  precision ≥95%) is a founder activity** once shadow volume accumulates; the
  promotion harness is not in this sprint. The exit gate blocks enabling
  auto-package (Sprint 62+), not this shadow ship.

## 3. Domain model

Migration **0067** (`0067_sprint_61_campaign_opportunities.sql`, generated via
`db:generate` then renamed + journal-tagged, per convention).

### 3.1 `campaigns` — added routing-policy columns

| column | type | notes |
|---|---|---|
| `routingBand` | text NOT NULL default `"review"` | `ROUTING_POLICY_BANDS = off \| review \| auto_package` |
| `routingMinFit` | integer NOT NULL default 70 | 0–100 |
| `routingMinConfidence` | integer NOT NULL default 60 | 0–100 |
| `routingMinTrust` | integer NOT NULL default 0 | 0–100; 0 = not enforced (D-61.4) |
| `routingExclusionsJson` | text NOT NULL default `"[]"` | keyword list (D-61.8), ≤50 entries, each ≤80 chars |

### 3.2 `campaign_routing_profiles` (§8.5)

Compiled candidate-retrieval/matching context for one active plan revision.
Append-only: recompiling with identical inputs is a no-op; any input change
inserts a new row with a bumped per-campaign `profileVersion`.

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `campaignId` | text NOT NULL → campaigns cascade | |
| `planRevisionId` | text NOT NULL → campaign_plan_revisions cascade | the revision that was active at compile time |
| `profileVersion` | integer NOT NULL | per-campaign monotonic |
| `profileFingerprint` | text NOT NULL | sha256 over canonical JSON of the compiled payload + compiler version |
| `routingBand` | text NOT NULL | snapshot of campaign policy at compile time |
| `minFit` / `minConfidence` / `minTrust` | integer NOT NULL | snapshots |
| `compilerVersion` | integer NOT NULL | `ROUTING_PROFILE_COMPILER_VERSION = 1` |
| `payloadJson` | text NOT NULL | compiled projection (below) — snapshot only |
| `createdAt` | integer NOT NULL | |

Unique: `(campaignId, planRevisionId, profileFingerprint)` (§8.5 verbatim) and
`(campaignId, profileVersion)`. Index: `(workspaceId, campaignId)`.
Current profile = max `profileVersion` for the campaign.

**Payload** (compiled from plan revision + active lane revisions + campaign
policy): `{ objective, kpi, timeframe, startAt, endAt, audiences[],
pillars[], offers[], ctas[], guidance (≤500 chars), personaIds[] (distinct,
from active lanes), channels[] (distinct), formats[] (distinct), exclusions[],
campaignName }`. Fulfillment gaps (§7) join in Sprint 63 when deliverables
exist.

### 3.3 `campaign_opportunities` (§8.6)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `workspaceId` | text NOT NULL → workspaces cascade | |
| `canonicalStoryId` | text nullable → canonical_external_stories cascade | XOR with `manualSignalId` |
| `manualSignalId` | text nullable → signals cascade | producer deferred (D-61.2) |
| `campaignId` | text NOT NULL → campaigns cascade | |
| `planRevisionId` | text NOT NULL → campaign_plan_revisions cascade | |
| `routingProfileId` | text NOT NULL → campaign_routing_profiles | the exact profile version used |
| `status` | text NOT NULL | `OPPORTUNITY_STATUSES`, below |
| `angle` | text NOT NULL | proposed angle |
| `angleHash` | text NOT NULL | sha256 of normalized angle text |
| `workspaceRelevance` | integer NOT NULL | 0–100 |
| `campaignFit` | integer NOT NULL | 0–100 |
| `confidence` | integer NOT NULL | 0–100 |
| `actionability` | integer NOT NULL | 0–100 |
| `sourceTrust` | integer NOT NULL | deterministic (D-61.4) |
| `suggestedPersonaId` | text nullable, no FK | recommendation snapshot; validated ∈ profile personas at write, else null (design §7: lane revision stays execution authority) |
| `supportedClaimsJson` | text NOT NULL default `"[]"` | `[{ claim, occurrenceIds[] }]`, occurrence IDs validated against the story's active members |
| `reason` | text NOT NULL | bounded matcher reason |
| `matcherVersion` | integer NOT NULL | `OPPORTUNITY_MATCHER_VERSION = 1` |
| `policyJson` | text NOT NULL | disposition snapshot `{ band, checks: [{ rule, threshold, value, passed }] }` |
| `expiresAt` | integer nullable | from matcher `expiresInDays` (clamped 1–30; null = no decay) |
| `decidedByUserId` | text nullable | last operator decision |
| `decidedAt` | integer nullable | |
| `decisionReason` | text nullable | |
| `createdAt` / `updatedAt` | integer NOT NULL | |

XOR invariant: SQLite `CHECK ((canonical_story_id IS NULL) <> (manual_signal_id IS NULL))`
plus service validation.

Partial uniques (§8.6 verbatim):

```text
(canonical_story_id, campaign_id, plan_revision_id, angle_hash, matcher_version)
  WHERE canonical_story_id IS NOT NULL
(manual_signal_id, campaign_id, plan_revision_id, angle_hash, matcher_version)
  WHERE manual_signal_id IS NOT NULL
```

Indexes: `(workspaceId, status, createdAt)`, `(canonicalStoryId)`,
`(campaignId, status)`.

### 3.4 `campaign_opportunity_events` (audit, §11.4 / §12.1)

Append-only status history: `id`, `workspaceId` (FK cascade),
`opportunityId` (FK cascade), `fromStatus` nullable (null = creation),
`toStatus`, `actorUserId` nullable (null = system), `reason` nullable,
`createdAt`. Index `(opportunityId, createdAt)`.

### 3.5 `canonical_external_stories` — added routing-queue columns

Mirrors the `discovered_items` matching-state machinery
(`schema.ts:510-516`, lease fence in `services/discovery-matching.ts`):

| column | type | notes |
|---|---|---|
| `routingState` | text NOT NULL default `"pending"` | `STORY_ROUTING_STATES = pending \| in_progress \| routed \| failed` |
| `routingFingerprint` | text nullable | what the last successful run saw (below) |
| `routingLeaseExpiresAt` | integer nullable | |
| `routingAttempts` | integer NOT NULL default 0 | failed runs go retryable with attempt cap 3 → `failed` |
| `routedAt` | integer nullable | |

Routing fingerprint = sha256 of: story's current enrichment content
fingerprint + sorted current profile fingerprints of eligible campaigns +
matcher version. A story is due when `routingState = 'pending'`, or when
`routed`/`failed` with a stale fingerprint (plan/lane/policy/membership
change re-queues it — the recompute-on-drift analog of
`matching-invalidation.ts`).

## 4. Lifecycle (contracts state machine)

`OPPORTUNITY_STATUSES = candidate | auto_qualified | qualified | needs_review
| watchlisted | dismissed | package_created | expired | superseded`.
`qualified` is the operator's qualification; `auto_qualified` is policy's —
both are "qualified" inputs for Sprint 62 package creation.

Transitions (defined once in `packages/contracts` as
`canTransitionOpportunity()` / `transitionOpportunity()` — the same pattern as
`transitionTo` / `canTransitionExternalAction`; no service rolls its own):

```text
candidate      → auto_qualified | needs_review | watchlisted | dismissed   (system, policy application)
needs_review   → qualified | dismissed | watchlisted                       (operator)
watchlisted    → qualified | dismissed | needs_review                      (operator: reopen)
auto_qualified → dismissed                                                 (operator override)
qualified      → dismissed                                                 (operator override)
dismissed      → needs_review                                              (operator: reopen/undo, §11.5)
auto_qualified | qualified | needs_review | watchlisted | candidate
               → expired                                                   (system sweep, past expiresAt)
auto_qualified | qualified | needs_review | watchlisted | candidate
               → superseded                                                (system, newer plan-revision decision)
auto_qualified | qualified → package_created                               (reserved, Sprint 62)
```

Operator actions map (`OPPORTUNITY_DECISION_ACTIONS = qualify | dismiss |
watch | reopen`): `qualify` → `qualified`; `dismiss` → `dismissed`; `watch` →
`watchlisted`; `reopen` → `needs_review`. Every transition writes an event
row; operator transitions require a reason for `dismiss` and `reopen`.

### Policy-band disposition (§9.4, applied at creation in the same txn)

- Exclusion keyword hit (angle/claims/story text) → `dismissed`
  (policy check recorded; stage 1 normally filters these before the LLM).
- Band `review`: `campaignFit >= minFit` → `needs_review`, else `watchlisted`.
- Band `auto_package`: fit ≥ minFit ∧ confidence ≥ minConfidence ∧ trust ≥
  minTrust → `auto_qualified`; fit ≥ minFit but confidence/trust short →
  `needs_review`; fit < minFit → `watchlisted`.
- Band `off`: campaign never reaches the matcher (stage-1 filter).

Every row starts as `candidate` and is transitioned by policy in the same
transaction, so the audit trail records both steps.

## 5. Matching design (§9.1–§9.2)

### Stage 1 — deterministic candidate retrieval (no LLM)

For a due story, eligible campaigns are: status `active`, `routingBand !=
'off'`, `currentPlanRevisionId` set, and plan timeframe current (`endAt`
null or ≥ now). Per campaign: drop it if any exclusion keyword matches the
story text (title + founding excerpt + title variants); otherwise score
lexical token overlap between story text and the profile's keyword bag
(name, objective, KPI, pillars, offers, CTAs, audiences). Retain the top
**3** by overlap (ties: older campaign first) — the explicit boundary that
keeps growth from pushing every campaign into every prompt (§9.1). Zero
eligible candidates ⇒ story goes `routed` with no opportunities and no LLM
call.

### Stage 2 — validated structured matcher

One `generateStructured(meteredLlm(llm, db, { workspaceId, pipeline:
"opportunity_matching" }), opportunityMatcherResponseSchema, { prompt, tier:
"cheap", signal })` call per story (all candidates in one prompt). The prompt
contains only: the canonical story (title, canonical URL, founding excerpt,
title variants, corroboration summary, active occurrence IDs), the candidate
profiles' compiled payloads, and untrusted-content delimiters instructing the
model that story content is data, not instructions (§9.2). Response, per
candidate: `{ campaignId, relevant, workspaceRelevance, campaignFit,
confidence, actionability, angle, supportedClaims: [{ claim,
occurrenceIds[] }], suggestedPersonaId?, expiresInDays?, reason }`.

Validation (service, after zod): campaign IDs ⊆ candidate set; occurrence IDs
⊆ the story's active members; persona ∈ profile personas else nulled. An
unknown campaign/occurrence ID, `StructuredOutputError`, timeout, or budget
abort ⇒ the story's routing attempt fails **retryable** (`pending` again,
attempts+1; cap 3 → `failed`) — never stored as no-match (invariant 3).
`relevant: false` candidates produce no row; idempotency comes from the
routing fingerprint, not from tombstones.

### Commit (one transaction, fingerprint-fenced)

Mirrors `commitMatchingResult` (`discovery-matching.ts:284-352`): re-derive
the routing fingerprint inside the txn; on drift reset to `pending` and
discard. Otherwise: insert opportunities (`onConflictDoNothing` on the
partial unique — an angle already decided at this matcher version stays
immutable), apply policy disposition, write events, supersede active
opportunities of the same story×campaign at older plan revisions, set
`routingState = 'routed'`, `routingFingerprint`, `routedAt`.

### Triggers

- **Discovery tick** (`runDiscoveryScheduler`, after the existing matching
  loop at `discovery-scheduler.ts:336-369`, same task lease): per workspace —
  lazily compile profiles (no-op on unchanged fingerprints), expire overdue
  opportunities, claim up to `maxRoutingStoriesPerTick` (default 10) due
  stories with the same lease/fence pattern, run stages 1–2. Skips the LLM
  stage when `llmBudgetExhausted` (stories stay pending). New operator-policy
  bounds: `maxRoutingStoriesPerTick`, `routingTimeoutMs` (45s).
- **Founder-triggered synchronous run** — `POST
  /workspaces/:id/opportunities/match` (D-60.5 precedent), bounded by the
  same per-tick cap, so the shadow layer is demonstrable without the worker.

## 6. Contracts additions (`packages/contracts/src/index.ts`)

- `ROUTING_POLICY_BANDS`, `OPPORTUNITY_STATUSES`,
  `OPPORTUNITY_DECISION_ACTIONS`, `STORY_ROUTING_STATES`,
  `OPPORTUNITY_MATCHER_VERSION = 1`, `ROUTING_PROFILE_COMPILER_VERSION = 1`.
- `canTransitionOpportunity` / `transitionOpportunity` (+ an
  `OpportunityTransitionError`), with the operator/system edge distinction.
- Zod: `campaignRoutingProfileSchema` (payload parsed),
  `campaignOpportunitySchema` (list projection incl. story title/URL +
  campaign name), `opportunityDetailSchema` (+ profile + events),
  `listOpportunitiesResponseSchema`, `opportunityDecisionInputSchema`,
  `routingPolicyPatchSchema`, `opportunityMatcherResponseSchema` (structured
  output; shape-only tolerance per the Sprint 58 comment convention),
  `opportunityMatchRunResultSchema`.
- `LLM_PIPELINES` gains `"opportunity_matching"`.
- Nav: new child `{ label: "Opportunities", path: "/opportunities" }` under
  **Discover**, after Signal inbox (design §11.2 calls it the default daily
  view; Signal inbox keeps the top-level path until cutover).

## 7. API surface — `apps/api/src/routes/opportunities.ts`

`registerOpportunityRoutes(app, db, llm)`, workspace-guarded:

| Method | Path | Behavior |
|---|---|---|
| GET | `/workspaces/:id/opportunities?status=&campaignId=&storyId=&limit=&offset=` | paginated `{ opportunities, total }` (validated limit/offset — Sprint 60 lesson) |
| GET | `/workspaces/:id/opportunities/:opportunityId` | detail: opportunity + story summary + campaign + exact profile + event history |
| POST | `/workspaces/:id/opportunities/:opportunityId/decision` | `{ action, reason? }` → contracts transition, actor attributed, event written |
| GET | `/workspaces/:id/campaigns/:campaignId/routing-profile` | current compiled profile (compiles lazily; 404 `no_active_plan` without an active revision) |
| PATCH | `/workspaces/:id/campaigns/:campaignId/routing-policy` | `{ band?, minFit?, minConfidence?, minTrust?, exclusions? }` → update campaign columns, recompile, return profile |
| POST | `/workspaces/:id/opportunities/match` | bounded synchronous shadow run → `{ storiesConsidered, storiesRouted, opportunitiesCreated, failures }` |

Errors follow conventions: 400 `invalid_input` / `invalid_transition`, 404
`workspace_not_found` / `opportunity_not_found` / `campaign_not_found` /
`no_active_plan`.

## 8. Services

- `apps/api/src/services/routing-profiles.ts` — `compileRoutingProfile(db,
  workspaceId, campaignId)` (deterministic; returns current row, inserting
  only on fingerprint change), `currentRoutingProfiles(db, workspaceId)`,
  `updateRoutingPolicy(...)`.
- `apps/api/src/services/opportunity-matching.ts` — stage 1
  (`selectCandidates`), prompt build, stage 2 + validation, fingerprint
  derivation, claim/lease/commit, expiry sweep, `runOpportunityRouting(db,
  llm, workspaceId, { limit, signal })` shared by tick and route.
- `apps/api/src/services/opportunities.ts` — list/detail/decision (transition
  + event), shared projections.
- `discovery-scheduler.ts` — routing phase after the matching loop.
- `runtime/operator-policy.ts` — the two new bounds.

## 9. Web — Opportunities page

`apps/web/app/workspaces/[id]/opportunities/page.tsx` + module CSS, following
the `/stories` page pattern (client component, `apiFetch`, contracts types):
stories grouped with expandable campaign opportunities (§11.2) — status/
campaign filters, score-dimension chips (fit/confidence/trust — dimensions
stay separate, §9.3), angle + reason, expiry, and per-opportunity actions
(qualify / dismiss / watch / reopen with a reason prompt where required); a
"Run matching" button drives `POST .../opportunities/match`. A small
routing-policy editor (band + thresholds + exclusions) appears on the
campaign detail page or inline per campaign filter — kept minimal; the full
§11 operator surface lands with cutover.

## 10. Out of scope (Sprint 62+)

Content packages and `package_created` production; sufficiency/lane
eligibility; novelty scoring; auto-package execution (band `auto_package`
only labels `auto_qualified` in shadow); manual-signal producers; snooze /
change-angle / request-research; sensitive-topic rules; daily caps; the
labeled eval set + promotion harness (D-61.9); retiring
`discovered_item_matches` or the accept→signal path; Postgres.

## 11. Implementation plan

- **Task 1 — Contracts.** Vocabularies, transition machine + tests, zod
  schemas, pipeline member, nav child. (§6)
- **Task 2 — Schema + migration 0067.** §3 tables/columns, `db:generate`,
  rename + journal tag, migration-shape test (`sprint61-migrations.test.ts`).
- **Task 3 — Routing profiles service.** Compiler + policy update +
  determinism/versioning tests.
- **Task 4 — Opportunity matching service.** Stages 1–2, fingerprints,
  lease/claim/commit, policy disposition, supersede, expiry; tests with
  `ScriptedGateway` (constrained path) + generate-only fakes, including
  retryable-failure invariants.
- **Task 5 — Opportunities service + routes + app wiring.** Route tests via
  `buildAuthedApp` (membership 404s, pagination validation, transitions,
  policy PATCH, match run).
- **Task 6 — Tick integration.** Discovery-scheduler routing phase + bounds +
  budget-exhausted behavior; scheduler tests.
- **Task 7 — Web page + nav.** Opportunities page; nav tests updated.
- **Task 8 — Verify + docs.** `npm test`, `npm run typecheck`, progress log,
  push, Plane sync.

## 12. Acceptance criteria

1. Compiling a routing profile is deterministic and versioned: unchanged
   plan/lanes/policy ⇒ same fingerprint, no new row; any change ⇒ new row
   with bumped `profileVersion`; `(campaignId, planRevisionId,
   profileFingerprint)` unique.
2. A story routed against two campaigns can produce independent
   opportunities; dismissing one leaves the other untouched (invariant 1),
   and re-running the matcher recreates nothing (fingerprint + partial-unique
   idempotency).
3. Policy bands govern disposition exactly as §4: `review` never yields
   `auto_qualified`; `auto_package` yields it only when fit/confidence/trust
   all clear their snapshots; `off` campaigns never reach the matcher.
4. A malformed matcher response, unknown campaign ID, or invented occurrence
   ID leaves the story retryable (`pending`, attempts+1) with **no**
   opportunity rows — and never marks it routed/irrelevant.
5. Every lifecycle change goes through the contracts transition machine,
   writes an event row, and attributes the actor; illegal transitions return
   400 `invalid_transition`.
6. A plan-revision activation stales routing fingerprints; the next run
   supersedes prior-revision opportunities and decides against the new
   profile.
7. Opportunities past `expiresAt` are swept to `expired` (undecided and
   qualified states only; `dismissed` stays).
8. XOR holds: an opportunity with both or neither trigger references is
   impossible (CHECK + service validation).
9. All routes 404 for non-members; two workspaces never see each other's
   profiles/opportunities.
10. Legacy flows unchanged: existing discovery/matching/automation suites
    pass unmodified (except additive nav/test extensions).
11. `npm test` and `npm run typecheck` green.

## 13. Risks

- **Tick-time cost.** One LLM call per story per tick, bounded at 10/tick and
  budget-gated; profiles compile lazily and are no-ops when unchanged.
- **Angle-hash sensitivity.** Trivial rewording produces a new angle hash and
  a second opportunity for the same idea. Acceptable in shadow; novelty
  scoring (Sprint 62) is the designed answer.
- **Free-string lane formats** (design §8.9) flow into profile payloads
  as-is; the format registry is a later sprint.
- **Migration adjacency.** 0067 is next on `main` today; if another branch
  merges first, renumber (Sprint 60 convention).

## 14. Progress log

- 2026-08-05 — Spec written; branch `sprint-61-campaign-opportunities` forked
  off `origin/main` (post-Sprint-60 merge `f76bd80`).
- 2026-08-05 — Tasks 1–6 implemented. Contracts: vocabularies, opportunity
  transition machine (`canTransitionOpportunity`/`transitionOpportunity` +
  `OPPORTUNITY_DECISION_TARGETS`), profile/opportunity/matcher zod schemas,
  `opportunity_matching` pipeline member, Opportunities nav child; contracts
  suite `test/opportunities.test.ts`. Migration
  `0067_sprint_61_campaign_opportunities` (XOR CHECK + partial uniques
  verbatim from §8.6) + `sprint61-migrations.test.ts`. Services:
  `routing-profiles.ts` (append-only fingerprinted compiler),
  `opportunity-matching.ts` (stage-1 lexical retrieval capped at 3, stage-2
  `generateStructured` matcher with §9.2 ID validation, fingerprint-fenced
  commit, policy disposition, supersede-on-revision-change, expiry sweep,
  retry cap 3), `opportunities.ts` (list/detail/decision + audit events).
  Routes `registerOpportunityRoutes` wired in `app.ts`; discovery-tick
  routing phase with new `maxRoutingStoriesPerTick`/`routingTimeoutMs`
  bounds; `discoveryRunSummarySchema` gained `storiesRouted`/
  `opportunitiesCreated`.
- 2026-08-05 — Three pre-existing tests updated for additive reasons:
  `operator-policy.test.ts` (two new bound rows), `sprint49-acceptance.test.ts`
  (policy fields + an explicit no-match branch for the new routing prompt so
  the choreography's deferred-promise stub isn't hit by the shadow phase),
  `sprint53-suggested-columns.test.ts` (allowlists
  `services/opportunities.ts` — the new §8.6 `suggestedPersonaId` column is
  unrelated to the retired legacy routing columns that guard protects).
