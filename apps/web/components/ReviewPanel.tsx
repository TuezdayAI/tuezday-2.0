"use client";

import { REVIEW_CHECK_LABELS, type GenerationReview } from "@tuezday/contracts";

/**
 * Renders a dual-LLM pre-review (Sprint 22): per-check scores + issues, with a
 * "flagged" badge when any check fell below the workspace threshold. Advisory
 * only — it never blocks an action, it just shows what the reviewers saw.
 */
export function ReviewPanel({ review }: { review: GenerationReview | null | undefined }) {
  if (!review) return null;

  const scoreClass = (score: number | null): string => {
    if (score === null) return "unknown";
    return score < review.threshold ? "weak" : "strong";
  };

  const allIssues = review.checks.flatMap((c) =>
    c.issues.map((issue) => ({ check: c.check, issue })),
  );

  return (
    <div className={`review-panel ${review.flagged ? "flagged" : ""}`}>
      <div className="review-head">
        <span className={`layer-badge ${review.flagged ? "badge-danger" : "badge-active"}`}>
          {review.flagged ? "⚑ flagged" : "✓ reviewed"}
        </span>
        <div className="review-scores">
          {review.checks.map((c) => (
            <span key={c.check} className={`review-score ${scoreClass(c.score)}`}>
              {REVIEW_CHECK_LABELS[c.check]} {c.score === null ? "n/a" : `${c.score}/100`}
            </span>
          ))}
        </div>
      </div>
      {allIssues.length > 0 && (
        <ul className="review-issues">
          {allIssues.map(({ check, issue }, i) => (
            <li key={`${check}-${i}`}>
              <strong>{REVIEW_CHECK_LABELS[check]}:</strong> {issue}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
