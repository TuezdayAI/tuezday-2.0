import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceLayout = readFileSync(
  new URL("../app/workspaces/[id]/layout.tsx", import.meta.url),
  "utf8",
);
const topBar = readFileSync(new URL("../src/components/top-bar.tsx", import.meta.url), "utf8");
const brainPage = readFileSync(
  new URL("../app/workspaces/[id]/brain/page.tsx", import.meta.url),
  "utf8",
);
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("workspace shell contract", () => {
  it("renders navigation section boundaries from contract metadata", () => {
    expect(workspaceLayout).toContain("NAV_SECTIONS");
    expect(workspaceLayout).toContain("data-section-start");
    expect(workspaceLayout).toContain("data-section-label");
    expect(globals).toContain('.ws-nav-group[data-section-start="true"]::before');
  });

  it("keeps Create New globally available", () => {
    expect(topBar).toContain("Create New");
    expect(topBar).toContain("/content");
  });

  it("provides a stable Content Preferences deep-link target", () => {
    expect(brainPage).toContain('id="content-preferences"');
    expect(globals).toContain("scroll-margin-top: 72px");
  });
});
