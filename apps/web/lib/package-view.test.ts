import { describe, expect, it } from "vitest";
import type {
  LaneEligibilityCheck,
  LaneEligibilityDecision,
  SufficiencyAssessment,
} from "@tuezday/contracts";
import { blockingChecks, blockingSummary, latestAssessment } from "./package-view";

function decision(
  eligible: boolean,
  checks: LaneEligibilityCheck[],
  laneName = "Lane",
): LaneEligibilityDecision {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    packageId: "00000000-0000-4000-8000-000000000002",
    assessmentId: "00000000-0000-4000-8000-000000000003",
    laneId: "00000000-0000-4000-8000-000000000004",
    laneRevisionId: "00000000-0000-4000-8000-000000000005",
    eligible,
    checks,
    evaluatorVersion: 1,
    createdAt: 0,
    laneName,
    channel: "linkedin",
    format: "linkedin_post",
  };
}

function assessment(assessmentVersion: number): SufficiencyAssessment {
  return {
    id: `00000000-0000-4000-8000-00000000001${assessmentVersion}`,
    packageId: "00000000-0000-4000-8000-000000000002",
    assessmentVersion,
    verdict: "sufficient",
    confidence: 80,
    supportedClaims: [],
    missingFacts: [],
    missingMedia: [],
    eligibleFormats: [],
    ineligibleFormats: [],
    researchActions: [],
    assessorVersion: 1,
    createdAt: 0,
  };
}

describe("blockingChecks", () => {
  it("returns only the failed checks, preserving order", () => {
    const failed = blockingChecks(
      decision(false, [
        { rule: "lane_active", passed: true },
        { rule: "media_available", passed: false, detail: "no media asset" },
        { rule: "format_registered", passed: false },
      ]),
    );
    expect(failed.map((c) => c.rule)).toEqual(["media_available", "format_registered"]);
    expect(failed[0]!.detail).toBe("no media asset");
  });

  it("returns an empty list when every check passed", () => {
    expect(
      blockingChecks(decision(true, [{ rule: "lane_active", passed: true }])),
    ).toEqual([]);
  });
});

describe("blockingSummary", () => {
  it("counts blocked lanes and lists failed rules deduplicated in first-seen order", () => {
    const summary = blockingSummary([
      decision(false, [
        { rule: "lane_active", passed: true },
        { rule: "media_available", passed: false },
      ]),
      decision(true, [{ rule: "lane_active", passed: true }]),
      decision(false, [
        { rule: "media_available", passed: false },
        { rule: "format_registered", passed: false },
      ]),
    ]);
    expect(summary).toBe("2 lanes blocked: media_available, format_registered");
  });

  it("uses singular phrasing for one blocked lane", () => {
    const summary = blockingSummary([
      decision(false, [{ rule: "format_supported", passed: false }]),
    ]);
    expect(summary).toBe("1 lane blocked: format_supported");
  });

  it("returns empty string when no lane is blocked", () => {
    expect(blockingSummary([])).toBe("");
    expect(
      blockingSummary([decision(true, [{ rule: "lane_active", passed: true }])]),
    ).toBe("");
  });
});

describe("latestAssessment", () => {
  it("picks the highest assessmentVersion regardless of order", () => {
    expect(
      latestAssessment([assessment(2), assessment(5), assessment(3)])?.assessmentVersion,
    ).toBe(5);
  });

  it("returns undefined for an empty list", () => {
    expect(latestAssessment([])).toBeUndefined();
  });
});
