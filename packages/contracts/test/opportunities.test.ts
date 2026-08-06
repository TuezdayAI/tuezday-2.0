import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_DECISION_TARGETS,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TRANSITIONS,
  canTransitionOpportunity,
  opportunityDecisionInputSchema,
  transitionOpportunity,
} from "../src/index.js";

describe("opportunity lifecycle state machine", () => {
  it("disposes a candidate by policy only", () => {
    expect(canTransitionOpportunity("candidate", "auto_qualified")).toBe(true);
    expect(canTransitionOpportunity("candidate", "needs_review")).toBe(true);
    expect(canTransitionOpportunity("candidate", "watchlisted")).toBe(true);
    expect(canTransitionOpportunity("candidate", "dismissed")).toBe(true);
    expect(canTransitionOpportunity("candidate", "qualified")).toBe(false);
    expect(canTransitionOpportunity("candidate", "package_created")).toBe(false);
  });

  it("lets operators qualify from review states and override qualifications", () => {
    expect(transitionOpportunity("needs_review", "qualified")).toBe("qualified");
    expect(transitionOpportunity("watchlisted", "qualified")).toBe("qualified");
    expect(transitionOpportunity("auto_qualified", "dismissed")).toBe("dismissed");
    expect(transitionOpportunity("qualified", "dismissed")).toBe("dismissed");
    // Policy qualification is never an operator target.
    expect(canTransitionOpportunity("needs_review", "auto_qualified")).toBe(false);
  });

  it("keeps dismissal reversible but terminal states final", () => {
    expect(canTransitionOpportunity("dismissed", "needs_review")).toBe(true);
    for (const to of OPPORTUNITY_STATUSES) {
      expect(canTransitionOpportunity("expired", to)).toBe(false);
      expect(canTransitionOpportunity("superseded", to)).toBe(false);
      expect(canTransitionOpportunity("package_created", to)).toBe(false);
    }
  });

  it("expires and supersedes every undecided or qualified state", () => {
    for (const from of [
      "candidate",
      "auto_qualified",
      "qualified",
      "needs_review",
      "watchlisted",
    ] as const) {
      expect(canTransitionOpportunity(from, "expired")).toBe(true);
      expect(canTransitionOpportunity(from, "superseded")).toBe(true);
    }
    expect(canTransitionOpportunity("dismissed", "expired")).toBe(false);
  });

  it("reserves package_created for qualified opportunities (Sprint 62)", () => {
    expect(canTransitionOpportunity("auto_qualified", "package_created")).toBe(true);
    expect(canTransitionOpportunity("qualified", "package_created")).toBe(true);
    expect(canTransitionOpportunity("needs_review", "package_created")).toBe(false);
  });

  it("maps every decision action to a reachable target", () => {
    for (const target of Object.values(OPPORTUNITY_DECISION_TARGETS)) {
      expect(OPPORTUNITY_STATUSES).toContain(target);
    }
    // Every non-terminal status appears as a transition source.
    for (const status of OPPORTUNITY_STATUSES) {
      expect(OPPORTUNITY_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe("opportunityDecisionInputSchema", () => {
  it("requires a reason to dismiss or reopen", () => {
    expect(opportunityDecisionInputSchema.safeParse({ action: "dismiss" }).success).toBe(false);
    expect(opportunityDecisionInputSchema.safeParse({ action: "reopen" }).success).toBe(false);
    expect(
      opportunityDecisionInputSchema.safeParse({ action: "dismiss", reason: "off-topic" })
        .success,
    ).toBe(true);
    expect(opportunityDecisionInputSchema.safeParse({ action: "qualify" }).success).toBe(true);
    expect(opportunityDecisionInputSchema.safeParse({ action: "watch" }).success).toBe(true);
  });
});
