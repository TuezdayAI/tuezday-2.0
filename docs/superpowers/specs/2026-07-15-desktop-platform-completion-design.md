# Desktop Platform Completion Design

Date: 2026-07-15  
Baseline: `ui-revamp/external-action-authorization@5cb9a1b`  
Target branch: `ui-revamp/desktop-platform-completion`

## Purpose

Complete the deferred external-action capabilities and bring the desktop interaction system to the quality level of the rebuilt product surfaces. The delivery is one umbrella program decomposed into small vertical coding-agent sessions. Each session starts with a failing test, ends with a focused green result and one reviewable commit, and can be resumed without conversational memory.

This design covers:

- real Meta budget and targeting mutations
- dedicated persona, connection, and campaign-lane policy editors
- explicit and campaign-wide batch authorization
- native governed email sending through Resend from Launches, Outbound, and PR
- the four deferred Home priority sources
- a unified desktop button hierarchy and Refined Lucide icon system
- desktop-only visual acceptance at four supported viewport widths

## Delivery model

Use vertical, end-to-end slices rather than layer-first or parallel workstream development. Shared foundations land before their consumers, but every later task delivers a complete observable behavior across its contract, service, route, UI, tests, and documentation where applicable.

Every coding-agent session must:

1. own one narrow behavior or one shared foundation
2. name the interfaces it consumes and produces
3. add and run a failing test before implementation
4. keep provider dependencies injectable and offline in tests
5. run its focused suite plus repository typechecking
6. end in one commit and a progress-log entry
7. leave no uncommitted compatibility shim for a later agent to infer

The implementation order is:

1. desktop action-system foundation
2. Meta mutation contracts and provider seam
3. budget mutation, targeting mutation, guardrails, and owning UI
4. persona, connection, and lane policy editors
5. batch preview/audit foundation, explicit batches, and campaign-wide batches
6. outbound email sender/domain and delivery foundation
7. Launches/sequences, Outbound, and PR email origins
8. signals, learning, connection health, and campaign-risk priorities
9. surface-by-surface legacy button/icon migration
10. full verification, desktop visual evidence, acceptance, and registry updates

## Meta budget and targeting mutations

### Scope

Only launched Meta ad sets connected through the existing ads execution fabric are eligible. Google Ads execution, creative changes, objectives, placements, campaign structure, and targeting dimensions beyond countries and age range are not part of this program.

The existing external-action kinds `budget_change` and `targeting_change` become executable. They remain subject to the same proposal, policy, authorization, staleness, guardrail, idempotency, runner, and audit model as publish, send, reply, and paid launch.

### Canonical intents

Add contract-owned payloads rather than adapter-local anonymous shapes:

```ts
interface BudgetChangeIntent {
  launchId: string;
  adAccountId: string;
  externalAccountId: string;
  externalAdSetId: string;
  currency: string;
  beforeDailyBudgetCents: number;
  afterDailyBudgetCents: number;
  providerUpdatedAt: number | null;
}

interface TargetingChangeIntent {
  launchId: string;
  adAccountId: string;
  externalAccountId: string;
  externalAdSetId: string;
  before: { countries: string[]; ageMin: number; ageMax: number };
  after: { countries: string[]; ageMin: number; ageMax: number };
  providerUpdatedAt: number | null;
}
```

Money remains integer cents in the ad account currency. Country arrays are normalized, deduplicated, and sorted before fingerprinting. Ages use the existing contract bounds. A no-op diff is invalid.

### Provider interface and data flow

Extend the Meta ads execution adapter with focused operations:

```ts
interface MetaAdSetState {
  externalAdSetId: string;
  dailyBudgetCents: number;
  countries: string[];
  ageMin: number;
  ageMax: number;
  updatedAt: number | null;
}

interface AdsMutationAdapter {
  getAdSetState(externalAccountId: string, externalAdSetId: string): Promise<MetaAdSetState>;
  updateDailyBudget(externalAccountId: string, externalAdSetId: string, dailyBudgetCents: number): Promise<MetaAdSetState>;
  updateTargeting(externalAccountId: string, externalAdSetId: string, targeting: TargetingChangeIntent["after"]): Promise<MetaAdSetState>;
}
```

