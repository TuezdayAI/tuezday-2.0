import { describe, it, expect } from "vitest";
import {
  WORKSPACE_NAV,
  visibleNavItems,
  type NavItem,
  type WorkspaceCapabilities,
} from "../src";

describe("visibleNavItems", () => {
  const CORE_NAV: NavItem[] = [
    { label: "Home", path: "" },
    { label: "Insights", path: "/insights" },
    { label: "Brain", path: "/brain" },
    {
      label: "Campaigns",
      path: "/campaigns",
      children: [
        { label: "Ads", path: "/ads" },
        { label: "Ad creatives", path: "/ad-creatives" },
        { label: "Launch ads", path: "/ad-launches" },
        { label: "Other", path: "/other" },
      ],
    },
    { label: "Calendar", path: "/calendar" },
  ];

  it("hides Insights if hasInsights is false", () => {
    const caps: WorkspaceCapabilities = {
      hasAds: true,
      hasInsights: false,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0,
    };
    const visible = visibleNavItems(CORE_NAV, caps);
    expect(visible.find((n) => n.label === "Insights")).toBeUndefined();
  });

  it("shows Insights if hasInsights is true", () => {
    const caps: WorkspaceCapabilities = {
      hasAds: true,
      hasInsights: true,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0,
    };
    const visible = visibleNavItems(CORE_NAV, caps);
    expect(visible.find((n) => n.label === "Insights")).toBeDefined();
  });

  it("hides Ads children if hasAds is false", () => {
    const caps: WorkspaceCapabilities = {
      hasAds: false,
      hasInsights: true,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0,
    };
    const visible = visibleNavItems(CORE_NAV, caps);
    const campaigns = visible.find((n) => n.label === "Campaigns");
    expect(campaigns).toBeDefined();
    expect(campaigns?.children).toBeDefined();
    expect(campaigns?.children?.length).toBe(1); // Only "Other" should remain
    expect(campaigns?.children?.[0]?.label).toBe("Other");
  });

  it("shows Ads children if hasAds is true", () => {
    const caps: WorkspaceCapabilities = {
      hasAds: true,
      hasInsights: true,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0,
    };
    const visible = visibleNavItems(CORE_NAV, caps);
    const campaigns = visible.find((n) => n.label === "Campaigns");
    expect(campaigns?.children?.length).toBe(4);
  });

  it("keeps the workspace shell to workflow-level top navigation", () => {
    expect(WORKSPACE_NAV.map((item) => item.label)).toEqual([
      "Home",
      "Brain",
      "Campaigns",
      "Discover",
      "Create",
      "Review",
      "Audience",
      "Settings",
    ]);
  });

  it("houses related module pages under the workflow they belong to", () => {
    const campaigns = WORKSPACE_NAV.find((item) => item.label === "Campaigns");
    const review = WORKSPACE_NAV.find((item) => item.label === "Review");
    const settings = WORKSPACE_NAV.find((item) => item.label === "Settings");

    expect(campaigns?.children?.map((child) => child.path)).toEqual([
      "/campaigns",
      "/calendar",
      "/cadence",
      "/automation",
      "/ads",
      "/ad-launches",
      "/insights",
    ]);
    expect(review?.children?.map((child) => child.path)).toEqual([
      "/approvals",
      "/inbox",
      "/learning",
    ]);
    expect(settings?.children?.map((child) => child.path)).toEqual([
      "/connectors",
      "/team",
      "/billing",
    ]);
  });

  it("removes gated children without leaving disconnected top-level routes", () => {
    const caps: WorkspaceCapabilities = {
      hasAds: false,
      hasInsights: false,
      hasCrm: false,
      hasConnections: false,
      draftCount: 0,
      generationCount: 0,
    };

    const visible = visibleNavItems(WORKSPACE_NAV, caps);

    expect(visible.map((item) => item.label)).toEqual([
      "Home",
      "Brain",
      "Campaigns",
      "Discover",
      "Create",
      "Review",
      "Audience",
      "Settings",
    ]);
    expect(visible.find((item) => item.label === "Campaigns")?.children?.map((child) => child.path))
      .toEqual(["/campaigns", "/calendar", "/cadence", "/automation"]);
    expect(visible.find((item) => item.path === "/insights")).toBeUndefined();
    expect(visible.find((item) => item.label === "Integrations")).toBeUndefined();
    expect(visible.find((item) => item.label === "Billing")).toBeUndefined();
  });
});
