import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const resultsTab = readFileSync(
  new URL(
    "../app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx",
    import.meta.url,
  ),
  "utf8",
);
const campaignPage = readFileSync(
  new URL("../app/workspaces/[id]/campaigns/[campaignId]/page.tsx", import.meta.url),
  "utf8",
);
const launchesPage = readFileSync(
  new URL("../app/workspaces/[id]/launches/page.tsx", import.meta.url),
  "utf8",
);

describe("execution results shell contract", () => {
  it("renders results through the shared view model and canonical badge", () => {
    expect(resultsTab).toContain("executionWorkflowStatus(");
    expect(resultsTab).toContain("WorkflowStatusBadge");
    expect(resultsTab).toContain("destinationSummary(");
    expect(resultsTab).toContain("EXECUTION_KIND_LABELS");
  });

  it("fetches the unified projection scoped to the campaign", () => {
    expect(resultsTab).toContain("/executions?campaign=");
  });

  it("offers recovery through the existing publication retry route", () => {
    expect(resultsTab).toContain("/retry");
    expect(resultsTab).toContain("executionTargetHref(");
  });

  it("mounts Results as a campaign workspace tab", () => {
    expect(campaignPage).toContain('["results", "Results"]');
    expect(campaignPage).toContain("CampaignResults");
  });

  it("supports the launch deep link the results tab targets", () => {
    expect(launchesPage).toContain('searchParams.get("launch")');
  });
});
