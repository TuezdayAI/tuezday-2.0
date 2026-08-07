import { describe, expect, it } from "vitest";
import {
  EXTRACTION_MAX_RULES,
  PREFERENCE_ACTIVATE_CONFIDENCE,
  PREFERENCE_EDIT_SOURCES,
  PREFERENCE_MAX_TOKENS,
  PREFERENCE_MERGE_DISTANCE,
  PREFERENCE_MIN_EDIT_DISTANCE,
  PREFERENCE_RULE_LIMIT,
  PREFERENCE_RULE_MAX_CHARS,
  PREFERENCE_RULE_ORIGINS,
  PREFERENCE_RULE_STATUSES,
  PROMOTE_MIN_CONFIDENCE,
  PROMOTE_MIN_OBSERVATIONS,
  RETIRE_AFTER_MS,
  createPreferenceRuleInputSchema,
  preferenceExtractionSchema,
  preferenceRuleSchema,
  updatePreferenceRuleInputSchema,
} from "../src/index";

describe("preference memory contracts (Sprint 68)", () => {
  it("names the two capture sources and the five rule statuses", () => {
    expect([...PREFERENCE_EDIT_SOURCES]).toEqual(["draft_edit", "editor_turn"]);
    expect([...PREFERENCE_RULE_STATUSES]).toEqual([
      "candidate",
      "active",
      "disabled",
      "promoted",
      "retired",
    ]);
    // Sprint 70 added a third origin: a rule the founder chose to keep while
    // answering an agent's question.
    expect([...PREFERENCE_RULE_ORIGINS]).toEqual(["extracted", "manual", "answered_question"]);
  });

  it("caps a rule at one line and injects only a handful", () => {
    expect(PREFERENCE_RULE_MAX_CHARS).toBe(160);
    expect(PREFERENCE_RULE_LIMIT).toBeLessThanOrEqual(10);
    // The section's own budget has to be small enough to be a rounding error
    // against a bundle budget, or "their own budget" means nothing.
    expect(PREFERENCE_MAX_TOKENS).toBeLessThan(1000);
  });

  it("keeps the thresholds in a coherent order", () => {
    // A rule good enough to promote must first be good enough to apply.
    expect(PROMOTE_MIN_CONFIDENCE).toBeGreaterThanOrEqual(PREFERENCE_ACTIVATE_CONFIDENCE);
    // Promotion needs the founder to have re-derived it, not just stated it once.
    expect(PROMOTE_MIN_OBSERVATIONS).toBeGreaterThan(1);
    // Capture threshold below merge threshold: a diff we would not even record
    // must not be wider than the gap that counts two rules as the same rule.
    expect(PREFERENCE_MIN_EDIT_DISTANCE).toBeLessThan(PREFERENCE_MERGE_DISTANCE);
    expect(RETIRE_AFTER_MS).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it("bounds what an extraction call may return", () => {
    const tooMany = {
      rules: Array.from({ length: EXTRACTION_MAX_RULES + 1 }, () => ({
        rule: "Never open with a rhetorical question",
        polarity: "avoid" as const,
        confidence: 80,
        evidence: "the founder cut every opening question",
      })),
    };
    expect(preferenceExtractionSchema.safeParse(tooMany).success).toBe(false);

    const empty = preferenceExtractionSchema.safeParse({ rules: [] });
    // "These edits taught nothing" must be expressible — it is a correct answer.
    expect(empty.success).toBe(true);
  });

  it("rejects a rule that is a paragraph rather than an instruction", () => {
    const long = createPreferenceRuleInputSchema.safeParse({
      rule: "x".repeat(PREFERENCE_RULE_MAX_CHARS + 1),
    });
    expect(long.success).toBe(false);
    const short = createPreferenceRuleInputSchema.safeParse({ rule: "short" });
    expect(short.success).toBe(false);
    const ok = createPreferenceRuleInputSchema.parse({
      rule: "Name the segment, not the persona",
    });
    expect(ok.polarity).toBe("avoid");
  });

  it("offers the founder four levers and not `promoted`", () => {
    // Promotion is the accepted synthesis's job, never a button.
    expect(updatePreferenceRuleInputSchema.safeParse({ status: "promoted" }).success).toBe(false);
    for (const status of ["candidate", "active", "disabled", "retired"]) {
      expect(updatePreferenceRuleInputSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("parses a stored rule with its counts", () => {
    const rule = preferenceRuleSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      rule: "Never open with a rhetorical question",
      polarity: "avoid",
      scopeTaskType: "signal_response",
      scopeChannel: "linkedin",
      status: "active",
      origin: "extracted",
      confidence: 80,
      observationCount: 3,
      appliedCount: 5,
      lastObservedAt: 10,
      lastAppliedAt: 20,
      promotedAt: null,
      retiredAt: null,
      createdAt: 1,
      updatedAt: 20,
    });
    expect(rule.observationCount).toBe(3);
    expect(rule.scopeChannel).toBe("linkedin");
  });
});
