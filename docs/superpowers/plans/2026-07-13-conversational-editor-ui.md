# Conversational Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a deep-linked three-region Review editor with persisted natural-language revisions, auditable provenance, destination-accurate preview, distinct content decisions, plan staleness, and execution history.

**Architecture:** A new draft-native revision-turn table preserves conversation and model provenance while successful revisions continue through the canonical draft `edit` transition. A focused API service owns both the composite editor projection and the revision workflow; the web consumes that projection through a pure view-model module and a self-fetching editor component embedded in the existing Review shell.

**Tech Stack:** TypeScript, Zod contracts, Fastify, Drizzle ORM with SQLite migrations, injected `LlmGateway` and `EvidenceStore`, Next.js 15 App Router, React 19, CSS Modules, Vitest.

## Global Constraints

- Branch is `ui-revamp/conversational-editor`, based on `ui-revamp/execution-results@8f313c9`; required merge order is foundations → campaign control plane → review workspace → calendar workspace → execution results → this branch.
- Implement only this conversational-editor slice. External-action authorization remains the next independent slice.
- TDD, one implementation task per commit.
- Every commit ends with `Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>`.
- Enum vocabularies live only in `@tuezday/contracts`.
- Approval transitions use `canTransition()` / `transitionTo()` through the existing draft service.
- No changes to login, authentication, onboarding, dev-admin bootstrap, or environment loading.
- Reuse `PreviewCard`, `previewKindFor`, `WorkflowStatusBadge`, the shared shell, design tokens, and existing recovery routes.
- Preserve route → service → database boundaries and dependency injection; tests never access the network.
- Preserve approve, reject, direct edit, resubmit, review rerun, carousel rendering, media, Posting to recovery, copy/download, decision history, and queue navigation.
- Do not add publishing, schedule mutation, combined Approve-and-publish, speculative cross-channel grouping, streaming, comments, or assignment.
- `npm test`, `npm run typecheck`, and `npm run build -w apps/web` must finish with exit code 0 before push.
- Push the branch to GitHub; never merge to main.

---

## What exists today

- `Draft` is the single approval object. `applyDraftAction()` already records `edit` decisions and supports `pending_review → edited` and `edited → edited`.
- `generations.sectionsJson` stores the exact resolver trace behind source generations, but drafts expose only copied pre-review data.
- `apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx` is 917 lines and contains queue, detail, connection recovery, editing, approval, history, media, copy/download, and carousel behavior.
- `GET /workspaces/:id/executions` already projects publication, targeted-launch, and ad-launch outcomes with `draftId` where the source model supports it.
- Publications already retain `draftId`, destination, schedule, external URL, and failure state.
- Campaigns retain `automationMode` and `currentPlanRevisionId`; active plan revisions retain `activatedAt`.
- No revision conversation table or natural-language revision endpoint exists.

## Scope decisions

1. Keep the editor under `/review?tab=approvals&draft=<id>` so browser history, campaign filters, and queue navigation remain continuous.
2. Store revision turns on the draft, not as new sandbox generations.
3. Insert a `running` turn before the provider call for duplicate-request visibility; update it to `completed` or `failed` afterward.
4. Count completed turns alongside generations for `monthlyGenerations`; failed turns do not consume usage.
5. Resolve current context for every conversational revision and store that exact trace on the turn.
6. Warn on plan staleness using the newest completed context source; direct manual edits do not clear the warning.
7. Include sibling channels only for drafts sharing a non-null `sourceSignalId`.
8. Keep schedule and execution state read-only. Authorization remains explicitly separate and unavailable until its API slice.

---

