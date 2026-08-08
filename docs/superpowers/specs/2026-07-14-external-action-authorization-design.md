# External-Action Authorization and Stage 3 Completion Design

Date: 2026-07-14  
Branch: `ui-revamp/external-action-authorization`  
Baseline: `ui-revamp/conversational-editor@25cbdf8`  
Merge order: foundations → campaign control plane → review workspace → calendar workspace → execution results → conversational editor → this branch  
Design sources: `docs/superpowers/specs/2026-07-12-consolidated-ui-ux-revamp-design.md` §6, `docs/superpowers/specs/2026-07-11-gtm-orchestration-control-plane-design.md`, and the Stage 3 capability registry

## Goal

Complete the Stage 3 golden operating loop with one durable governance boundary for every action that can leave Tuezday or change spend:

`Home priority → Campaign context → Review queue → Conversational editor → content approval → external-action authorization → Calendar → execution result`

The slice must make authorization real rather than decorative. Future publish, send, reply, and paid-launch execution paths—whether started by a user, cadence, sequence, or worker—submit through the same coordinator. The coordinator records the exact proposed action, resolves policy, requires a human decision when appropriate, revalidates before execution, applies guardrails, and links the resulting operational receipt back to the proposal.

Content approval and action authorization remain separate decisions. Approval means the content is acceptable; authorization means Tuezday may perform one exact action with one exact destination, payload, timing, and policy context.

## Approved scope

This branch delivers the full Stage 3 authorization foundation and its required golden-loop consumers:

- canonical external-action persistence, lifecycle, policy resolution, immutable decisions, staleness, idempotency, and audit history
- all six existing contract kinds: `publish`, `send`, `reply`, `paid_launch`, `budget_change`, and `targeting_change`
- real adapters for publish, send, reply, and paid launch
- honest durable blocks for budget and targeting changes until the Stage 5 Ads wave owns those mutations
- workspace policy defaults and campaign policy overrides in the UI
- API-supported persona, connection, and lane policy constraints, included in effective-policy explanations
- a third Review tab for external-action authorizations
- publication proposal and status in the conversational editor's Execution region
- unified Home priorities for content review, authorization, stale/blocked actions, and execution failures
- Calendar representation and recovery for timed actions before execution records exist
- action linkage in unified execution results
- cutover of user-triggered and automated execution boundaries, including worker recovery

This is a compatibility migration of execution authority, not a rewrite of connector implementations. Existing publication, launch-message, inbox-reply, and ad-launch services remain the operational adapters behind the coordinator.

## Approaches considered

### 1. Canonical action coordinator — selected

Persist the proposal before any externally visible effect. Existing boundary routes and automated workers submit through one coordinator, which owns policy resolution, authorization, revalidation, scheduling/dispatch, idempotency, and receipt linkage.

This is the only approach that makes the Review queue a real gate, prevents automated paths from bypassing that gate, and supports a reliable proposal-to-outcome audit trail.

### 2. Shadow authorization ledger — rejected

Mirroring existing execution after it starts would provide an audit screen but could not prevent the action. It would also create two competing sources of truth.

### 3. Separate authorization-only endpoints — rejected

New protected endpoints alongside unchanged direct execution routes would remain bypassable by current clients and workers. Authorization must be integrated at the shared service boundary.

## Contract model

`packages/contracts` remains the only owner of public enum vocabularies and schemas.

### Existing vocabulary retained

`EXTERNAL_ACTION_KINDS` remains:

- `publish`
- `send`
- `reply`
- `paid_launch`
- `budget_change`
- `targeting_change`

`EXTERNAL_ACTION_STATUSES` gains `stale` alongside the existing proposed, authorization, scheduling, dispatch, result, blocked, and cancelled states.

The canonical transitions permit a proposal to resolve to authorization or autonomous execution, allow pending/authorized/scheduled actions to become stale, and preserve terminal history. Reproposal creates a successor action rather than mutating the exact historical payload.

### New vocabulary and schemas

Contracts add:

- policy rule values: `inherit | autonomous | human_required`
- policy scope kinds: `workspace | campaign | persona | connection | lane`
- authorization decision values: `authorize | deny`
- typed external-action subject and execution-reference schemas
- `externalActionSchema`, including the exact subject snapshot, policy snapshot, lifecycle, blocker, requested timing, predecessor/successor lineage, and execution reference
- `externalActionDecisionSchema`
- policy-rule input, effective-policy, and contributing-rule schemas
- proposal/submission, list-filter, authorization, denial, and reproposal schemas
- priority-item schemas for Home
- nullable or empty action linkage on execution results

