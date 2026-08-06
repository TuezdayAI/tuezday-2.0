import {
  canTransitionPipelineRun,
  pipelineSpecSchema,
  type PipelineChecklistEntry,
  type PipelineRunDecisionAction,
  type PipelineRunStatus,
  type PipelineSpec,
  type PipelineStepSpec,
} from "@tuezday/contracts";

/** One-line label for a step chip: key · tier · output · caps. */
export function stepSummary(step: PipelineStepSpec): string {
  if (step.kind === "propose") return `${step.key} · gate handoff`;
  const loop = step.loop
    ? ` · loop ≥${step.loop.threshold} ×${step.loop.maxIterations}`
    : "";
  return `${step.key} · ${step.tier} · ${step.output} · ≤${step.maxSteps} steps${loop}`;
}

/** Checklist rollup for a run card: how many passes earned their evidence. */
export function checklistRollup(checklist: PipelineChecklistEntry[]): {
  passed: number;
  total: number;
} {
  return {
    passed: checklist.filter((entry) => entry.passes).length,
    total: checklist.length,
  };
}

/** Decisions the machine allows from this status (resume only when paused). */
export function decisionsFor(status: PipelineRunStatus): PipelineRunDecisionAction[] {
  const actions: PipelineRunDecisionAction[] = [];
  if (status === "escalated") actions.push("resume");
  if (canTransitionPipelineRun(status, "cancelled")) actions.push("cancel");
  return actions;
}

/**
 * Client-side spec validation before submit — the same contracts schema the
 * API enforces, so the editor rejects a bad definition without a round trip.
 */
export function parseSpecInput(
  text: string,
): { spec: PipelineSpec; error?: undefined } | { spec?: undefined; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "Not valid JSON." };
  }
  const parsed = pipelineSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    return { error: `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid spec."}` };
  }
  return { spec: parsed.data };
}
