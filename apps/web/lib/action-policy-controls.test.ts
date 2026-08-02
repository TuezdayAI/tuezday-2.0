import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { effectivePolicyWorkflowStatus } from "./external-actions";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const workspaceControl = read("app/workspaces/[id]/automation/action-policy.tsx");
const automationPage = read("app/workspaces/[id]/automation/page.tsx");
const campaignControl = read(
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx",
);
const campaignOverview = read(
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-overview.tsx",
);

describe("effectivePolicyWorkflowStatus", () => {
  it("maps effective policy onto the canonical badge vocabulary", () => {
    expect(effectivePolicyWorkflowStatus("human_required")).toBe("authorization_required");
    expect(effectivePolicyWorkflowStatus("autonomous")).toBe("active");
  });
});

describe("action policy controls source contract", () => {
  it("iterates the contract kind vocabulary without redeclaring it", () => {
    for (const source of [workspaceControl, campaignControl]) {
      expect(source).toContain("EXTERNAL_ACTION_KINDS");
      expect(source).toContain('from "@tuezday/contracts"');
      // No hand-rolled kind arrays — the contracts enum is the only vocabulary.
      expect(source).not.toMatch(/=\s*\[\s*"publish"/);
    }
  });

  it("fetches the policy routes independently of guardrails and plan data", () => {
    expect(workspaceControl).toContain("/external-action-policies?scope=workspace");
    expect(workspaceControl).not.toContain("/automation/settings");
    expect(campaignControl).toContain("/external-action-policies?scope=campaign");
    expect(campaignControl).not.toContain("/plan/workspace");
  });

  it("edits six concrete workspace defaults with no inherit option", () => {
    expect(workspaceControl).toContain('"autonomous"');
    expect(workspaceControl).toContain('"human_required"');
    expect(workspaceControl).not.toContain('"inherit"');
    expect(workspaceControl).toContain('scope: "workspace"');
    expect(workspaceControl).toContain('method: "PUT"');
    expect(workspaceControl).toContain("rules: EXTERNAL_ACTION_KINDS.map");
  });

  it("lets a campaign inherit through one complete optimistic replacement", () => {
    expect(campaignControl).toContain('"inherit"');
    expect(campaignControl).toContain('scope: "campaign"');
    expect(campaignControl).toContain('method: "PUT"');
    expect(campaignControl).toContain("expectedUpdatedAt: view.updatedAt");
    expect(campaignControl).toContain("rules: EXTERNAL_ACTION_KINDS.map");
    expect(campaignControl).not.toContain('method: "DELETE"');
  });

  it("shows effective badges and read-only contributing constraints", () => {
    for (const source of [workspaceControl, campaignControl]) {
      expect(source).toContain("WorkflowStatusBadge");
      expect(source).toContain("effectivePolicyWorkflowStatus");
    }
    expect(campaignControl).toContain("contributingRules");
  });

  it("announces saves and errors politely", () => {
    for (const source of [workspaceControl, campaignControl]) {
      expect(source).toContain('aria-live="polite"');
    }
  });

  it("separates automation cadence from action permission in plain language", () => {
    expect(workspaceControl).toMatch(/cadence/i);
    expect(workspaceControl).toMatch(/permission/i);
    expect(campaignControl).toMatch(/cadence/i);
    expect(campaignControl).toMatch(/permission/i);
  });

  // Sprint 52 (D2b) — the collapsed publish gate is a built-in meaning of
  // `human_required`, not a third policy value. The editor has to say so, or
  // the default is hidden behavior.
  it("explains what human required means for publish, without adding a policy value", () => {
    expect(workspaceControl).toContain('kind === "publish"');
    expect(workspaceControl).toContain('draft[kind] === "human_required"');
    expect(workspaceControl).toContain("approving a draft on");
    expect(workspaceControl).toContain("also authorizes its publication");
    expect(workspaceControl).toMatch(/re-arms that second gate/);
    expect(workspaceControl).toMatch(/only your own approval counts/);
    // Still exactly two options — no `collapsed`/`auto` rule was invented.
    expect(workspaceControl).not.toMatch(/<option value="(?!human_required|autonomous)/);
  });

  it("is mounted on the automation page and the campaign overview", () => {
    expect(automationPage).toContain("<ActionPolicy");
    expect(campaignOverview).toContain("<CampaignActionPolicy");
  });
});
