import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "app/workspaces/[id]/campaigns/page.tsx",
  "app/workspaces/[id]/campaigns/_components/campaign-card.tsx",
  "app/workspaces/[id]/campaigns/_components/campaign-form.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/page.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-action-policy.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-channels.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-lane-form.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-form.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-plan-history.tsx",
  "app/workspaces/[id]/campaigns/[campaignId]/_components/campaign-results.tsx",
  "app/workspaces/[id]/ad-creatives/page.tsx",
  "app/workspaces/[id]/ad-launches/page.tsx",
  "app/workspaces/[id]/ads/page.tsx",
  "app/workspaces/[id]/discovery/page.tsx",
  "app/workspaces/[id]/insights/page.tsx",
] as const;

const sources = Object.fromEntries(
  FILES.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]),
) as Record<(typeof FILES)[number], string>;

describe("desktop campaign and growth actions", () => {
  it("uses shared semantic actions without legacy command patterns", () => {
    for (const file of FILES) {
      const source = sources[file];
      expect(source, file).not.toMatch(/buttonStyles\.|link-button|button-secondary/);
      expect(source, file).not.toMatch(/<Button\b[^>]*\bsize="(?:sm|md)"/s);
      expect(source, file).not.toContain('variant="ghost"');
      expect(source, file).not.toContain("<button");
      expect(source, file).not.toContain('from "lucide-react"');
    }
  });

  it("keeps refined risk and mutation icons adjacent to their labels", () => {
    expect(sources["app/workspaces/[id]/campaigns/[campaignId]/page.tsx"]).toContain(
      'name="campaign-risk"',
    );
    const launches = sources["app/workspaces/[id]/ad-launches/page.tsx"];
    expect(launches).toContain('name="budget"');
    expect(launches).toContain('name="targeting"');
    expect(launches).toContain('"authorize"');
    expect(sources["app/workspaces/[id]/discovery/page.tsx"]).toContain('name="signal"');
  });

  it("makes irreversible launch and source deletion explicit", () => {
    const launches = sources["app/workspaces/[id]/ad-launches/page.tsx"];
    const discovery = sources["app/workspaces/[id]/discovery/page.tsx"];
    expect(launches).toContain('variant="danger"');
    expect(launches).toContain('Delete ad launch "${launch.name}"?');
    expect(discovery).toContain('variant="danger"');
    expect(discovery).toContain('Delete source "${source.name}"?');
  });
});
