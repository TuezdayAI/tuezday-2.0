import { describe, expect, it } from "vitest";
import {
  renderExamples,
  resolveContext,
  type ResolveExamples,
  type ResolveInput,
} from "../src/index";

const docs = {
  soul: "We exist to end GTM amnesia. ".repeat(10),
  icp: "Founder-led SaaS companies with small GTM teams. ".repeat(10),
  voice: "Direct, technical, never corporate. ".repeat(10),
  history: "Launched the rebuild in June 2026. ".repeat(10),
  now: "This month we are proving the brain loop. ".repeat(10),
};

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    workspaceName: "Hexalog",
    docs,
    taskType: "signal_response",
    channel: "linkedin",
    ...overrides,
  };
}

const examples: ResolveExamples = {
  query: "competitor launched a new pricing page",
  approved: [
    { content: "Approved take one on pricing.", wasEdited: false },
    { content: "Approved take two, human polished.", wasEdited: true },
  ],
  rejected: [
    {
      content: "Rejected pitchy take.",
      reason: "Too salesy — we never pitch on a competitor's news day.",
      outcome: "rejected",
    },
    { content: "Corrected hedge-heavy take.", reason: null, outcome: "edited before approval" },
  ],
};

describe("examples section (Sprint 66)", () => {
  it("is absent entirely when the caller does not participate", () => {
    const resolved = resolveContext(baseInput());
    expect(resolved.sections.find((s) => s.key === "examples")).toBeUndefined();
  });

  it("renders approved-to-imitate and rejected-to-avoid with the why, traced", () => {
    const resolved = resolveContext(baseInput({ examples }));
    const section = resolved.sections.find((s) => s.key === "examples")!;
    expect(section.included).toBe(true);
    expect(section.layer).toBe("examples");
    expect(section.content).toContain("Approved — imitate these");
    expect(section.content).toContain("[A2] (human-edited before approval");
    expect(section.content).toContain("avoid repeating these mistakes");
    expect(section.content).toContain("Why: Too salesy");
    expect(section.reason).toContain("2 approved and 2 rejected/corrected");
    expect(section.reason).toContain(examples.query);
    expect(resolved.prompt).toContain("Prior examples from your approval history");
  });

  it("sits after evidence and before the task instruction in prompt order", () => {
    const resolved = resolveContext(baseInput({ examples }));
    const keys = resolved.sections.map((s) => s.key);
    expect(keys.indexOf("examples")).toBeGreaterThan(keys.indexOf("evidence"));
    expect(keys.indexOf("examples")).toBeLessThan(keys.indexOf("task"));
  });

  it("traces the exclusion reason when there is no usable history", () => {
    const resolved = resolveContext(
      baseInput({ examplesExclusionReason: "no approved or rejected prior outputs yet." }),
    );
    const section = resolved.sections.find((s) => s.key === "examples")!;
    expect(section.included).toBe(false);
    expect(section.reason).toContain("no approved or rejected prior outputs yet.");
  });

  it("excludes an empty examples payload with the default reason", () => {
    const resolved = resolveContext(
      baseInput({ examples: { query: "q", approved: [], rejected: [] } }),
    );
    const section = resolved.sections.find((s) => s.key === "examples")!;
    expect(section.included).toBe(false);
    expect(section.reason).toContain("Excluded");
  });

  it("is dropped by the budget ladder before brain content is demoted", () => {
    const fat: ResolveExamples = {
      query: "q",
      approved: [{ content: "Long approved example. ".repeat(200), wasEdited: false }],
      rejected: [],
    };
    const resolved = resolveContext(baseInput({ examples: fat, tokenBudget: 700 }));
    const section = resolved.sections.find((s) => s.key === "examples")!;
    expect(section.included).toBe(false);
    expect(section.reason).toContain("token budget");
    // The org docs survive the cut the examples absorbed.
    expect(resolved.sections.find((s) => s.key === "org:soul")!.included).toBe(true);
  });

  it("renderExamples is exported and stable for engine reuse", () => {
    const rendered = renderExamples(examples);
    expect(rendered).toContain("[A1]");
    expect(rendered).toContain("[R1] (rejected)");
    expect(rendered).toContain("Why: Too salesy");
  });
});
