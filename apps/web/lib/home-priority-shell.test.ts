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

describe("Home inbox shell (Sprint 70)", () => {
  it("renders ranked feed items with canonical status and standard recovery actions", () => {
    expect(home).toContain("inboxItemView(item)");
    expect(home).toContain("WorkflowStatusBadge");
    expect(home).toContain("item.campaignId");
    expect(home).toContain("item.dueAt");
    expect(home).toContain("<ButtonLink");
    expect(home).toContain('variant="secondary"');
    expect(home).not.toContain("buttonStyles");
  });

  it("stacks the three lanes in the order the contract fixes", () => {
    expect(home).toContain("LANE_ORDER.map");
    expect(home).toContain("laneMeta(lane)");
    expect(home).toContain("feed.counts[lane]");
  });

  it("lets the founder answer a question without leaving Home", () => {
    // The ask lane is only worth building if answering is one click from
    // where the question is read.
    expect(home).toContain("AskCard");
    expect(home).toContain("/questions/${question.id}/answer");
    expect(home).toContain("answerOptions(question)");
    expect(home).toContain("Remember this for next time");
  });

  it("keeps the desktop queue readable without mobile-only layout rules", () => {
    expect(css).toContain(".priorityGrid");
    expect(css).toContain("minmax(280px, 1fr)");
    expect(css).not.toContain("@media (max-width");
  });
});
