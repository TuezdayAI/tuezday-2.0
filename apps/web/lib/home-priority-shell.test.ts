import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const home = readFileSync(
  new URL("../app/workspaces/[id]/page.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../app/workspaces/[id]/home-hero.module.css", import.meta.url),
  "utf8",
);

describe("Home priority shell", () => {
  it("renders ranked priorities with canonical status and standard recovery actions", () => {
    expect(home).toContain("priorityView(priority)");
    expect(home).toContain("WorkflowStatusBadge");
    expect(home).toContain("priority.campaignId");
    expect(home).toContain("priority.dueAt");
    expect(home).toContain("<ButtonLink");
    expect(home).toContain('variant="secondary"');
    expect(home).not.toContain("buttonStyles");
  });

  it("keeps the desktop queue readable without mobile-only layout rules", () => {
    expect(css).toContain(".priorityGrid");
    expect(css).toContain("minmax(280px, 1fr)");
    expect(css).not.toContain("@media (max-width");
  });
});
