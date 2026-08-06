import { describe, expect, it } from "vitest";
import type { Variant } from "@tuezday/contracts";
import {
  actionsFor,
  canGenerateNow,
  latestVariant,
  selectableVariants,
  slotLabel,
} from "./deliverable-view";

function variant(variantVersion: number, status: Variant["status"] = "candidate"): Variant {
  return {
    id: `00000000-0000-4000-8000-00000000000${variantVersion}`,
    deliverableId: "00000000-0000-4000-8000-000000000010",
    variantVersion,
    contextSnapshotId: "00000000-0000-4000-8000-000000000020",
    status,
    content: `Variant ${variantVersion}`,
    model: "m",
    provider: "p",
    durationMs: 1,
    createdByUserId: null,
    selectedAt: null,
    createdAt: variantVersion,
  };
}

describe("latestVariant", () => {
  it("picks the highest version regardless of order", () => {
    expect(latestVariant([variant(1), variant(3), variant(2)])?.variantVersion).toBe(3);
    expect(latestVariant([])).toBeUndefined();
  });
});

describe("selectableVariants", () => {
  it("keeps only candidates, newest first", () => {
    const list = selectableVariants([
      variant(1, "superseded"),
      variant(2),
      variant(3, "selected"),
      variant(4),
    ]);
    expect(list.map((entry) => entry.variantVersion)).toEqual([4, 2]);
  });
});

describe("slotLabel", () => {
  it("labels reactive deliverables and formats planned slots", () => {
    expect(slotLabel({ kind: "reactive", originalScheduledFor: null })).toBe("Reactive");
    expect(slotLabel({ kind: "planned", originalScheduledFor: null })).toBe("Reactive");
    const label = slotLabel({
      kind: "planned",
      originalScheduledFor: Date.UTC(2026, 0, 6, 4, 30),
    });
    expect(label.length).toBeGreaterThan(4);
  });
});

describe("canGenerateNow", () => {
  it("requires a package and a pending queue on an eligible status", () => {
    expect(
      canGenerateNow({ status: "ready", generationState: "pending", packageId: "x" }),
    ).toBe(true);
    expect(
      canGenerateNow({
        status: "candidate_ready",
        generationState: "pending",
        packageId: "x",
      }),
    ).toBe(true);
    expect(
      canGenerateNow({ status: "ready", generationState: "pending", packageId: null }),
    ).toBe(false);
    expect(
      canGenerateNow({ status: "ready", generationState: "failed", packageId: "x" }),
    ).toBe(false);
    expect(
      canGenerateNow({ status: "planned", generationState: "pending", packageId: null }),
    ).toBe(false);
  });
});

describe("actionsFor", () => {
  it("offers machine-legal actions per status", () => {
    expect(actionsFor({ status: "planned", packageId: null })).toEqual(["cancel"]);
    expect(actionsFor({ status: "ready", packageId: "x" })).toEqual([
      "regenerate",
      "cancel",
    ]);
    expect(actionsFor({ status: "candidate_ready", packageId: "x" })).toEqual([
      "regenerate",
      "select",
      "cancel",
    ]);
    expect(actionsFor({ status: "fulfilled", packageId: "x" })).toEqual([]);
    expect(actionsFor({ status: "cancelled", packageId: null })).toEqual([]);
  });
});
