import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("campaign workspace source contract", () => {
  it("links inventory cards into a campaign workspace", () => {
    const card = read("app/workspaces/[id]/campaigns/_components/campaign-card.tsx");
    expect(card).toContain("/campaigns/${campaign.id}");
    expect(card).toContain("WorkflowStatusBadge");
    expect(card).toContain("configurationIssueCount");
  });

  it("preserves campaign creation, automation, archive, and settings from the inventory", () => {
    const page = read("app/workspaces/[id]/campaigns/page.tsx");
    expect(page).toContain("CampaignForm");
    expect(page).toContain("CampaignCard");
    expect(page).toContain("saveAutomation");
    expect(page).toContain("setStatus");
    expect(page).toContain("SettingsModal");
    expect(page).toContain("/plan/summary");
  });

  it("defines the focused campaign workspace tabs", () => {
    const page = read("app/workspaces/[id]/campaigns/[campaignId]/page.tsx");
    expect(page).toContain('"overview"');
    expect(page).toContain('"plan"');
    expect(page).toContain('"channels"');
    expect(page).toContain("/plan/workspace");
  });

  it("creates and activates immutable plan revisions", () => {
    const history = read(
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx",
    );
    const page = read("app/workspaces/[id]/campaigns/[campaignId]/page.tsx");
    expect(history).toContain("Plan history");
    expect(history).toContain("WorkflowStatusBadge");
    expect(page).toContain("/plan/revisions");
    expect(page).toContain("/activate");
  });

  it("configures campaign channels only through draft lane revisions", () => {
    const channels = read(
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx",
    );
    const laneForm = read(
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-lane-form.tsx",
    );
    expect(channels).toContain("formatLaneSchedule");
    expect(channels).toContain("Create a plan revision to edit channels");
    expect(laneForm).toContain("UpsertCampaignLaneRevisionInput");
    expect(laneForm).toContain("publishingConnectionId");
  });
});
