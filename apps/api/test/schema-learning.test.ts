/**
 * Learning-loop schema invariants (Sprints 66–70): evals, preference memory,
 * agent proposals, and the ask lane.
 *
 * Ported from the sprint66–70 migration tests. The recurring rule across all
 * of them is the Sprint 67 freeze rule — a record of what happened must
 * survive deletion of the thing it happened to, which is `ON DELETE SET NULL`
 * rather than CASCADE. Getting that backwards is silent and unrecoverable, so
 * it is asserted per link rather than inferred from the schema file.
 */
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { indexes } from "./schema-introspection";
import { PG_ERROR, expectPgError } from "./postgres";
import type { Db } from "../src/db";
import {
  agentProposals,
  agentQuestions,
  approvalDecisions,
  drafts,
  evalCaseResults,
  evalCases,
  evalRuns,
  evalSuites,
  pipelineDefinitions,
  pipelineRuns,
  preferenceEdits,
  preferenceRuleEvidence,
  preferenceRules,
  workspaceBannedClaims,
  workspaces,
} from "../src/db/schema";

const WS = "ws-1";
const SUITE = "suite-1";

async function seeded(): Promise<Db> {
  const db = await createTestDb();
  await db.insert(workspaces).values({ id: WS, name: "Workspace", createdAt: 1, updatedAt: 1 });
  return db;
}

async function seedSuite(db: Db): Promise<void> {
  await db.insert(evalSuites).values({
    id: SUITE,
    workspaceId: WS,
    name: "Suite",
    taskKey: "signal_social_post",
    channel: "linkedin",
    createdAt: 1,
  });
}

