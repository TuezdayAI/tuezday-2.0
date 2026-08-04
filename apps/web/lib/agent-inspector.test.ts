import { describe, expect, it } from "vitest";
import type { AgentRunStep } from "@tuezday/contracts";
import {
  formatCost,
  formatElapsed,
  formatJson,
  formatTokens,
  groupSteps,
  runBadge,
} from "./agent-inspector";

function step(kind: "model_call" | "tool_call", stepIndex: number): AgentRunStep {
  return {
    id: `step-${stepIndex}`,
    stepIndex,
    kind,
    message: null,
    toolName: kind === "tool_call" ? "search_evidence" : null,
    toolCallId: null,
    toolArgs: null,
    toolResult: null,
    toolError: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costCents: 0 },
    durationMs: 5,
    createdAt: 1,
  };
}

describe("runBadge", () => {
  it("maps run state onto badge tones", () => {
    expect(runBadge({ status: "running", stopReason: null })).toEqual({
      label: "running",
      tone: "pending",
    });
    expect(runBadge({ status: "done", stopReason: "complete" }).tone).toBe("approved");
    expect(runBadge({ status: "done", stopReason: "error" }).tone).toBe("danger");
    expect(runBadge({ status: "done", stopReason: "needs_human" }).tone).toBe("pending");
    expect(runBadge({ status: "done", stopReason: "max_steps" }).tone).toBe("edited");
    expect(runBadge({ status: "done", stopReason: "timeout" }).tone).toBe("edited");
  });
});

describe("groupSteps", () => {
  it("attaches each tool dispatch to the model call that requested it", () => {
    const steps = [
      step("model_call", 0),
      step("tool_call", 1),
      step("tool_call", 2),
      step("model_call", 3),
    ];
    const grouped = groupSteps(steps);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.tools.map((t) => t.stepIndex)).toEqual([1, 2]);
    expect(grouped[1]!.tools).toEqual([]);
  });

  it("drops orphaned tool steps rather than crashing on a partial trace", () => {
    expect(groupSteps([step("tool_call", 0)])).toEqual([]);
  });
});

describe("formatters", () => {
  it("formats tokens compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1250)).toBe("1.3k");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("formats cost in cents up to a dollar, then dollars", () => {
    expect(formatCost(0)).toBe("0¢");
    expect(formatCost(0.004)).toBe("<0.01¢");
    expect(formatCost(0.42)).toBe("0.42¢");
    expect(formatCost(250)).toBe("$2.50");
  });

  it("formats elapsed time across units", () => {
    expect(formatElapsed(0, null)).toBe("running");
    expect(formatElapsed(0, 800)).toBe("800ms");
    expect(formatElapsed(0, 12_340)).toBe("12.3s");
    expect(formatElapsed(0, 65_000)).toBe("1m 05s");
  });

  it("renders JSON deterministically and strings verbatim", () => {
    expect(formatJson(null)).toBe("—");
    expect(formatJson("plain text")).toBe("plain text");
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
