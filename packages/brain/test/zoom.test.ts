import { describe, expect, it } from "vitest";
import { parseDocSections } from "../src/sections";
import { composeZoomQuery, rankSections, tokenize, type ZoomCandidate } from "../src/zoom";

function candidatesFrom(doc: string): ZoomCandidate[] {
  return parseDocSections(doc).map((section) => ({ docType: "history" as const, section }));
}

const HISTORY = `## Launch of reporting dashboards

We shipped weekly reporting dashboards in March. Agencies loved the export.

## Pricing experiment

We tested usage-based pricing in April. Churn dropped for small agencies.

## Conference talk

The founder spoke at SaaSCon about onboarding.
`;

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and single chars", () => {
    expect(tokenize("The Pricing... of a B2B plan!")).toEqual(["pricing", "b2b", "plan"]);
  });
});

describe("rankSections", () => {
  it("ranks the section matching the query first, with positive scores only", () => {
    const ranked = rankSections("usage based pricing churn", candidatesFrom(HISTORY));
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.section.id).toBe("pricing-experiment");
    expect(ranked.every((r) => r.score > 0)).toBe(true);
    expect(ranked.some((r) => r.section.id === "conference-talk")).toBe(false);
  });

  it("is deterministic and breaks ties by document order", () => {
    const doc = "## Alpha\n\nsame words here\n\n## Beta\n\nsame words here\n";
    const first = rankSections("same words", candidatesFrom(doc));
    const second = rankSections("same words", candidatesFrom(doc));
    expect(first.map((r) => r.section.id)).toEqual(["alpha", "beta"]);
    expect(second.map((r) => r.section.id)).toEqual(first.map((r) => r.section.id));
  });

  it("returns [] when nothing matches or the query is all stopwords", () => {
    expect(rankSections("quantum blockchain", candidatesFrom(HISTORY))).toEqual([]);
    expect(rankSections("the and of", candidatesFrom(HISTORY))).toEqual([]);
    expect(rankSections("pricing", [])).toEqual([]);
  });
});

describe("composeZoomQuery", () => {
  it("folds in task, channel, campaign objective/pillars, signal, and angle", () => {
    const query = composeZoomQuery({
      taskType: "linkedin_post",
      channel: "linkedin",
      campaign: {
        name: "Q3 agencies push",
        overlay: "",
        objective: "Win 20 agency logos",
        pillars: ["reporting pain", "white-label"],
      },
      signal: { content: "Agencies complain about reporting busywork", source: "reddit" },
      angle: "The Sunday-night report scramble",
    });
    expect(query).toContain("linkedin post");
    expect(query).toContain("Win 20 agency logos");
    expect(query).toContain("reporting pain white-label");
    expect(query).toContain("reporting busywork");
    expect(query).toContain("Sunday-night report scramble");
  });

  it("is deterministic and skips absent fields", () => {
    const a = composeZoomQuery({ taskType: "pr_pitch", channel: "pr" });
    const b = composeZoomQuery({ taskType: "pr_pitch", channel: "pr" });
    expect(a).toBe(b);
    expect(a).toBe("pr pitch\npr");
  });
});
