import { describe, expect, it } from "vitest";
import { rankEvidenceChunks, RETRIEVAL, type ScoredCandidate } from "../src/services/evidence";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function candidate(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    text: over.text ?? "some evidence text about churn and onboarding",
    title: over.title ?? "Doc",
    documentId: over.documentId ?? "d1",
    kind: over.kind ?? "manual",
    score: over.score ?? 0.8,
    sourceCreatedAt: over.sourceCreatedAt ?? NOW,
  };
}

describe("rankEvidenceChunks", () => {
  it("drops chunks below the similarity floor", () => {
    expect(rankEvidenceChunks([candidate({ score: 0.2 })], NOW)).toHaveLength(0);
  });

  it("ranks fresher evidence above stale at equal similarity + kind", () => {
    const fresh = candidate({ documentId: "fresh", text: "fresh churn insight", sourceCreatedAt: NOW });
    const stale = candidate({
      documentId: "stale",
      text: "stale churn insight",
      sourceCreatedAt: NOW - 365 * DAY,
    });
    const out = rankEvidenceChunks([stale, fresh], NOW);
    expect(out[0]!.documentId).toBe("fresh");
    expect(out[0]!.recencyScore).toBeGreaterThan(out[1]!.recencyScore);
  });

  it("ranks higher-weight origins above lower-weight at equal similarity + recency", () => {
    const manual = candidate({ documentId: "m", text: "manual fact alpha", kind: "manual" });
    const signal = candidate({ documentId: "s", text: "signal fact beta", kind: "signal" });
    const out = rankEvidenceChunks([signal, manual], NOW);
    expect(out[0]!.documentId).toBe("m");
    expect(out[0]!.sourceWeight).toBe(RETRIEVAL.sourceWeight.manual);
  });

  it("caps the number of chunks taken from one document", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      candidate({ documentId: "same", text: `distinct chunk number ${i} alpha beta`, score: 0.9 - i * 0.05 }),
    );
    const out = rankEvidenceChunks(many, NOW);
    expect(out.filter((c) => c.documentId === "same")).toHaveLength(RETRIEVAL.perDocCap);
  });

  it("removes near-duplicate text even across documents", () => {
    const a = candidate({ documentId: "a", text: "the brain rollout dropped churn by thirty percent" });
    const b = candidate({ documentId: "b", text: "the brain rollout dropped churn by thirty percent" });
    expect(rankEvidenceChunks([a, b], NOW)).toHaveLength(1);
  });

  it("keeps at most KEEP_MAX chunks", () => {
    const lots = Array.from({ length: 20 }, (_, i) =>
      candidate({ documentId: `d${i}`, text: `unique chunk ${i} ${"word".repeat(i + 1)}`, score: 0.9 }),
    );
    expect(rankEvidenceChunks(lots, NOW)).toHaveLength(RETRIEVAL.keepMax);
  });
});
