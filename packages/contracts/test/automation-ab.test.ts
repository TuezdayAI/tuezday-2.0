import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_GENERATION_PATHS,
  PIPELINE_RUN_MODES,
  ROLLOUT_DECISION_KINDS,
  SHADOW_VERDICTS,
  automationComparisonSchema,
  pipelineShadowPairSchema,
  recordRolloutDecisionInputSchema,
  rolloutDecisionSchema,
  shadowVerdictInputSchema,
  updateSocialAutomationSettingsInputSchema,
  type AutomationComparison,
} from "../src/index.js";

function sampleComparison(): AutomationComparison {
  return {
    workspaceId: randomUUID(),
    generationPath: "shadow",
    windowDays: 30,
    legacy: {
      drafts: 12,
      decided: 10,
      approved: 8,
      rejected: 2,
      approvalRate: 80,
      avgEditDistance: 14.5,
      costCents: 120,
    },
    engine: {
      drafts: 6,
      decided: 4,
      approved: 4,
      rejected: 0,
      approvalRate: 100,
      avgEditDistance: 3.2,
      costCents: 45,
      health: { runs: 9, succeeded: 7, failed: 1, escalated: 1 },
    },
    shadow: { pairs: 9, reviewed: 5, engineWins: 3, legacyWins: 1, ties: 1 },
  };
}

describe("Sprint 65 vocabularies", () => {
  it("defines the generation paths, shadow mode, verdicts, and decisions", () => {
    expect(AUTOMATION_GENERATION_PATHS).toEqual(["legacy", "shadow", "pipeline"]);
    expect(PIPELINE_RUN_MODES).toContain("shadow");
    expect(SHADOW_VERDICTS).toEqual(["engine", "legacy", "tie"]);
    expect(ROLLOUT_DECISION_KINDS).toEqual([
      "adopt_engine",
      "keep_legacy",
      "extend_shadow",
    ]);
  });

  it("accepts generationPath in the settings patch and rejects unknown paths", () => {
    expect(
      updateSocialAutomationSettingsInputSchema.safeParse({ generationPath: "pipeline" })
        .success,
    ).toBe(true);
    expect(
      updateSocialAutomationSettingsInputSchema.safeParse({ generationPath: "yolo" })
        .success,
    ).toBe(false);
  });
});

describe("shadow verdict input", () => {
  it("defaults notes to empty and rejects unknown verdicts", () => {
    expect(shadowVerdictInputSchema.parse({ verdict: "engine" })).toEqual({
      verdict: "engine",
      notes: "",
    });
    expect(shadowVerdictInputSchema.safeParse({ verdict: "better" }).success).toBe(false);
  });
});

describe("comparison + rollout schemas", () => {
  it("round-trips a comparison and distinguishes no-data from zero", () => {
    const comparison = sampleComparison();
    expect(automationComparisonSchema.parse(comparison)).toEqual(comparison);
    const noData = {
      ...comparison,
      legacy: { ...comparison.legacy, decided: 0, approvalRate: null, avgEditDistance: null },
    };
    expect(automationComparisonSchema.safeParse(noData).success).toBe(true);
  });

  it("parses a shadow pair with a not-yet-finished run", () => {
    expect(
      pipelineShadowPairSchema.safeParse({
        id: randomUUID(),
        workspaceId: randomUUID(),
        signalId: randomUUID(),
        campaignId: null,
        channel: "linkedin",
        draftId: randomUUID(),
        runId: randomUUID(),
        draftContent: "the legacy draft",
        draftState: "pending_review",
        proposalContent: null,
        runStatus: "queued",
        verdict: null,
        verdictNotes: "",
        verdictAt: null,
        createdAt: 1,
      }).success,
    ).toBe(true);
  });

  it("requires a rationale on a rollout decision and freezes the snapshot", () => {
    expect(
      recordRolloutDecisionInputSchema.safeParse({ decision: "adopt_engine" }).success,
    ).toBe(false);
    expect(
      recordRolloutDecisionInputSchema.safeParse({
        decision: "adopt_engine",
        rationale: "",
      }).success,
    ).toBe(false);
    expect(
      rolloutDecisionSchema.safeParse({
        id: randomUUID(),
        workspaceId: randomUUID(),
        taskKey: "signal_social_post",
        decision: "keep_legacy",
        rationale: "Engine escalates too often on PR-adjacent signals.",
        metrics: sampleComparison(),
        decidedByUserId: null,
        createdAt: 5,
      }).success,
    ).toBe(true);
  });
});
