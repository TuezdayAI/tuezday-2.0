import { ContextSection } from "@tuezday/brain";
import { GenerationReview } from "@tuezday/contracts";
import { ReviewPanel } from "./ReviewPanel";

export function EvidenceRetrieval({ section }: { section: ContextSection }) {
  if (!section.evidence) return null;
  const { query, chunks } = section.evidence;
  return (
    <div style={{ marginTop: 8 }}>
      <p className="meta">
        Retrieval query: <em>{query}</em>
      </p>
      <ul className="section-list" style={{ marginTop: 4 }}>
        {chunks.map((c, i) => (
          <li
            key={`${c.documentId}-${i}`}
            className={`section-card ${c.kept ? "" : "excluded"}`}
            style={{ padding: 8 }}
          >
            <div className="section-head">
              <span className="layer-badge">{c.kind}</span>
              <span className="section-title" style={{ fontSize: "0.85rem" }}>
                {c.title}
              </span>
              <span className="section-tokens">{c.kept ? "Kept" : "Dropped (budget)"}</span>
            </div>
            <p className="meta" style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
              sim {c.score.toFixed(2)} · rec {c.recencyScore.toFixed(2)} · src{" "}
              {c.sourceWeight.toFixed(2)} · final {c.finalScore.toFixed(2)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WhyThisOutput({
  sections,
  prompt,
  review,
}: {
  sections?: ContextSection[];
  prompt?: string;
  review?: GenerationReview | null;
}) {
  if (!sections && !prompt && !review) return null;

  return (
    <details className="trace-details" style={{ marginTop: 12, marginBottom: 12 }}>
      <summary className="link-button" style={{ cursor: "pointer", listStyle: "none" }}>
        How did Tuezday write this?
      </summary>
      <div className="trace-content" style={{ marginTop: 8 }}>
        {review && <ReviewPanel review={review} />}
        {sections
          ?.filter((s) => s.key === "evidence" && s.evidence)
          .map((s) => (
            <EvidenceRetrieval key={s.key} section={s} />
          ))}
        {prompt && <pre className="section-content">{prompt}</pre>}
      </div>
    </details>
  );
}
