import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV, navEntryForPath } from "../src/index.js";

describe("navEntryForPath", () => {
  it("resolves the workspace root to Home", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "")).toMatchObject({ label: "Home", icon: "home" });
  });
  it("resolves a group path to its same-path child (child beats group)", () => {
    // Sprint 60 gave Discover children; like "Campaign home" under Campaigns,
    // the child sharing the group's path wins and carries parentLabel.
    expect(navEntryForPath(WORKSPACE_NAV, "/discovery")).toMatchObject({
      label: "Signal inbox",
      parentLabel: "Discover",
    });
    expect(navEntryForPath(WORKSPACE_NAV, "/stories")).toMatchObject({
      label: "Stories",
      parentLabel: "Discover",
    });
    expect(navEntryForPath(WORKSPACE_NAV, "/opportunities")).toMatchObject({
      label: "Opportunities",
      parentLabel: "Discover",
    });
    expect(navEntryForPath(WORKSPACE_NAV, "/packages")).toMatchObject({
      label: "Packages",
      parentLabel: "Discover",
    });
  });
  it("resolves Calendar as a primary surface", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/calendar")).toMatchObject({
      label: "Calendar",
    });
    expect(navEntryForPath(WORKSPACE_NAV, "/calendar")?.parentLabel).toBeUndefined();
  });
  it("resolves the unified Review workspace as a primary surface", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/review")).toMatchObject({ label: "Review" });
    expect(navEntryForPath(WORKSPACE_NAV, "/review")?.parentLabel).toBeUndefined();
  });
  it("matches sub-routes of a page (detail views)", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/campaigns/abc123")).toMatchObject({
      label: "Campaign home",
    });
  });
  it("places Learning under Insights", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/learning")).toMatchObject({
      label: "Learning",
      parentLabel: "Insights",
    });
  });
  it("keeps hash-only aliases from replacing the Brain page title", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/brain")).toMatchObject({
      label: "Brain docs",
      parentLabel: "Brain",
    });
  });
  it("returns null for unknown paths", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/nope")).toBeNull();
  });
});
