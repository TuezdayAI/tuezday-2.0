# External-Action Authorization Acceptance

Date: 2026-07-14  
Branch: `ui-revamp/external-action-authorization`  
Baseline: `ui-revamp/conversational-editor@25cbdf8`

## Outcome

The external-action authorization slice is accepted at the implementation and automated-verification level. Publish, reply, social send, and paid launch now cross one durable policy, proposal, authorization, guardrail, and execution boundary. Content approval remains a separate decision, and historical operational rows remain honest when no governing action exists.

This slice also closes the Stage 3 operating loop across Home, Campaign, Review, the conversational editor, Calendar, and unified execution results. An authenticated visual walkthrough remains pre-release QA and is documented below rather than claimed as completed.

## Delivered contracts and persistence

- Canonical contract vocabularies and schemas cover six action kinds (`publish`, `send`, `reply`, `paid_launch`, `budget_change`, `targeting_change`), policy scopes/rules, action subjects, decisions, execution references, lifecycle statuses including `stale`, priority items, action-aware Calendar entries, governing action IDs on execution results, and action history in editor context.
- `external_action_policy_rules`, `external_actions`, and immutable `external_action_decisions` are persisted by generated migration `0045_legal_azazel.sql`. Publications, inbox items, launch messages, and ad launches have nullable indexed governing-action links.
- Actions retain immutable payload, subject, fingerprint, and effective-policy snapshots plus mutable lifecycle, blocker, successor, receipt, and timestamp fields. Workspace-scoped idempotency prevents duplicate proposals and rejects key reuse for changed intent.
- Startup backfill is idempotent. It creates safe `human_required` workspace defaults for all six kinds, preserves accepted `scheduled_auto` behavior with autonomous campaign overrides for the four executable kinds, and keeps manual/human-in-the-loop campaigns human-required. New campaigns receive the same compatible defaults.
- Legacy operational rows are not assigned fabricated action or decision history.

## Policy, lifecycle, and API

- Resolution starts from the workspace rule, applies a non-inheriting campaign override, and then lets any applicable persona, connection, or lane `human_required` rule tighten the result. Every contributing rule is retained for explanation. Policy or subject changes before dispatch make the action stale rather than silently executing changed intent.
- The coordinator owns proposal, authorization, denial, reproposal, scheduling, dispatch, crash recovery, blockers, receipts, and successor lineage. Routes validate and delegate; connector, fetcher, analytics, and other external dependencies remain injectable.
- Policy API: `GET|PUT /workspaces/:id/external-action-policies` and `DELETE /workspaces/:id/external-action-policies/:ruleId`.
- Action API: `GET /workspaces/:id/external-actions`, `GET /workspaces/:id/external-actions/:actionId`, and action-scoped `authorize`, `deny`, and `repropose` mutations. `POST /workspaces/:id/external-actions/run` resumes due authorized/scheduled work.
- Priority API: `GET /workspaces/:id/priorities`, ranked by overdue failures/blocks/staleness, overdue authorizations, remaining blockers, authorizations, and then content review.
- Publication, cadence, inbox reply, launch dispatch/sequence, and paid-launch entry points now propose through the coordinator instead of invoking side effects directly. Autonomous actions continue through guardrails; human-required actions stop at authorization.

## Delivered adapters and guardrails

- Publication revalidates approved content, destination, campaign context, timing, and connection before creating or reusing a publication receipt.
- Reply snapshots the exact approved reply and inbox destination. Send snapshots the exact approved message, recipient, and connection for manual launches and sequence X sends.
- Paid launch snapshots the approved launch, parsed creative, ad account, budget, dates, targeting, media, and gate status; spend guardrails remain dispatch-time blockers and the existing ad setup approval remains separate.
- Current automation caps, kill switches, stop-on-reply behavior, cadence constraints, and retry semantics remain in force around the new coordinator.
- Budget and targeting change proposals are represented durably but finish as `blocked` with `unsupported_until_ads_wave`; no mutation is implied.

## Delivered product surfaces

