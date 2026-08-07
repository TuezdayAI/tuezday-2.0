import { describe, expect, it } from "vitest";
import {
  approvalDecisionSchema,
  findingsOutputSchema,
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  rejectDraftInputSchema,
} from "../src/index";

describe("grounded critic contract (Sprint 66)", () => {
  it("requires a citation on every finding", () => {
    const cited = findingsOutputSchema.safeParse({
      score: 55,
      findings: [{ issue: "Opens with a pitch", citation: "Guardrail: never open with a CTA" }],
    });
    expect(cited.success).toBe(true);

    const uncited = findingsOutputSchema.safeParse({
      score: 55,
      findings: [{ issue: "Opens with a pitch" }],
    });
    expect(uncited.success).toBe(false);

    const empty = findingsOutputSchema.safeParse({
      score: 55,
      findings: [{ issue: "Opens with a pitch", citation: "" }],
    });
    expect(empty.success).toBe(false);
  });

  it("keeps the score — the engine's revise-loop control signal", () => {
    expect(findingsOutputSchema.safeParse({ findings: [] }).success).toBe(false);
  });

  it("arms the reference critique step with the full retrieval set", () => {
    const critique = REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps.find((s) => s.key === "critique")!;
    expect(critique.tools).toEqual([
      "find_similar_approved_drafts",
      "find_instructive_rejections",
      "list_channel_guardrails",
      "get_campaign_plan",
      "list_recent_publications_with_metrics",
      "get_brain_section",
    ]);
    expect(critique.maxSteps).toBe(6);
    expect(critique.goal).toContain("Retrieve before you judge");
    expect(critique.goal).toContain("cite");
  });

  it("keeps the bounded revise loop at max 2 iterations", () => {
    const revise = REFERENCE_SIGNAL_SOCIAL_POST_SPEC.steps.find((s) => s.key === "revise")!;
    expect(revise.loop).toEqual({ scoreFrom: "critique", threshold: 70, maxIterations: 2 });
  });
});

describe("reject reason contract (Sprint 66)", () => {
  it("accepts an optional trimmed reason and rejects blank or oversized ones", () => {
    expect(rejectDraftInputSchema.parse({})).toEqual({});
    expect(rejectDraftInputSchema.parse({ reason: "  too salesy  " }).reason).toBe("too salesy");
    expect(rejectDraftInputSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(rejectDraftInputSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });

  it("carries the reason on approval decisions, null when not given", () => {
    const decision = approvalDecisionSchema.parse({
      id: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b11",
      draftId: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b12",
      workspaceId: "6a1f8f6e-8a4e-4e21-9a63-0dfc1f2a2b13",
      action: "reject",
      fromState: "pending_review",
      toState: "rejected",
      contentSnapshot: null,
      contentFingerprint: null,
      actor: "founder",
      actorId: null,
      reason: "Wrong audience for this channel",
      createdAt: 1,
    });
    expect(decision.reason).toBe("Wrong audience for this channel");
    expect(
      approvalDecisionSchema.safeParse({ ...decision, reason: null }).success,
    ).toBe(true);
  });
});
