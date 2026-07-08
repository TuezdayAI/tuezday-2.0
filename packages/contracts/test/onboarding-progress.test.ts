import { describe, expect, it } from "vitest";
import { onboardingReadingProgress } from "../src/index";

describe("onboardingReadingProgress", () => {
  it("waits before any read", () => {
    expect(onboardingReadingProgress("none", 0)).toEqual({
      percent: 0,
      label: "Waiting for your website…",
    });
  });

  it("walks scraping → extracting → ready", () => {
    expect(onboardingReadingProgress("scraping", 1).percent).toBe(35);
    expect(onboardingReadingProgress("scraping", 1).label).toMatch(/reading your website/i);
    expect(onboardingReadingProgress("extracting", 1).percent).toBe(70);
    expect(onboardingReadingProgress("extracting", 1).label).toMatch(/understanding your brand/i);
    expect(onboardingReadingProgress("ready", 1)).toEqual({ percent: 100, label: "Done — brand profile ready." });
  });

  it("failed is visible, never stuck", () => {
    const failed = onboardingReadingProgress("failed", 1);
    expect(failed.percent).toBe(100);
    expect(failed.label).toMatch(/couldn't/i);
  });

  it("mentions socials in the pre-scrape label once connected", () => {
    expect(onboardingReadingProgress("none", 1).label).toMatch(/social/i);
  });
});
