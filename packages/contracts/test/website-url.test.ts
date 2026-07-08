import { describe, expect, it } from "vitest";
import {
  SOCIAL_READ_PROVIDERS,
  createWorkspaceInputSchema,
  normalizeWebsiteUrl,
} from "../src/index";

describe("normalizeWebsiteUrl", () => {
  it("prepends https:// to a bare domain", () => {
    expect(normalizeWebsiteUrl("tuezdayai.com")).toBe("https://tuezdayai.com");
    expect(normalizeWebsiteUrl("www.tuezdayai.com")).toBe("https://www.tuezdayai.com");
    expect(normalizeWebsiteUrl("  acme.com/path  ")).toBe("https://acme.com/path");
  });

  it("leaves an explicit scheme untouched", () => {
    expect(normalizeWebsiteUrl("http://acme.com")).toBe("http://acme.com");
    expect(normalizeWebsiteUrl("https://acme.com")).toBe("https://acme.com");
  });

  it("returns null for empty or unusable input", () => {
    expect(normalizeWebsiteUrl("")).toBeNull();
    expect(normalizeWebsiteUrl("   ")).toBeNull();
    expect(normalizeWebsiteUrl("not a url at all")).toBeNull();
  });
});

describe("createWorkspaceInputSchema accepts bare domains", () => {
  it("normalizes a bare domain to a valid https URL", () => {
    const parsed = createWorkspaceInputSchema.parse({ name: "X", websiteUrl: "tuezdayai.com" });
    expect(parsed.websiteUrl).toBe("https://tuezdayai.com");
  });
  it("still rejects genuine garbage", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "X", websiteUrl: "###" }).success).toBe(false);
  });
});

describe("SOCIAL_READ_PROVIDERS includes reddit", () => {
  it("has all four onboarding social sources", () => {
    expect([...SOCIAL_READ_PROVIDERS].sort()).toEqual(
      ["instagram", "linkedin", "reddit", "twitter"].sort(),
    );
  });
});
