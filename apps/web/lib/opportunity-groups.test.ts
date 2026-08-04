import { describe, expect, it } from "vitest";
import {
  MANUAL_GROUP_KEY,
  MANUAL_GROUP_LABEL,
  groupOpportunitiesByStory,
} from "./opportunity-groups";

function opp(
  canonicalStoryId: string | null,
  storyTitle: string | null = null,
  storyUrl: string | null = null,
) {
  return { canonicalStoryId, storyTitle, storyUrl };
}

describe("opportunity grouping", () => {
  it("groups by canonical story preserving first-seen order", () => {
    const groups = groupOpportunitiesByStory([
      opp("s1", "Story one", "https://a.example"),
      opp("s2", "Story two", "https://b.example"),
      opp("s1", "Story one", "https://a.example"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["s1", "s2"]);
    expect(groups[0]!.opportunities).toHaveLength(2);
    expect(groups[0]!.title).toBe("Story one");
    expect(groups[0]!.url).toBe("https://a.example");
    expect(groups[1]!.opportunities).toHaveLength(1);
  });

  it("collects story-less opportunities under one Manual signal group", () => {
    const groups = groupOpportunitiesByStory([
      opp(null),
      opp("s1", "Story one", null),
      opp(null),
    ]);
    expect(groups.map((g) => g.key)).toEqual([MANUAL_GROUP_KEY, "s1"]);
    expect(groups[0]!.title).toBe(MANUAL_GROUP_LABEL);
    expect(groups[0]!.url).toBeNull();
    expect(groups[0]!.opportunities).toHaveLength(2);
  });

  it("falls back to Untitled story when a story row has no title", () => {
    const groups = groupOpportunitiesByStory([opp("s1", null, null)]);
    expect(groups[0]!.title).toBe("Untitled story");
  });

  it("returns an empty list for no opportunities", () => {
    expect(groupOpportunitiesByStory([])).toEqual([]);
  });
});