Action detail payloads contain their decisions and policy explanation. List payloads remain bounded summaries suitable for queues.

## Persistence

Edit `apps/api/src/db/schema.ts` and generate the migration with `npm run db:generate -w apps/api`. Do not hand-write the migration.

### `external_action_policy_rules`

One explicit rule per workspace, scope, scope record, and action kind:

- `id`, `workspaceId`
- `scope`, `scopeId`
- `actionKind`, `rule`
- `createdBy`, `createdAt`, `updatedAt`

The service validates that campaign, persona, connection, and lane records belong to the workspace. A unique constraint prevents multiple rules for the same scope and action kind. Deleting a UI-managed override restores inheritance; history remains preserved in action snapshots.

### `external_actions`

The durable, immutable proposal plus mutable lifecycle:

- identity: `id`, `workspaceId`, `kind`, `status`
- subject: typed subject kind/ID and nullable links such as draft, campaign, persona, connection, lane revision, launch, launch message, inbox item, or ad launch where available
- exact intent: validated adapter payload JSON and a display-safe subject snapshot JSON
- requested timing: nullable `requestedFor`
- safety: unique workspace idempotency key, canonical subject fingerprint, resolved policy snapshot JSON, and nullable blocker code/detail
- lineage: nullable `supersedesActionId` and `supersededByActionId`
- execution: nullable execution kind/ID and durable receipt summary
- attribution: proposer actor, `createdAt`, `updatedAt`, nullable `authorizedAt`, `dispatchedAt`, and `completedAt`

The payload and fingerprint do not change after insertion. Reproposal snapshots the corrected current subject into a new action and links both records.

### `external_action_decisions`

Append-only authorize/deny decisions:

- `id`, `workspaceId`, `actionId`
- `decision`, nullable reason
- actor identity and timestamp
- subject fingerprint and effective-policy snapshot evaluated for the decision

Denial records the decision and cancels the action. Authorization records the decision before dispatch. Decisions are never edited or deleted independently.

### Operational linkage

Future publications, launch messages, inbox reply receipts, and ad launches link to the governing external action. Existing historical rows remain queryable and keep a null action link; the migration does not invent policy history that was never captured.

## Policy resolution

Only external actions are governed. Drafting, generation, content review, discovery, and other internal work do not require action authorization.

Workspace policy is the safe baseline. Campaign policy is the deliberate operating-mode override for actions in that campaign. Persona, connection, and lane rules are safety constraints: an explicit `human_required` at any of those scopes forces human authorization and cannot be relaxed by a campaign.

Resolution is deterministic:

1. Begin with the workspace rule for the action kind; absent data defaults to `human_required`.
2. Replace that baseline with a non-inheriting campaign override when one exists.
3. Collect the applicable persona, connection, and lane rules.
4. If any collected safety constraint is `human_required`, the effective result is `human_required`.
5. Otherwise retain the workspace/campaign result. `inherit` contributes explanation but no permission.

The action stores the effective result and every contributing rule. Configuration changes never rewrite why an existing decision was made, but pre-dispatch revalidation detects a changed effective policy and marks the proposal stale.

This baseline/override distinction is required to make campaign overrides useful while preserving the control-plane invariant that a sensitive persona, connection, or lane can always demand a human decision.

### Migration defaults

- Every workspace receives a safe `human_required` default for all six kinds.
- Existing `scheduled_auto` campaigns receive explicit `autonomous` campaign overrides for publish, send, reply, and paid launch so accepted automation behavior continues.
- Existing `manual` and `human_in_the_loop` campaigns receive `human_required` overrides for those kinds.
- Budget and targeting changes remain human-required in policy and are additionally blocked by unsupported adapters.
- New campaigns default to human-required action policy.

`automationMode` remains the production and drafting cadence setting. External-action policy becomes the sole permission authority for effects outside Tuezday.

Workspace defaults are editable on Automation. Campaign overrides are editable from the campaign workspace. Persona, connection, and lane policies are API-supported and visible in snapshots, while dedicated editors are deferred.

## Coordinator and lifecycle

Add a focused external-action service layer rather than embedding policy and lifecycle logic in route handlers or connector adapters.

### Proposal

`proposeExternalAction`:

1. validates workspace ownership, subject eligibility, exact destination, campaign context, timing, and adapter payload
2. derives a canonical fingerprint over the content/configuration, destination, schedule, campaign/persona/lane context, and effective policy inputs
3. derives or validates a workspace-scoped idempotency key
4. returns the existing action for an identical retry; rejects reuse with a different fingerprint
5. stores the proposal and effective-policy snapshot before any operational row or connector call
6. moves human-required proposals to `authorization_required`
7. sends autonomous proposals through guardrails and then schedule/dispatch

