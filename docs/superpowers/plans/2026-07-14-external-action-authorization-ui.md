# External-Action Authorization and Stage 3 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Stage 3 with one durable external-action policy and authorization boundary that governs publish, send, reply, and paid launch, then connect it to Review, the conversational editor, Home, Calendar, and execution results.

**Architecture:** Contracts define the public action, policy, decision, priority, and projection vocabulary. Three new persistence tables and typed links on operational rows support an immutable proposal/decision audit trail. A coordinator resolves policy, fingerprints and revalidates intent, applies guardrails, and invokes existing execution services through kind-specific adapters; every HTTP and automated execution path uses that coordinator. Self-fetching web components consume focused projections and keep content approval visually and behaviorally separate from external-action authorization.

**Tech Stack:** TypeScript, Zod contracts, Fastify, Drizzle ORM with SQLite migrations, injected connector fabric/fetcher/analytics dependencies, Next.js 15 App Router, React 19, CSS Modules, Vitest.

## Global Constraints

- Branch is `ui-revamp/external-action-authorization`, based on `ui-revamp/conversational-editor@25cbdf8`; completed UI revamp work through that baseline is also on `main`.
- Design of record is `docs/superpowers/specs/2026-07-14-external-action-authorization-design.md`.
- TDD: write and run the failing test before implementation in every task.
- One implementation task per commit.
- Every commit ends with `Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>`.
- Enum vocabularies live only in `@tuezday/contracts`; never redeclare action, policy, decision, priority, or status arrays in API/web code.
- External-action transitions use `canTransitionExternalAction()`; draft and ad-launch approval transitions keep their existing canonical helpers.
- Content approval and action authorization remain separate records, labels, controls, and analytics events.
- Routes validate and delegate; services own business logic and database access.
- Connector, fetcher, analytics, LLM, and evidence dependencies remain injectable through `buildApp`; tests never access the network.
- Do not change login, authentication, onboarding, dev-admin bootstrap, or environment-loading files.
- Reuse `WorkflowStatusBadge`, Review URL helpers, existing preview components, shell, tokens, and recovery patterns.
- Budget and targeting mutation adapters remain unsupported and must create durable `blocked` actions with `unsupported_until_ads_wave`.
- Email CSV export remains outside external-action governance because no send occurs.
- Run `npm run db:generate -w apps/api` after the schema edit; do not hand-write migration SQL.
- Before push, run unpiped and confirm exit code 0 for `npm test`, `npm run typecheck`, and `npm run build -w apps/web`.
- Write `docs/ui-ux/external-action-authorization-acceptance.md`, update `docs/ui-ux/capability-registry.md`, push the feature branch, and do not merge this unfinished slice to main.

---

## What exists today

- `EXTERNAL_ACTION_KINDS`, `EXTERNAL_ACTION_STATUSES`, and `canTransitionExternalAction()` exist in `packages/contracts/src/index.ts`; `stale`, policy schemas, action records, decisions, and routes do not.
- Publish, reply, launch dispatch, sequence X sends, and paid launch invoke operational services directly.
- `publications`, `launch_messages`, `inbox_items`, and `ad_launches` have no governing-action link.
- Review has Approvals and Inbox tabs. The editor Execution region explicitly says authorization is deferred.
- Home's **Needs you now** queue contains pending drafts only.
- Calendar projects cadence slots and publications. Execution Results projects publications, launch-message rollups, and ad launches without action lineage.
- Workspace Automation and campaign workspaces already provide the right homes for policy controls.
- Baseline verification at `25cbdf8`: 122 test files / 1,277 tests, typecheck exit 0, web build exit 0.

## Locked interfaces

The tasks below use these names consistently:

```ts
type PolicyScope = "workspace" | "campaign" | "persona" | "connection" | "lane";
type PolicyRule = "inherit" | "autonomous" | "human_required";

interface ProposeExternalActionCommand {
  workspaceId: string;
  kind: ExternalActionKind;
  subject: ExternalActionSubject;
  context: ExternalActionContext;
  payload: unknown;
  requestedFor: number | null;
  idempotencyKey: string;
}

interface ActionActor {
  userId: string | null;
  label: string;
}

interface ExternalActionRuntime {
  propose(command: ProposeExternalActionCommand, actor: ActionActor): Promise<ExternalActionSubmission>;
  authorize(workspaceId: string, actionId: string, actor: ActionActor): Promise<ExternalActionSubmission>;
  deny(workspaceId: string, actionId: string, reason: string | null, actor: ActionActor): ExternalActionDetail;
  repropose(workspaceId: string, actionId: string, idempotencyKey: string, actor: ActionActor): Promise<ExternalActionSubmission>;
  run(workspaceId: string, now?: number): Promise<ExternalActionSubmission[]>;
}
```

`createExternalActionRuntime({ db, fabric, fetcher, analytics })` is constructed once in `buildApp()` and passed to action routes plus publication, cadence, inbox, launch, and ad-launch route/service entry points.

---

### Task 1: Complete external-action contracts and state machine

**Files:**
- Modify: `packages/contracts/src/index.ts:1026-1092, 2981-2999, 4116-4135, 4190-4220`
- Create: `packages/contracts/test/external-actions.test.ts`
- Modify: `packages/contracts/test/execution-results.test.ts`

**Interfaces:**
- Produces `EXTERNAL_ACTION_POLICY_SCOPES`, `EXTERNAL_ACTION_POLICY_RULES`, `EXTERNAL_ACTION_DECISIONS`, `EXTERNAL_ACTION_SUBJECT_KINDS`, `EXTERNAL_ACTION_EXECUTION_KINDS`, and `PRIORITY_ITEM_KINDS` plus inferred types.
- Produces `externalActionPolicyRuleSchema`, `effectiveExternalActionPolicySchema`, `externalActionSubjectSchema`, `externalActionSchema`, `externalActionDecisionSchema`, `externalActionDetailSchema`, `externalActionSubmissionSchema`, action filter/mutation inputs, `priorityItemSchema`, and `priorityQueueSchema`.
- Extends `calendarEntrySchema` with action entries and `executionResultSchema` with `externalActionIds`.
- Extends `draftEditorContextSchema` with `actions: z.array(externalActionSchema)` and keeps legacy operational action links nullable.

