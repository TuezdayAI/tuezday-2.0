import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  pipelineSpecSchema,
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  type PipelineSpec,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  agentRuns,
  agentRunSteps,
  drafts,
  generations,
  pipelineRuns,
  signals,
  workspaces,
} from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import {
  createPipelineDefinition,
  updatePipelineSpec,
} from "../src/services/pipeline-definitions";
import {
  decidePipelineRun,
  executePipelineRun,
  getPipelineRunDetail,
  listPipelineRuns,
  runPipelineDryRun,
  startPipelineRun,
  DuplicatePipelineRunError,
  InvalidPipelineRunTransitionError,
  type PipelineEngineDeps,
} from "../src/services/pipeline-engine";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "ws-engine";
const SIGNAL_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_2_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = { userId: null, label: "founder" };

function fixture(script: ScriptedStep[]) {
  const db = createTestDb();
  db.insert(workspaces)
    .values({ id: WORKSPACE_ID, name: "Engine", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(signals)
    .values([
      {
        id: SIGNAL_ID,
        workspaceId: WORKSPACE_ID,
        content: "A competitor raised a Series B.",
        source: "manual",
        sourceUrl: null,
        createdAt: 2,
      },
      {
        id: SIGNAL_2_ID,
        workspaceId: WORKSPACE_ID,
        content: "A buyer complained about generic outreach.",
        source: "manual",
        sourceUrl: null,
        createdAt: 1,
      },
    ])
    .run();
  const gateway = new ScriptedGateway(script);
  const deps: PipelineEngineDeps = {
    llm: gateway,
    evidence: {} as unknown as EvidenceStore,
    safeFetch: {} as unknown as SafeFetchService,
  };
  return { db, gateway, deps };
}

function miniSpec(overrides: Partial<PipelineSpec> = {}): PipelineSpec {
  return pipelineSpecSchema.parse({
    steps: [
      {
        key: "draft",
        title: "Draft",
        goal: "Write the post.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "draft",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      {
        key: "critique",
        title: "Critique",
        goal: "Judge the draft.",
        kind: "agent",
        tools: [],
        tier: "cheap",
        output: "findings",
        maxSteps: 2,
        maxTokens: 8_000,
      },
      {
        key: "revise",
        title: "Revise",
        goal: "Fix the findings.",
        kind: "agent",
        tools: [],
        tier: "frontier",
        output: "draft",
        maxSteps: 2,
        maxTokens: 8_000,
        loop: { scoreFrom: "critique", threshold: 70, maxIterations: 2 },
      },
      { key: "propose", title: "Propose", goal: "Submit.", kind: "propose", output: "proposal" },
    ],
    budget: { maxTokens: 100_000 },
    ...overrides,
  });
}

function definitionWith(db: Db, spec: PipelineSpec) {
  return createPipelineDefinition(
    db,
    WORKSPACE_ID,
    { taskKey: "signal_social_post", name: "Test pipeline", description: "", spec },
    ACTOR,
  );
}

function startLive(db: Db, definition: ReturnType<typeof definitionWith>, key?: string) {
  return startPipelineRun(db, {
    workspaceId: WORKSPACE_ID,
    definition,
    signalId: SIGNAL_ID,
    channel: "linkedin",
    mode: "live",
    idempotencyKey: key ?? null,
    createdBy: "founder",
  });
}

const draftOut = (content: string, confidence?: number) => ({
  text: JSON.stringify({ content, ...(confidence === undefined ? {} : { confidence }) }),
});
const findingsOut = (score: number, extras: Record<string, unknown> = {}) => ({
  text: JSON.stringify({ score, findings: [], guardrailUncertain: false, ...extras }),
});

describe("pipeline engine", () => {
  it("runs the reference definition end to end and hands the draft to the gate", async () => {
    const { db, gateway, deps } = fixture([
      {
        text: JSON.stringify({
          summary: "Series B in our category.",
          keyFacts: ["Competitor raised $30M"],
          sources: [],
          confidence: 85,
        }),
      },
      {
        text: JSON.stringify({
          angles: [{ title: "Category heat", rationale: "Funding proves demand." }],
          confidence: 80,
        }),
      },
      draftOut("Funding follows pain. Here's what buyers actually want.", 82),
      findingsOut(90, { confidence: 88 }),
      // revise is skipped (score 90 ≥ 70); propose is engine-owned — no more calls.
    ]);
    const definition = definitionWith(db, REFERENCE_SIGNAL_SOCIAL_POST_SPEC);
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.blocked).toBeUndefined();
    expect(outcome.run.status).toBe("succeeded");
    expect(outcome.run.checklist.map((entry) => entry.stepKey)).toEqual([
      "research",
      "angle",
      "draft",
      "critique",
      "revise",
      "propose",
    ]);
    expect(outcome.run.checklist.every((entry) => entry.passes)).toBe(true);
    expect(outcome.run.checklist[4]!.evidence).toContain("Skipped");

    // Tier routing (Sprint 59 seam): research cheap, the rest frontier.
    expect(gateway.calls.map((call) => call.tier)).toEqual([
      "cheap",
      "frontier",
      "frontier",
      "frontier",
    ]);

    // Gate handoff (D-64.4/5): a pending_review draft + an honest generation trace.
    const draftRows = db.select().from(drafts).all();
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]).toMatchObject({
      state: "pending_review",
      channel: "linkedin",
      taskType: "signal_response",
      sourceSignalId: SIGNAL_ID,
      content: "Funding follows pain. Here's what buyers actually want.",
    });
    const generationRows = db.select().from(generations).all();
    expect(generationRows).toHaveLength(1);
    const sections = JSON.parse(generationRows[0]!.sectionsJson) as { key: string }[];
    expect(sections.map((section) => section.key)).toEqual(
      expect.arrayContaining(["pipeline:research", "pipeline:critique"]),
    );
    expect(outcome.run.draftId).toBe(draftRows[0]!.id);
    expect(outcome.run.generationId).toBe(generationRows[0]!.id);
    expect(outcome.run.result).toMatchObject({ simulated: false });
    expect(outcome.run.inputTokens).toBeGreaterThan(0);

    // Every agent step is an inspectable agent_run labelled pipeline:<step>.
    const agentTasks = db.select().from(agentRuns).all().map((row) => row.task);
    expect(agentTasks).toEqual([
      "pipeline:research",
      "pipeline:angle",
      "pipeline:draft",
      "pipeline:critique",
    ]);
  });

  it("drives the revise loop until the critique score clears the threshold", async () => {
    const { db, deps } = fixture([
      draftOut("Post v1"),
      findingsOut(50),
      draftOut("Post v2"),
      findingsOut(85),
    ]);
    const definition = definitionWith(db, miniSpec());
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.run.status).toBe("succeeded");
    expect(outcome.run.result).toMatchObject({ content: "Post v2" });
    const detail = getPipelineRunDetail(db, WORKSPACE_ID, run.id)!;
    const passes = detail.steps.map((step) => `${step.stepKey}#${step.iteration}:${step.status}`);
    expect(passes).toEqual([
      "draft#1:succeeded",
      "critique#1:succeeded",
      "revise#1:succeeded",
      "critique#2:succeeded",
      "propose#1:succeeded",
    ]);
  });

  it("escalates on low confidence and resumes from the pause point without re-running steps", async () => {
    const { db, gateway, deps } = fixture([
      draftOut("Tentative post", 40),
      // Resume continues here:
      findingsOut(90),
    ]);
    const definition = definitionWith(
      db,
      miniSpec({ escalation: { minConfidence: 60, onGuardrailUncertain: true } }),
    );
    const run = startLive(db, definition);
    const paused = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);
    expect(paused.run.status).toBe("escalated");
    expect(paused.run.pausedAtStepKey).toBe("draft");
    expect(paused.run.escalationReason).toContain("low_confidence:draft");
    expect(db.select().from(drafts).all()).toHaveLength(0);

    const resumed = await decidePipelineRun(db, deps, WORKSPACE_ID, run.id, {
      action: "resume",
    });
    expect(resumed.run.status).toBe("succeeded");
    expect(resumed.run.pausedAtStepKey).toBeNull();
    expect(resumed.run.escalationReason).toBeNull();
    // The draft step was replayed from cache, not re-executed.
    expect(gateway.calls).toHaveLength(2);
    expect(db.select().from(drafts).all()).toHaveLength(1);
  });

  it("escalates on guardrail uncertainty and honours cancel", async () => {
    const { db, deps } = fixture([
      draftOut("Post", 90),
      findingsOut(90, { guardrailUncertain: true }),
    ]);
    const definition = definitionWith(
      db,
      miniSpec({ escalation: { onGuardrailUncertain: true } }),
    );
    const run = startLive(db, definition);
    const paused = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);
    expect(paused.run.status).toBe("escalated");
    expect(paused.run.escalationReason).toBe("guardrail_uncertain:critique");

    const cancelled = await decidePipelineRun(db, deps, WORKSPACE_ID, run.id, {
      action: "cancel",
      reason: "not worth publishing",
    });
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.run.failureReason).toBe("cancelled: not worth publishing");

    await expect(
      decidePipelineRun(db, deps, WORKSPACE_ID, run.id, { action: "resume" }),
    ).rejects.toBeInstanceOf(InvalidPipelineRunTransitionError);
  });

  it("retries an invalid structured output and fails the run at the attempt cap", async () => {
    const { db, deps } = fixture([
      { text: JSON.stringify({ wrong: true }) },
      { text: JSON.stringify({ also: "wrong" }) },
    ]);
    const definition = definitionWith(db, miniSpec());
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.failureReason).toBe("step_failed:draft (invalid_output)");
    const detail = getPipelineRunDetail(db, WORKSPACE_ID, run.id)!;
    expect(detail.steps.map((step) => `${step.attempt}:${step.status}`)).toEqual([
      "1:failed",
      "2:failed",
    ]);
    expect(detail.steps.every((step) => step.failureReason === "invalid_output")).toBe(true);
    expect(db.select().from(drafts).all()).toHaveLength(0);
  });

  it("recovers when the retry produces a valid output", async () => {
    const { db, deps } = fixture([
      { text: "not even json{" },
      draftOut("Post v1"),
      findingsOut(90),
    ]);
    const definition = definitionWith(db, miniSpec());
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.run.status).toBe("succeeded");
    const detail = getPipelineRunDetail(db, WORKSPACE_ID, run.id)!;
    const draftAttempts = detail.steps.filter((step) => step.stepKey === "draft");
    expect(draftAttempts.map((step) => `${step.attempt}:${step.status}`)).toEqual([
      "1:failed",
      "2:succeeded",
    ]);
  });

  it("fails the run when the cumulative token budget is crossed", async () => {
    const { db, deps } = fixture([
      { ...draftOut("Expensive post"), usage: { inputTokens: 900, outputTokens: 200 } },
    ]);
    const definition = definitionWith(db, miniSpec({ budget: { maxTokens: 1_000 } }));
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.failureReason).toBe("budget_exhausted");
    expect(db.select().from(drafts).all()).toHaveLength(0);
  });

  it("dedupes runs by idempotency key", () => {
    const { db } = fixture([]);
    const definition = definitionWith(db, miniSpec());
    startLive(db, definition, "signal:abc");
    expect(() => startLive(db, definition, "signal:abc")).toThrow(DuplicatePipelineRunError);
    // No key — repeats are allowed (manual founder re-runs).
    startLive(db, definition);
    startLive(db, definition);
  });

  it("returns unknown-tool data when a step calls outside its allowlist", async () => {
    const { db, deps } = fixture([
      { toolCalls: [{ name: "search_evidence", arguments: { query: "anything" } }] },
      draftOut("Post v1"),
      findingsOut(90),
    ]);
    const spec = miniSpec();
    spec.steps[0]!.tools = ["get_campaign_plan"];
    const definition = definitionWith(db, spec);
    const run = startLive(db, definition);
    const outcome = await executePipelineRun(db, deps, WORKSPACE_ID, run.id);

    expect(outcome.run.status).toBe("succeeded");
    const toolRows = db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.kind, "tool_call"))
      .all();
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]!.toolError).toContain('Unknown tool "search_evidence"');
  });

  it("dry-runs a definition over historical signals without writing drafts", async () => {
    const { db, deps } = fixture([
      draftOut("Dry post for signal 1"),
      findingsOut(90),
      draftOut("Dry post for signal 2"),
      findingsOut(80),
    ]);
    const definition = definitionWith(db, miniSpec());
    const result = await runPipelineDryRun(db, deps, {
      workspaceId: WORKSPACE_ID,
      definition,
      options: { limit: 2, channel: "linkedin" },
      createdBy: "founder",
    });

    expect(result.runs).toHaveLength(2);
    // listSignals is newest-first: SIGNAL_ID (createdAt 2) leads.
    expect(result.runs.map((entry) => entry.signalId)).toEqual([SIGNAL_ID, SIGNAL_2_ID]);
    for (const entry of result.runs) {
      expect(entry.status).toBe("succeeded");
      expect(entry.proposal).toMatchObject({ simulated: true, draftId: null });
    }
    expect(db.select().from(drafts).all()).toHaveLength(0);
    expect(db.select().from(generations).all()).toHaveLength(0);

    const stored = listPipelineRuns(db, WORKSPACE_ID, { mode: "dry_run" });
    expect(stored.total).toBe(2);
    expect(stored.runs.every((run) => run.dryRunBatchId === result.batchId)).toBe(true);
  });

  it("acceptance: editing the definition changes behaviour with no code deploy", async () => {
    const { db, gateway, deps } = fixture([
      // Run 1 (version 1, draft tier cheap):
      draftOut("Post v1"),
      findingsOut(90),
      // Run 2 (version 2, draft tier frontier, threshold 95 → revise loop):
      draftOut("Post v1"),
      findingsOut(90),
      draftOut("Post v2"),
      findingsOut(96),
    ]);
    const definition = definitionWith(db, miniSpec());
    const first = startLive(db, definition);
    const firstOutcome = await executePipelineRun(db, deps, WORKSPACE_ID, first.id);
    expect(firstOutcome.run.status).toBe("succeeded");
    expect(firstOutcome.run.definitionVersion).toBe(1);
    expect(gateway.calls[0]!.tier).toBe("cheap");
    // Version 1: score 90 ≥ 70, revise skipped.
    expect(firstOutcome.run.result).toMatchObject({ content: "Post v1" });

    const edited = miniSpec();
    edited.steps[0]!.tier = "frontier";
    edited.steps[2]!.loop = { scoreFrom: "critique", threshold: 95, maxIterations: 2 };
    const updated = updatePipelineSpec(db, WORKSPACE_ID, definition.id, { spec: edited }, ACTOR);

    const second = startLive(db, updated);
    const secondOutcome = await executePipelineRun(db, deps, WORKSPACE_ID, second.id);
    expect(secondOutcome.run.status).toBe("succeeded");
    expect(secondOutcome.run.definitionVersion).toBe(2);
    expect(gateway.calls[2]!.tier).toBe("frontier");
    // Version 2's tighter threshold forces the revise loop this time.
    expect(secondOutcome.run.result).toMatchObject({ content: "Post v2" });

    // The first run stays pinned to the version it executed.
    const rows = db.select().from(pipelineRuns).all();
    expect(rows.map((row) => row.definitionVersion).sort()).toEqual([1, 2]);
  });
});