Proposal reads current Meta state and stores an exact before/after snapshot. Authorization and dispatch re-fetch Meta state. A different budget, targeting set, provider update marker, local launch record, policy result, connection, or external identifier makes the action stale. The adapter never applies a blind patch against unknown provider state.

Dispatch re-runs the workspace kill switch, daily spending cap, provider minimum/maximum, country and age validation, and connection checks. Success stores an `ad_mutation` execution receipt with the external ad-set ID and returned provider state, then updates the local ad-launch projection. Provider failure leaves the prior local state intact and produces a durable failed action.

### UI

Ad Launches adds separate **Change budget** and **Change targeting** flows for launched rows. Each flow shows:

- account, campaign, and ad-set identity
- current provider value and requested value
- absolute and percentage budget delta where meaningful
- countries added/removed and the age-range delta
- effective policy and relevant guardrails
- resulting authorization, stale, blocked, failed, or succeeded state

The origin creates the proposal. Authorization remains in Review. Stale recovery returns to the mutation form with current provider values.

## Narrow-scope policy editors

The policy API already supports persona, connection, and lane scopes. This program adds the missing owning-surface editors without changing policy precedence.

- Persona detail owns persona rules.
- Connector detail owns connection rules.
- Campaign → Channels owns lane rules per active lane revision.

Each editor lists all six canonical action kinds directly from `EXTERNAL_ACTION_KINDS`. Because persona, connection, and lane scopes are safety constraints, every row supports only `inherit` or `human_required`; these scopes can tighten a workspace/campaign result but never loosen it. Each row shows the effective result, names contributing workspace, campaign, and narrower rules, and explains that the editor changes permission but does not execute an action.

One bounded save writes the complete six-kind scope. `inherit` deletes an existing explicit rule. Optimistic concurrency uses the newest policy update timestamp so a stale browser cannot overwrite another editor silently. Successful saves announce the new effective result; conflicts reload and preserve the user's attempted selection for comparison.

## Batch authorization

### Modes

Support two modes through the same durable batch model:

```ts
type AuthorizationBatchSelection =
  | { mode: "selected"; actionIds: string[] }
  | { mode: "campaign"; campaignId: string; kinds: ExternalActionKind[] | null };
```

Explicit selection accepts 1–25 actions. Campaign selection snapshots at most 100 currently `authorization_required` actions; larger campaigns return a continuation count rather than authorizing an unbounded query. The founder can filter campaign-wide preview by action kind.

### Preview and persistence

Create durable `external_action_batches` and `external_action_batch_items` rows. Preview resolves the selection into an immutable item snapshot containing action ID, action fingerprint, action update timestamp, kind, risk/impact summary, campaign, and initial eligibility or exclusion reason. A batch is workspace-scoped and idempotent by client request ID.

Campaign-wide preview groups included and excluded items by kind and blocker/risk explanation. Confirmation uses the batch ID; actions created after preview are never silently included.

### Execution semantics

Each item is independently reloaded, revalidated, and passed through the canonical single-action authorization coordinator. Policy, status, fingerprint, staleness, connection, and guardrail checks are never bypassed. Results are stored per item as succeeded, scheduled, failed, blocked, stale, or skipped.

The batch itself completes as `completed`, `partially_completed`, or `failed`. External side effects are not rolled back and the UI never calls the operation atomic. Retrying a confirmed batch resumes unfinished items and returns stored outcomes for completed items.

Content approval is excluded from the batch vocabulary and UI. Batch authorization never approves drafts or paid-launch setup gates.

## Native governed email

### Boundary

Add a new `OutboundEmailProvider` instead of extending the best-effort transactional `Mailer`. Invitations and approval notifications keep their current semantics; governed outbound email uses external actions, delivery persistence, suppression, caps, and provider receipts.

The first provider is Resend. The provider remains injected through `buildApp`; tests use a deterministic fake.

```ts
interface OutboundEmailMessage {
  from: string;
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  idempotencyKey: string;
}

interface OutboundEmailProvider {
  send(message: OutboundEmailMessage): Promise<{ provider: "resend"; messageId: string; acceptedAt: number }>;
}
```

### Workspace sender verification

Tuezday's platform Resend account manages per-workspace sender domains; workspaces do not expose or store their own Resend API keys. Add persisted workspace sender configuration with domain, from name, from local-part/address, reply-to, verification state, provider domain ID, DNS challenge projection, last checked time, and last error.