- [x] **Step 1: Write failing vocabulary, schema, and transition tests**

```ts
expect(EXTERNAL_ACTION_STATUSES).toEqual([
  "proposed", "authorization_required", "authorized", "scheduled",
  "dispatching", "succeeded", "failed", "blocked", "stale", "cancelled",
]);
expect(canTransitionExternalAction("authorization_required", "stale")).toBe(true);
expect(canTransitionExternalAction("scheduled", "stale")).toBe(true);
expect(canTransitionExternalAction("succeeded", "dispatching")).toBe(false);
expect(EXTERNAL_ACTION_POLICY_RULES).toEqual(["inherit", "autonomous", "human_required"]);
expect(externalActionSubmissionSchema.parse(actionSubmissionFixture()).action.status)
  .toBe("authorization_required");
expect(priorityQueueSchema.parse({ items: [priorityFixture()], generatedAt: 100 }).items)
  .toHaveLength(1);
expect(executionResultSchema.parse({ ...executionFixture(), externalActionIds: [] }))
  .toMatchObject({ externalActionIds: [] });
```

- [x] **Step 2: Run contract tests and confirm RED**

Run: `npm test -w packages/contracts -- external-actions.test.ts execution-results.test.ts`  
Expected: FAIL on missing exports and missing `externalActionIds`.

- [x] **Step 3: Add the canonical schemas and refinements**

Use discriminated subjects (`draft`, `inbox_item`, `launch_message`, `ad_launch`, `campaign`) and execution refs (`publication`, `inbox_reply`, `launch_message`, `ad_launch`). Require a blocker for `blocked|stale`, require an execution ref for `succeeded`, and reject `workspace` rules whose `scopeId` differs from `workspaceId`.

```ts
export const EXTERNAL_ACTION_POLICY_SCOPES = ["workspace", "campaign", "persona", "connection", "lane"] as const;
export const EXTERNAL_ACTION_POLICY_RULES = ["inherit", "autonomous", "human_required"] as const;
export const EXTERNAL_ACTION_DECISIONS = ["authorize", "deny"] as const;
export const EXTERNAL_ACTION_SUBJECT_KINDS = ["draft", "inbox_item", "launch_message", "ad_launch", "campaign"] as const;
export const EXTERNAL_ACTION_EXECUTION_KINDS = ["publication", "inbox_reply", "launch_message", "ad_launch"] as const;
export const PRIORITY_ITEM_KINDS = ["execution_failure", "stale_action", "policy_block", "authorization", "content_review"] as const;
```

Add `externalActionId: z.string().uuid().nullable()` to `publicationSchema` and `inboxItemSchema`; add the equivalent field to launch-message/ad-launch contracts. Add `kind: "external_action"`, `externalActionId`, and action-compatible statuses to Calendar without weakening slot/publication requirements.

Keep compatibility request IDs optional on existing publish/dispatch inputs; routes derive a deterministic key when an older client omits one. New editor/origin clients always send their retained request ID.

- [x] **Step 4: Run contract tests and confirm GREEN**

Run: `npm test -w packages/contracts -- external-actions.test.ts execution-results.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/external-actions.test.ts packages/contracts/test/execution-results.test.ts
git commit -m "feat(contracts): define external action governance"
```

### Task 2: Persist policies, actions, decisions, and operational links

**Files:**
- Modify: `apps/api/src/db/schema.ts:491-624, 964-1093, 1250-1351`
- Create: generated `apps/api/drizzle/0045_*.sql`
- Modify: generated `apps/api/drizzle/meta/_journal.json`
- Create: generated `apps/api/drizzle/meta/0045_snapshot.json`
- Create: `apps/api/src/services/external-action-backfill.ts`
- Modify: `apps/api/src/services/campaigns.ts:71-88`
- Create: `apps/api/test/external-action-persistence.test.ts`

**Interfaces:**
- Produces Drizzle tables `externalActionPolicyRules`, `externalActions`, and `externalActionDecisions` and row types.
- Produces `ensureWorkspaceActionPolicies(db, workspaceId)`, `ensureCampaignActionPolicies(db, workspaceId, campaignId, automationMode)`, and `backfillExternalActionPolicies(db)`.

- [x] **Step 1: Write failing persistence and backfill tests**

Test unique `(workspaceId, scope, scopeId, actionKind)`, unique `(workspaceId, idempotencyKey)`, decision/action cascade, operational nullable links, and this compatibility matrix:

```ts
expect(policy(db, workspace.id, "workspace", workspace.id, "publish")?.rule)
  .toBe("human_required");
expect(policy(db, workspace.id, "campaign", scheduled.id, "publish")?.rule)
  .toBe("autonomous");
expect(policy(db, workspace.id, "campaign", manual.id, "publish")?.rule)
  .toBe("human_required");
expect(policy(db, workspace.id, "campaign", scheduled.id, "budget_change")?.rule)
  .toBe("human_required");
```

- [x] **Step 2: Run the new API test and confirm RED**

Run: `npm test -w apps/api -- external-action-persistence.test.ts`  
Expected: FAIL because the tables do not exist.

- [x] **Step 3: Add schema tables and links**

Place policy/action tables after connections and before publications. `external_actions` stores immutable `payloadJson`, `subjectSnapshotJson`, `fingerprint`, and `policySnapshotJson`; mutable lifecycle columns store status, blockers, successor link, execution ref/receipt, and timestamps. Add nullable indexed `externalActionId` to publications, ad launches, launch messages, and inbox items.

