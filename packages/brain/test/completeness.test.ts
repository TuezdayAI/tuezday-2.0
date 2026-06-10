import { describe, expect, it } from "vitest";
import { COMPLETE_WORD_THRESHOLD, scoreBrain, scoreDoc } from "../src/index";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("scoreDoc", () => {
  it("scores empty content as empty with 0 words", () => {
    expect(scoreDoc("")).toEqual({ words: 0, status: "empty" });
  });

  it("treats whitespace-only content as empty", () => {
    expect(scoreDoc("   \n\t  ")).toEqual({ words: 0, status: "empty" });
  });

  it("scores short content as draft", () => {
    const result = scoreDoc(words(COMPLETE_WORD_THRESHOLD - 1));
    expect(result.status).toBe("draft");
    expect(result.words).toBe(COMPLETE_WORD_THRESHOLD - 1);
  });

  it("scores content at the threshold as complete", () => {
    expect(scoreDoc(words(COMPLETE_WORD_THRESHOLD)).status).toBe("complete");
  });

  it("counts words across lines and markdown", () => {
    expect(scoreDoc("# Heading\n\n- one\n- two\n").words).toBe(3);
  });
});

describe("scoreBrain", () => {
  it("scores an all-empty brain at 0 percent", () => {
    const result = scoreBrain({ soul: "", icp: "", voice: "", history: "", now: "" });
    expect(result.percent).toBe(0);
    expect(result.docs).toHaveLength(5);
    expect(result.docs.map((d) => d.docType)).toEqual([
      "soul",
      "icp",
      "voice",
      "history",
      "now",
    ]);
  });

  it("scores an all-complete brain at 100 percent", () => {
    const full = words(COMPLETE_WORD_THRESHOLD);
    const result = scoreBrain({
      soul: full,
      icp: full,
      voice: full,
      history: full,
      now: full,
    });
    expect(result.percent).toBe(100);
  });

  it("scores drafts at half weight", () => {
    const result = scoreBrain({
      soul: "just a few words here",
      icp: "",
      voice: "",
      history: "",
      now: "",
    });
    expect(result.percent).toBe(10); // 0.5 of 5 docs
  });

  it("rounds to a whole percent", () => {
    const full = words(COMPLETE_WORD_THRESHOLD);
    const result = scoreBrain({
      soul: full,
      icp: "a draft",
      voice: "",
      history: "",
      now: "",
    });
    expect(result.percent).toBe(30); // (1 + 0.5) / 5
  });
});
