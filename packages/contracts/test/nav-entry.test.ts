import { describe, expect, it } from "vitest";
import { WORKSPACE_NAV, navEntryForPath } from "../src/index.js";

describe("navEntryForPath", () => {
  it("resolves the workspace root to Home", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "")).toMatchObject({ label: "Home", icon: "home" });
  });
  it("resolves a group path to the group", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/discovery")).toMatchObject({ label: "Discover" });
  });
  it("resolves a child path with its parent label", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/calendar")).toMatchObject({
      label: "Calendar",
      parentLabel: "Campaigns",
    });
  });
  it("prefers the deepest match (child over group sharing a prefix)", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/approvals")).toMatchObject({
      label: "Approval queue",
      parentLabel: "Review",
    });
  });
  it("matches sub-routes of a page (detail views)", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/campaigns/abc123")).toMatchObject({
      label: "Campaign home",
    });
  });
  it("returns null for unknown paths", () => {
    expect(navEntryForPath(WORKSPACE_NAV, "/nope")).toBeNull();
  });
});