The Connections surface owns setup and verification. A workspace cannot propose a native email send until its sender is verified. Domain verification checks use the provider API and persist only provider identifiers and public DNS challenge data; the platform API key remains server-side.

### Delivery persistence and events

Create `email_deliveries` and immutable `email_delivery_events`. A delivery links to its governing external action and identifies its origin as launch message, outbound draft, or PR draft. It stores recipient, subject/body snapshot, sender, provider message ID, accepted time, terminal state, and last error.

Add `email_delivery` to the external-action execution-reference vocabulary and unified execution results. Delivery statuses distinguish `queued`, `accepted`, `delivered`, `bounced`, `complained`, and `failed`.

Resend webhooks are signature-verified before mutation. Duplicate events are idempotent by provider event ID. Bounce or complaint creates a workspace suppression and can never revert to delivered. Accepted provider receipts prevent duplicate sends after retry or process recovery.

### Recipient safety

Before dispatch, the coordinator checks:

- verified workspace sender
- syntactically valid recipient address
- explicit recipient send permission in Tuezday
- workspace and recipient suppressions
- unsubscribe status
- workspace email kill switch and daily cap
- exact current subject/body/recipient/sender fingerprint

Existing recipients begin with unknown permission and cannot be sent natively until the founder marks them allowed or imports them with an allowed value. This field is a technical permission gate, not a legal determination. Unsubscribe links use signed, expiring-independent tokens and work without authentication.

### Origin surfaces

- Launches and sequences send approved email launch messages and preserve step timing, stop-on-reply, pause, and cap behavior.
- Outbound can send approved personalized sales drafts individually or through an explicit governed selection.
- PR can send approved pitches from Tuezday instead of opening the local mail client.

All three show the action state, provider receipt, delivery outcome, and recovery link. CSV export and mailto remain secondary recovery/export tools.

## Home priority completion

Extend the contract-owned priority-kind vocabulary and keep one server-ranked projection. Each new source is implemented and testable independently.

### Signals

Include only signals that require an explicit campaign decision or are overdue for triage. Link to the exact signal/campaign surface. Passive informational signals do not enter the urgent queue.

### Learning suggestions

Include suggestions awaiting accept/reject. Accepted, rejected, superseded, and purely informational learning records are excluded.

### Connection health

Include disconnected, expired, or failing connections only when they affect an active campaign, scheduled action, sender, CRM sync, or paid-media account. Deduplicate a connection item when an existing blocked external action already provides the more specific recovery path.

### Campaign risk

Include blocked active lanes, repeated recent execution failure, overdue scheduled work, and campaign-level inability to proceed. Risk derivation is deterministic and names the underlying evidence. Generic low-performance observations remain Insights, not urgent Home work.

### Ranking and copy

Every item includes what needs attention, why it matters, the consequence of ignoring it, an exact recovery URL, campaign context, due/created time, and canonical workflow status. Existing action/failure tiers remain highest. New sources rank after blocking execution work and authorization, but before ordinary content review when they stop active delivery. Stable IDs and provenance keys prevent duplicates across sources.

## Desktop action system

### Button hierarchy

The shared component layer becomes the only source of action styling. Add link-aware and icon-aware primitives so pages do not compose CSS-module classes manually.

| Level | Semantics | Minimum desktop size | Treatment |
|---|---|---:|---|
| Primary | one dominant action per decision region | 44px high | ink fill, white text |
| Secondary | supporting or alternative action | 40px high | panel fill and defined border |
| Tertiary | low-emphasis in-context command | 40px high | transparent, no forced underline |
| Destructive | deny/remove/disconnect/irreversible | 40px high | red outline; filled only in final confirmation |
| Icon-only | close, previous/next, toolbar command | 40×40px | quiet or bordered, tooltip and accessible label |
| Compact | dense table/list command only | 36px high | secondary or tertiary; never page-primary |
| Inline link | navigation or disclosure | text-sized | semantic anchor with underline |

Tabs, filter chips, segmented controls, checkboxes, and toggles remain separate components. They do not reuse command-button variants.

Every button variant defines default, hover, pressed, focus-visible, loading, disabled, and error-recovery behavior. Loading preserves button width and keeps a meaningful label. Destructive confirmation identifies the exact affected object. Adjacent actions expose at most one filled primary.