### Task 1: Contracts for revision turns and editor context

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/conversational-editor.test.ts`

**Interfaces:**
- Produces `DRAFT_REVISION_STATUSES`, `DraftRevisionStatus`, `DRAFT_REVISION_INSTRUCTION_MAX_CHARS`, `draftRevisionTurnSchema`, `DraftRevisionTurn`, `reviseDraftInputSchema`, `ReviseDraftInput`, `draftEditorContextSchema`, and `DraftEditorContext`.
- Reuses `draftSchema`, `approvalDecisionSchema`, `publicationSchema`, and `executionResultSchema`.

- [x] **Step 1: Write the failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  DRAFT_REVISION_INSTRUCTION_MAX_CHARS,
  DRAFT_REVISION_STATUSES,
  draftEditorContextSchema,
  draftRevisionTurnSchema,
  reviseDraftInputSchema,
} from "../src/index";

function editorContextFixture() {
  return {
    draft: {
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      sourceGenerationId: null,
      sourceSignalId: null,
      campaignId: null,
      leadId: null,
      mediaContactId: null,
      taskType: "linkedin_post",
      channel: "linkedin",
      personaId: null,
      originalContent: "Original copy",
      content: "Current copy",
      state: "pending_review",
      media: null,
      createdAt: 10,
      updatedAt: 20,
      review: null,
    },
    decisions: [],
    turns: [],
    contextSections: [
      { key: "voice", layer: "org", title: "Voice", content: "Direct", included: true, reason: "Constitutional", tokens: 1 },
      { key: "evidence", layer: "evidence", title: "Evidence", content: "", included: false, reason: "Excluded: no evidence retrieved.", tokens: 0 },
    ],
    evidenceCitations: [],
    campaign: null,
    persona: null,
    staleness: { stale: false, planActivatedAt: null, contextResolvedAt: 10, reason: "No active campaign plan applies." },
    siblings: [],
    destination: null,
    publications: [],
    executions: [],
  };
}

describe("conversational editor contracts", () => {
  it("owns the revision vocabulary", () => {
    expect(DRAFT_REVISION_STATUSES).toEqual(["running", "completed", "failed"]);
  });

  it("validates idempotent revision input", () => {
    expect(reviseDraftInputSchema.parse({
      requestId: "11111111-1111-4111-8111-111111111111",
      instruction: "Make the opening more direct.",
      expectedDraftUpdatedAt: 42,
    }).instruction).toBe("Make the opening more direct.");
    expect(reviseDraftInputSchema.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
      instruction: "x".repeat(DRAFT_REVISION_INSTRUCTION_MAX_CHARS + 1),
      expectedDraftUpdatedAt: 42,
    }).success).toBe(false);
  });

  it("requires completed turns to carry result metadata", () => {
    expect(draftRevisionTurnSchema.safeParse({
      id: "22222222-2222-4222-8222-222222222222",
      requestId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      draftId: "55555555-5555-4555-8555-555555555555",
      actorId: null,
      instruction: "Shorter.",
      sourceContent: "Long copy",
      resultContent: "Short copy",
      contextSections: [],
      status: "completed",
      error: null,
      model: "fake-model",
      provider: "fake",
      durationMs: 5,
      createdAt: 10,
      completedAt: 15,
    }).success).toBe(true);
  });

  it("accepts a complete editor projection", () => {
    const result = draftEditorContextSchema.safeParse(editorContextFixture());
    expect(result.success).toBe(true);
  });
});
```

- [x] **Step 2: Run the new test and confirm RED**

Run: `npm test -w packages/contracts -- conversational-editor.test.ts`  
Expected: FAIL because the new exports do not exist.

- [x] **Step 3: Add the schemas and refinements**

```ts
export const DRAFT_REVISION_STATUSES = ["running", "completed", "failed"] as const;
export type DraftRevisionStatus = (typeof DRAFT_REVISION_STATUSES)[number];
export const DRAFT_REVISION_INSTRUCTION_MAX_CHARS = 2_000;

export const editorContextSectionSchema = z.object({
  key: z.string().min(1),
  layer: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  included: z.boolean(),
  reason: z.string(),
  tokens: z.number().int().nonnegative(),
});

export const editorEvidenceCitationSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().url().nullable(),
  score: z.number(),
  finalScore: z.number(),
  kept: z.boolean(),
  exclusionReason: z.string().nullable(),
});

export const draftRevisionTurnSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  draftId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  instruction: z.string().min(1).max(DRAFT_REVISION_INSTRUCTION_MAX_CHARS),
  sourceContent: z.string(),
  resultContent: z.string().nullable(),
  contextSections: z.array(editorContextSectionSchema),
  status: z.enum(DRAFT_REVISION_STATUSES),
  error: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int(),
  completedAt: z.number().int().nullable(),
}).superRefine((turn, ctx) => {
  if (turn.status === "completed" && (!turn.resultContent || !turn.model || !turn.provider || turn.completedAt === null)) {
    ctx.addIssue({ code: "custom", message: "Completed revisions require result and provider metadata." });
  }
  if (turn.status === "failed" && !turn.error) {
    ctx.addIssue({ code: "custom", message: "Failed revisions require an error." });
  }
});
export type DraftRevisionTurn = z.infer<typeof draftRevisionTurnSchema>;

export const reviseDraftInputSchema = z.object({
  requestId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(DRAFT_REVISION_INSTRUCTION_MAX_CHARS),
  expectedDraftUpdatedAt: z.number().int().nonnegative(),
});
export type ReviseDraftInput = z.infer<typeof reviseDraftInputSchema>;
```

Define `draftEditorContextSchema` with exact fields: `draft`, `decisions`, `turns`, `contextSections`, `evidenceCitations`, `campaign {id,name,automationMode}|null`, `persona {id,name}|null`, `staleness {stale,planActivatedAt,contextResolvedAt,reason}`, `siblings [{draftId,channel,state}]`, `destination {providerKey,label,status,error}|null`, `publications`, and `executions`.

- [x] **Step 4: Verify GREEN**

