import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../app/workspaces/[id]/discovery/page.tsx", import.meta.url),
  "utf8",
);

function functionSource(name: string, nextName: string): string {
  const start = page.indexOf(`async function ${name}`);
  const end = page.indexOf(`async function ${nextName}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("discovery matching readiness UI", () => {
  it("shows founder-readable scoring states without exposing worker internals", () => {
    expect(page).toContain(
      'const matchingReady = item.matchingState === "ready";',
    );
    expect(page).toContain('"Scoring delayed — retry discovery"');
    expect(page).toContain(
      'item.matchingState === "pending" || item.matchingState === "running"',
    );
    expect(page).toContain('? "Scoring"');
    expect(page).toContain("item.matchingError");

    for (const internalField of [
      "matchingVersion",
      "matchingInputFingerprint",
      "matchingLeaseOwner",
      "matchingLeaseExpiresAt",
      "matchingHeartbeatAt",
      "cursorJson",
    ]) {
      expect(page).not.toContain(internalField);
    }
  });

  it("gates Accept on readiness while keeping Skip available", () => {
    expect(page).toContain("disabled={busy || !matchingReady}");
    expect(page).toMatch(
      /onClick=\{\(\) => triage\(item\.id, "skip"\)\}[\s\S]{0,180}disabled=\{busy\}|disabled=\{busy\}[\s\S]{0,180}onClick=\{\(\) => triage\(item\.id, "skip"\)\}/,
    );
  });

  it("surfaces the stable matching-not-ready response message", () => {
    const triage = functionSource("triage", "toggleDuplicates");
    expect(triage).toContain(
      "const body = await res.json().catch(() => null);",
    );
    expect(triage).toContain(
      "if (!res.ok) throw new Error(body?.message",
    );
    expect(triage).toContain(
      'setError(err instanceof Error ? err.message : "Triage failed")',
    );
  });

  it("distinguishes an overlapping tick and a safety-limited tick from an empty completion", () => {
    expect(page).toContain("runSummary.busy");
    expect(page).toContain("Discovery is already running");
    expect(page).toContain("runSummary.budgetExhausted");
    expect(page).toContain("safety budget");
    expect(page).toContain("Run finished:");
  });
});
