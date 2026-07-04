import { describe, expect, it } from "vitest";
import {
  PREAMBLE_ID,
  buildFallbackOutline,
  firstSentenceSummary,
  parseDocSections,
  renderOutline,
  slugifyHeading,
} from "../src/sections";

const SOUL_LIKE = `# Acme Soul

Acme exists because reporting has a memory problem.

Weekly metrics die in screenshots.

## The belief

Reporting should compound. Every report should make the next one sharper.

## Operating principles

The principles below are non-negotiable.

### Brain first

The brain is the platform primitive. Nothing ships before it.

### Context before output

Useful output starts with usable context.

## The standard

Acme is working when customers stop re-explaining themselves.
`;

describe("parseDocSections", () => {
  it("splits preamble, H2s, and H3 children with stable path IDs", () => {
    const sections = parseDocSections(SOUL_LIKE);
    expect(sections.map((s) => s.id)).toEqual([
      PREAMBLE_ID,
      "the-belief",
      "operating-principles",
      "operating-principles/brain-first",
      "operating-principles/context-before-output",
      "the-standard",
    ]);
    const brainFirst = sections.find((s) => s.id === "operating-principles/brain-first")!;
    expect(brainFirst.level).toBe(3);
    expect(brainFirst.parentId).toBe("operating-principles");
    expect(brainFirst.body).toContain("### Brain first");
    expect(brainFirst.body).toContain("platform primitive");
    // The H2 keeps only its own intro text, not its children's bodies.
    const principles = sections.find((s) => s.id === "operating-principles")!;
    expect(principles.body).toContain("non-negotiable");
    expect(principles.body).not.toContain("platform primitive");
    // The preamble keeps the H1 + intro prose.
    expect(sections[0]!.body).toContain("memory problem");
    expect(sections.every((s) => s.tokens > 0)).toBe(true);
  });

  it("suffixes duplicate headings in document order", () => {
    const sections = parseDocSections("## Lessons\n\nfirst\n\n## Lessons\n\nsecond\n");
    expect(sections.map((s) => s.id)).toEqual(["lessons", "lessons-2"]);
  });

  it("ignores heading markers inside fenced code blocks", () => {
    const doc = "## Setup\n\nRun this:\n\n```md\n## not a heading\n### also not\n```\n\ndone\n";
    const sections = parseDocSections(doc);
    expect(sections.map((s) => s.id)).toEqual(["setup"]);
    expect(sections[0]!.body).toContain("## not a heading");
  });

  it("parses a heading-less doc as a single preamble section", () => {
    const sections = parseDocSections("Just two paragraphs.\n\nNo headings anywhere.");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe(PREAMBLE_ID);
  });

  it("returns [] for an empty doc", () => {
    expect(parseDocSections("")).toEqual([]);
    expect(parseDocSections("   \n  ")).toEqual([]);
  });

  it("slugifies unicode and strips punctuation", () => {
    expect(slugifyHeading("Who we are for?")).toBe("who-we-are-for");
    expect(slugifyHeading("  ---  ")).toBe("section");
  });
});

describe("firstSentenceSummary", () => {
  it("takes the first sentence, skipping the heading line", () => {
    expect(firstSentenceSummary("## The belief\n\nReporting should compound. More text.")).toBe(
      "Reporting should compound.",
    );
  });

  it("flattens bullets and truncates long sentences with an ellipsis", () => {
    const long = `## X\n\n- ${"word ".repeat(60)}end.`;
    const summary = firstSentenceSummary(long, 80);
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("buildFallbackOutline / renderOutline", () => {
  it("builds a fallback outline and renders it with H3 indentation", () => {
    const outline = buildFallbackOutline(SOUL_LIKE, 123)!;
    expect(outline.generatedAt).toBe(123);
    expect(outline.sections.every((s) => s.summarySource === "fallback")).toBe(true);
    const rendered = renderOutline(outline);
    expect(rendered).toContain("- (intro)");
    expect(rendered).toContain("- The belief — Reporting should compound.");
    expect(rendered).toContain("  - Brain first — The brain is the platform primitive.");
  });

  it("returns null for an empty doc", () => {
    expect(buildFallbackOutline("", 1)).toBeNull();
  });
});