- [x] **Step 4: Generate and inspect the migration**

Run: `npm run db:generate -w apps/api`  
Expected: one new numbered SQL migration and snapshot; SQL contains three `CREATE TABLE` statements, four `external_action_id` columns, unique idempotency/policy indexes, and no unrelated table changes.

- [x] **Step 5: Implement idempotent runtime backfill**

`backfillExternalActionPolicies()` iterates workspaces and campaigns, calls the two ensure functions, and is safe on every app start. Workspace defaults cover all six kinds with `human_required`. Campaign rules use `autonomous` only for the four executable kinds when `automationMode === "scheduled_auto"`; all other combinations are `human_required`. `createCampaign()` calls `ensureCampaignActionPolicies()` after insertion.

- [x] **Step 6: Run persistence tests and confirm GREEN**

Run: `npm test -w apps/api -- external-action-persistence.test.ts campaigns.test.ts`  
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/services/external-action-backfill.ts apps/api/src/services/campaigns.ts apps/api/test/external-action-persistence.test.ts apps/api/drizzle
git commit -m "feat(api): persist external action governance"
```

### Task 3: Implement deterministic policy resolution and policy routes

**Files:**
- Create: `apps/api/src/services/external-action-policy.ts`
- Create: `apps/api/src/routes/external-action-policies.ts`
- Modify: `apps/api/src/app.ts:20-190`
- Create: `apps/api/test/external-action-policy.test.ts`

**Interfaces:**
- Produces `resolveExternalActionPolicy(db, context)`, `listExternalActionPolicies()`, `upsertExternalActionPolicies()`, and `deleteExternalActionPolicy()`.
- Produces GET/PUT/DELETE routes exactly as specified in the design.

- [x] **Step 1: Write failing policy table tests**

Cover workspace fallback, campaign replacement, persona/connection/lane human constraints, inherit, cross-workspace scope rejection, complete contributing-rule labels, bounded batch writes, and deleting a campaign override.

```ts
expect(resolveExternalActionPolicy(db, {
  workspaceId, actionKind: "publish", campaignId: autonomousCampaignId,
  personaId: protectedPersonaId, connectionId: null, laneRevisionId: null,
}).effective).toBe("human_required");
```

- [x] **Step 2: Run tests and confirm RED**

Run: `npm test -w apps/api -- external-action-policy.test.ts`  
Expected: FAIL on missing service/routes.

- [x] **Step 3: Implement the resolver and mutations**

Resolve workspace baseline, replace it with an explicit non-inherit campaign rule, then force `human_required` if any persona/connection/lane constraint requires it. Return every queried scope with its label and stored/inherited rule so UI explanations are complete. Reject workspace `inherit` and a batch larger than six kinds.

- [x] **Step 4: Add thin routes and register them**

```ts
GET    /workspaces/:id/external-action-policies?scope=&scopeId=
PUT    /workspaces/:id/external-action-policies
DELETE /workspaces/:id/external-action-policies/:ruleId
```

Call `backfillExternalActionPolicies(db)` once inside `buildApp()` before route registration.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -w apps/api -- external-action-policy.test.ts external-action-persistence.test.ts`  
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/external-action-policy.ts apps/api/src/routes/external-action-policies.ts apps/api/src/app.ts apps/api/test/external-action-policy.test.ts
git commit -m "feat(api): resolve external action policy"
```

### Task 4: Build the action repository, fingerprint, and coordinator lifecycle

**Files:**
- Create: `apps/api/src/services/external-action-fingerprint.ts`
- Create: `apps/api/src/services/external-actions.ts`
- Create: `apps/api/src/services/external-action-coordinator.ts`
- Create: `apps/api/test/external-actions.test.ts`

**Interfaces:**
- Produces `canonicalActionFingerprint(value)`, action row mappers/query functions, typed lifecycle errors, and `createExternalActionRuntime()`.
- Consumes Task 3's `resolveExternalActionPolicy()`.
- Uses an injected adapter registry whose `revalidate`, `guard`, and `execute` functions are completed in Tasks 5–7.

- [x] **Step 1: Write failing lifecycle tests with fake adapters**

Cover identical idempotent proposal, incompatible-key conflict, human queue with zero adapter calls, autonomous dispatch, authorization/denial decisions, stale revalidation, scheduled runner, blocked guardrail, failed execution receipt, successor reproposal, unsupported action block, and restart retry without duplicate execution.

```ts
const runtime = createExternalActionRuntime({ db, adapters: fakeAdapters(), analytics: fakeAnalytics });
const first = await runtime.propose(command({ idempotencyKey: "publish:1" }), USER);
const retry = await runtime.propose(command({ idempotencyKey: "publish:1" }), USER);
expect(retry.action.id).toBe(first.action.id);
expect(fake.execute).toHaveBeenCalledTimes(0);
```

- [x] **Step 2: Run coordinator tests and confirm RED**

Run: `npm test -w apps/api -- external-actions.test.ts`  
Expected: FAIL because the repository/runtime do not exist.

- [x] **Step 3: Implement canonical serialization and repository operations**

Sort object keys recursively, preserve array order, normalize absent optionals to null in prepared commands, and hash UTF-8 JSON with SHA-256. Repository mutations call `canTransitionExternalAction()` and throw `InvalidExternalActionTransitionError` otherwise. Store payload/snapshots once; never update them.

- [x] **Step 4: Implement proposal, decision, dispatch, and runner flow**

`propose()` inserts before effect, resolves policy, then queues or invokes `dispatch()`. `authorize()` revalidates and transactionally records its decision before dispatch. `deny()` records and cancels. `dispatch()` marks blockers/results durably. `run()` selects `authorized` plus due `scheduled` actions, revalidates each, and processes independently.

Emit `review.action_authorized` only after the decision commit. Return durable action submissions for blocked/failed outcomes rather than throwing provider errors.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -w apps/api -- external-actions.test.ts external-action-policy.test.ts`  
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/external-action-fingerprint.ts apps/api/src/services/external-actions.ts apps/api/src/services/external-action-coordinator.ts apps/api/test/external-actions.test.ts
git commit -m "feat(api): coordinate external action lifecycle"
```

### Task 5: Add action routes and the publication adapter/cutover

**Files:**
- Create: `apps/api/src/routes/external-actions.ts`
- Create: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/routes/publications.ts:1-190`
- Modify: `apps/api/src/services/publications.ts:1-230`
- Modify: `apps/api/src/services/automation.ts`
- Modify: `apps/api/src/services/cadences.ts:280-355`
- Modify: `apps/api/src/routes/cadences.ts`
- Modify: `apps/api/src/app.ts:139-188`
- Create: `apps/api/test/external-action-publication.test.ts`
- Modify: `apps/api/test/publish.test.ts`
- Modify: `apps/api/test/cadences.test.ts`
- Modify: `apps/api/test/automation.test.ts`
- Modify: `apps/api/test/carousels.test.ts`
- Modify: `apps/api/test/inbox.test.ts`
- Modify: `apps/web/app/workspaces/[id]/content/page.tsx`

