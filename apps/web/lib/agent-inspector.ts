import type { AgentRunStep, AgentRunSummary } from "@tuezday/contracts";

// ---------------------------------------------------------------------------
// Agent Inspector page logic (Sprint 57) — pure, unit-tested per the app's
// lib-module convention. The page renders what these return.
// ---------------------------------------------------------------------------

export type InspectorBadgeTone =
  | "neutral"
  | "approved"
  | "pending"
  | "edited"
  | "rejected"
  | "danger";

/** One badge per run: running > stop reason. Bounds read as "edited" (amber
 * caution — the run was cut short, not broken); needs_human as pending. */
export function runBadge(run: Pick<AgentRunSummary, "status" | "stopReason">): {
  label: string;
  tone: InspectorBadgeTone;
} {
  if (run.status === "running") return { label: "running", tone: "pending" };
  switch (run.stopReason) {
    case "complete":
      return { label: "complete", tone: "approved" };
    case "needs_human":
      return { label: "needs human", tone: "pending" };
    case "error":
      return { label: "error", tone: "danger" };
    case "max_steps":
      return { label: "max steps", tone: "edited" };
    case "max_tokens":
      return { label: "max tokens", tone: "edited" };
    case "timeout":
      return { label: "timeout", tone: "edited" };
    default:
      return { label: "done", tone: "neutral" };
  }
}

/** A model call followed by the tool dispatches it requested — the visual
 * unit of the transcript. Steps are persisted in exactly this order. */
export interface TimelineEntry {
  model: AgentRunStep;
  tools: AgentRunStep[];
}

export function groupSteps(steps: AgentRunStep[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const step of steps) {
    if (step.kind === "model_call") {
      entries.push({ model: step, tools: [] });
    } else if (entries.length > 0) {
      entries[entries.length - 1]!.tools.push(step);
    }
  }
  return entries;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

/** costCents is telemetry-grade REAL cents (Sprint 56 pricing table). */
export function formatCost(costCents: number): string {
  if (costCents === 0) return "0¢";
  if (costCents < 0.01) return "<0.01¢";
  if (costCents < 100) return `${costCents.toFixed(2)}¢`;
  return `$${(costCents / 100).toFixed(2)}`;
}

export function formatElapsed(startedAt: number, finishedAt: number | null): string {
  if (finishedAt === null) return "running";
  const ms = Math.max(0, finishedAt - startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Deterministic, display-ready JSON for tool arguments and results. */
export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
