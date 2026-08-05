// Pure view helpers for the Sprint 67 eval harness page — kept in lib so they
// are unit-tested (node env). Every number these format comes from the API's
// metrics/comparison payloads; nothing is measured here.

import type {
  EvalCheckResult,
  EvalComparison,
  EvalRun,
  EvalRunMetrics,
  EvalVerdict,
} from "@tuezday/contracts";

/** The metrics worth showing on a run card, in the order they read best. */
export const HEADLINE_METRICS = [
  "hardCheckPassRate",
  "rejectRecall",
  "approvePassRate",
  "agreementRate",
  "avgEditDistanceToFinal",
  "avgJudgeScore",
] as const;

export type HeadlineMetric = (typeof HEADLINE_METRICS)[number];

const LABELS: Record<HeadlineMetric, string> = {
  hardCheckPassRate: "Hard checks passed",
  rejectRecall: "Caught what the founder rejected",
  approvePassRate: "Passed what the founder approved",
  agreementRate: "Agreed with the founder",
  avgEditDistanceToFinal: "Distance from what shipped",
  avgJudgeScore: "Judge score",
};

export function metricLabel(metric: string): string {
  return LABELS[metric as HeadlineMetric] ?? metric;
}

/**
 * A null metric means "no data" and renders as an em dash — never as 0%, which
 * would read as a measured failure.
 */
export function formatMetric(metric: HeadlineMetric, value: number | null): string {
  if (value === null) return "—";
  return metric === "avgJudgeScore" ? `${value}/100` : `${value}%`;
}

/** How a metric moves when it improves — drives the arrow direction in the UI. */
export function metricBetterDirection(metric: string): "higher" | "lower" {
  return metric === "avgEditDistanceToFinal" ? "lower" : "higher";
}

/**
 * A run's own summary line. Reports `completed` rather than `cases` because a
 * case that failed to replay was scored on nothing.
 */
export function runSummary(run: Pick<EvalRun, "metrics" | "judgeEnabled">): string {
  const { cases, completed, failed, judged } = run.metrics;
  const parts = [`${completed}/${cases} replayed`];
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(run.judgeEnabled ? `${judged} judged` : "not judged");
  return parts.join(" · ");
}

/**
 * `blocked` when the gate would fail a merge, `clean` when it passed with a
 * baseline to compare against, `unmeasured` when there was no baseline (which
 * is not a pass — it is an absence of evidence).
 */
export function regressionSeverity(
  comparison: Pick<EvalComparison, "ok" | "baselineRunId">,
): "blocked" | "clean" | "unmeasured" {
  if (comparison.baselineRunId === null) return "unmeasured";
  return comparison.ok ? "clean" : "blocked";
}

export function verdictTone(verdict: EvalVerdict | null): "approved" | "rejected" | "neutral" {
  if (verdict === "pass") return "approved";
  if (verdict === "flag") return "rejected";
  return "neutral";
}

/** Only the checks that actually failed — what a reviewer needs to see first. */
export function failedChecks(checks: EvalCheckResult[]): EvalCheckResult[] {
  return checks.filter((check) => check.status === "fail");
}

/**
 * Oldest-first series for one metric across runs, skipping runs where it is
 * null. Runs arrive newest-first from the API.
 */
export function trendSeries(
  runs: Array<Pick<EvalRun, "id" | "createdAt" | "metrics">>,
  metric: HeadlineMetric,
): Array<{ runId: string; createdAt: number; value: number }> {
  return runs
    .map((run) => ({
      runId: run.id,
      createdAt: run.createdAt,
      value: run.metrics[metric as keyof EvalRunMetrics] as number | null,
    }))
    .filter((point): point is { runId: string; createdAt: number; value: number } =>
      point.value !== null,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}