**Interfaces:**
- Registers action list/detail/authorize/deny/repropose/run routes.
- Adds `publishActionAdapter` and changes publication boundary responses to `ExternalActionSubmission`.
- Adds optional `externalActionId` to `createPublication()` and uses it for idempotent operational creation.

- [x] **Step 1: Write failing route and publication tests**

Test queue/detail isolation, authorize-once, deny, stale conflict, runner recovery, human-required publish creating no publication, autonomous publish creating exactly one linked publication, scheduled authorization, cadence proposal, duplicate HTTP retry, and adapter failure as a durable failed action.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `npm test -w apps/api -- external-action-publication.test.ts publish.test.ts cadences.test.ts`  
Expected: FAIL on missing action routes/envelope.

- [x] **Step 3: Implement shared action routes and error mapping**

Map invalid input to 400, inaccessible rows to 404, invalid transition/idempotency/stale errors to 409, and authorization-required proposal to 202. Other submissions return 200/201 with the same envelope shape.

- [x] **Step 4: Implement publish prepare/revalidate/guard/execute**

Prepare from the approved draft, campaign, persona, connection, target/title/media, and requested time. Revalidation repeats approval, routing, connection, content, duplicate, and fingerprint checks. Guard uses existing automation caps/kill switch where applicable. Execute calls `createPublication(..., cadenceId, action.id)` and maps the publication to an execution receipt.

The adapter registry treats an unregistered executable adapter as durable `adapter_unavailable` rather than calling a legacy path. At this task boundary publish is registered; Tasks 6 and 7 replace the safe block for messaging and paid launch. Budget/targeting always use `unsupported_until_ads_wave`.

- [x] **Step 5: Cut over manual publish and cadence fill**

The existing publish URL calls `runtime.propose()` with a client request ID or deterministic cadence slot key. Cadence fill no longer calls `createPublication()` directly. `/publish/run` invokes the external-action runner before legacy due-publication processing so already-authorized scheduled receipts continue to fire.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `npm test -w apps/api -- external-action-publication.test.ts publish.test.ts cadences.test.ts external-actions.test.ts`  
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/routes/external-actions.ts apps/api/src/services/external-action-adapters.ts apps/api/src/routes/publications.ts apps/api/src/services/publications.ts apps/api/src/services/cadences.ts apps/api/src/routes/cadences.ts apps/api/src/app.ts apps/api/test/external-action-publication.test.ts apps/api/test/publish.test.ts apps/api/test/cadences.test.ts
git commit -m "feat(api): authorize publication actions"
```

### Task 6: Cut reply, launch dispatch, and sequence sends over to actions

**Files:**
- Modify: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/routes/inbox.ts:31-108`
- Modify: `apps/api/src/services/inbox.ts:585-624`
- Modify: `apps/api/src/routes/launches.ts:161-197, 248-317`
- Modify: `apps/api/src/services/launches.ts:576-705`
- Modify: `apps/api/src/services/launch-sequences.ts:556-690`
- Modify: `apps/api/src/app.ts:173-186`
- Create: `apps/api/test/external-action-messaging.test.ts`
- Modify: `apps/api/test/inbox.test.ts`
- Modify: `apps/api/test/launches.test.ts`
- Modify: `apps/api/test/launch-sequences.test.ts`

**Interfaces:**
- Adds `replyActionAdapter` and `sendActionAdapter`.
- Route dispatch returns `{ submissions: ExternalActionSubmission[] }`.
- Sequence runtime receives the shared `ExternalActionRuntime` and never calls the X adapter directly.

- [x] **Step 1: Write failing messaging cutover tests**

Cover manual reply queue/authorization, auto-reply queue under human policy, autonomous reply once, broadcast send action, one X action per message, partial batch outcomes, sequence-generated approved X step proposal, worker restart idempotency, content change staleness, stop-on-reply guard, and unchanged email CSV behavior.

- [x] **Step 2: Run tests and confirm RED**

Run: `npm test -w apps/api -- external-action-messaging.test.ts inbox.test.ts launches.test.ts launch-sequences.test.ts`  
Expected: FAIL because messaging still dispatches directly.

- [x] **Step 3: Implement reply and send adapters**

Reply snapshots the approved reply draft, inbound parent, recipient, connection, campaign/persona, and exact text; execute calls `postReplyForItem()` and links the inbox item. Send snapshots one launch message/destination; execute uses the existing broadcast publication or X DM logic and links the launch message. Revalidation rejects changed draft content/state, recipient, connection, or stop state.

- [x] **Step 4: Replace direct route and worker dispatch calls**

