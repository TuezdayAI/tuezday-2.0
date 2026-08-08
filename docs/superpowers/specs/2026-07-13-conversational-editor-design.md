# Conversational Editor Design

Date: 2026-07-13  
Branch: `ui-revamp/conversational-editor`  
Baseline: `ui-revamp/execution-results@8f313c9`  
Merge order: foundations → campaign control plane → review workspace → calendar workspace → execution results → this branch  
Design source: `docs/superpowers/specs/2026-07-12-consolidated-ui-ux-revamp-design.md` §6.3 and the Stage 3 golden operating loop

## Goal

Turn Review's expanded approval detail into Tuezday's primary conversational editor: one deep-linkable workspace where a user can understand why an output exists, refine it in natural language or with focused controls, preview the destination result, make a content decision, and understand the downstream execution state without conflating content approval with external-action authorization.

## Approved scope

This is a complete vertical slice, not a visual-only rearrangement. It includes a persisted conversational revision loop, a composite editor read model, provenance, revision lineage, destination preview, policy explanation, plan staleness, and execution history.

The editor remains part of Review. Opening a draft changes the canonical URL to `/workspaces/:id/review?tab=approvals&draft=<draftId>` while retaining active queue filters. Closing the editor or using browser Back returns to the same queue context. Previous/Next navigation updates the `draft` parameter and preserves the filtered queue.

External-action authorization remains a separate decision and a separate future slice. This editor may explain that authorization infrastructure is not yet available; it must not invent an authorization state, combine approval with publishing, or add a fake action gate.

## Approaches considered

### 1. Draft-native revision turns — selected

Keep the existing draft as the approval object and store each natural-language instruction and AI result as a revision turn attached to it. Successful turns use the canonical draft `edit` transition, so the approval state machine, decision log, and all existing consumers remain authoritative.

This gives the editor a real conversation and version lineage without making every refinement a disconnected generation.

### 2. Stateless revision endpoint — rejected

Revising only the current content would be smaller, but it would lose conversation history, provenance per revision, idempotency, and a trustworthy explanation of how the output changed.

### 3. New Generation row per revision — rejected

This would preserve model accounting, but it would split one approval object's history across unrelated sandbox generations and blur the boundary between initial generation and refinement. Revision usage will instead be counted directly alongside generation usage.

## Architecture

### Contracts

`packages/contracts` owns the new public vocabulary and schemas:

- `DRAFT_REVISION_STATUSES = ["running", "completed", "failed"]`
- `draftRevisionTurnSchema`
- `reviseDraftInputSchema`
- `draftEditorContextSchema`
- Supporting schemas for normalized context inputs, evidence citations, sibling channel items, staleness, destination state, and automation explanation

The editor context schema reuses existing `draftSchema`, `approvalDecisionSchema`, `publicationSchema`, and `executionResultSchema`. Context `layer` remains descriptive string data rather than a second enum vocabulary; the canonical resolver owns its internal layer type.

The revision input contains:

- `requestId`: client-generated UUID used for idempotency
- `instruction`: trimmed natural-language instruction, 1–2,000 characters
- `expectedDraftUpdatedAt`: the exact draft version visible to the user

### Persistence

Add `draft_revision_turns` in `apps/api/src/db/schema.ts`, then generate the migration with `npm run db:generate -w apps/api`.

Each row stores:

- identity and ownership: `id`, `requestId`, `workspaceId`, `draftId`, `actorId`
- conversation: `instruction`, `sourceContent`, nullable `resultContent`
- provenance: `sectionsJson`
- execution: `status`, nullable `error`, nullable `model`, nullable `provider`, nullable `durationMs`
- timing: `createdAt`, nullable `completedAt`

`(draftId, requestId)` is unique. Deleting a draft cascades to its turns. A running row makes concurrent duplicate requests visible. A duplicate completed request returns its stored result; a duplicate running request returns `409 revision_in_progress`; a duplicate failed request returns the stored failure and the UI retries with a new request ID.

Only completed revision turns count toward monthly generation usage. Failed provider calls do not consume usage. A completed revision emits `draft.revised` analytics.

### API services and routes

Add a focused `apps/api/src/services/draft-editor.ts` rather than growing `services/drafts.ts` into an editor aggregation layer.

The service exposes two operations:

1. `getDraftEditorContext(db, workspaceId, draftId)` builds the editor read model.
2. `reviseDraft(...)` resolves current context, calls the injected `LlmGateway`, and commits the successful revision.

Wire two additive routes through `apps/api/src/routes/drafts.ts`:

- `GET /workspaces/:id/drafts/:draftId/editor`
- `POST /workspaces/:id/drafts/:draftId/revise`

