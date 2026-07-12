import { describe, it, expect } from "vitest";
import {
  WORKSPACE_NAV,
  visibleNavItems,
  type NavItem,
  type WorkspaceCapabilities,
} from "../src";

describe("visibleNavItems", () => {
  const CORE_NAV: NavItem[] = [
    { label: "Home", path: "", section: "operate" },
    { label: "Insights", path: "/insights", section: "operate" },
    { label: "Brain", path: "/brain", section: "operate" },
    {
      label: "Campaigns",
      path: "/campaigns",
      section: "operate",
      children: [
        { label: "Ads", path: "/ads" },
        { label: "Ad creatives", path: "/ad-creatives" },
        { label: "Launch ads", path: "/ad-launches" },
        { label: "Other", path: "/other" },
      ],
    },
    { label: "Calendar", path: "/calendar", section: "operate" },
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

  it("uses the approved sectioned information architecture", () => {
    expect(WORKSPACE_NAV.map((item) => [item.section, item.label, item.path])).toEqual([
      ["operate", "Home", ""],
      ["operate", "Calendar", "/calendar"],
      ["operate", "Campaigns", "/campaigns"],
      ["operate", "Review", "/approvals"],
      ["grow", "Discover", "/discovery"],
      ["grow", "Audience", "/outbound"],
      ["grow", "Ads", "/ads"],
      ["grow", "Insights", "/insights"],
      ["foundations", "Brain", "/brain"],
      ["foundations", "Integrations", "/connectors"],
      ["library", "Create New", "/content"],
      ["workspace", "Settings", "/team"],
    ]);
  });

  it("houses related module pages under the workflow they belong to", () => {
    const campaigns = WORKSPACE_NAV.find((item) => item.label === "Campaigns");
    const review = WORKSPACE_NAV.find((item) => item.label === "Review");
    const settings = WORKSPACE_NAV.find((item) => item.label === "Settings");

    expect(campaigns?.children?.map((child) => child.path)).toEqual([
      "/campaigns",
      "/cadence",
      "/automation",
    ]);
    expect(review?.children?.map((child) => child.path)).toEqual([
      "/approvals",
      "/inbox",
    ]);
    expect(settings?.children?.map((child) => child.path)).toEqual([
      "/team",
      "/billing",
      "/notifications",
      "/activity",
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
      "Calendar",
      "Campaigns",
      "Review",
      "Discover",
      "Audience",
      "Brain",
      "Integrations",
      "Create New",
      "Settings",
    ]);
    expect(visible.find((item) => item.label === "Campaigns")?.children?.map((child) => child.path))
      .toEqual(["/campaigns", "/cadence", "/automation"]);
    expect(visible.find((item) => item.path === "/insights")).toBeUndefined();
    expect(visible.find((item) => item.label === "Ads")).toBeUndefined();
    expect(visible.find((item) => item.label === "Integrations")).toBeDefined();
    expect(visible.find((item) => item.label === "Billing")).toBeUndefined();
  });
});