Manual channel dispatch proposes all eligible message actions and returns their envelopes. Sequence steps propose after content approval and wait when authorization is required. `postApprovedReplies()` proposes rather than posts. Email export code remains untouched apart from regression assertions.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -w apps/api -- external-action-messaging.test.ts inbox.test.ts launches.test.ts launch-sequences.test.ts`  
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/external-action-adapters.ts apps/api/src/routes/inbox.ts apps/api/src/services/inbox.ts apps/api/src/routes/launches.ts apps/api/src/services/launches.ts apps/api/src/services/launch-sequences.ts apps/api/src/app.ts apps/api/test/external-action-messaging.test.ts apps/api/test/inbox.test.ts apps/api/test/launches.test.ts apps/api/test/launch-sequences.test.ts
git commit -m "feat(api): authorize reply and send actions"
```

### Task 7: Cut paid launch over and preserve spend guardrails

**Files:**
- Modify: `apps/api/src/services/external-action-adapters.ts`
- Modify: `apps/api/src/routes/ad-launches.ts:270-331`
- Modify: `apps/api/src/services/ad-launches.ts:300-430`
- Modify: `apps/api/src/app.ts:175-180`
- Create: `apps/api/test/external-action-paid-launch.test.ts`
- Modify: `apps/api/test/ads-execution.test.ts`

**Interfaces:**
- Adds `paidLaunchActionAdapter`.
- Existing `/ads/launches/:launchId/launch` returns `ExternalActionSubmission` and never calls `performLaunch()` directly.

- [x] **Step 1: Write failing paid-launch tests**

Test setup approval remains required, human authorization creates no provider records, authorization then launches once, autonomous still checks kill switch/daily cap, creative/budget/targeting/policy change causes stale conflict, provider failure persists both action and ad-launch error, and historic approval decisions remain unchanged.

- [x] **Step 2: Run tests and confirm RED**

Run: `npm test -w apps/api -- external-action-paid-launch.test.ts ads-execution.test.ts`  
Expected: FAIL because launch calls the adapter directly.

- [x] **Step 3: Implement paid prepare/revalidate/guard/execute**

Fingerprint the approved ad launch, parsed creative, account, campaign, budget, dates, countries, age bounds, media URL, and effective policy. Guard calls `checkSpendGuardrails()`. Execute resolves the injected ad adapter, calls `performLaunch()` once with action attribution, emits `ad.launched`, and links the ad launch.

- [x] **Step 4: Replace the launch route body and run tests**

Run: `npm test -w apps/api -- external-action-paid-launch.test.ts ads-execution.test.ts external-actions.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/external-action-adapters.ts apps/api/src/routes/ad-launches.ts apps/api/src/services/ad-launches.ts apps/api/src/app.ts apps/api/test/external-action-paid-launch.test.ts apps/api/test/ads-execution.test.ts
git commit -m "feat(api): authorize paid launch actions"
```

### Task 8: Add priority, Calendar, editor, and execution projections

**Files:**
- Create: `apps/api/src/services/priorities.ts`
- Create: `apps/api/src/routes/priorities.ts`
- Modify: `apps/api/src/services/calendar.ts:1-98`
- Modify: `apps/api/src/services/executions.ts:1-204`
- Modify: `apps/api/src/services/draft-editor.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/priorities.test.ts`
- Modify: `apps/api/test/cadences.test.ts`
- Modify: `apps/api/test/executions.test.ts`
- Modify: `apps/api/test/draft-editor-context.test.ts`

**Interfaces:**
- Produces `listWorkspacePriorities(db, workspaceId, limit?)` and `GET /workspaces/:id/priorities`.
- Adds relevant action summaries to `DraftEditorContext`.
- Adds action entries to Calendar and action IDs to execution results.

- [x] **Step 1: Write failing projection tests**

Test deterministic rank/due-time ties, linked failure deduplication, all-clear, campaign/recovery copy, Calendar action-before-receipt and receipt-after-link deduplication, legacy result empty IDs, launch rollup multiple IDs, and editor action history scoped to its draft.

- [x] **Step 2: Run projection tests and confirm RED**

Run: `npm test -w apps/api -- priorities.test.ts cadences.test.ts executions.test.ts draft-editor-context.test.ts`  
Expected: FAIL on missing projection fields/routes.

- [x] **Step 3: Implement priorities and route**

Rank overdue failure/block/stale, overdue authorization, other failure/block/stale, authorization, then content review. Dedupe a failed execution when its linked action already represents it. Include `reason`, `consequence`, `status`, `campaignId/name`, `dueAt`, `createdAt`, and exact Review/owner URL.

- [x] **Step 4: Extend Calendar, executions, and editor context**

Calendar includes timed action states only while no native calendar receipt is linked. Execution results read operational `externalActionId` values and aggregate unique launch-message action IDs. Editor context lists actions whose subject or execution draft ID equals the draft.

- [x] **Step 5: Run projection tests and confirm GREEN**

Run: `npm test -w apps/api -- priorities.test.ts cadences.test.ts executions.test.ts draft-editor-context.test.ts`  
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/priorities.ts apps/api/src/routes/priorities.ts apps/api/src/services/calendar.ts apps/api/src/services/executions.ts apps/api/src/services/draft-editor.ts apps/api/src/app.ts apps/api/test/priorities.test.ts apps/api/test/cadences.test.ts apps/api/test/executions.test.ts apps/api/test/draft-editor-context.test.ts
git commit -m "feat(api): project action priorities and outcomes"
```

### Task 9: Build the authorization web model and Review tab

**Files:**
- Create: `apps/web/lib/external-actions.ts`
- Create: `apps/web/lib/external-actions.test.ts`
- Modify: `apps/web/lib/review-workspace.ts:1-92`
- Modify: `apps/web/lib/review-workspace.test.ts`
- Create: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.tsx`
- Create: `apps/web/app/workspaces/[id]/review/_components/authorizations-queue.module.css`
- Modify: `apps/web/app/workspaces/[id]/review/page.tsx:1-106`
- Modify: `apps/web/app/workspaces/[id]/review/review.module.css`
- Create: `apps/web/lib/authorization-shell-contract.test.ts`

