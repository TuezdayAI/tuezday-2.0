import { describe, expect, it } from "vitest";
import { ICON_REGISTRY, ICON_NAMES } from "../src/components/ui/icon";
import { BRAND_ICONS } from "../src/components/ui/brand-icons";
import { WORKSPACE_NAV } from "@tuezday/contracts";

// The spec §4 vocabulary — nav, content types, status, brain docs, actions.
const REQUIRED: string[] = [
  // nav groups
  "home", "calendar", "campaigns", "review", "discover", "audience", "ad",
  "status-learning", "brain", "connect", "create", "settings",
  // content types
  "email", "post", "blog", "ad", "carousel",
  // status
  "status-review", "status-live", "status-generating", "status-approved", "status-rejected", "status-learning",
  // brain docs
  "doc-soul", "doc-icp", "doc-voice", "doc-history", "doc-now",
  // actions
  "approve", "reject", "edit", "regenerate", "connect", "module-settings",
  // common UI
  "calendar", "search", "add", "close", "chevron-right", "chevron-down", "external", "user", "notification", "warning", "info",
];

describe("icon registry", () => {
  it("contains every vocabulary name", () => {
    for (const name of REQUIRED) {
      expect(ICON_REGISTRY[name as keyof typeof ICON_REGISTRY], name).toBeDefined();
    }
  });

  it("ICON_NAMES matches the registry keys exactly", () => {
    expect(ICON_NAMES.slice().sort()).toEqual(Object.keys(ICON_REGISTRY).sort());
  });

  it("bundles the seven brand marks", () => {
    expect(Object.keys(BRAND_ICONS).sort()).toEqual(
      ["freshsales", "google", "instagram", "linkedin", "meta", "reddit", "x"].sort(),
    );
    for (const path of Object.values(BRAND_ICONS)) {
      expect(path.length).toBeGreaterThan(20); // real path data, not a stub
    }
  });
});

describe("nav icon coverage", () => {
  it("every nav icon name resolves in the registry", () => {
    for (const item of WORKSPACE_NAV) {
      expect(ICON_REGISTRY[item.icon as keyof typeof ICON_REGISTRY], item.label).toBeDefined();
      for (const child of item.children ?? []) {
        expect(ICON_REGISTRY[child.icon as keyof typeof ICON_REGISTRY], child.label).toBeDefined();
      }
    }
  });
});
