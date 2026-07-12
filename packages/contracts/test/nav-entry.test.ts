import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV, navEntryForPath } from "../src/index.js";

describe("navEntryForPath", () => {
  it("resolves the workspace root to Home", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "")).toMatchObject({ label: "Home", icon: "home" });
  });
  it("resolves a group path to the group", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/discovery")).toMatchObject({ label: "Discover" });
  });
  it("resolves Calendar as a primary surface", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/calendar")).toMatchObject({
      label: "Calendar",
    });
    expect(navEntryForPath(WORKSPACE_NAV, "/calendar")?.parentLabel).toBeUndefined();
  });
  it("prefers the deepest match (child over group sharing a prefix)", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/approvals")).toMatchObject({
      label: "Approvals",
      parentLabel: "Review",
    });
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