**Interfaces:**
- Adds `"authorizations"` to `REVIEW_TABS` and `action` to `reviewHref()` options.
- Produces `externalActionWorkflowStatus()`, action labels, policy explanation, impact summary, recovery URL, and filter helpers.

- [x] **Step 1: Write failing pure view-model tests**

```ts
expect(reviewHref("ws", { tab: "authorizations", campaign: "c", action: "a" }))
  .toBe("/workspaces/ws/review?tab=authorizations&campaign=c&action=a");
expect(externalActionWorkflowStatus(action({ status: "authorization_required" })))
  .toBe("authorization_required");
expect(policyExplanation(actionFixture())).toContain("Campaign override");
```

Test all statuses, filter preservation, blocked/stale recovery, and exact destination/timing copy.

- [x] **Step 2: Run web model tests and confirm RED**

Run: `npm test -w apps/web -- external-actions.test.ts review-workspace.test.ts`  
Expected: FAIL on missing module/tab.

- [x] **Step 3: Implement the pure model and URL changes**

Use contract types only. Map action states to canonical workflow statuses without local status arrays. Preserve campaign, channel, status, kind, and selected action in queue URLs.

- [x] **Step 4: Write the failing shell contract test**

Pin the component to `WorkflowStatusBadge`, the external-action helper module, action detail endpoint, authorize/deny mutations, labelled policy/guardrail/decision regions, and no combined content-approval copy.

- [x] **Step 5: Build the self-fetching Authorization queue**

Fetch filtered list and selected detail. Render exact snapshot, destination, requested timing, campaign/persona/lane, impact, effective/contributing policy, guardrail/blocker, lifecycle, decisions, and receipt. Authorize/deny only in `authorization_required`; stale shows owning-surface recovery/repropose. Use an accessible live region and disable duplicate mutations.

- [x] **Step 6: Add the Review tab/count and run tests**

Run: `npm test -w apps/web -- external-actions.test.ts review-workspace.test.ts authorization-shell-contract.test.ts review-shell-contract.test.ts`  
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web/lib/external-actions.ts apps/web/lib/external-actions.test.ts apps/web/lib/review-workspace.ts apps/web/lib/review-workspace.test.ts apps/web/app/workspaces/[id]/review apps/web/lib/authorization-shell-contract.test.ts
git commit -m "feat(web): add authorization review queue"
```

### Task 10: Add workspace and campaign policy controls

**Files:**
- Create: `apps/web/app/workspaces/[id]/automation/action-policy.tsx`
- Modify: `apps/web/app/workspaces/[id]/automation/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/automation/automation.module.css`
- Create: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-overview.tsx`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css`
- Create: `apps/web/lib/action-policy-controls.test.ts`

**Interfaces:**
- Workspace control edits six concrete defaults (`autonomous|human_required`).
- Campaign control edits six values including `inherit` and shows effective result/contributors.

- [x] **Step 1: Write failing structural/view tests**

Pin contract kind iteration, no redeclared kind arrays, workspace disallowing inherit, campaign inherit/reset behavior, save/error announcements, and plain-language separation between automation cadence and action permission.

- [x] **Step 2: Run test and confirm RED**

Run: `npm test -w apps/web -- action-policy-controls.test.ts`  
Expected: FAIL because controls do not exist.

- [x] **Step 3: Build workspace defaults and campaign overrides**

Fetch policy routes independently of guardrails/campaign plan data. Save one bounded six-kind batch. Show effective status badges and contributing persona/connection/lane constraints read-only. A campaign `inherit` deletes its stored override.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -w apps/web -- action-policy-controls.test.ts campaign-workspace-contract.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/app/workspaces/[id]/automation apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-overview.tsx apps/web/app/workspaces/[id]/campaigns/[campaignId]/campaign-workspace.module.css apps/web/lib/action-policy-controls.test.ts
git commit -m "feat(web): configure external action policy"
```

### Task 11: Connect proposal/status UX to editor and owning surfaces

**Files:**
- Modify: `apps/web/lib/conversational-editor.ts`
- Modify: `apps/web/lib/conversational-editor.test.ts`
- Modify: `apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx:42-550`
- Modify: `apps/web/app/workspaces/[id]/review/_components/conversational-editor.module.css`
- Modify: `apps/web/app/workspaces/[id]/review/_components/inbox-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/launches/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/ad-launches/page.tsx`
- Modify: `apps/web/lib/conversational-editor-shell-contract.test.ts`
- Create: `apps/web/lib/action-origin-shell-contract.test.ts`

**Interfaces:**
- Editor submits existing publish URL with `idempotencyKey` and shows returned action.
- Inbox, Launches, and Ad Launches parse action submission envelopes and link queued/blocked/stale actions to Review.

- [ ] **Step 1: Write failing helper and shell tests**