async function seedDraft(db: Db, state = "approved"): Promise<void> {
  await db.insert(drafts).values({
    id: "draft-1",
    workspaceId: WS,
    taskType: "signal_response",
    channel: "linkedin",
    originalContent: "gen",
    content: "final",
    state,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function seedEdit(db: Db, id = "edit-1", draftId: string | null = null): Promise<void> {
  await db.insert(preferenceEdits).values({
    id,
    workspaceId: WS,
    source: "approval_decision",
    sourceId: id,
    draftId,
    taskType: "signal_response",
    channel: "linkedin",
    beforeContent: "before",
    afterContent: "after",
    createdAt: 1,
  });
}

async function seedRule(db: Db): Promise<void> {
  await db.insert(preferenceRules).values({
    id: "rule-1",
    workspaceId: WS,
    rule: "Lead with the number.",
    polarity: "prefer",
    status: "active",
    origin: "extracted",
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("banned claims and eval schema", () => {
  it("keeps a banned claim unique per workspace", async () => {
    const db = await seeded();
    const insert = (id: string, phrase: string) =>
      db.insert(workspaceBannedClaims).values({ id, workspaceId: WS, phrase, createdAt: 1 });

    await insert("claim-1", "guaranteed results");
    await expectPgError(insert("claim-2", "guaranteed results"), PG_ERROR.uniqueViolation);
  });

  it("points a baseline label at exactly one run, but allows many unlabelled ones", async () => {
    const db = await seeded();
    await seedSuite(db);
    const insert = (id: string, baselineLabel: string | null) =>
      db.insert(evalRuns).values({
        id,
        workspaceId: WS,
        suiteId: SUITE,
        status: "succeeded",
        judgeEnabled: false,
        metricsJson: "{}",
        baselineLabel,
        createdAt: 1,
      });

    await insert("run-1", "pre-66");
    await expectPgError(insert("run-2", "pre-66"), PG_ERROR.uniqueViolation);
    // The partial index must not collapse the unlabelled runs into one.
    await insert("run-3", null);
    await insert("run-4", null);
  });

  it("keeps an eval case after its source draft is deleted (D-67.2)", async () => {
    const db = await seeded();
    await seedSuite(db);
    await seedDraft(db);
    await db.insert(evalCases).values({
      id: "case-1",
      suiteId: SUITE,
      workspaceId: WS,
      signalContent: "signal",
      signalSource: "other",
      channel: "linkedin",
      sourceDraftId: "draft-1",
      generatedContent: "gen",
      finalContent: "final",
      outcome: "approved",
      decidedAt: 1,
      createdAt: 1,
    });

    await db.delete(drafts).where(eq(drafts.id, "draft-1"));

    const [row] = await db.select().from(evalCases).where(eq(evalCases.id, "case-1"));
    expect(row?.sourceDraftId).toBeNull();
    expect(row?.generatedContent).toBe("gen");
  });

  it("cascades case results away with their run", async () => {
    const db = await seeded();
    await seedSuite(db);
    await db.insert(evalCases).values({
      id: "case-1",
      suiteId: SUITE,
      workspaceId: WS,
      signalContent: "s",
      signalSource: "other",
      channel: "linkedin",
      generatedContent: "g",
      finalContent: "f",
      outcome: "approved",
      decidedAt: 1,
      createdAt: 1,
    });
    await db.insert(evalRuns).values({
      id: "run-1",
      workspaceId: WS,
      suiteId: SUITE,
      status: "succeeded",
      judgeEnabled: false,
      metricsJson: "{}",
      createdAt: 1,
    });
    await db.insert(evalCaseResults).values({
      id: "res-1",
      runId: "run-1",
      caseId: "case-1",
      checksJson: "[]",
      costCents: 0,
      durationMs: 0,
      createdAt: 1,
    });

    await db.delete(evalRuns).where(eq(evalRuns.id, "run-1"));
    expect(await db.select({ n: count() }).from(evalCaseResults)).toEqual([{ n: 0 }]);
  });
});

describe("approval decision reasons", () => {
  it("stores a rejection reason and leaves it null when none was given", async () => {
    const db = await seeded();
    await seedDraft(db, "rejected");
    const decision = (id: string, reason: string | null, createdAt: number) =>
      db.insert(approvalDecisions).values({
        id,
        draftId: "draft-1",
        workspaceId: WS,
        action: "reject",
        fromState: "pending_review",
        toState: "rejected",
        actor: "founder",
        reason,
        createdAt,
      });

    await decision("dec-1", null, 1);
    await decision("dec-2", "Too generic", 2);

    const rows = await db
      .select({ id: approvalDecisions.id, reason: approvalDecisions.reason })
      .from(approvalDecisions)
      .orderBy(approvalDecisions.createdAt);
    expect(rows).toEqual([
      { id: "dec-1", reason: null },
      { id: "dec-2", reason: "Too generic" },
    ]);
  });
});

describe("preference memory schema", () => {
  it("captures one edit per source row and refuses a duplicate", async () => {
    const db = await seeded();
    await seedEdit(db, "decision-1");
    // Re-recording the same decision is a no-op, not a second observation.
    await expectPgError(seedEdit(db, "decision-1"), PG_ERROR.uniqueViolation);
  });

  it("keeps a captured correction after its draft is deleted", async () => {
    const db = await seeded();
    await seedDraft(db, "edited");
    await seedEdit(db, "edit-1", "draft-1");

    await db.delete(drafts).where(eq(drafts.id, "draft-1"));

    const [row] = await db
      .select()
      .from(preferenceEdits)
      .where(eq(preferenceEdits.id, "edit-1"));
    expect(row?.draftId).toBeNull();
    expect(row?.beforeContent).toBe("before");
  });

  it("links a rule to an edit exactly once and cascades from either side", async () => {
    const db = await seeded();
    await seedEdit(db);
    await seedRule(db);
    const insert = (id: string) =>
      db.insert(preferenceRuleEvidence).values({
        id,
        ruleId: "rule-1",
        editId: "edit-1",
        excerpt: "why",
        createdAt: 1,
      });

    await insert("ev-1");
    await expectPgError(insert("ev-2"), PG_ERROR.uniqueViolation);

    await db.delete(preferenceRules).where(eq(preferenceRules.id, "rule-1"));
    expect(await db.select({ n: count() }).from(preferenceRuleEvidence)).toEqual([{ n: 0 }]);
    // The edit itself survives its rule — it is evidence, not a derivative.
    expect(await db.select({ n: count() }).from(preferenceEdits)).toEqual([{ n: 1 }]);
  });

  it("takes both edits and rules with the workspace", async () => {
    const db = await seeded();
    await seedEdit(db);
    await seedRule(db);

    await db.delete(workspaces).where(eq(workspaces.id, WS));
    expect(await db.select({ n: count() }).from(preferenceEdits)).toEqual([{ n: 0 }]);
    expect(await db.select({ n: count() }).from(preferenceRules)).toEqual([{ n: 0 }]);
  });
});

describe("agent proposal ledger", () => {
  it("keeps the proposal after the thing it proposed is deleted", async () => {
    const db = await seeded();
    await seedDraft(db);
    await db.insert(agentProposals).values({
      id: "p-1",
      workspaceId: WS,
      agentRunId: "run-1",
      tool: "propose_draft",
      targetKind: "draft",
      draftId: "draft-1",
      summary: "Submitted a draft.",
      rationale: "Because pricing moved.",
      createdAt: 1,
    });

    await db.delete(drafts).where(eq(drafts.id, "draft-1"));

    // The ledger is a record of what the agent did, not a derivative of what
    // survives — nulling the link is right, deleting the row would not be.
    const [row] = await db.select().from(agentProposals).where(eq(agentProposals.id, "p-1"));
    expect(row?.draftId).toBeNull();
    expect(row?.summary).toBe("Submitted a draft.");
  });

  it("takes proposals with the workspace", async () => {
    const db = await seeded();
    await db.insert(agentProposals).values({
      id: "p-1",
      workspaceId: WS,
      agentRunId: "run-1",
      tool: "propose_draft",
      targetKind: "draft",
      summary: "Submitted a draft.",
      rationale: "Because pricing moved.",
      createdAt: 1,
    });

    await db.delete(workspaces).where(eq(workspaces.id, WS));
    expect(await db.select({ n: count() }).from(agentProposals)).toEqual([{ n: 0 }]);
  });
});

describe("ask lane schema", () => {
  async function withRun(): Promise<Db> {
    const db = await seeded();
    await db.insert(pipelineDefinitions).values({
      id: "def-1",
      workspaceId: WS,
      taskKey: "signal_social_post",
      name: "Reference",
      specJson: "{}",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(pipelineRuns).values({
      id: "run-1",
      workspaceId: WS,
      definitionId: "def-1",
      definitionVersion: 1,
      taskKey: "signal_social_post",
      channel: "linkedin",
      createdBy: "test",
      createdAt: 1,
    });
    return db;
  }

  function insertQuestion(db: Db, id: string, pipelineRunId: string | null = "run-1") {
    return db.insert(agentQuestions).values({
      id,
      workspaceId: WS,
      agentRunId: "agent-run-1",
      pipelineRunId,
      type: "clarification",
      question: "Which offer?",
      why: "Two are live.",
      fingerprint: "f".repeat(64),
      createdAt: 1,
    });
  }

  it("opens a question as open, with no answer", async () => {
    const db = await withRun();
    await insertQuestion(db, "q-1");

    const [row] = await db
      .select({
        status: agentQuestions.status,
        answer: agentQuestions.answer,
        answeredAt: agentQuestions.answeredAt,
      })
      .from(agentQuestions)
      .where(eq(agentQuestions.id, "q-1"));
    expect(row).toEqual({ status: "open", answer: null, answeredAt: null });
  });

  it("keeps the question when the run it blocked is deleted", async () => {
    const db = await withRun();
    await insertQuestion(db, "q-1");

    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, "run-1"));

    // "The agent asked this and the run is gone" is a different, and more
    // honest, statement than "the agent never asked".
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, "q-1"));
    expect(row?.pipelineRunId).toBeNull();
  });

  it("cascades questions with the workspace", async () => {
    const db = await withRun();
    await insertQuestion(db, "q-1");
    await insertQuestion(db, "q-2", null);

    await db.delete(workspaces).where(eq(workspaces.id, WS));
    expect(await db.select({ n: count() }).from(agentQuestions)).toEqual([{ n: 0 }]);
  });

  it("indexes the two lookups the ask lane actually makes", async () => {
    const db = await createTestDb();
    const names = (await indexes(db, "agent_questions")).map((i) => i.name);
    // The inbox reads open questions per workspace; resume reads them per run.
    expect(names).toContain("agent_questions_workspace_status");
    expect(names).toContain("agent_questions_pipeline_run");
  });
});