### Authorization and denial

Authorization is transactional up to the durable `authorized` state:

1. verify the action is still authorization-required
2. re-read the subject, destination, timing, campaign context, and effective policy
3. compare the new canonical fingerprint with the stored fingerprint
4. on any material change, move the action to `stale` and return a conflict without executing
5. append the immutable authorization decision and transition to `authorized`
6. after commit, apply guardrails and schedule or dispatch immediately

There is no second **Run** click. Denial appends its decision and cancels the action without calling an adapter.

### Guardrails and dispatch

Guardrails remain distinct from authorization. Kill switches, connection health, rate/daily caps, destination assignment, schedule windows, format rules, stop-on-reply, and spend caps may block an autonomous or human-authorized action.

- Guardrail/business failure → durable `blocked` with a stable, user-actionable reason and no connector call.
- Immediate execution → `authorized → dispatching → succeeded | failed`.
- Future execution → `authorized → scheduled`; the runner revalidates and dispatches when due.
- Connector/provider failure → durable `failed` action plus the existing operational error receipt.
- Budget or targeting mutation → durable `blocked` with a Stage 5 unsupported-adapter reason.

Every connector call uses the external action ID as its stable idempotency key where the provider supports one. Local operational creation also checks the action link so process retries cannot duplicate a publication, reply, message send, or ad launch.

The request path attempts authorized immediate work promptly. A resumable runner also claims authorized and due scheduled actions, so a process crash between decision commit and adapter invocation cannot strand or duplicate work.

### Reproposal and staleness

Content, destination, timing, campaign/persona/lane context, or effective-policy changes invalidate an unexecuted proposal. Authorization and scheduled dispatch both revalidate. A stale or correctable blocked action can be reproposed from the current authoritative subject; this creates a successor with a new fingerprint and retains the original record and decisions.

Succeeded actions are immutable. Failed actions can use bounded adapter retry only when their subject fingerprint is unchanged; otherwise recovery creates a successor proposal.

## Adapter cutover

The coordinator becomes the only path to new externally visible execution records.

### Publish

`POST /workspaces/:id/drafts/:draftId/publish` retains its URL but submits a `publish` action. The draft must still be approved, routable, platform-valid, and campaign-bound. A publication row is created only after authorization and guardrails pass; future actions create a scheduled publication, while immediate actions dispatch it.

Cadence auto-fill calls the same coordinator. Campaign policy decides whether the resulting action is scheduled automatically or waits in Review.

### Reply

`POST /workspaces/:id/inbox/:itemId/post-reply` submits a `reply` action for the exact approved reply draft, conversation, connection, and recipient. Manual and auto-reply services share this boundary. Stop-on-reply and reply caps remain dispatch guardrails.

### Send

Launch channel dispatch and sequence-step workers submit one `send` action per externally observable message/destination. A route may therefore return several submissions. Existing launch-message rows receive the action link and continue to store per-recipient outcome.

Email CSV generation remains outside action governance because exporting a file does not contact an audience. A future native/provider email send must use the coordinator.

### Paid launch

The existing ad-launch approval remains approval of the configured creative/campaign setup. The launch boundary then submits a separate `paid_launch` action. Authorization does not bypass spend guardrails; after both decision and guardrails pass, the adapter calls the existing ad launch service once.

Historic ad-launch decisions are retained. They are not rewritten as external-action decisions.

### No bypass

HTTP handlers, cadence services, inbox automation, launch sequences, manual run paths, and worker recovery all call the same coordinator. Operational services may be invoked directly only from an external-action adapter or for read-only/history behavior.

## API surface

Routes remain thin and delegate to services. All records are workspace-scoped through the existing auth guard and actor model.

### Actions

- `GET /workspaces/:id/external-actions?status=&kind=&campaign=&channel=&limit=`
- `GET /workspaces/:id/external-actions/:actionId`
- `POST /workspaces/:id/external-actions/:actionId/authorize`
- `POST /workspaces/:id/external-actions/:actionId/deny`
- `POST /workspaces/:id/external-actions/:actionId/repropose`
- `POST /workspaces/:id/external-actions/run` for resumable authorized/due work

Existing execution routes return a consistent action-submission envelope containing the action and nullable execution receipt. Batch launch dispatch returns an array of submissions. All current web clients and tests migrate to the envelope in the same task as their boundary.

### Policies