Test publish eligibility (approved + campaign + connected destination), initial target/title, immediate/future payload, action status/recovery links, and strict absence of **Approve and publish**. Pin owning surfaces to `ExternalActionSubmission` and `reviewHref(...authorizations...)`.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -w apps/web -- conversational-editor.test.ts conversational-editor-shell-contract.test.ts action-origin-shell-contract.test.ts`  
Expected: FAIL because the deferred note remains and clients expect legacy responses.

- [ ] **Step 3: Build editor Prepare publication flow**

Replace the deferred authorization box with destination/target/title/timing fields for eligible drafts, a generated request ID retained across retry, and submission status. Render effective policy, pending/stale/blocked/result states, and **Open authorization**. Keep authorization out of the editor and keep the content decision footer unchanged.

- [ ] **Step 4: Update Inbox, Launches, and Ad Launches**

Parse single/batch envelopes, refresh owning data after terminal autonomous results, show queued action badges/links, and surface durable blocker/failure text. Preserve email export, existing approval controls, and launch deep links.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -w apps/web -- conversational-editor.test.ts conversational-editor-shell-contract.test.ts action-origin-shell-contract.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/conversational-editor.ts apps/web/lib/conversational-editor.test.ts apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx apps/web/app/workspaces/[id]/review/_components/conversational-editor.module.css apps/web/app/workspaces/[id]/review/_components/inbox-queue.tsx apps/web/app/workspaces/[id]/launches/page.tsx apps/web/app/workspaces/[id]/ad-launches/page.tsx apps/web/lib/conversational-editor-shell-contract.test.ts apps/web/lib/action-origin-shell-contract.test.ts
git commit -m "feat(web): propose actions from owning workflows"
```

### Task 12: Complete Home, Calendar, and Results consumers

**Files:**
- Create: `apps/web/lib/priorities.ts`
- Create: `apps/web/lib/priorities.test.ts`
- Modify: `apps/web/app/workspaces/[id]/page.tsx:1-255`
- Modify: `apps/web/app/workspaces/[id]/home-hero.module.css`
- Modify: `apps/web/lib/calendar-workspace.ts`
- Modify: `apps/web/lib/calendar-workspace.test.ts`
- Modify: `apps/web/app/workspaces/[id]/calendar/page.tsx`
- Modify: `apps/web/app/workspaces/[id]/calendar/calendar.module.css`
- Modify: `apps/web/lib/execution-results.ts`
- Modify: `apps/web/lib/execution-results.test.ts`
- Modify: `apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx`
- Create: `apps/web/lib/stage-three-loop-shell-contract.test.ts`

**Interfaces:**
- Home consumes `/priorities` instead of constructing a draft-only queue.
- Calendar action entries link to authorization recovery.
- Results expose one/many governing action links.

- [ ] **Step 1: Write failing pure-model tests**

Test priority labels/icons/status/recovery, all-clear, action Calendar detail labels, action/publication deduped UI keys, and execution links for zero/one/many action IDs.

- [ ] **Step 2: Run model tests and confirm RED**

Run: `npm test -w apps/web -- priorities.test.ts calendar-workspace.test.ts execution-results.test.ts`  
Expected: FAIL on missing helpers/action cases.

- [ ] **Step 3: Replace Home's local draft queue**

Fetch `/priorities` with existing workspace/checklist/learning calls. Render deterministic priority cards with canonical badge, why/consequence text, campaign context, and exact CTA. Keep setup and learning zones. Show all-clear only when the projection is empty.

- [ ] **Step 4: Extend Calendar and Results UI**

Calendar displays authorization required, authorized, stale, and policy blocked with text/icon/color and Review recovery. Results show **View authorization** for one action and **View N actions** to the filtered authorization queue for rolled-up launches.

- [ ] **Step 5: Add the Stage 3 shell contract and run tests**

Pin Home → campaign/review links, Review authorization → Calendar recovery, editor → authorization, Calendar → results, canonical badges, and no duplicate local status vocabularies.

Run: `npm test -w apps/web -- priorities.test.ts calendar-workspace.test.ts execution-results.test.ts stage-three-loop-shell-contract.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/priorities.ts apps/web/lib/priorities.test.ts apps/web/app/workspaces/[id]/page.tsx apps/web/app/workspaces/[id]/home-hero.module.css apps/web/lib/calendar-workspace.ts apps/web/lib/calendar-workspace.test.ts apps/web/app/workspaces/[id]/calendar apps/web/lib/execution-results.ts apps/web/lib/execution-results.test.ts apps/web/app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx apps/web/lib/stage-three-loop-shell-contract.test.ts
git commit -m "feat(web): close the Stage 3 operating loop"
```

### Task 13: Full verification, acceptance, registry, and push

**Files:**
- Create: `docs/ui-ux/external-action-authorization-acceptance.md`
- Modify: `docs/ui-ux/capability-registry.md`
- Modify: this plan's progress log

- [ ] **Step 1: Run the full test suite unpiped**

Run: `npm test`  
Expected: exit 0. If macOS sandboxing denies the Playwright Chromium rendezvous, rerun the same command with browser execution permitted and record only the green run.

- [ ] **Step 2: Run typecheck unpiped**

Run: `npm run typecheck`  
Expected: exit 0.

- [ ] **Step 3: Run the production web build unpiped**

Run: `npm run build -w apps/web`  
Expected: exit 0. Network access may be required for the configured Google Fonts.

- [ ] **Step 4: Write acceptance evidence**

Record delivered contracts/tables/routes/adapters, policy resolution, Review/editor/Home/Calendar/Results behavior, migration/backfill, exact test counts and exit codes, manual testing steps, and explicit deferrals for budget/targeting adapters, dedicated narrow-scope policy editors, batch authorization, and native email send.

- [ ] **Step 5: Update capability registry accurately**

Mark External-action authorization implemented; update Ranked next action, Calendar, Publication execution, Unified execution results, and editor execution rows. Do not mark deferred action adapters or later priority sources complete.

- [ ] **Step 6: Commit docs**

```bash
git add docs/ui-ux/external-action-authorization-acceptance.md docs/ui-ux/capability-registry.md docs/superpowers/plans/2026-07-14-external-action-authorization-ui.md
git commit -m "docs: accept external action authorization slice"
```

- [ ] **Step 7: Confirm clean branch and push**

Run: `git status --short --branch`  
Expected: clean `ui-revamp/external-action-authorization`.

Run: `git push -u origin ui-revamp/external-action-authorization`  
Expected: push succeeds. Do not merge this branch to main until founder review.

## Progress log

