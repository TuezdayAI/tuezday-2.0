import { ContextSection } from "@tuezday/brain";
import { GenerationReview } from "@tuezday/contracts";
import { ReviewPanel } from "./ReviewPanel";

/** Tier / matrix-mode / zoom badges for one resolved section (Sprint 43). */
export function SectionBadges({ section }: { section: ContextSection }) {
  return (
    <>
      {section.tier !== undefined && (
        <span className="tier-badge">tier {section.tier}</span>
      )}
      {section.mode && <span className={`mode-badge mode-${section.mode}`}>{section.mode}</span>}
      {section.zoom && (
        <span className="zoom-score">
          #{section.zoom.rank} · score {section.zoom.score.toFixed(2)}
        </span>
      )}
    </>
  );
}

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

/** Compact per-section trace: which tier admitted each section and why (Sprint 43). */
export function ContextSectionsTrace({ sections }: { sections: ContextSection[] }) {
  return (
    <ul className="section-list" style={{ marginTop: 4 }}>
      {sections.map((s) => (
        <li
          key={s.key}
          className={`section-card ${s.included ? "" : "excluded"}`}
          style={{ padding: 8 }}
        >
          <div className="section-head">
            <span className={`layer-badge layer-${s.layer}`}>{s.layer}</span>
            <SectionBadges section={s} />
            <span className="section-title" style={{ fontSize: "0.85rem" }}>
              {s.title}
            </span>
            <span className="section-tokens">{s.included ? `~${s.tokens} tok` : "excluded"}</span>
          </div>
          <p className="section-reason">{s.reason}</p>
        </li>
      ))}
    </ul>
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
        {sections && sections.length > 0 && <ContextSectionsTrace sections={sections} />}
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