Run: `npm test -w packages/contracts -- conversational-editor.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/conversational-editor.test.ts
git commit -m "feat(contracts): define conversational editor models" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 2: Persist draft revision turns and count completed usage

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: generated files under `apps/api/drizzle/`
- Create: `apps/api/src/services/draft-revisions.ts`
- Modify: `apps/api/src/services/entitlements.ts`
- Create: `apps/api/test/draft-revisions.test.ts`

**Interfaces:**
- Consumes `DraftRevisionTurn` and `DraftRevisionStatus` from Task 1.
- Produces `createRunningTurn`, `completeTurn`, `failTurn`, `getTurnByRequest`, `listRevisionTurns`, and `countCompletedRevisionTurnsSince`.

- [x] **Step 1: Write persistence tests first**

```ts
it("persists running, completed, and failed turns in chronological order", () => {
  const running = createRunningTurn(db, input);
  expect(running.status).toBe("running");
  const completed = completeTurn(db, running.id, {
    resultContent: "Revised copy",
    contextSections: [],
    model: "fake-model",
    provider: "fake",
    durationMs: 5,
  });
  expect(completed.status).toBe("completed");
  expect(listRevisionTurns(db, workspaceId, draftId)).toHaveLength(1);
});

it("enforces one request id per draft", () => {
  createRunningTurn(db, input);
  expect(() => createRunningTurn(db, input)).toThrow();
});

