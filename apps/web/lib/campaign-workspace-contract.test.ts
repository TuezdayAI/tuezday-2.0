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
    expect(page).toContain("pendingCampaignIds.has(campaign.id)");
    const card = read("app/workspaces/[id]/campaigns/_components/campaign-card.tsx");
    expect(card).toContain("disabled={busy}");
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

  // Sprint 53 Task 5 — the plan form previews what the LLM will actually see
  // for the revision being edited, not for the already-active one.
  it("previews the resolved context for the unsaved plan draft", () => {
    const form = read(
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx",
    );
    // The preview resolves the in-progress values, inline, through /resolve.
    expect(form).toContain("/resolve");
    expect(form).toContain("campaignPlanDraft");
    expect(form).toContain("planDraft()");
    // Whole bundle, not just the plan section — budget pressure has to be visible.
    expect(form).toContain("ContextSectionsTrace");
    expect(form).toContain("bundle.overBudget");
    expect(form).toContain("includedTokens");
    // Task type and channel are pickable, with a default that resolves.
    expect(form).toContain('useState<TaskType>("linkedin_post")');
    expect(form).toContain('useState<Channel>("linkedin")');
    expect(form).toContain("TASK_TYPES.map");
    expect(form).toContain("CHANNELS.map");
    // The preview button must not submit the surrounding form.
    expect(form).toContain('type="button"');
  });

  /**
   * Sprint 53 review (C1) — no dead inputs.
   *
   * Once a campaign has an active plan revision, its row's objective / KPI /
   * timeframe / audience / pillars stop reaching any prompt: the overlay is
   * free text and the resolver reads the plan. Leaving those five editable in
   * the campaign wizard would let the founder type strategy, save it, and have
   * the model never see it. In that state they are read-only and say where
   * strategy is actually edited.
   */
  it("stops presenting the row's strategy columns as editable once a plan exists", () => {
    const form = read("app/workspaces/[id]/campaigns/_components/campaign-form.tsx");
    expect(form).toContain("const planManaged = Boolean(campaign?.currentPlanRevisionId)");
    // All five, read-only, in whichever wizard step they live.
    expect(form.match(/readOnly=\{planManaged\}/g)).toHaveLength(5);
    expect(form.match(/aria-readonly=\{planManaged\}/g)).toHaveLength(5);
    expect(form).toContain('managedLabel("Objective")');
    expect(form).toContain('managedLabel("KPI")');
    expect(form).toContain('managedLabel("Timeframe")');
    expect(form).toContain('managedLabel("Audience")');
    expect(form).toContain('managedLabel("Messaging pillars")');
    // And it points at the place strategy is really edited.
    expect(form).toContain("?tab=plan");
    expect(form).toContain("Edit the campaign plan");
    expect(form).toContain("planManagedNote");
  });

  it("gives the plan form the ids its preview needs", () => {
    const history = read(
      "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx",
    );
    const page = read("app/workspaces/[id]/campaigns/[campaignId]/page.tsx");
    expect(history).toContain("workspaceId={workspaceId}");
    expect(history).toContain("campaignId={campaignId}");
    expect(page).toContain("<CampaignPlanHistory");
    expect(page).toContain("workspaceId={id}");
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
