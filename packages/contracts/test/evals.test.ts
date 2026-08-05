import { describe, expect, it } from "vitest";
import {
  bannedClaimInputSchema,
  buildEvalSuiteInputSchema,
  evalRubricSchema,
  evalRunMetricsSchema,
  labelBaselineInputSchema,
  runEvalSuiteInputSchema,
  EVAL_CASE_OUTCOMES,
  EVAL_CHECK_KINDS,
  EVAL_JUDGE_PASS,
  EVAL_MAX_BODY_CHARS,
  EVAL_MIN_BODY_CHARS,
  EVAL_REGRESSION_THRESHOLDS,
  EVAL_VERDICTS,
} from "../src/index";

describe("eval vocabularies (Sprint 67)", () => {
  it("names the five deterministic checks the PRD asks for", () => {
    expect(EVAL_CHECK_KINDS).toEqual([
      "length_bounds",
      "banned_claims",
      "placeholder_leak",
      "cta_presence",
      "citation_validity",
    ]);
    expect(EVAL_CASE_OUTCOMES).toEqual(["approved", "rejected", "edited"]);
    expect(EVAL_VERDICTS).toEqual(["pass", "flag"]);
  });

  it("sources channel length bounds from the publish constraints", () => {
    expect(EVAL_MAX_BODY_CHARS.linkedin).toBe(3000);
    expect(EVAL_MAX_BODY_CHARS.instagram).toBe(2200);
    expect(EVAL_MAX_BODY_CHARS.x).toBe(280);
    // A channel with no published limit has no invented one.
    expect(EVAL_MAX_BODY_CHARS.pr).toBeUndefined();
    expect(EVAL_MIN_BODY_CHARS).toBeGreaterThan(0);
    expect(EVAL_JUDGE_PASS).toBeGreaterThan(0);
  });
});

describe("regression thresholds (D-67.9)", () => {
  it("gates only metrics CI can compute — no judge-derived metric", () => {
    const gated = Object.keys(EVAL_REGRESSION_THRESHOLDS);
    expect(gated).toContain("hardCheckPassRate");
    expect(gated).toContain("rejectRecall");
    expect(gated).not.toContain("avgJudgeScore");
  });

  it("knows which direction each metric improves in", () => {
    expect(EVAL_REGRESSION_THRESHOLDS.hardCheckPassRate.better).toBe("higher");
    // Closer to what the founder shipped is better, so this one runs the other way.
    expect(EVAL_REGRESSION_THRESHOLDS.avgEditDistanceToFinal.better).toBe("lower");
  });
});

describe("eval schemas", () => {
  it("defaults a suite build to 20 linkedin cases with no CTA expectation", () => {
    const parsed = buildEvalSuiteInputSchema.parse({ name: "  baseline  " });
    expect(parsed).toEqual({
      name: "baseline",
      channel: "linkedin",
      ctaExpectation: "any",
      limit: 20,
    });
    expect(buildEvalSuiteInputSchema.safeParse({ name: "x", limit: 51 }).success).toBe(false);
    expect(buildEvalSuiteInputSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("leaves the judge off unless asked", () => {
    const parsed = runEvalSuiteInputSchema.parse({
      suiteId: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b11",
    });
    expect(parsed.judge).toBe(false);
    expect(parsed.baselineLabel).toBeUndefined();
  });

  it("requires a non-blank baseline label", () => {
    expect(labelBaselineInputSchema.parse({ baselineLabel: " pre-66 " }).baselineLabel).toBe(
      "pre-66",
    );
    expect(labelBaselineInputSchema.safeParse({ baselineLabel: "  " }).success).toBe(false);
  });

  it("accepts null for every rate that has no denominator", () => {
    const metrics = evalRunMetricsSchema.parse({
      cases: 0,
      completed: 0,
      failed: 0,
      hardCheckPassRate: null,
      violations: {},
      judged: 0,
      avgJudgeScore: null,
      avgEditDistanceToFinal: null,
      agreementRate: null,
      rejectRecall: null,
      approvePassRate: null,
      costCents: 0,
      avgDurationMs: 0,
      production: null,
    });
    expect(metrics.rejectRecall).toBeNull();
  });

  it("bounds every rubric dimension at 5 and the overall at 100", () => {
    const dimension = { score: 4, justification: "Reads like the voice doc." };
    const rubric = {
      voiceFit: dimension,
      specificity: dimension,
      channelFit: dimension,
      brandSafety: dimension,
      actionability: dimension,
      overall: 82,
    };
    expect(evalRubricSchema.safeParse(rubric).success).toBe(true);
    expect(
      evalRubricSchema.safeParse({ ...rubric, voiceFit: { ...dimension, score: 6 } }).success,
    ).toBe(false);
    expect(evalRubricSchema.safeParse({ ...rubric, overall: 101 }).success).toBe(false);
  });

  it("requires a banned claim long enough to match on", () => {
    expect(bannedClaimInputSchema.parse({ phrase: "  guaranteed results " })).toEqual({
      phrase: "guaranteed results",
      note: "",
    });
    expect(bannedClaimInputSchema.safeParse({ phrase: "a" }).success).toBe(false);
  });
});
