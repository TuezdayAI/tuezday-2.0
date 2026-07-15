import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("campaign lane policy ownership", () => {
  it("mounts policy editors only for active lane revisions", () => {
    expect(source).toContain("ScopedActionPolicy");
    expect(source).toContain('scope="lane"');
    expect(source).toContain("scopeId={lane.id}");
    expect(source).toContain("active?.lanes");
    expect(source).toContain("policyLaneId === lane.id");
  });

  it("keeps plan revisions immutable while allowing a separate tightening rule", () => {
    expect(source).toContain("active plan is immutable");
    expect(source).toMatch(/can only\s+tighten workspace and campaign permission/);
    expect(source).toContain("Action permission for this lane");
  });
});
