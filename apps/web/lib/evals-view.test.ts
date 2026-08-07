import { describe, expect, it } from "vitest";
import type { EvalCheckResult, EvalRun, EvalRunMetrics } from "@tuezday/contracts";
import {
  failedChecks,
  formatMetric,
  metricBetterDirection,
  metricLabel,
  regressionSeverity,
  runSummary,
  trendSeries,
  verdictTone,
  HEADLINE_METRICS,
} from "./evals-view";

function metrics(overrides: Partial<EvalRunMetrics> = {}): EvalRunMetrics {
  return {
    cases: 5,
    completed: 5,
    failed: 0,
    hardCheckPassRate: 80,
    violations: {},
    judged: 0,
    avgJudgeScore: null,
    avgEditDistanceToFinal: 22,
    agreementRate: 90,
    rejectRecall: 100,
    approvePassRate: 75,
    costCents: 0,
    avgDurationMs: 5,
    production: null,
    ...overrides,
  };
}

function run(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "run-1",
    workspaceId: "ws-1",
    suiteId: "suite-1",
    definitionId: null,
    definitionVersion: null,
    status: "succeeded",
    judgeEnabled: false,
    metrics: metrics(),
    baselineLabel: null,
    failureReason: null,
    createdAt: 1_000,
    finishedAt: 2_000,
    ...overrides,
  };
}

describe("evals view helpers (Sprint 67)", () => {
  it("labels every headline metric in plain language", () => {
    for (const metric of HEADLINE_METRICS) {
      expect(metricLabel(metric)).not.toBe(metric);
    }
    // An unknown metric falls back to its own key rather than rendering blank.
    expect(metricLabel("costCents")).toBe("costCents");
  });

  it("renders a missing metric as an em dash, never as zero", () => {
    expect(formatMetric("hardCheckPassRate", null)).toBe("—");
    expect(formatMetric("hardCheckPassRate", 0)).toBe("0%");
    expect(formatMetric("avgJudgeScore", 82)).toBe("82/100");
  });

  it("knows edit distance improves downward", () => {
    expect(metricBetterDirection("avgEditDistanceToFinal")).toBe("lower");
    expect(metricBetterDirection("rejectRecall")).toBe("higher");
  });

  it("summarises a run by what was actually scored", () => {
    expect(runSummary(run())).toBe("5/5 replayed · not judged");
    expect(runSummary(run({ judgeEnabled: true, metrics: metrics({ judged: 4, failed: 1, completed: 4 }) }))).toBe(
      "4/5 replayed · 1 failed · 4 judged",
    );
  });

  it("treats no baseline as unmeasured, not as a pass", () => {
    expect(regressionSeverity({ ok: true, baselineRunId: null })).toBe("unmeasured");
    expect(regressionSeverity({ ok: true, baselineRunId: "run-0" })).toBe("clean");
    expect(regressionSeverity({ ok: false, baselineRunId: "run-0" })).toBe("blocked");
  });

  it("tones a verdict and surfaces only the failing checks", () => {
    expect(verdictTone("pass")).toBe("approved");
    expect(verdictTone("flag")).toBe("rejected");
    expect(verdictTone(null)).toBe("neutral");

    const checks: EvalCheckResult[] = [
      { kind: "length_bounds", status: "pass", detail: "ok" },
      { kind: "banned_claims", status: "fail", detail: "uses a banned claim" },
      { kind: "cta_presence", status: "skipped", detail: "no expectation" },
    ];
    expect(failedChecks(checks).map((check) => check.kind)).toEqual(["banned_claims"]);
  });

  it("builds an oldest-first trend, skipping runs with no value", () => {
    const series = trendSeries(
      [
        run({ id: "c", createdAt: 3_000, metrics: metrics({ rejectRecall: 90 }) }),
        run({ id: "b", createdAt: 2_000, metrics: metrics({ rejectRecall: null }) }),
        run({ id: "a", createdAt: 1_000, metrics: metrics({ rejectRecall: 60 }) }),
      ],
      "rejectRecall",
    );
    expect(series.map((point) => point.runId)).toEqual(["a", "c"]);
    expect(series.map((point) => point.value)).toEqual([60, 90]);
  });
});
