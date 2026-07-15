import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  policyConflictCopy,
  tighteningPolicyDirty,
  tighteningPolicyDraft,
} from "./external-actions";
import type { ExternalActionPolicyView } from "@tuezday/contracts";

const component = readFileSync(
  new URL("../src/components/scoped-action-policy.tsx", import.meta.url),
  "utf8",
);
const helpers = readFileSync(new URL("./external-actions.ts", import.meta.url), "utf8");

describe("tightening scoped action policy", () => {
  const view = {
    scope: "persona",
    scopeId: "11111111-1111-4111-8111-111111111111",
    scopeLabel: "Founder",
    rules: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        workspaceId: "33333333-3333-4333-8333-333333333333",
        scope: "persona",
        scopeId: "11111111-1111-4111-8111-111111111111",
        actionKind: "publish",
        rule: "human_required",
        createdBy: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    effective: [],
    updatedAt: 2,
  } satisfies ExternalActionPolicyView;

  it("owns a reusable conflict-safe editor and pure draft helpers", () => {
    expect(component).toContain("export function ScopedActionPolicy");
    expect(helpers).toContain("export function tighteningPolicyDraft");
    expect(helpers).toContain("export function tighteningPolicyDirty");
    expect(helpers).toContain("export function policyConflictCopy");
    expect(component).toContain("expectedUpdatedAt: view.updatedAt");
  });

  it("only exposes inherit and human-required choices", () => {
    expect(component).toContain('<option value="inherit">');
    expect(component).toContain('<option value="human_required">');
    expect(component).not.toContain('<option value="autonomous">');
  });

  it("derives and compares all six tightening-only choices", () => {
    const draft = tighteningPolicyDraft(view);
    expect(draft.publish).toBe("human_required");
    expect(draft.paid_launch).toBe("inherit");
    expect(tighteningPolicyDirty(view, draft)).toBe(false);
    expect(tighteningPolicyDirty(view, { ...draft, send: "human_required" })).toBe(true);
    expect(policyConflictCopy()).toContain("changed in another editor");
  });

  it("preserves attempted changes when another editor wins", () => {
    expect(component).toContain("Reload current policy");
    expect(component).toContain("Your attempted setting");
    expect(component).toContain("Current saved setting");
    expect(component).toContain('aria-live="polite"');
  });
});