- 2026-07-14: Approved four-part design: shared six-kind model, workspace/campaign policy UI, immediate post-authorization execution, full current adapter cutover, and unified Home priorities.
- 2026-07-14: Completed UI revamp chain through conversational editor fast-forwarded into `main`; post-merge verification passed 122 files / 1,277 tests, typecheck, and web build; pushed `main@25cbdf8`.
- 2026-07-14: Design specification committed on this branch as `5e4ea22`; implementation plan written after mapping contracts, schema, all execution boundaries, and golden-loop consumers.
- 2026-07-14: Task 1 — external-action policy/action/decision/priority contracts, stale transitions, action-aware Calendar/result/editor fields, and exhaustive Calendar workflow mapping. Verified 25 contract files / 273 tests, focused web test, and monorepo typecheck.
- 2026-07-14: Task 2 — persisted normalized policy, action, and immutable decision rows; linked all four current execution records; generated and inspected migration 0045; added idempotent workspace/campaign policy backfill that preserves scheduled-auto behavior. Verified 19 focused API tests and monorepo typecheck.
- 2026-07-14: Task 3 — implemented deterministic workspace/campaign resolution with persona/connection/lane safety constraints, complete labeled contributions, bounded policy mutations, authenticated policy routes, and startup backfill. Verified 11 focused API tests and monorepo typecheck.
- 2026-07-14: Task 4 — added canonical fingerprints, immutable action/decision mapping, guarded lifecycle transitions, idempotent proposal, transactional authorize/deny, staleness, scheduling/runner recovery, durable blockers/results, and successor lineage. Verified 22 focused contract/API tests and monorepo typecheck.
- 2026-07-14: Task 5 — registered shared action lifecycle routes and a destination-revalidating publication adapter; cut manual publishing, cadence fill, and the due runner over to durable actions while retaining legacy receipt recovery; preserved automation caps across pending actions and updated publication consumers for the action envelope. Verified 8 focused files / 105 tests and monorepo typecheck.
- 2026-07-14: Task 6 — added reply and send adapters that snapshot the approved draft, recipient, connection, and exact text; cut manual post-reply, inbox auto-reply posting, launch channel dispatch, and sequence X sends over to durable `send`/`reply` actions with deterministic content-hashed idempotency keys (re-dispatch reports the governing action for already-sent messages); stop-on-reply, kill switch, and daily caps remain dispatch guardrails, engine-level pre-checks keep the pause-and-retry semantics for automated sends, and email CSV export stays outside governance. Verified 4 focused files / 51 tests, full suite 128 files / 1,322 tests, and monorepo typecheck.
- 2026-07-14: Task 9 — added the pure external-action web model (canonical workflow-status mapping including kind-aware dispatching states, kind labels, policy explanations naming every non-inherit contributing scope, impact/timing copy, owning-surface recovery links, combined filters), extended `reviewHref`/`REVIEW_TABS` with the authorizations tab plus kind/status/action params, and built the self-fetching Authorizations queue with detail panel (exact content, policy/guardrail/receipt/decision regions, live announcements, authorize/deny guarded against double submits, stale/blocked recovery + re-propose) mounted with its own Review tab count. Verified 25 focused web tests, full suite 132 files / 1,349 tests, and monorepo typecheck.
- 2026-07-14: Task 8 — added the ranked priorities projection and `GET /workspaces/:id/priorities` (overdue failures/blocks/stale, overdue authorizations, other blockers, authorizations, then content review; linked failed executions dedupe behind their governing action); Calendar now projects timed action states until a native receipt is linked and lets queued actions hold their cadence slots; execution results carry governing action ids (unique launch-message rollups, empty for legacy rows); the editor context lists actions scoped to its draft. Verified 4 focused files / 29 tests, full suite 130 files / 1,336 tests, and monorepo typecheck.
- 2026-07-14: Task 7 — added a paid-launch adapter that fingerprints the approved launch, parsed creative, account, budget, dates, targeting, media, and gate status; the launch route now proposes durable `paid_launch` actions (attempt-numbered keys let a founder retry after failed/blocked/denied attempts), spend guardrails run as dispatch-time blockers, `performLaunch` executes once with action attribution and emits `ad.launched`, and historic ad-launch approval decisions stay untouched. Verified 6 new boundary tests, full suite 129 files / 1,328 tests, and monorepo typecheck.
- 2026-07-14: Task 10 — added the workspace Action permissions card on Automation (six concrete `autonomous|human_required` defaults iterated straight from `EXTERNAL_ACTION_KINDS`, one bounded six-kind PUT, effective badges via the shared `effectivePolicyWorkflowStatus` helper, polite save/error announcements, and copy separating cadence guardrails from action permission) and the campaign Who-signs-off panel on the campaign overview (per-kind inherit/human/autonomous selects where inherit deletes the stored override, read-only workspace/persona/connection/lane contributor lines, and its own bounded batch save). Verified 20 focused web tests, all 23 web files / 110 tests, and monorepo typecheck.

## Plan self-review

- **Spec coverage:** Tasks 1–8 cover contracts, data, migration/backfill, policy, lifecycle, all four executable adapters, unsupported kinds, worker recovery, and projections. Tasks 9–12 cover Review, policy UI, editor/origin surfaces, Home, Calendar, and Results. Task 13 covers acceptance and registry.
- **Decision separation:** no task combines content approval with action authorization; editor authorization remains link-only.
- **No bypass:** cadence, auto reply, channel dispatch, sequence, manual routes, and paid launch all receive explicit cutover steps and regression tests.
- **Historical honesty:** legacy execution rows retain nullable action links and no backfilled decision snapshots.
- **Type consistency:** every later task consumes the locked `ExternalActionRuntime`, action submission, policy, priority, Calendar, and execution-link contracts from Tasks 1–4.
- **Completeness scan:** every task names exact files, commands, expected results, error mappings, and test behavior; no unnamed implementation step remains.
