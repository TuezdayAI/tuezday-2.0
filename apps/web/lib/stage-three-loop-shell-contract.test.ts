import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const home = read("app/workspaces/[id]/page.tsx");
const authorizations = read(
  "app/workspaces/[id]/review/_components/authorizations-queue.tsx",
);
const editor = read("app/workspaces/[id]/review/_components/conversational-editor.tsx");
const calendar = read("app/workspaces/[id]/calendar/page.tsx");
const results = read(
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx",
);

describe("Stage 3 operating loop shell contract", () => {
  it("drives Home from the ranked priority projection and its exact recovery links", () => {
    expect(home).toContain("/priorities");
    expect(home).toContain("priorityView(");
    expect(home).toContain("priorityQueueState(");
    expect(home).toContain("priority.href");
    expect(home).toContain("WorkflowStatusBadge");
    expect(home).not.toContain("const PRIORITY_STATUS");
  });

  it("carries authorization state from Review into Calendar recovery", () => {
    expect(authorizations).toContain("/external-actions/");
    expect(authorizations).toContain('decision: "authorize" | "deny"');
    expect(calendar).toContain("externalActionId");
    expect(calendar).toContain("calendarRecoveryLabel(");
    expect(calendar).toContain('tab: "authorizations"');
  });

  it("keeps editor authorization separate and link-only", () => {
    expect(editor).toContain("actionAuthorizationHref");
    expect(editor).toContain("Open authorization");
    expect(editor).not.toMatch(/external-actions\/[^\"]*\/(authorize|deny)/);
  });

  it("links Calendar context to campaign results and results back to governing actions", () => {
    expect(calendar).toContain("?tab=results");
    expect(results).toContain("executionAuthorizationLink(");
    expect(results).toContain("actionLink.label");
  });

  it("uses canonical badges instead of local workflow vocabularies", () => {
    for (const source of [home, calendar, results]) {
      expect(source).toContain("WorkflowStatusBadge");
    }
    expect(calendar).toContain("entryWorkflowStatus(");
    expect(results).toContain("executionWorkflowStatus(");
  });
});