- `GET /workspaces/:id/external-action-policies?scope=&scopeId=` returns stored rules and the effective policy for the requested context
- `PUT /workspaces/:id/external-action-policies` upserts a bounded set of action-kind rules for one scope
- `DELETE /workspaces/:id/external-action-policies/:ruleId` removes an override and restores inheritance

Policy writes validate action kind, scope, workspace ownership, and allowed UI authority. The UI exposes only workspace and campaign mutations in this slice.

### Priorities

Add `GET /workspaces/:id/priorities` as a unified projection. Keep the existing `/next-action` route for compatibility with checklist-era consumers.

Priority candidates in this slice are:

- failed external actions and execution results
- stale or policy-blocked actions
- actions awaiting authorization
- drafts awaiting content review

Linked action/result failures are deduplicated. Ranking is deterministic: overdue recovery and decisions first, then other failures/stale/blocked work, then authorization, then content review; ties use due time and oldest creation time. Every item includes why it matters, the consequence of waiting, canonical status, campaign context, and one recovery URL.

## Review authorization workspace

Review gains a third `Authorizations` tab beside Approvals and Inbox. Counts and query parameters remain deep-linkable and preserve campaign/channel filters.

Each authorization card/detail exposes:

- action kind and canonical status
- exact content or configuration snapshot
- destination, recipient/account, requested timing, campaign, persona, and lane where available
- impact/risk summary and guardrail preview
- effective policy plus every contributing rule
- subject and policy staleness state
- decision and lifecycle history
- execution receipt or failure when one exists

Authorization and denial are available only for `authorization_required`. Stale actions cannot be authorized. Their recovery returns to the owning surface to correct and repropose. Batch authorization is deferred because equivalent-risk grouping is not yet modeled strongly enough.

## Conversational editor integration

For approved, campaign-bound drafts, the Execution region replaces the deferred authorization note with a real **Prepare publication** control using the resolved destination plus editable target/title and immediate or future timing.

Submission calls the migrated publication boundary and shows the resulting action state. Human-required actions link to Review's Authorization tab; autonomous actions show scheduled/dispatch/result state. The editor never labels content approval as action authorization and does not authorize inline.

Existing linked actions remain visible with policy explanation, staleness, decision history, execution history, and owning-surface recovery.

Reply, send, and paid-launch proposals continue to originate from Inbox, Launches, and Ad Launches respectively; each surface shows queued/blocked/result state and links to the same authorization detail.

## Home integration

Home's draft-only **Needs you now** area becomes the unified priority projection. The first item remains scannable within five seconds and explains:

1. what needs attention
2. why it matters
3. what happens if ignored
4. the exact next action

The UI uses canonical workflow badges and links directly to content review, authorization detail, the owning recovery surface, or execution results. Signals, broader campaign risk, connection health, and learning suggestions remain later priority sources.

## Calendar and execution-result integration

Timed external actions appear in the Calendar while they are awaiting authorization, stale, blocked, authorized, or scheduled. Before an operational receipt exists, the action is the calendar source. Once a publication or other calendar-native receipt is linked, that receipt replaces the proposal entry so one intent is never displayed twice.

Calendar details show policy/authorization state and link to Review for decisions or correction. Immediate actions without meaningful scheduled time remain out of the planning calendar after completion.

`executionResultSchema` gains `externalActionIds`, empty for legacy results. Publication and paid-launch results usually link one action; a rolled-up targeted launch may link several message actions. Campaign Results and editor execution history expose those links without changing existing outcome rollups.

## Status, error, and response behavior

- `400 invalid_input`: malformed payload, invalid scope, destination, or schedule.
- `404 not_found`: workspace-scoped action, subject, policy scope, or execution is inaccessible.
- `409 invalid_transition`: action is no longer in the requested lifecycle state.
- `409 idempotency_conflict`: an idempotency key was reused for a different fingerprint.
- `409 stale_action`: revalidation changed the subject or effective policy; the durable action is stale.
- Business/guardrail failure returns the durable `blocked` action and recovery reason rather than discarding it behind a generic error.
- Connector failure returns the durable `failed` action and receipt. Retryability is explicit in the blocker/receipt.
- Human-required proposals return `202` without operational execution.
- Successful proposal handling returns the submission envelope whether the action is queued, scheduled, completed, blocked, or failed.

The UI preserves the authoritative queue/surface during errors, uses accessible live announcements, disables duplicate decisions while pending, and never represents a partial response as successful execution.

## Testing strategy

### Contracts and state machine

- every new vocabulary and nested schema
- stale and terminal transitions
- proposal, submission, decision, policy snapshot, priority, and execution-link parsing
- limits, nullable legacy links, and invalid scope combinations