The draft routes receive the existing injected LLM and analytics dependencies plus the existing `EvidenceStore`. No network dependency is constructed inside a service or route.

### Composite editor context

The editor endpoint returns one coherent projection so the browser does not independently join generation, campaign, persona, evidence, connector, publication, decision, and execution records.

The projection contains:

- the authoritative draft
- approval decision history
- completed, failed, and in-progress revision turns
- the source generation's stored resolver trace when available
- normalized included and excluded inputs for Brain, persona, campaign, guidance, account, signal, conversation, angle, task, and evidence
- normalized evidence citations with document title, kind, scores, kept/dropped state, and safe source URL when one exists
- campaign and persona identity
- plan staleness state and explanation
- reliable sibling channel items
- destination/connection state
- campaign automation mode and a user-facing policy explanation
- publication schedule/result rows for the draft
- unified execution results whose `draftId` matches the draft

Sibling channel items are included only when lineage is reliable. In this slice that means another draft in the workspace shares the same non-null `sourceSignalId`. Campaign membership or creation-time proximity is never used as a substitute for lineage.

### Plan staleness

For campaign work, compare the active campaign plan's `activatedAt` with the most recent context-resolved source:

- newest completed conversational revision turn, otherwise
- source generation creation time, otherwise
- draft creation time

Manual direct edits do not clear staleness because they do not prove the output was checked against current campaign context. A successful conversational revision resolves current context and therefore refreshes the source timestamp. Staleness warns and explains; it does not silently reject approval.

### Revision flow

The revision endpoint follows this order:

1. Validate workspace ownership, draft state, entitlement, request ID, instruction, and `expectedDraftUpdatedAt`.
2. Return the stored outcome for an already-completed request ID or the appropriate conflict/failure for an existing non-completed request.
3. Confirm `canTransition(draft.state, "edit")`; approved and rejected drafts are immutable.
4. Insert the running turn with the exact current content as `sourceContent`.
5. Resolve current Brain, persona, campaign, guidance, account, signal, and evidence inputs through the same resolver policies used for generation.
6. Build a bounded revision prompt from the resolved context, current content, up to the six most recent completed turns, and the new instruction. Conversation text is capped before prompt assembly so revision history cannot consume the resolver's context budget.
7. Ask the LLM for revised content only. The service rejects an empty result.
8. Re-read the draft and compare `updatedAt` with `expectedDraftUpdatedAt`. If it changed, mark the turn failed with `draft_changed` and return `409`; never overwrite newer work.
9. In one database transaction, apply the canonical `edit` transition and approval decision, store the completed turn and its context trace, and record completion metadata.
10. Emit analytics after the transaction succeeds.

Provider or parsing failure marks the running turn failed, preserves the authoritative draft, returns a retryable error, and leaves the instruction visible in history. Evidence retrieval remains best-effort: its exclusion reason is persisted in the trace and revision continues.

## Editor experience

### Entry and continuity

The existing Review gallery remains the queue. Its detail implementation moves into a focused `conversational-editor.tsx` component. Selecting a card sets the `draft` URL parameter and swaps the queue body for the editor. Queue filters and ordering remain the source of Previous/Next navigation.

All existing approval-detail behavior is retained:

- approve, reject, direct edit, and resubmit
- re-run pre-review
- decision history
- carousel rendering
- media strips
- Posting to connection rail and inline OAuth recovery
- copy and Markdown download
- queue focus/advance behavior

### Guidance region

Guidance contains:

- AI review recommendations and flagged checks
- a collapsed-by-default **Why Tuezday made this** disclosure
- grouped included inputs and explicit excluded-input reasons
- evidence citations and provenance
- conversation timeline with user instructions, completed revisions, failed attempts, model metadata, and timestamps
- a natural-language revision composer with useful example prompts

The composer preserves the typed instruction after recoverable errors. It announces running, success, conflict, and failure states through an accessible live region. A failed turn has a Retry action that creates a fresh request ID.

### Preview region

Preview uses the shared `PreviewCard` and `previewKindFor` path so channel framing remains destination-accurate. It supports existing media and carousel strips.

The version control switches among:

- Original
- Current
- each completed conversational revision

Comparison shows the selected version without mutating the draft. Returning to Current restores the authoritative content. Reliable sibling items appear as channel switches and navigate to that sibling's editor URL; they are not relabeled as variants when no shared source exists.

### Execution region

Execution contains:

- canonical content status
- campaign link and persona
- channel, destination, and connection health
- read-only schedule/publication state
- campaign automation mode with plain-language policy explanation
- a clearly separate external-action authorization note
- focused direct-edit controls
- execution and outcome history using the unified execution-result vocabulary
- links to Calendar, campaign Results, Content, or the owning recovery surface

