// Pure view helpers for the packages page (Sprint 62) — kept in lib so they
// are unit-tested (node env). All judgment data comes from the API; these
// only derive presentation facts (blocked lanes, latest assessment).

import type {
  LaneEligibilityCheck,
  LaneEligibilityDecision,
  SufficiencyAssessment,
} from "@tuezday/contracts";

/** The checks that failed on one lane eligibility decision. */
export function blockingChecks(decision: LaneEligibilityDecision): LaneEligibilityCheck[] {
  return decision.checks.filter((check) => !check.passed);
}

/**
 * Human summary of blocked lanes across a package's eligibility decisions,
 * e.g. "2 lanes blocked: media_available, format_registered". Failed rules
 * are deduplicated in first-seen order; empty string when every lane is
 * eligible (or there are no decisions yet).
 */
export function blockingSummary(eligibility: LaneEligibilityDecision[]): string {
  const blocked = eligibility.filter((decision) => !decision.eligible);
  if (blocked.length === 0) return "";
  const rules: string[] = [];
  for (const decision of blocked) {
    for (const check of blockingChecks(decision)) {
      if (!rules.includes(check.rule)) rules.push(check.rule);
    }
  }
  const count = `${blocked.length} lane${blocked.length === 1 ? "" : "s"} blocked`;
  return rules.length === 0 ? count : `${count}: ${rules.join(", ")}`;
}

/** Latest assessment by assessmentVersion — never assumes the API sort order. */
export function latestAssessment(
  assessments: SufficiencyAssessment[],
): SufficiencyAssessment | undefined {
  let latest: SufficiencyAssessment | undefined;
  for (const assessment of assessments) {
    if (!latest || assessment.assessmentVersion > latest.assessmentVersion) {
      latest = assessment;
    }
  }
  return latest;
}
