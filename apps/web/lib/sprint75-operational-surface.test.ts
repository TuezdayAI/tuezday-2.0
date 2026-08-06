import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("Sprint 75 operational settings surfaces", () => {
  it("exposes the independent reply budget with account-local copy", () => {
    const source = read("app/workspaces/[id]/automation/guardrails.tsx");
    expect(source).toContain("loaded.perConnectionReplyDailyCap");
    expect(source).toContain("patch({ perConnectionReplyDailyCap: v })");
    expect(source).toContain("Maximum automation per account-local day");
    expect(source).toContain("Replies / account / day");
  });

  it("lets a founder update each social account's IANA timezone", () => {
    const source = read("app/workspaces/[id]/connectors/page.tsx");
    expect(source).toContain("async function saveTimezone");
    expect(source).toContain("body: JSON.stringify({ timezone: value })");
    expect(source).toContain("defaultValue={connection.timezone}");
    expect(source).toContain("budgets reset at this account&apos;s local midnight");
  });
});