### Color direction

Use ink/charcoal for primary buttons. Coral is reserved for focus, selection, progress, and restrained brand emphasis. Semantic blocked/danger/ready colors retain their workflow meaning and are not repurposed as generic CTA colors.

### Icon direction

Keep Lucide and the existing typed `ICON_REGISTRY`. No page imports `lucide-react` directly. Standardize 16px compact, 18px standard, and 20px emphasized icons under one optical stroke treatment. Audit ambiguous Campaigns, Create, Review, authorization, Ads, and workflow-status mappings.

Official provider marks continue through generated Simple Icons data. Lucide never substitutes for a platform brand. Unfamiliar actions keep visible text; icons reinforce rather than replace meaning.

### Migration

Migrate raw `<button>` elements, `link-button`, `button-secondary`, `button-danger`, page-specific CTA classes, 32px icon controls, and scattered small padding surface by surface. Do not perform a blind global CSS replacement. Each surface migration has a shell/contract test pinning hierarchy, size, and accessible naming.

## Desktop visual acceptance

The supported visual-QA widths are:

- 1024px minimum desktop
- 1280px standard desktop
- 1440px wide desktop
- 1728px large desktop

Mobile screenshots and mobile-layout acceptance are not release gates. Existing narrow-layout code may remain functional, but this program makes no mobile design claim.

Build an authenticated deterministic visual fixture covering representative campaigns, approvals, authorizations, inbox items, Calendar entries, Meta mutations, email delivery states, policy editors, batch partial results, Home priorities, and failure recovery. Capture Playwright evidence at all four widths.

Visual review covers action prominence, button consistency, icon meaning, content overflow, modal/dialog sizing, dense-table controls, focus order, loading width, empty/error states, partial batch outcomes, and exact recovery paths.

## Reliability, security, and error handling

- Routes validate and delegate; services own database and provider behavior.
- Provider secrets never enter snapshots, client responses, analytics, or logs.
- Meta and Resend dependencies are injectable; automated tests never access their networks.
- All external effects use deterministic idempotency and durable provider receipts.
- Batch and webhook processing are resumable and idempotent.
- Stale intent never executes silently.
- Partial external success remains visible rather than being rolled back cosmetically.
- Generated migrations are inspected and tested against empty and populated databases.
- Content approval, paid-launch setup approval, and external-action authorization remain separate decisions.

## Verification contract

Every coding-agent session runs its focused tests and `npm run typecheck`. Every workstream milestone runs the relevant API/web regression suite. Final acceptance requires fresh, unpiped success for:

```bash
npm test
npm run typecheck
npm run build -w apps/web
```

Final documentation records exact test counts and exit codes, migration/backfill behavior, delivered routes/tables/adapters/surfaces, desktop visual evidence, and remaining deferrals. The capability registry must not mark Google Ads execution, broader Meta targeting, additional email providers, mobile QA, or distributed job infrastructure complete.

## Explicit non-goals

- Google Ads budget, targeting, or launch execution
- Meta placement, objective, creative, or campaign-structure mutation
- targeting dimensions beyond countries and age range
- SMTP or additional outbound-email providers
- workspace-owned Resend API keys
- batch content approval
- replacing current worker patterns with a distributed queue platform
- mobile UI redesign or mobile visual acceptance
- redesigning navigation or unrelated product surfaces

## Design self-review

- **Agent isolation:** every workstream has foundations before consumers and no task needs hidden conversational context.
- **Decision separation:** content, paid-launch setup, and external-action decisions never collapse into one control.
- **Policy safety:** persona, connection, and lane editors expose only inherit/human-required, matching the existing rule validator and tightening-only precedence.
- **Provider honesty:** accepted email is not called delivered; Meta mutation success uses returned provider state.
- **Batch honesty:** campaign-wide authorization snapshots bounded items and reports partial results.
- **Desktop consistency:** one button hierarchy and one typed icon vocabulary replace scattered page-level action styling.
- **Scope honesty:** Meta-only execution, Resend-only outbound, four named Home sources, and desktop-only QA are explicit.
- **Recovery:** every stale, blocked, partial, bounced, complained, or failed state has an owning surface and exact recovery path.
