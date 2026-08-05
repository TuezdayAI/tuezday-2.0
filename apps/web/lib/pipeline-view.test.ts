import { describe, expect, it } from "vitest";
import { REFERENCE_SIGNAL_SOCIAL_POST_SPEC } from "@tuezday/contracts";
import {
  checklistRollup,
  decisionsFor,
  parseSpecInput,
  stepSummary,
} from "./pipeline-view";

describe("stepSummary", () => {
  it("labels agent steps with tier, output and caps, and propose as the gate", () => {
    const research = REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps[0]!;
    expect(stepSummary(research)).toBe("research · cheap · brief · ≤6 steps");
    const revise = REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps[4]!;
    expect(stepSummary(revise)).toBe("revise · frontier · draft · ≤2 steps · loop ≥70 ×2");
    const propose = REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps[5]!;
    expect(stepSummary(propose)).toBe("propose · gate handoff");
  });
});

describe("checklistRollup", () => {
  it("counts earned passes", () => {
    expect(
      checklistRollup([
        { stepKey: "a", iteration: 1, output: "brief", passes: true, evidence: "", agentRunId: null },
        { stepKey: "b", iteration: 1, output: "draft", passes: false, evidence: "", agentRunId: null },
      ]),
    ).toEqual({ passed: 1, total: 2 });
    expect(checklistRollup([])).toEqual({ passed: 0, total: 0 });
  });
});

describe("decisionsFor", () => {
  it("offers machine-legal decisions per status", () => {
    expect(decisionsFor("escalated")).toEqual(["resume", "cancel"]);
    expect(decisionsFor("queued")).toEqual(["cancel"]);
    expect(decisionsFor("running")).toEqual(["cancel"]);
    expect(decisionsFor("succeeded")).toEqual([]);
    expect(decisionsFor("failed")).toEqual([]);
    expect(decisionsFor("cancelled")).toEqual([]);
  });
});

describe("parseSpecInput", () => {
  it("accepts the reference spec and reports schema violations with a path", () => {
    const ok = parseSpecInput(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC));
    expect(ok.error).toBeUndefined();
    expect(ok.spec?.steps).toHaveLength(6);

    expect(parseSpecInput("{nope").error).toBe("Not valid JSON.");

    const broken = JSON.parse(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC)) as {
      steps: { key: string }[];
    };
    broken.steps[1]!.key = "research";
    const result = parseSpecInput(JSON.stringify(broken));
    expect(result.error).toContain("research");
  });
});