This slice does not edit campaign schedules, publish immediately, or add a combined Approve-and-publish action.

### Content-decision bar

Approve and Reject remain content decisions in a sticky action bar. Edited drafts retain Resubmit. The bar never labels approval as authorization and never implies that approval itself caused an external action.

## Responsive and accessible behavior

- Wide desktop: Guidance, Preview, and Execution are visible as three columns; Preview receives the flexible center width.
- Laptop: Preview remains primary and Guidance/Execution share a tabbed side rail.
- Narrow screens: Preview, Guidance, and Execution stack in that order; the content-decision bar remains sticky.
- Dense refinement is desktop-first, but narrow screens retain preview, conversation, direct edit, approval, rejection, history, and recovery.

Each region is a labelled landmark. Region tabs use real tab semantics and keyboard navigation. Disclosure controls expose expanded state. Status uses the shared `WorkflowStatusBadge`, never color alone. Loading uses stable skeleton regions; errors use text and an icon; focus moves to the selected sibling or queue neighbor heading after navigation. The sticky action bar does not cover focused controls or the final scroll content.

## Error and recovery behavior

- `400 invalid_input`: keep the instruction and focus the invalid composer field.
- `402 upgrade_required`: use the existing upgrade flow; current content remains unchanged.
- `404 draft_not_found`: return to the filtered queue with a clear message.
- `409 invalid_transition`: refresh the editor context and explain the authoritative state.
- `409 draft_changed`: refresh Current, preserve the instruction, and offer **Try again on latest**.
- `409 revision_in_progress`: show the existing running turn rather than starting another.
- `502 revision_failed`: keep current content, show the failed turn and Retry.
- Editor projection failure: preserve the Review shell and offer a reload; never render partial data as authoritative context.

## Testing and acceptance

### Contracts

Test every new schema, status vocabulary, limits, nullable legacy-source cases, and nested use of existing draft/publication/execution schemas.

### API

Tests cover:

- complete editor projection and workspace isolation
- normalized resolver inputs and evidence provenance
- explicit evidence exclusion
- reliable sibling inclusion and speculative sibling exclusion
- stale/current/no-plan cases
- publication and unified execution history scoped to the draft
- successful revision and canonical `edited` decision
- current context rather than stale source context
- bounded conversation continuity
- idempotent completed request
- duplicate running request
- changed-draft conflict without overwrite
- invalid approval states
- empty/provider-failed results and retry history
- usage accounting and entitlement rejection
- analytics only after a completed revision

Tests use the injected fake LLM and evidence store; they never access the network.

### Web

Pure view-model tests cover editor URLs, preserved queue parameters, input grouping, evidence summaries, version selection, sibling switching, automation copy, staleness copy, and execution recovery targets.

Structural component tests pin the editor to shared `PreviewCard`, `WorkflowStatusBadge`, canonical review helpers, accessible landmarks/live regions, the three responsive layouts, and preserved content actions. Existing Review, Preview, status, Calendar, campaign Results, and launch deep-link tests remain green.

### Completion gates

Before acceptance and push:

- `npm test` passes with exit code 0. The Playwright renderer may require an unsandboxed rerun in restricted environments, but the final recorded gate must be green.
- `npm run typecheck` passes with exit code 0.
- `npm run build -w apps/web` passes with exit code 0.
- `docs/ui-ux/conversational-editor-acceptance.md` records delivered behavior and verification evidence.
- `docs/ui-ux/capability-registry.md` marks the editor, destination preview, and Brain evidence disclosure accurately, including explicit deferrals.
- The branch is pushed to GitHub and never merged to main by the agent.

## Global constraints

- TDD, one implementation task per commit.
- Every commit ends with `Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>`.
- Enum vocabularies live only in `@tuezday/contracts`.
- Approval transitions use `canTransition()` / `transitionTo()` through the existing draft service.
- No changes to login, authentication, onboarding, dev-admin bootstrap, or environment loading.
- Reuse the shared shell, design tokens, status badge, preview components, and recovery patterns.
- Preserve API dependency injection and route → service → database boundaries.
- Do not merge to main.

## Explicit deferrals

- External-action authorization table, service, route, queue, and mutations
- Combined content approval and external-action execution
- Campaign schedule editing from the editor
- A new content-set entity
- Cross-channel grouping without a reliable shared source
- Streaming token delivery
- Comments, assignment, and presence
- Bulk stale-work regeneration
- Results analytics, learning suggestions, and outcome comparisons beyond the existing execution history