- **Review / Authorizations:** a deep-linkable third tab with counts, filters, exact action content/configuration, destination and timing, risk/impact, guardrails, full policy contributions, staleness, decisions, lifecycle, receipts, and single-item authorize/deny/repropose controls. Content approval remains in Approvals.
- **Automation and Campaign:** workspace defaults are editable for all six kinds; campaign overrides support inherit/human/autonomous while showing narrower read-only contributors.
- **Conversational editor:** approved, eligible drafts can prepare a publication with destination, target/title, and immediate/future timing. The client retains its request ID across retry, displays policy and canonical action status, and links to Review for authorization instead of authorizing inline.
- **Inbox, Launches, and Ad Launches:** origin surfaces consume governed action envelopes, including stale action-only responses, display canonical state, and route authorization or recovery to the owning surface. Email CSV export and paid-launch setup approval are preserved.
- **Home:** the local draft-only queue is replaced by the server-ranked priority projection with why/consequence copy, campaign context, exact recovery links, and an all-clear state only when the queue is empty.
- **Calendar:** timed actions appear before native receipts, action/publication keys cannot collide, kind-aware icons and canonical states are used, and authorization/stale/blocked entries route to exact recovery. A linked native receipt replaces its proposal so intent is not duplicated.
- **Campaign Results and editor outcomes:** zero, one, or many governing action IDs are projected and linked without inventing lineage for legacy rows. Publication, launch, and ad-launch recovery remains on the existing owning surfaces.

## Explicit deferrals

- Real budget-change and targeting-change adapters remain Stage 5 Ads work; this slice returns durable blocked actions.
- Persona, connection, and lane policies are supported by the API and appear in snapshots, but dedicated editors wait for their owning surfaces.
- Batch authorization waits until equivalent-risk grouping is modeled safely.
- Native/provider email sending remains deferred; CSV export is still the outbound boundary and does not create an external action.
- Signals, learning suggestions, general connection health, and broader campaign risk remain later Home priority sources.
- The resumable runner uses current worker patterns; this slice does not introduce a distributed queue platform.

## Verification evidence

| Gate | Command | Result |
|---|---|---|
| Full repository suite | `npm test` | Passed: 136 files, 1,378 tests; exit 0, including the headless Chromium renderer |
| Workspace typecheck | `npm run typecheck` | Passed across API, MCP, web, worker, brain, contracts, and testing workspaces; exit 0 |
| Production web build | `npm run build -w apps/web` | Passed: optimized build, type validation, and all 7 static pages; exit 0 |
| Task 11 origin/editor regression | `npm exec --prefix apps/web vitest -- run lib/conversational-editor.test.ts lib/conversational-editor-shell-contract.test.ts lib/action-origin-shell-contract.test.ts lib/external-actions.test.ts` | Passed: 4 files, 23 tests |
| Task 12 operating-loop regression | focused priorities, Calendar, results, Review, and Stage 3 shell suite | Passed: 6 files, 36 tests |

The first full-suite attempt was blocked only by the macOS sandbox denying Chromium rendezvous. The same unpiped command was rerun with browser execution permitted and produced the green result recorded above, as required by the implementation plan.

## Manual testing checklist

Run the authenticated walkthrough with representative campaigns, destinations, approved drafts, inbox replies, launch recipients, and paid-launch data at `1440px`, `1024px`, `768px`, and `390px`:

1. Change workspace and campaign rules; confirm effective-policy explanations and narrower safety constraints remain accurate after reload.
2. Propose one action of each executable kind under human-required and autonomous policy; confirm duplicate clicks do not duplicate actions or side effects.
3. Authorize and deny individual actions from Review; confirm stale actions cannot be authorized and reproposal returns to the owning surface with successor lineage.
4. Confirm content approval and action authorization remain distinct in Review, the editor, and paid-launch setup.
5. Exercise immediate and future publication, reply, launch send, and paid launch; verify Calendar deduplication, receipts, Results lineage, Home ranking, and failure recovery links.
6. Confirm budget/targeting actions show the explicit Ads-wave blocker, email export creates no action, keyboard focus and live announcements work, and layouts do not overflow at the target widths.

## Known non-blocking notes

- Next.js continues to report the inherited multiple-lockfile/output-tracing-root warning; compilation and page generation complete successfully.
- The authenticated visual walkthrough above was not performed in this non-interactive acceptance pass and remains required before release.
