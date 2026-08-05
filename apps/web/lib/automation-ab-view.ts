// Pure view helpers for the Sprint 65 generation-path A/B section — kept in
// lib so they are unit-tested (node env). All measurement comes from the API
// comparison endpoint; these only derive presentation facts.

import type {
  AutomationGenerationPath,
  PipelineShadowPair,
  ShadowVerdict,
} from "@tuezday/contracts";

/** Plain-language label + consequence for each generation path. */
export function pathLabel(path: AutomationGenerationPath): { title: string; consequence: string } {
  switch (path) {
    case "legacy":
      return {
        title: "Legacy",
        consequence: "Automation drafts through the original single-shot generator.",
      };
    case "shadow":
      return {
        title: "Shadow A/B",
        consequence:
          "Legacy still produces the real draft; the pipeline engine runs the same signal in parallel for comparison only.",
      };
    case "pipeline":
      return {
        title: "Pipeline engine",
        consequence:
          "Automation drafts through the pipeline definition; legacy is bypassed (it falls back if no definition is active).",
      };
  }
}

/** "82.4%" — or an em dash when there is no data (null, not zero). */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate}%`;
}

/** Cents → "$1.23"; zero renders as "$0.00" (a real measured zero). */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Verdict tally from a reviewed pair list (pairs without a verdict ignored). */
export function verdictTally(
  pairs: Pick<PipelineShadowPair, "verdict">[],
): Record<ShadowVerdict, number> {
  const tally: Record<ShadowVerdict, number> = { engine: 0, legacy: 0, tie: 0 };
  for (const pair of pairs) {
    if (pair.verdict) tally[pair.verdict] += 1;
  }
  return tally;
}

/**
 * Which path the comparison currently favors, judged only on approval rate
 * over decided drafts — the one metric both paths measure the same way.
 * Returns null when either side has no decided drafts yet (no verdict from
 * no data), or "tie" when the rates are equal.
 */
export function comparisonLeader(comparison: {
  legacy: { approvalRate: number | null };
  engine: { approvalRate: number | null };
}): "engine" | "legacy" | "tie" | null {
  const legacy = comparison.legacy.approvalRate;
  const engine = comparison.engine.approvalRate;
  if (legacy === null || engine === null) return null;
  if (engine > legacy) return "engine";
  if (legacy > engine) return "legacy";
  return "tie";
}
