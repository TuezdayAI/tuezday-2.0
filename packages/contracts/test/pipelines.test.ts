import { describe, expect, it } from "vitest";
import {
  canTransitionPipelineRun,
  pipelineRunDecisionInputSchema,
  pipelineSpecSchema,
  transitionPipelineRun,
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  PIPELINE_RUN_STATUSES,
  type PipelineRunStatus,
  type PipelineSpec,
} from "../src/index";

function baseSpec(): PipelineSpec {
  return JSON.parse(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC)) as PipelineSpec;
}

describe("pipelineSpecSchema", () => {
  it("accepts the reference signal → social post definition", () => {
    const parsed = pipelineSpecSchema.safeParse(REFERENCE_SIGNAL_SOCIAL_POST_SPEC);
    expect(parsed.success).toBe(true);
    expect(REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps.map((step) => step.key)).toEqual([
      "research",
      "angle",
      "draft",
      "critique",
      "revise",
      "propose",
    ]);
    expect(REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps[0]!.tier).toBe("cheap");
    expect(REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps[2]!.tier).toBe("frontier");
  });

  it("rejects duplicate step keys", () => {
    const spec = baseSpec();
    spec.steps[1]!.key = "research";
    const parsed = pipelineSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it("requires exactly one propose step, last", () => {
    const spec = baseSpec();
    // Move propose before the end.
    const propose = spec.steps.pop()!;
    spec.steps.splice(1, 0, propose);
    expect(pipelineSpecSchema.safeParse(spec).success).toBe(false);

    const noPropose = baseSpec();
    noPropose.steps = noPropose.steps.filter((step) => step.kind !== "propose");
    expect(pipelineSpecSchema.safeParse(noPropose).success).toBe(false);
  });

  it("keeps the propose step engine-owned: no tools, no loop", () => {
    const spec = baseSpec();
    spec.steps.at(-1)!.tools = ["get_brain_section"];
    expect(pipelineSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("validates revise-loop references", () => {
    const forward = baseSpec();
    forward.steps[2]!.loop = { scoreFrom: "critique", threshold: 70, maxIterations: 2 };
    // draft (index 2) references critique (index 3) — a later step.
    expect(pipelineSpecSchema.safeParse(forward).success).toBe(false);

    const notFindings = baseSpec();
    notFindings.steps[4]!.loop = { scoreFrom: "angle", threshold: 70, maxIterations: 2 };
    expect(pipelineSpecSchema.safeParse(notFindings).success).toBe(false);

    const notDraft = baseSpec();
    notDraft.steps[4]!.output = "angles";
    expect(pipelineSpecSchema.safeParse(notDraft).success).toBe(false);
  });

  it("rejects unknown tool names", () => {
    const spec = JSON.parse(JSON.stringify(REFERENCE_SIGNAL_SOCIAL_POST_SPEC)) as {
      steps: { tools: string[] }[];
    };
    spec.steps[0]!.tools = ["drop_table"];
    expect(pipelineSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe("pipeline run machine", () => {
  it("moves queued → running → succeeded and treats terminals as dead ends", () => {
    expect(canTransitionPipelineRun("queued", "running")).toBe(true);
    expect(canTransitionPipelineRun("running", "succeeded")).toBe(true);
    expect(canTransitionPipelineRun("running", "escalated")).toBe(true);
    expect(canTransitionPipelineRun("escalated", "running")).toBe(true);
    expect(canTransitionPipelineRun("escalated", "cancelled")).toBe(true);
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      for (const to of PIPELINE_RUN_STATUSES) {
        expect(canTransitionPipelineRun(terminal, to as PipelineRunStatus)).toBe(false);
      }
    }
    expect(canTransitionPipelineRun("queued", "succeeded")).toBe(false);
    expect(canTransitionPipelineRun("queued", "escalated")).toBe(false);
    expect(transitionPipelineRun("running", "failed")).toBe("failed");
    expect(transitionPipelineRun("queued", "failed")).toBeUndefined();
  });
});

describe("pipelineRunDecisionInputSchema", () => {
  it("requires a reason to cancel but not to resume", () => {
    expect(pipelineRunDecisionInputSchema.safeParse({ action: "cancel" }).success).toBe(false);
    expect(
      pipelineRunDecisionInputSchema.safeParse({ action: "cancel", reason: "obsolete" }).success,
    ).toBe(true);
    expect(pipelineRunDecisionInputSchema.safeParse({ action: "resume" }).success).toBe(true);
  });
});
