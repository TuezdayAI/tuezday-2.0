import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { EvalRunMetrics } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { drafts, signals } from "../src/db/schema";
import type { EvidenceStore } from "../src/evidence/store";
import type { LlmGateway } from "../src/llm/gateway";
import { ScriptedGateway, type ScriptedStep } from "../src/llm/scripted";
import type { SafeFetchService } from "../src/safe-fetch/index";
import { addBannedClaim } from "../src/services/banned-claims";
import { emptyEvalMetrics } from "../src/services/eval-harness";
import {
  buildEvalSuite,
  compareEvalRuns,
  findBaselineRun,
  getEvalComparison,
  labelBaseline,
  listEvalCases,
  listEvalRuns,
  runEvalSuite,
  EvalDefinitionUnavailableError,
  EvalSuiteNotFoundError,
  type EvalHarnessDeps,
} from "../src/services/eval-harness";
import {
  ensurePipelineDefinitions,
  listPipelineDefinitions,
  setPipelineStatus,
} from "../src/services/pipeline-definitions";
import { buildAuthedApp, createTestDb } from "./helpers";

function generatingGateway(): LlmGateway {
  let n = 0;
  return {
    async generate() {
      n += 1;
      return {
        text: `Historical take ${n} on usage-based pricing and competitor pages.`,
        model: "fake-model",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
}

/** research → angle → draft → critique, for one replayed case. */
function caseScript(draftContent: string, citation?: string): ScriptedStep[] {
  return [
    {
      text: JSON.stringify({
        summary: "Pricing moved.",
        keyFacts: ["A competitor changed pricing."],
        sources: [],
      }),
    },
    { text: JSON.stringify({ angles: [{ title: "Pricing is positioning", rationale: "Buyers read it." }] }) },
    { text: JSON.stringify({ content: draftContent }) },
    {
      text: JSON.stringify({
        score: 90,
        findings: citation ? [{ issue: "Could be sharper.", citation }] : [],
        guardrailUncertain: false,
      }),
    },
  ];
}

const CLEAN =
  "A competitor moved to usage-based pricing this morning, and the interesting part is what " +
  "it says about who they think their buyer is now.";

describe("Sprint 67 — eval & replay harness", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db, llm: generatingGateway() });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Sprint67" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function createSignal(content: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals`,
      payload: { content, source: "other" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function draftFrom(signalId: string): Promise<{ id: string; content: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals/${signalId}/draft`,
      payload: { channel: "linkedin" },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function act(draftId: string, action: string, payload?: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/${action}`,
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(200);
  }

  /** One approved, one edited-then-approved, one rejected with a reason. */
  async function seedHistory(): Promise<{ approvedId: string; editedId: string; rejectedId: string }> {
    const s1 = await createSignal("Competitor published a usage-based pricing page.");
    const approved = await draftFrom(s1);
    await act(approved.id, "approve");

    const s2 = await createSignal("Analyst report on category consolidation landed.");
    const edited = await draftFrom(s2);
    await act(edited.id, "edit", { content: "A tightened version the founder actually shipped." });
    await act(edited.id, "approve");

    const s3 = await createSignal("A rival announced a cloud partnership today.");
    const rejected = await draftFrom(s3);
    await act(rejected.id, "reject", { reason: "Pitchy on a competitor's news day" });

    return { approvedId: approved.id, editedId: edited.id, rejectedId: rejected.id };
  }

  async function activateDefinition(): Promise<string> {
    await ensurePipelineDefinitions(db, workspaceId);
    const definition = (await listPipelineDefinitions(db, workspaceId))[0]!;
    await setPipelineStatus(db, workspaceId, definition.id, "active");
    return definition.id;
  }

  function depsFor(script: ScriptedStep[]): { deps: EvalHarnessDeps; gateway: ScriptedGateway } {
    const gateway = new ScriptedGateway(script);
    return {
      gateway,
      deps: {
        llm: gateway,
        evidence: {} as unknown as EvidenceStore,
        safeFetch: {} as unknown as SafeFetchService,
      },
    };
  }

  describe("buildEvalSuite (D-67.2)", () => {
    it("classifies each decided draft by what the founder actually did", async () => {
      await seedHistory();
      const { suite, cases } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "baseline", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      expect(suite.caseCount).toBe(3);
      const outcomes = cases.map((entry) => entry.outcome).sort();
      expect(outcomes).toEqual(["approved", "edited", "rejected"]);

      const rejected = cases.find((entry) => entry.outcome === "rejected")!;
      expect(rejected.rejectionReason).toBe("Pitchy on a competitor's news day");

      const edited = cases.find((entry) => entry.outcome === "edited")!;
      expect(edited.finalContent).toBe("A tightened version the founder actually shipped.");
      expect(edited.generatedContent).not.toBe(edited.finalContent);
    });

    it("survives its source draft being deleted, snapshots intact", async () => {
      const { approvedId } = await seedHistory();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "frozen", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      const before = (await listEvalCases(db, workspaceId, suite.id)).find(
        (entry) => entry.sourceDraftId === approvedId,
      )!;

      await db.delete(drafts).where(eq(drafts.id, approvedId));

      const after = (await listEvalCases(db, workspaceId, suite.id)).find(
        (entry) => entry.id === before.id,
      )!;
      // The FK went null; the frozen content did not (D-67.2).
      expect(after.sourceDraftId).toBeNull();
      expect(after.generatedContent).toBe(before.generatedContent);
      expect(after.finalContent).toBe(before.finalContent);
      expect(after.outcome).toBe("approved");
    });

    it("builds an empty suite when the gate has no history", async () => {
      const { suite, cases } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "empty", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      expect(suite.caseCount).toBe(0);
      expect(cases).toEqual([]);
    });

    it("only takes drafts on the requested channel", async () => {
      await seedHistory();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "x-only", channel: "x", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      expect(suite.caseCount).toBe(0);
    });
  });

  describe("runEvalSuite", () => {
    it("replays every case and scores it against the founder's decision", async () => {
      await seedHistory();
      await activateDefinition();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "replay", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      const { deps } = depsFor([
        ...caseScript(CLEAN),
        ...caseScript(CLEAN),
        ...caseScript(CLEAN),
      ]);

      const run = await runEvalSuite(
        db,
        deps,
        workspaceId,
        { suiteId: suite.id, judge: false },
        { userId: null, label: "founder" },
      );

      expect(run.status).toBe("succeeded");
      expect(run.metrics.cases).toBe(3);
      expect(run.metrics.completed).toBe(3);
      expect(run.metrics.hardCheckPassRate).toBe(100);
      expect(run.results).toHaveLength(3);
      expect(run.results.every((result) => result.pipelineRunId !== null)).toBe(true);
      // Every case passed, so it agrees on the approvals and misses the rejection.
      expect(run.metrics.approvePassRate).toBe(100);
      expect(run.metrics.rejectRecall).toBe(0);
      expect(run.metrics.agreementRate).toBe(round(2 / 3));
      // The production snapshot rides along so a baseline carries §1.3 too.
      expect(run.metrics.production).not.toBeNull();
    });

    it("flags a draft that trips a hard check, which is how it catches a rejection", async () => {
      await seedHistory();
      await activateDefinition();
      await addBannedClaim(db, workspaceId, { phrase: "the only platform that", note: "" });
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "banned", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      const dirty = `${CLEAN} We are the only platform that treats it as positioning.`;
      const { deps } = depsFor([
        ...caseScript(dirty),
        ...caseScript(dirty),
        ...caseScript(dirty),
      ]);

      const run = await runEvalSuite(
        db,
        deps,
        workspaceId,
        { suiteId: suite.id, judge: false },
        { userId: null, label: "founder" },
      );
      expect(run.metrics.hardCheckPassRate).toBe(0);
      expect(run.metrics.violations.banned_claims).toBe(3);
      expect(run.metrics.rejectRecall).toBe(100);
      expect(run.results.every((result) => result.verdict === "flag")).toBe(true);
    });

    it("grounds citations in what that run actually retrieved (D-67.6)", async () => {
      await seedHistory();
      await activateDefinition();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "citations", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      // The first citation quotes the critique step's own goal (which is in the
      // system prompt, hence the corpus); the second is invented.
      const { deps } = depsFor([
        ...caseScript(CLEAN, "Retrieve before you judge — never critique from memory."),
        ...caseScript(CLEAN, "Guardrail 14b: name a customer inside the first twelve words."),
        ...caseScript(CLEAN, "Retrieve before you judge — never critique from memory."),
      ]);

      const run = await runEvalSuite(
        db,
        deps,
        workspaceId,
        { suiteId: suite.id, judge: false },
        { userId: null, label: "founder" },
      );
      expect(run.metrics.violations.citation_validity).toBe(1);
      const failing = run.results.find((result) =>
        result.checks.some(
          (check) => check.kind === "citation_validity" && check.status === "fail",
        ),
      )!;
      expect(
        failing.checks.find((check) => check.kind === "citation_validity")!.detail,
      ).toContain("Guardrail 14b");
    });

    it("records a case whose signal was deleted as a failure, not a pass", async () => {
      await seedHistory();
      await activateDefinition();
      const { suite, cases } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "orphan", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      // The case survives its source being deleted (set-null FK); the replay cannot.
      await db.delete(signals).where(eq(signals.id, cases[0]!.signalId!));
      const { deps } = depsFor([...caseScript(CLEAN), ...caseScript(CLEAN)]);

      const run = await runEvalSuite(
        db,
        deps,
        workspaceId,
        { suiteId: suite.id, judge: false },
        { userId: null, label: "founder" },
      );
      expect(run.metrics.cases).toBe(3);
      expect(run.metrics.completed).toBe(2);
      expect(run.metrics.failed).toBe(1);
      expect(run.results.some((result) => result.failureReason === "signal_deleted")).toBe(true);
    });

    it("refuses to run without a suite or an active definition", async () => {
      await seedHistory();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "no-definition", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      const { deps } = depsFor([]);
      await expect(
        runEvalSuite(db, deps, workspaceId, { suiteId: suite.id, judge: false }, { userId: null, label: "f" }),
      ).rejects.toBeInstanceOf(EvalDefinitionUnavailableError);

      await activateDefinition();
      await expect(
        runEvalSuite(
          db,
          deps,
          workspaceId,
          { suiteId: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b11", judge: false },
          { userId: null, label: "f" },
        ),
      ).rejects.toBeInstanceOf(EvalSuiteNotFoundError);
    });
  });

  describe("baselines (D-67.3)", () => {
    async function twoRuns() {
      await seedHistory();
      await activateDefinition();
      const { suite } = await buildEvalSuite(
        db,
        workspaceId,
        { name: "baseline", channel: "linkedin", ctaExpectation: "any", limit: 20 },
        { userId: null },
      );
      const script = [...caseScript(CLEAN), ...caseScript(CLEAN), ...caseScript(CLEAN)];
      const first = await runEvalSuite(
        db,
        depsFor(script).deps,
        workspaceId,
        { suiteId: suite.id, judge: false, baselineLabel: "pre-66" },
        { userId: null, label: "founder" },
      );
      const second = await runEvalSuite(
        db,
        depsFor(script).deps,
        workspaceId,
        { suiteId: suite.id, judge: false },
        { userId: null, label: "founder" },
      );
      return { first, second };
    }

    it("labels a run at creation and finds it as the baseline", async () => {
      const { first } = await twoRuns();
      expect(first.baselineLabel).toBe("pre-66");
      expect((await findBaselineRun(db, workspaceId, "pre-66"))!.id).toBe(first.id);
    });

    it("moves a label rather than failing on the unique index", async () => {
      const { first, second } = await twoRuns();
      await labelBaseline(db, workspaceId, second.id, "pre-66");
      const runs = await listEvalRuns(db, workspaceId);
      expect(runs.find((run) => run.id === second.id)!.baselineLabel).toBe("pre-66");
      expect(runs.find((run) => run.id === first.id)!.baselineLabel).toBeNull();
    });

    it("compares a later run against the labelled baseline", async () => {
      const { second } = await twoRuns();
      const comparison = (await getEvalComparison(db, workspaceId, second.id))!;
      expect(comparison.baselineLabel).toBe("pre-66");
      expect(comparison.ok).toBe(true);
      expect(comparison.regressions).toEqual([]);
    });
  });
});

function round(fraction: number): number {
  return Math.round(1000 * fraction) / 10;
}

describe("compareEvalRuns (D-67.9)", () => {
  function metrics(overrides: Partial<EvalRunMetrics>): EvalRunMetrics {
    return { ...emptyEvalMetrics(), ...overrides };
  }

  it("reports a drop past tolerance as a regression", () => {
    const comparison = compareEvalRuns(
      { id: "b", metrics: metrics({ hardCheckPassRate: 80 }) },
      { id: "a", metrics: metrics({ hardCheckPassRate: 95 }), baselineLabel: "pre" },
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.regressions[0]).toMatchObject({
      metric: "hardCheckPassRate",
      baseline: 95,
      current: 80,
      delta: -15,
    });
  });

  it("tolerates a drop inside the threshold", () => {
    const comparison = compareEvalRuns(
      { id: "b", metrics: metrics({ hardCheckPassRate: 94 }) },
      { id: "a", metrics: metrics({ hardCheckPassRate: 95 }), baselineLabel: "pre" },
    );
    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it("knows edit distance improves by going down", () => {
    const closer = compareEvalRuns(
      { id: "b", metrics: metrics({ avgEditDistanceToFinal: 20 }) },
      { id: "a", metrics: metrics({ avgEditDistanceToFinal: 40 }), baselineLabel: "pre" },
    );
    expect(closer.ok).toBe(true);
    expect(closer.improvements[0]!.metric).toBe("avgEditDistanceToFinal");

    const further = compareEvalRuns(
      { id: "b", metrics: metrics({ avgEditDistanceToFinal: 60 }) },
      { id: "a", metrics: metrics({ avgEditDistanceToFinal: 40 }), baselineLabel: "pre" },
    );
    expect(further.ok).toBe(false);
  });

  it("skips a metric that is null on either side instead of scoring it zero", () => {
    const comparison = compareEvalRuns(
      { id: "b", metrics: metrics({ hardCheckPassRate: null, rejectRecall: 50 }) },
      { id: "a", metrics: metrics({ hardCheckPassRate: 95, rejectRecall: 90 }), baselineLabel: "pre" },
    );
    expect(comparison.skipped).toContain("hardCheckPassRate");
    expect(comparison.regressions.map((entry) => entry.metric)).toEqual(["rejectRecall"]);
  });

  it("skips everything when there is no baseline at all", () => {
    const comparison = compareEvalRuns(
      { id: "b", metrics: metrics({ hardCheckPassRate: 10 }) },
      null,
    );
    expect(comparison.ok).toBe(true);
    expect(comparison.baselineRunId).toBeNull();
    expect(comparison.skipped).toContain("hardCheckPassRate");
  });
});
