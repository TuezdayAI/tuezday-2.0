import { describe, expect, it } from "vitest";
import {
  SOCIAL_READ_PROVIDERS,
  socialCorpusSchema,
  socialProfileReadSchema,
} from "../src/index";

describe("social corpus contracts", () => {
  it("fixes the three readable social providers", () => {
    expect(SOCIAL_READ_PROVIDERS).toEqual(["linkedin", "twitter", "instagram", "reddit"]);
  });

  it("accepts a full profile read and defaults the rest", () => {
    const full = socialProfileReadSchema.safeParse({
      provider: "twitter",
      handle: "hexalog",
      displayName: "Hexalog",
      bio: "Logs, but hexagonal",
      recentPosts: [{ text: "We shipped!", url: "https://x.com/1", createdAt: 1 }],
    });
    expect(full.success).toBe(true);
    const minimal = socialProfileReadSchema.safeParse({ provider: "linkedin" });
    expect(minimal.success).toBe(true);
    expect(minimal.data?.recentPosts).toEqual([]);
  });

  it("rejects an unknown provider", () => {
    expect(socialProfileReadSchema.safeParse({ provider: "myspace" }).success).toBe(false);
  });

  it("corpus view carries per-provider entries incl. failures", () => {
    const parsed = socialCorpusSchema.safeParse({
      connected: ["twitter"],
      entries: [
        { provider: "twitter", profile: null, error: "scope missing" },
      ],
      corpus: "",
    });
    expect(parsed.success).toBe(true);
  });
});
