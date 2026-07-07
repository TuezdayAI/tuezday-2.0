import { describe, expect, it } from "vitest";
import {
  BRAND_PROFILE_STATUSES,
  VOICE_DIMENSIONS,
  brandProfileSchema,
  brandProfileViewSchema,
  updateBrandProfileInputSchema,
} from "../src/index";

const FULL = {
  businessName: "Hexalog",
  tagline: "Logs, but hexagonal",
  summary: "Hexalog is a logging platform for platform teams.",
  targetAgeRange: "25-45",
  tone: "Confident, plain-spoken, technical",
  voiceDimensions: {
    purpose: "Help platform teams see production clearly",
    audience: "Senior platform engineers",
    tone: "Direct",
    emotions: "Calm confidence",
    character: "The experienced SRE next desk over",
    syntax: "Short sentences",
    language: "US English, no fluff",
  },
  pillars: ["Observability", "Cost control"],
  sourceNotes: "No pricing page found.",
};

describe("brand profile contracts", () => {
  it("fixes the seven voice dimensions", () => {
    expect(VOICE_DIMENSIONS).toEqual([
      "purpose", "audience", "tone", "emotions", "character", "syntax", "language",
    ]);
  });

  it("fixes the run statuses", () => {
    expect(BRAND_PROFILE_STATUSES).toEqual(["scraping", "extracting", "ready", "failed"]);
  });

  it("accepts a full profile", () => {
    expect(brandProfileSchema.safeParse(FULL).success).toBe(true);
  });

  it("accepts a minimal profile (defaults fill the rest)", () => {
    const parsed = brandProfileSchema.safeParse({
      businessName: "X",
      voiceDimensions: {},
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.pillars).toEqual([]);
    expect(parsed.data?.voiceDimensions.purpose).toBe("");
  });

  it("rejects a missing businessName and >8 pillars", () => {
    expect(brandProfileSchema.safeParse({ ...FULL, businessName: " " }).success).toBe(false);
    expect(
      brandProfileSchema.safeParse({ ...FULL, pillars: Array.from({ length: 9 }, () => "p") })
        .success,
    ).toBe(false);
  });

  it("view carries status incl. none, nullable profile", () => {
    expect(
      brandProfileViewSchema.safeParse({
        status: "none",
        profile: null,
        sourceUrl: null,
        error: null,
        updatedAt: null,
      }).success,
    ).toBe(true);
    expect(
      brandProfileViewSchema.safeParse({
        status: "ready",
        profile: FULL,
        sourceUrl: "https://hexalog.com",
        error: null,
        updatedAt: 1,
      }).success,
    ).toBe(true);
    expect(
      brandProfileViewSchema.safeParse({
        status: "sideways",
        profile: null,
        sourceUrl: null,
        error: null,
        updatedAt: null,
      }).success,
    ).toBe(false);
  });

  it("update input is a partial edit", () => {
    expect(updateBrandProfileInputSchema.safeParse({ tone: "Warmer" }).success).toBe(true);
    expect(updateBrandProfileInputSchema.safeParse({}).success).toBe(true);
    expect(updateBrandProfileInputSchema.safeParse({ businessName: "" }).success).toBe(false);
  });
});
