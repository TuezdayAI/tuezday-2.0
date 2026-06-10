import { describe, expect, it } from "vitest";
import { BRAIN_DOC_META, renderBrainMarkdown } from "../src/index";

describe("BRAIN_DOC_META", () => {
  it("covers all five docs in canonical order", () => {
    expect(BRAIN_DOC_META.map((m) => m.docType)).toEqual([
      "soul",
      "icp",
      "voice",
      "history",
      "now",
    ]);
  });

  it("gives every doc a title and description", () => {
    for (const meta of BRAIN_DOC_META) {
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });
});

describe("renderBrainMarkdown", () => {
  it("renders workspace name and all five sections in order", () => {
    const md = renderBrainMarkdown("Hexalog", {
      soul: "We exist to end GTM amnesia.",
      icp: "Founder-led SaaS.",
      voice: "Direct, technical, never corporate.",
      history: "Launched v0 in June.",
      now: "Pushing the rebuild this month.",
    });

    expect(md).toContain("# Hexalog — GTM Brain");
    const positions = ["## Soul", "## ICP", "## Voice", "## History", "## Now"].map((h) =>
      md.indexOf(h),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(md).toContain("We exist to end GTM amnesia.");
  });

  it("renders a placeholder for unwritten docs", () => {
    const md = renderBrainMarkdown("Hexalog", {
      soul: "",
      icp: "  ",
      voice: "Has content",
      history: "",
      now: "",
    });
    expect(md.match(/_Not written yet\._/g)).toHaveLength(4);
  });
});
