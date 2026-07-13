import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const calendarPage = readFileSync(
  new URL("../app/workspaces/[id]/calendar/page.tsx", import.meta.url),
  "utf8",
);
const campaignOverview = readFileSync(
  new URL(
    "../app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-overview.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("calendar workspace shell contract", () => {
  it("drives view, density, and scope from the URL through the shared parsers", () => {
    expect(calendarPage).toContain("calendarView(");
    expect(calendarPage).toContain("calendarDensity(");
    expect(calendarPage).toContain('searchParams.get("campaign")');
    expect(calendarPage).toContain('searchParams.get("channel")');
  });

  it("renders both time views from the shared date helpers", () => {
    expect(calendarPage).toContain("weekDays(");
    expect(calendarPage).toContain("monthGrid(");
    expect(calendarPage).toContain("rangeFor(");
    expect(calendarPage).toContain("shiftAnchor(");
  });

  it("speaks the canonical status vocabulary and keeps slots unbadged", () => {
    expect(calendarPage).toContain("WorkflowStatusBadge");
    expect(calendarPage).toContain("entryWorkflowStatus(");
    expect(calendarPage).toContain("Open slot");
  });

  it("mounts the detail panel with the existing recovery routes", () => {
    expect(calendarPage).toContain("DetailPanel");
    expect(calendarPage).toContain("/retry");
    expect(calendarPage).toContain('{ method: "DELETE" }');
  });

  it("links generated work awaiting review into the Review workspace", () => {
    expect(calendarPage).toContain("state=pending_review");
    expect(calendarPage).toContain("reviewHref(");
  });

  it("scopes the campaign workspace's Calendar link through the shared builder", () => {
    expect(campaignOverview).toContain("calendarHref(");
    expect(campaignOverview).toContain("campaign: campaign.id");
  });
});
