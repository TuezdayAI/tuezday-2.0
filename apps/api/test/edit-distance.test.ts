import { describe, expect, it } from "vitest";
import { levenshtein, normalizedEditDistance } from "../src/services/edit-distance";

describe("levenshtein", () => {
  it("computes the classic cases", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("same", "same")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
  });
});

describe("normalizedEditDistance", () => {
  it("scales 0 (untouched) to 100 (fully rewritten)", () => {
    expect(normalizedEditDistance("post", "post")).toBe(0);
    expect(normalizedEditDistance("aaaa", "bbbb")).toBe(100);
    expect(normalizedEditDistance("", "")).toBe(0);
    // One substituted character in ten → 10%.
    expect(normalizedEditDistance("abcdefghij", "abcdefghiX")).toBe(10);
    // kitten → sitting: 3 edits over max length 7 → 42.9 (one decimal).
    expect(normalizedEditDistance("kitten", "sitting")).toBe(42.9);
  });
});