it("counts only completed turns for usage", () => {
  const completed = createRunningTurn(db, input);
  completeTurn(db, completed.id, result);
  const failed = createRunningTurn(db, { ...input, requestId: randomUUID() });
  failTurn(db, failed.id, "provider down");
  expect(countCompletedRevisionTurnsSince(db, workspaceId, 0)).toBe(1);
});
```

- [x] **Step 2: Confirm RED**

Run: `npm test -- draft-revisions.test.ts`  
Expected: FAIL because the table and service do not exist.

- [x] **Step 3: Add the Drizzle table and generate the migration**

```ts
export const draftRevisionTurns = sqliteTable(
  "draft_revision_turns",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    draftId: text("draft_id").notNull().references(() => drafts.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    instruction: text("instruction").notNull(),
    sourceContent: text("source_content").notNull(),
    resultContent: text("result_content"),
    sectionsJson: text("sections_json").notNull().default("[]"),
    status: text("status").notNull(),
    error: text("error"),
    model: text("model"),
    provider: text("provider"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    uniqueIndex("draft_revision_turn_request").on(t.draftId, t.requestId),
    index("draft_revision_turn_draft").on(t.draftId, t.createdAt),
  ],
);
```

Run: `npm run db:generate -w apps/api`  
Expected: a new checked-in migration and journal entry representing `draft_revision_turns`.

- [x] **Step 4: Implement the service and usage sum**

`rowToTurn()` parses `sectionsJson`. `completeTurn()` writes result/model/provider/duration, clears error, sets `status: "completed"`, and sets `completedAt`. `failTurn()` writes the bounded error, null result metadata, and `status: "failed"`.

```ts
export function countCompletedRevisionTurnsSince(db: Db, workspaceId: string, sinceMs: number): number {
  return db.select({ id: draftRevisionTurns.id })
    .from(draftRevisionTurns)
    .where(and(
      eq(draftRevisionTurns.workspaceId, workspaceId),
      eq(draftRevisionTurns.status, "completed"),
      gte(draftRevisionTurns.completedAt, sinceMs),
    )).all().length;
}
```

Update `getUsage()` with explicit counts:

```ts
const monthlyGenerationCount = countGenerationsSince(db, workspaceId, periodStart);
const monthlyRevisionCount = countCompletedRevisionTurnsSince(db, workspaceId, periodStart);
return {
  seats: listMembers(db, workspaceId).length,
  connectors: listConnections(db, workspaceId).length,
  monthlyGenerations: monthlyGenerationCount + monthlyRevisionCount,
};
```

- [x] **Step 5: Verify GREEN and migration boot**

Run: `npm test -- draft-revisions.test.ts health.test.ts`  
Expected: PASS; the in-memory database migrates successfully.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/services/draft-revisions.ts apps/api/src/services/entitlements.ts apps/api/test/draft-revisions.test.ts
git commit -m "feat(api): persist conversational draft revisions" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 3: Build the composite editor projection

**Files:**
- Create: `apps/api/src/services/draft-editor.ts`
- Modify: `apps/api/src/routes/drafts.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/draft-editor-context.test.ts`

**Interfaces:**
- Consumes Task 1 contracts, Task 2 turn readers, `listDecisions`, `listPublications`, `listExecutionResults`, `getCurrentCampaignPlan`, `listConnections`, and source generation `sectionsJson`.
- Produces `getDraftEditorContext(db, workspaceId, draftId): DraftEditorContext | undefined` and the GET editor route.

- [x] **Step 1: Write projection tests first**

```ts
it("returns an editor context conforming to the public schema", async () => {
  const draft = await generatedDraft(app, workspaceId, { campaignId, personaId });
  const response = await app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/drafts/${draft.id}/editor`,
  });
  expect(response.statusCode).toBe(200);
  const parsed = draftEditorContextSchema.parse(response.json());
  expect(parsed.draft.id).toBe(draft.id);
  expect(parsed.contextSections.some((section) => section.layer === "campaign")).toBe(true);
});

it("includes only source-signal siblings", async () => {
  expect(context.siblings.map((item) => item.draftId)).toEqual([sameSignalDraft.id]);
  expect(context.siblings).not.toContainEqual(expect.objectContaining({ draftId: campaignOnlyDraft.id }));
});

it("marks a draft stale only when the active plan is newer than its context source", async () => {
  expect(staleContext.staleness.stale).toBe(true);
  expect(currentContext.staleness.stale).toBe(false);
});

it("scopes publications and executions by draft id", async () => {
  expect(context.publications.every((item) => item.draftId === draft.id)).toBe(true);
  expect(context.executions.every((item) => item.draftId === draft.id)).toBe(true);
});
```

Add a second workspace and assert its user cannot read the first workspace's draft through the route.

- [x] **Step 2: Confirm RED**

Run: `npm test -- draft-editor-context.test.ts`  
Expected: FAIL with GET 404 because the route does not exist.

- [x] **Step 3: Implement normalization helpers**

Create pure internal helpers in `draft-editor.ts`:

```ts
function safeSourceUrl(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  try {
    const url = new URL(sourceRef);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function planStaleness(planActivatedAt: number | null, contextResolvedAt: number) {
  const stale = planActivatedAt !== null && planActivatedAt > contextResolvedAt;
  return {
    stale,
    planActivatedAt,
    contextResolvedAt,
    reason: stale
      ? "The campaign plan changed after this output last resolved its context."
      : "This output reflects the current campaign plan.",
  };
}
```

Normalize stored resolver sections without inventing a new layer enum. Join evidence trace document IDs against `evidence_documents` for title, kind, and safe source URL. Resolve destination from the draft's persona account where available, otherwise from a matching channel connection.

- [x] **Step 4: Implement and register the GET route**

```ts
app.get<{ Params: { id: string; draftId: string } }>(
  "/workspaces/:id/drafts/:draftId/editor",
  async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const context = getDraftEditorContext(db, request.params.id, request.params.draftId);
    if (!context) return reply.status(404).send({ error: "draft_not_found" });
    return draftEditorContextSchema.parse(context);
  },
);
```

The service sorts decisions and turns oldest-first, publications and executions newest-first, and determines `contextResolvedAt` from newest completed turn → source generation → draft creation.

- [x] **Step 5: Verify GREEN**

Run: `npm test -- draft-editor-context.test.ts executions.test.ts drafts.test.ts`  
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/services/draft-editor.ts apps/api/src/routes/drafts.ts apps/api/src/app.ts apps/api/test/draft-editor-context.test.ts
git commit -m "feat(api): expose conversational editor context" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 4: Implement the natural-language revision workflow

**Files:**
- Modify: `apps/api/src/services/draft-editor.ts`
- Modify: `apps/api/src/services/drafts.ts`
- Modify: `apps/api/src/routes/drafts.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/draft-editor-revision.test.ts`

**Interfaces:**
- Produces `reviseDraft(deps, input): Promise<{ draft: Draft; turn: DraftRevisionTurn }>` and typed errors `RevisionInProgressError`, `DraftChangedError`, and `RevisionFailedError`.
- Adds a transaction-safe draft edit helper that accepts the transaction database while preserving existing `applyDraftAction()` behavior.

- [x] **Step 1: Write the revision API tests first**

```ts
it("revises with current context and records the canonical edit decision", async () => {
  const response = await revise(app, workspaceId, draft, {
    instruction: "Make the opening sharper.",
    expectedDraftUpdatedAt: draft.updatedAt,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().draft).toMatchObject({ state: "edited", content: "Sharper copy" });
  expect(response.json().turn).toMatchObject({ status: "completed", resultContent: "Sharper copy" });
  expect(capturedPrompt()).toContain("Make the opening sharper.");
  expect(capturedPrompt()).toContain("CURRENT DRAFT");
  expect(editor.decisions.at(-1).action).toBe("edit");
});

it("returns the completed result for a duplicate request id", async () => {
  const first = await reviseWithRequestId(requestId);
  const second = await reviseWithRequestId(requestId);
  expect(second.json()).toEqual(first.json());
  expect(llmCallCount()).toBe(1);
});

it("does not overwrite a draft changed during the provider call", async () => {
  const pending = reviseWithDeferredLlm();
  await directEditDraft();
  releaseLlm("Late AI copy");
  expect((await pending).statusCode).toBe(409);
  expect((await getDraft()).content).toBe("Newer manual copy");
});

it("records provider failure without consuming usage", async () => {
  expect((await reviseWithFailingLlm()).statusCode).toBe(502);
  expect((await getEditor()).turns.at(-1).status).toBe("failed");
  expect((await getUsage()).monthlyGenerations).toBe(beforeUsage);
});
```

Also test approved/rejected invalid transitions, duplicate running request, empty model output, 402 entitlement enforcement with `TEST_BILLING_GATING`, six-turn history bounding, current campaign guidance in the prompt, evidence exclusion, analytics-after-success, and cross-workspace isolation.

- [x] **Step 2: Confirm RED**

Run: `npm test -- draft-editor-revision.test.ts`  
Expected: FAIL with POST 404.

- [x] **Step 3: Add transaction-safe draft editing**

Refactor the internals of `applyDraftAction()` into a structural write helper used by both the existing function and revision transaction. Keep the exported signature unchanged for every current caller. Update Task 2's `completeTurn()` and `failTurn()` to accept the same structural write database so the turn update participates in the transaction.

```ts
type DraftWriteDb = Pick<Db, "insert" | "update">;

function applyDraftActionWith(
  db: DraftWriteDb,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
): Draft {
  const toState = transitionTo(draft.state, action);
  if (!toState) throw new InvalidTransitionError(draft.state, action);
  const now = Date.now();
  const content = action === "edit" && newContent !== undefined ? newContent : draft.content;
  db.update(drafts).set({ state: toState, content, updatedAt: now }).where(eq(drafts.id, draft.id)).run();
  logDecision(db, draft, actor, action, draft.state, toState, action === "edit" ? content : null);
  return { ...draft, state: toState, content, updatedAt: now };
}

export function applyDraftAction(
  db: Db,
  draft: Draft,
  action: ApprovalAction,
  actor: DraftActor,
  newContent?: string,
): Draft {
  return applyDraftActionWith(db, draft, action, actor, newContent);
}
```

Change `logDecision()` to accept `DraftWriteDb`, then export `applyDraftActionWith` under the name `applyDraftActionInTransaction` with `DraftWriteDb` as its first parameter. Drizzle's transaction callback satisfies this structural type; do not cast the transaction to `unknown`.

- [x] **Step 4: Resolve current revision context and build the bounded prompt**

```ts
const recentConversation = turns
  .filter((turn) => turn.status === "completed")
  .slice(-6)
  .map((turn) => `USER: ${turn.instruction}\nTUEZDAY: ${turn.resultContent ?? ""}`)
  .join("\n\n")
  .slice(-12_000);

const prompt = `${resolved.prompt}\n\nREVISION RULES\nReturn only the revised deliverable. Preserve supported facts and citations.\n\nRECENT REVISIONS\n${recentConversation || "None"}\n\nCURRENT DRAFT\n${draft.content}\n\nUSER INSTRUCTION\n${input.instruction}`;
```

Use the same Brain, campaign, persona, channel guidance, account, signal, selective-context, and evidence services as generation. Do not call the generation route from the service.

- [x] **Step 5: Implement POST route status mapping**

Parse `reviseDraftInputSchema`; map entitlement to 402, duplicate running/draft changed/invalid transition to 409, and provider/empty output to 502. Pass `actorOf(request)` and track `draft.revised` only after the successful transaction.

- [x] **Step 6: Verify GREEN**

Run: `npm test -- draft-editor-revision.test.ts drafts.test.ts entitlements.test.ts analytics-capture.test.ts`  
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/services/draft-editor.ts apps/api/src/services/drafts.ts apps/api/src/routes/drafts.ts apps/api/src/app.ts apps/api/test/draft-editor-revision.test.ts
git commit -m "feat(api): add conversational draft revision" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 5: Define the editor web view model and canonical URLs

**Files:**
- Create: `apps/web/lib/conversational-editor.ts`
- Create: `apps/web/lib/conversational-editor.test.ts`
- Modify: `apps/web/lib/review-workspace.ts`
- Modify: `apps/web/lib/review-workspace.test.ts`

**Interfaces:**
- Produces `editorVersionOptions`, `editorVersionContent`, `groupEditorSections`, `automationExplanation`, `stalenessExplanation`, `editorRecoveryHref`, and `reviewHref()` support for `draft`, `state`, and `channel`.

- [x] **Step 1: Write pure-function tests first**

```ts
it("preserves queue context in editor URLs", () => {
  expect(reviewHref("w1", {
    tab: "approvals",
    campaign: "c1",
    state: "pending_review",
    channel: "linkedin",
    draft: "d1",
  })).toBe("/workspaces/w1/review?tab=approvals&campaign=c1&state=pending_review&channel=linkedin&draft=d1");
});

it("builds original, current, and completed revision versions", () => {
  expect(editorVersionOptions(context).map((item) => item.label)).toEqual([
    "Original", "Current", "Revision 1",
  ]);
  expect(editorVersionContent(context, "revision:turn-1")).toBe("Revised copy");
});

it("groups included and excluded context without losing reasons", () => {
  expect(groupEditorSections(context.contextSections).excluded[0].reason).toContain("Excluded");
});

it("explains automation modes in user language", () => {
  expect(automationExplanation("scheduled_auto")).toContain("may approve and post");
  expect(automationExplanation("manual")).toContain("you stay in control");
});
```

- [x] **Step 2: Confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/conversational-editor.test.ts lib/review-workspace.test.ts`  
Expected: FAIL because the module and URL options are missing.

- [x] **Step 3: Implement pure view-model functions**

```ts
export type EditorVersionId = "original" | "current" | `revision:${string}`;

export function editorVersionOptions(context: DraftEditorContext) {
  return [
    { id: "original" as const, label: "Original" },
    { id: "current" as const, label: "Current" },
    ...context.turns.filter((turn) => turn.status === "completed").map((turn, index) => ({
      id: `revision:${turn.id}` as const,
      label: `Revision ${index + 1}`,
    })),
  ];
}
```

`editorRecoveryHref()` delegates publication/launch/ad-launch recovery to `executionTargetHref()` and returns Calendar/Content links for scheduled rows. `groupEditorSections()` preserves resolver order inside layer groups.

- [x] **Step 4: Verify GREEN**

Run: `npm exec --prefix apps/web vitest -- run lib/conversational-editor.test.ts lib/review-workspace.test.ts`  
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/lib/conversational-editor.ts apps/web/lib/conversational-editor.test.ts apps/web/lib/review-workspace.ts apps/web/lib/review-workspace.test.ts
git commit -m "feat(web): define conversational editor view model" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 6: Build the self-fetching three-region editor

**Files:**
- Create: `apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx`
- Create: `apps/web/app/workspaces/[id]/review/_components/conversational-editor.module.css`
- Create: `apps/web/lib/conversational-editor-shell-contract.test.ts`

**Interfaces:**
- Component props: `{ workspaceId: string; draftId: string; previousId: string | null; nextId: string | null; onNavigate(id: string): void; onClose(): void; onChanged(): Promise<void> | void }`.
- Fetches `GET /drafts/:draftId/editor`; mutates existing draft action/review/carousel routes and the new revise route.

- [x] **Step 1: Write the structural contract test first**

```ts
it("uses the shared preview and canonical status primitives", () => {
  const source = read("app/workspaces/[id]/review/_components/conversational-editor.tsx");
  expect(source).toContain("PreviewCard");
  expect(source).toContain("previewKindFor");
  expect(source).toContain("WorkflowStatusBadge");
  expect(source).toContain('aria-label="Guidance"');
  expect(source).toContain('aria-label="Preview"');
  expect(source).toContain('aria-label="Execution"');
  expect(source).toContain('aria-live="polite"');
});

it("keeps content and external-action decisions separate", () => {
  expect(source).toContain("Content decision");
  expect(source).toContain("External action authorization");
  expect(source).not.toContain("Approve and publish");
});
```

- [x] **Step 2: Confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/conversational-editor-shell-contract.test.ts`  
Expected: FAIL because the component does not exist.

- [x] **Step 3: Implement data loading, navigation, and mutation state**

The component owns `context`, `selectedVersion`, `instruction`, `busyAction`, `error`, and responsive side-rail tab state. On draft ID change it reloads context, resets selected version to Current, focuses the editor heading, and retains no stale mutation state.

Revision submission sends:

```ts
const response = await apiFetch(`/workspaces/${workspaceId}/drafts/${draftId}/revise`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: crypto.randomUUID(),
    instruction,
    expectedDraftUpdatedAt: context.draft.updatedAt,
  }),
});
```

On success clear the composer, reload Current, call `onChanged`, and announce success. On `draft_changed`, reload but retain the instruction and label the retry **Try again on latest**. Provider failure retains the instruction and exposes Retry with a new request ID.

- [x] **Step 4: Implement Guidance, Preview, and Execution landmarks**

Guidance renders pre-review checks, the collapsed disclosure, grouped source sections, evidence citations, chronological turns, model metadata, failed-turn recovery, and composer examples.

Preview renders sibling channel links, version tabs, `PreviewCard`, media strip, and Original/Current/revision content without mutating the draft.

Execution renders `WorkflowStatusBadge`, campaign/persona links, destination state, schedule rows, automation explanation, the authorization boundary, direct edit, copy/download, carousel, and execution recovery links.

The sticky **Content decision** bar renders only legal actions determined by `canTransition()` and never merges approval with action execution.

- [x] **Step 5: Implement responsive CSS and focus safety**

```css
.layout { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(420px, 1.45fr) minmax(280px, .9fr); gap: 16px; align-items: start; }
.region { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.decisionBar { position: sticky; bottom: 0; z-index: 4; display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, transparent); }
@media (max-width: 1180px) { .layout { grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); } .guidance, .execution { grid-column: 2; } .preview { grid-column: 1; grid-row: 1 / span 2; } }
@media (max-width: 760px) { .layout { display: flex; flex-direction: column; } .preview { order: 1; } .guidance { order: 2; } .execution { order: 3; } }
```

Use only existing token names confirmed in `globals.css`; if a listed alias is absent, substitute the nearest existing token rather than adding feature-local raw colors.

- [x] **Step 6: Verify component contract and typecheck**

Run: `npm exec --prefix apps/web vitest -- run lib/conversational-editor-shell-contract.test.ts lib/conversational-editor.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [x] **Step 7: Commit**

```bash
git add 'apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx' 'apps/web/app/workspaces/[id]/review/_components/conversational-editor.module.css' apps/web/lib/conversational-editor-shell-contract.test.ts
git commit -m "feat(web): build the conversational editor" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 7: Integrate the editor with Review and preserve queue behavior

**Files:**
- Modify: `apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx`
- Modify: `apps/web/app/workspaces/[id]/review/_components/approvals-queue.module.css`
- Modify: `apps/web/app/workspaces/[id]/review/page.tsx`
- Modify: `apps/web/lib/review-shell-contract.test.ts`
- Modify: `apps/web/lib/conversational-editor-shell-contract.test.ts`

**Interfaces:**
- Consumes Task 5 canonical URL builder and Task 6 component.
- Approvals queue keeps list/filter/group ownership and delegates detail ownership to `ConversationalEditor`.

- [x] **Step 1: Extend shell tests for deep-link continuity**

```ts
it("renders the editor from the draft query while keeping Review canonical", () => {
  expect(queueSource).toContain('searchParams.get("draft")');
  expect(queueSource).toContain("<ConversationalEditor");
  expect(queueSource).toContain("reviewHref");
  expect(queueSource).not.toContain("function renderDetail");
});

it("preserves campaign, state, and channel when navigating drafts", () => {
  expect(reviewWorkspaceSource).toContain("draft");
  expect(reviewWorkspaceSource).toContain("campaign");
  expect(reviewWorkspaceSource).toContain("channel");
  expect(reviewWorkspaceSource).toContain("state");
});
```

- [x] **Step 2: Confirm RED**

Run: `npm exec --prefix apps/web vitest -- run lib/review-shell-contract.test.ts lib/conversational-editor-shell-contract.test.ts`  
Expected: FAIL because Review does not mount the editor.

- [x] **Step 3: Move detail ownership out of the 917-line queue**

Remove `renderDetail`, editing/history/detail-only states, and detail-only helpers after their behavior exists in `ConversationalEditor`. Keep queue loading, grouping, filtering, cards, approve-all, and focus advance.

Read `draft`, `state`, `campaign`, and `channel` from `useSearchParams`. Opening and closing use `router.push(reviewHref(id, { tab: "approvals", campaign, state, channel, draft }))`; filter changes use the same call through `router.replace()` with the changed filter value.

```tsx
if (openDraftId) {
  const { prev, next } = queueNeighbors(orderedVisibleIds, openDraftId);
  return (
    <ConversationalEditor
      workspaceId={id}
      draftId={openDraftId}
      previousId={prev}
      nextId={next}
      onNavigate={(draft) => navigateToDraft(draft)}
      onClose={() => navigateToDraft(null)}
      onChanged={load}
    />
  );
}
```

The card **Open editor** action writes the draft URL. Sibling and Previous/Next navigation use the same builder. Closing removes only `draft`, not filters.

- [x] **Step 4: Preserve direct card decisions and focus advance**

Keep card-level Approve/Edit/Reject controls only where they already exist and remain unambiguous. After an editor approval, `onChanged()` reloads the queue and navigates to the next visible approvable item, or closes to the filtered queue if none remains.

- [x] **Step 5: Verify focused regression set**

Run: `npm exec --prefix apps/web vitest -- run lib/review-workspace.test.ts lib/review-shell-contract.test.ts lib/conversational-editor.test.ts lib/conversational-editor-shell-contract.test.ts lib/preview-kind.test.ts lib/workflow-status.test.ts`  
Expected: PASS.  
Run: `npm run typecheck`  
Expected: exit 0.

- [x] **Step 6: Commit**

```bash
git add 'apps/web/app/workspaces/[id]/review/_components/approvals-queue.tsx' 'apps/web/app/workspaces/[id]/review/_components/approvals-queue.module.css' 'apps/web/app/workspaces/[id]/review/page.tsx' apps/web/lib/review-shell-contract.test.ts apps/web/lib/conversational-editor-shell-contract.test.ts
git commit -m "feat(web): open conversational editing from Review" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification, acceptance, registry, and push

**Files:**
- Create: `docs/ui-ux/conversational-editor-acceptance.md`
- Modify: `docs/ui-ux/capability-registry.md`
- Modify: `docs/superpowers/plans/2026-07-13-conversational-editor-ui.md` progress log and checkboxes

**Interfaces:**
- Records the delivered scope and verification evidence; changes no runtime API.

- [ ] **Step 1: Run all focused editor suites**

Run: `npm test -- conversational-editor draft-editor draft-revisions review-workspace review-shell execution-results`  
Expected: all selected files and tests pass.

- [ ] **Step 2: Run the full suite unpiped**

Run: `npm test`  
Expected: exit 0. If the inherited Playwright renderer is blocked by the environment, rerun the exact renderer test with the environment's approved unsandboxed mechanism, then rerun the full suite in the final capable environment; do not record a green gate from truncated output.

- [ ] **Step 3: Run typecheck and production build unpiped**

Run: `npm run typecheck`  
Expected: exit 0.  
Run: `npm run build -w apps/web`  
Expected: exit 0 and `/workspaces/[id]/review` compiles.

- [ ] **Step 4: Write acceptance and update registry**

Acceptance includes: outcome, branch/baseline/merge order, contracts, migration, API behavior, three regions, preserved behavior, staleness, responsive/accessibility behavior, error recovery, explicit authorization boundary, verification table, and known non-blocking notes.

Update registry rows:

- Destination preview → implemented in conversational editor for draft channel/media and reliable source-signal siblings.
- Brain evidence disclosure → implemented through **Why Tuezday made this** with stored source and revision traces.
- Unified execution results → editor added as a consumer.
- Content approval → editor retains canonical decisions.
- External-action authorization → still contracts-only and next slice.

- [ ] **Step 5: Check repository hygiene**

Run: `git diff --check`  
Expected: exit 0.  
Run: `rg -n 'FIXME|Approve and publish' apps/api/src/services/draft-editor.ts 'apps/web/app/workspaces/[id]/review/_components/conversational-editor.tsx' docs/ui-ux/conversational-editor-acceptance.md`  
Expected: no output.  
Run: `git status --short`  
Expected: only the acceptance, registry, and plan progress changes for this task.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/ui-ux/conversational-editor-acceptance.md docs/ui-ux/capability-registry.md docs/superpowers/plans/2026-07-13-conversational-editor-ui.md
git commit -m "docs: accept conversational editor slice" -m "Co-Authored-By: Claude GPT-5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push without merging**

Run: `git push -u origin ui-revamp/conversational-editor`  
Expected: branch created/updated on origin; no merge command is run.

## Progress log

- 2026-07-13: Created isolated worktree from `ui-revamp/execution-results@8f313c9`; installed workspace dependencies. Baseline: 1,241/1,242 tests passed in the restricted sandbox, with the sole Chromium renderer test passing separately outside the sandbox.
- 2026-07-13: Approved design captured in `docs/superpowers/specs/2026-07-13-conversational-editor-design.md` and committed as `977a2f0`.
- 2026-07-13: Implementation plan written after mapping contracts, draft state machine, resolver traces, evidence, plan revisions, publications, executions, automation modes, Review URL state, and current component ownership.
- 2026-07-13: Task 1 RED confirmed with five missing-export failures; GREEN with five contract tests covering revision vocabulary/input/turn invariants and the composite editor projection.
- 2026-07-13: Task 2 RED confirmed on the missing persistence module; GREEN with migration `0044`, six revision-turn service tests, health migration boot, and API typecheck.
- 2026-07-13: Task 3 RED confirmed with the missing editor route; GREEN with schema-conforming provenance/staleness/sibling/destination/publication/execution projection, workspace isolation, 25 focused API tests, and API typecheck.
- 2026-07-13: Task 4 RED confirmed with seven missing-route failures; GREEN with 12 revision workflow tests covering canonical edits, idempotency, optimistic conflicts, live scoped context, bounded history, evidence exclusion, metering, analytics, provider failures, invalid states, and workspace isolation. The focused 38-test API set and API typecheck pass.
- 2026-07-13: Task 5 RED confirmed on the missing editor view-model module and dropped URL state; GREEN with 11 pure tests for versions, context grouping, policy/staleness copy, recovery ownership, and canonical Review deep links. Web typecheck passes.
- 2026-07-13: Task 6 RED confirmed on the absent editor shell; GREEN with structural coverage for shared preview/status primitives, accessible Guidance/Preview/Execution landmarks, explicit authorization separation, optimistic concurrency recovery, and focus safety. The component and responsive CSS pass focused tests and web typecheck.
- 2026-07-13: Task 7 RED confirmed on missing Review mounting and URL continuity; GREEN after reducing ApprovalsQueue from 917 lines to queue-only ownership, mounting the editor from `draft`, preserving campaign/state/channel scope, retaining direct/batch decisions and focus advance, and routing terminal decisions to the next eligible item. The 23-test focused web regression set and web typecheck pass.