### Persistence and migration

- generated migration applies to a fresh in-memory database
- policy/action/decision constraints and indexes
- campaign automation backfill preserves scheduled-auto permission while manual/HITL remain gated
- existing operational history remains unchanged and readable

### Policy service

- workspace defaults and campaign overrides for all six kinds
- human-required persona, connection, and lane constraints winning over autonomous campaigns
- inheritance, missing records, cross-workspace rejection, and complete contributing-rule snapshots
- configuration changes affecting revalidation without rewriting prior snapshots

### Coordinator

- idempotent proposal and incompatible-key conflict
- human-required queueing with zero adapter calls
- autonomous guardrail/dispatch path
- immutable authorization and denial decisions
- subject, destination, timing, and policy staleness conflicts
- scheduled execution and restart recovery without duplicates
- blocked, retryable failure, permanent failure, reproposal lineage, and execution linkage
- unsupported budget/targeting actions remaining honest durable blocks

### Adapter regression

- publish now, scheduled publish, cadence-created publish, duplicate prevention, and failure receipts
- manual and automated inbox reply
- social launch dispatch and sequence steps at per-message granularity
- email export remaining non-executing
- approved paid launch plus authorization and spend guardrails
- direct operational calls no longer reachable from route/worker entry points

All connector tests use injected fakes and never access the network.

### Web

- Review Authorizations URLs, filtering, status/decision behavior, policy explanations, staleness, and recovery
- workspace defaults and campaign overrides
- editor publication proposal with strict separation from content approval
- Home ranking/deduplication/all-clear/error behavior
- Calendar proposal/receipt deduplication and recovery targets
- execution-result action links
- structural tests pinning shared `WorkflowStatusBadge`, Review helpers, and accessible labelled/live regions

Existing draft, review, editor, publication, cadence, inbox, launch, sequence, ad-launch, Calendar, campaign Results, shell, and status tests remain green.

## Delivery and completion gates

Implementation follows TDD with one task per commit. Every commit ends with:

`Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>`

Before acceptance and push, run unpiped and verify exit code 0 for:

- `npm test`
- `npm run typecheck`
- `npm run build -w apps/web`

Then:

- write `docs/ui-ux/external-action-authorization-acceptance.md`
- update `docs/ui-ux/capability-registry.md` for authorization, Home priorities, Calendar, editor execution, and execution results
- push `ui-revamp/external-action-authorization` to GitHub
- never merge to main

## Global constraints

- Do not change login, authentication, onboarding, dev-admin bootstrap, or environment-loading files.
- Enum vocabularies live only in `@tuezday/contracts`.
- Routes validate and delegate; services own business logic and database access.
- External dependencies remain injectable through `buildApp`; tests never use real network services.
- Reuse canonical state transitions, shared status badges, Preview components, shell, tokens, and recovery patterns.
- Keep content approval and external-action authorization separate in storage, API copy, and UI actions.
- Preserve user changes and unrelated worktree state.

## Explicit deferrals

- Real budget-change and targeting-change mutation adapters: Stage 5 Ads wave.
- Dedicated persona, connection, and lane policy editors: API and snapshots exist now; focused editors follow their owning surfaces.
- Bulk authorization: deferred until equivalence/risk grouping is modeled safely.
- Native/provider email sending: CSV export remains the current outbound boundary.
- Signals, learning suggestions, general connection health, and broader campaign risk in Home priorities: later journeys consume the new projection pattern.
- Full distributed job infrastructure: this slice adds a durable resumable runner around current worker patterns, not a new external queue platform.

## Spec self-review

- **Permission authority:** every current externally visible publish, reply, social send, and paid-launch entry point routes through one coordinator, including automated workers.
- **Decision separation:** content approval never implies action authorization; paid launch likewise retains setup approval before the action decision.
- **Policy consistency:** campaign overrides can preserve accepted scheduled automation, while persona, connection, and lane constraints can only tighten permission.
- **Historical honesty:** legacy receipts remain visible but receive no fabricated action or policy history.
- **Idempotency:** proposal creation, operational-row creation, connector invocation, and crash recovery all share the action identity.
- **Staleness:** no action executes after material subject, destination, timing, campaign context, or effective-policy change.
- **Scope honesty:** all six kinds are represented; unsupported spend mutations are durable blocked states rather than fake success.
- **Golden-loop closure:** Home, Campaign, Review, editor, authorization, Calendar, and execution results share one action lineage and recovery path.
- **Placeholder scan:** no unresolved implementation choices or placeholder language remain.
