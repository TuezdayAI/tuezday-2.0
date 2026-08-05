import type { EvalCheckResult } from "@tuezday/contracts";

/** The kinds that failed, sorted so the golden expectation is order-stable. */
export function failedCheckKinds(checks: EvalCheckResult[]): string[] {
  return checks
    .filter((check) => check.status === "fail")
    .map((check) => check.kind)
    .sort();
}
