# Conversational Editor Acceptance

Date: 2026-07-13  
Branch: `ui-revamp/conversational-editor`  
Baseline: `ui-revamp/execution-results@8f313c9` (merge order: foundations → campaign control plane → review workspace → calendar workspace → execution results → this branch)

## Outcome

The conversational-editor slice is accepted at the implementation and automated-verification level. A Review draft can now move through the Stage 3 middle loop in one URL-addressable workspace: understand why Tuezday produced it, compare output lineage in a destination-aware preview, revise it in natural language against current context, make a content decision, and inspect scheduling and execution outcomes without conflating approval with permission to act externally.

The canonical entry is `/workspaces/:id/review?tab=approvals&draft=:draftId`. Campaign, state, and channel filters survive open, close, sibling, and previous/next navigation.

## Delivered contracts and persistence

- `@tuezday/contracts` is the sole vocabulary owner for revision statuses (`running | completed | failed`), revision input, persisted turns, normalized resolver sections/citations, and the composite `DraftEditorContext` projection.
- Migration `apps/api/drizzle/0044_cheerful_vulcan.sql` adds `draft_revision_turns`, including workspace/draft/actor attribution, unique request IDs, source/result content, resolver trace, provider metadata, duration, terminal error, and timestamps.
- Completed revision turns count toward `monthlyGenerations`; running and failed attempts do not.
- No login, authentication, onboarding, dev-bootstrap, or environment-loading file changed.

## Delivered API behavior

- `GET /workspaces/:id/drafts/:draftId/editor` projects the draft, canonical decision history, revision turns, current resolver trace, source citations, campaign/persona context, plan staleness, exact source-signal siblings, destination connection, scheduled publications, and unified execution results.
- `POST /workspaces/:id/drafts/:draftId/revise` accepts a client request ID, natural-language instruction, and expected draft timestamp.
- Each revision resolves the live Brain, persona, campaign, scoped channel guidance, routed account profile, signal, selective-context matrix/outlines, and evidence policy through the same resolver used for generation. Conversation history is bounded to the newest six completed turns and 12,000 characters.
- Successful output passes normal draft/ad-format validation, performs the canonical `edit` transition, records the approval decision, and completes the revision turn in one database transaction.
- Request IDs are idempotent. A running duplicate returns `revision_in_progress`; stale input or a mid-flight edit returns `draft_changed`; illegal approval states return `invalid_transition`; plan limits return 402; provider and empty-output failures persist a failed turn and return `revision_failed` without consuming usage.
- Successful first attempts emit the existing `review.revision_requested` analytics event once per request ID.

## Delivered three-region editor

### Guidance

- **Why Tuezday made this** exposes included and excluded resolver layers with their reasons, evidence citations/provenance links, pre-review checks, chronological revision history, provider/model metadata, and failure recovery.
- The composer retains instructions after errors, announces progress through an `aria-live` region, retries with a new idempotency key, and reloads the latest draft before offering **Try again on latest** after an optimistic-lock conflict.
- Plan-change staleness is explicit and directs the reviewer to revise again against the latest campaign plan.

### Preview

- The shared `PreviewCard` and `previewKindFor()` render the draft in social, email, blog, or ad framing with canonical workflow status and media.
- Original, Current, and every completed conversational revision are selectable without mutating the draft.
- Exact source-signal sibling drafts provide reliable channel switching; unrelated drafts are never inferred as variants.

### Execution

- Campaign, persona, routed destination/connection state, automation-mode explanation, scheduled publication receipts, and unified execution outcomes are visible beside the content.
- Failed/running/completed outcomes link to the surface that owns recovery: Content, targeted Launches, or Ad launches. Scheduled receipts link to Calendar.
- Focused direct edit, copy, Markdown download, pre-review rerun, and approved-copy carousel generation preserve the useful actions from the prior approval detail.
- The sticky **Content decision** rail exposes only state-machine-legal content actions and keeps the external-action authorization boundary separate and non-actionable in this slice.

## Queue, responsive, and accessibility behavior

- `ApprovalsQueue` now owns queue loading, grouping, filters, batch/direct decisions, and keyboard focus advance only; editor detail ownership moved out of the former 917-line component.
- Direct card decisions remain available. A terminal editor decision advances to the next eligible draft in the current scope, or returns to the filtered queue when none remains.
- Desktop uses Guidance / Preview / Execution columns; laptop pins Preview beside stacked side regions; narrow layouts order Preview → Guidance → Execution.
- Guidance, Preview, Execution, Content decision, channel variants, version history, and decision history have named landmarks or controls. Draft navigation moves focus to the editor heading; mutation progress and recovery are announced without relying on color.

## Authorization boundary and deferrals

- External-action authorization remains contracts-only. This slice explains policy and displays existing schedules/outcomes but creates no authorization table, route, queue mutation, publish mutation, send mutation, or spend mutation.
- The next Stage 3 slice must build the authorization API foundation (table/service/routes) before adding its Review queue.
- A completed revision stores the context trace used for that turn; the read projection intentionally shows the newest completed revision trace, then source-generation trace, then draft creation as the staleness fallback.
- Variant lineage is limited to the reliable `sourceSignalId` relationship. General generation-angle lineage remains deferred until the data model can represent it honestly.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Focused editor regression | `npm test -- conversational-editor draft-editor draft-revisions review-workspace review-shell execution-results` | Passed: 11 files, 59 tests |
| Full repository suite | `npm test` | Passed: 122 files, 1,277 tests, exit 0 (including Chromium renderer) |
| Workspace typecheck | `npm run typecheck` | Passed across API, MCP, web, worker, brain, contracts, and testing workspaces; exit 0 |
| Production web build | `npm run build -w apps/web` | Passed; `/workspaces/[id]/review` compiled, exit 0 |

## Known non-blocking notes

- Next.js still reports the inherited multiple-lockfile/output-tracing-root warning during build; compilation and page generation complete successfully.
- A fresh worktree requires `npm install` so workspace packages resolve from this branch rather than a stale parent checkout.
- Automated source, component-contract, compilation, and production-build checks are complete. An authenticated visual walkthrough at target viewport widths remains pre-release QA.
