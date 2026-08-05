import { describe, expect, it } from "vitest";
import {
  DELIVERABLE_DECISION_ACTIONS,
  DELIVERABLE_PRODUCTION_STATUSES,
  DELIVERABLE_TRANSITIONS,
  VARIANT_STATUSES,
  VARIANT_TRANSITIONS,
  canTransitionDeliverable,
  canTransitionVariant,
  deliverableDecisionInputSchema,
  transitionDeliverable,
  transitionVariant,
} from "../src/index.js";

describe("deliverable production state machine (activated Sprint 63)", () => {
  it("walks the happy path: planned → ready → generating → candidate_ready → fulfilled", () => {
    expect(transitionDeliverable("planned", "ready")).toBe("ready");
    expect(transitionDeliverable("ready", "generating")).toBe("generating");
    expect(transitionDeliverable("generating", "candidate_ready")).toBe("candidate_ready");
    expect(transitionDeliverable("candidate_ready", "fulfilled")).toBe("fulfilled");
  });

  it("returns a failed generation to ready and allows regeneration", () => {
    expect(canTransitionDeliverable("generating", "ready")).toBe(true);
    expect(canTransitionDeliverable("candidate_ready", "generating")).toBe(true);
  });

  it("keeps fulfilled history immutable: fulfilled and cancelled are terminal", () => {
    for (const to of DELIVERABLE_PRODUCTION_STATUSES) {
      expect(canTransitionDeliverable("fulfilled", to)).toBe(false);
      expect(canTransitionDeliverable("cancelled", to)).toBe(false);
    }
  });

  it("lets planned and ready slots go stale, but never a fulfilled one", () => {
    expect(canTransitionDeliverable("planned", "stale")).toBe(true);
    expect(canTransitionDeliverable("ready", "stale")).toBe(true);
    expect(canTransitionDeliverable("candidate_ready", "stale")).toBe(true);
    // In-flight generation finishes before staleness applies (D-63.10).
    expect(canTransitionDeliverable("generating", "stale")).toBe(false);
  });

  it("declares a transition row for every status", () => {
    for (const status of DELIVERABLE_PRODUCTION_STATUSES) {
      expect(DELIVERABLE_TRANSITIONS[status]).toBeDefined();
    }
    expect(new Set(DELIVERABLE_DECISION_ACTIONS).size).toBe(
      DELIVERABLE_DECISION_ACTIONS.length,
    );
  });
});

describe("variant state machine", () => {
  it("moves a candidate to selected or superseded, both terminal", () => {
    expect(transitionVariant("candidate", "selected")).toBe("selected");
    expect(transitionVariant("candidate", "superseded")).toBe("superseded");
    for (const to of VARIANT_STATUSES) {
      expect(canTransitionVariant("selected", to)).toBe(false);
      expect(canTransitionVariant("superseded", to)).toBe(false);
    }
  });

  it("declares a transition row for every status", () => {
    for (const status of VARIANT_STATUSES) {
      expect(VARIANT_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe("deliverableDecisionInputSchema", () => {
  it("requires a variant to select and a reason to cancel", () => {
    expect(deliverableDecisionInputSchema.safeParse({ action: "select" }).success).toBe(false);
    expect(
      deliverableDecisionInputSchema.safeParse({
        action: "select",
        variantId: "6b2f2e6a-9df1-4f57-9df9-b8f1f5f6a111",
      }).success,
    ).toBe(true);
    expect(deliverableDecisionInputSchema.safeParse({ action: "cancel" }).success).toBe(false);
    expect(
      deliverableDecisionInputSchema.safeParse({ action: "cancel", reason: "slot dropped" })
        .success,
    ).toBe(true);
    expect(deliverableDecisionInputSchema.safeParse({ action: "regenerate" }).success).toBe(true);
  });
});
