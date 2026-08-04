import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  CHANNEL_FORMAT_REGISTRY,
  ELIGIBILITY_RULES,
  PACKAGE_DECISION_TARGETS,
  PACKAGE_STATUSES,
  PACKAGE_TRANSITIONS,
  TASK_TYPES,
  canTransitionPackage,
  formatCapability,
  formatsForChannel,
  isRegisteredFormat,
  packageDecisionInputSchema,
  transitionPackage,
} from "../src/index.js";

describe("package lifecycle state machine", () => {
  it("disposes an assessing package into every business outcome", () => {
    expect(canTransitionPackage("assessing", "ready")).toBe(true);
    expect(canTransitionPackage("assessing", "research_needed")).toBe(true);
    expect(canTransitionPackage("assessing", "blocked")).toBe(true);
    expect(canTransitionPackage("assessing", "cancelled")).toBe(true);
  });

  it("keeps reassessment open from every settled state", () => {
    expect(transitionPackage("research_needed", "assessing")).toBe("assessing");
    expect(transitionPackage("ready", "assessing")).toBe("assessing");
    expect(transitionPackage("blocked", "assessing")).toBe("assessing");
  });

  it("lets lane changes move a package between ready and blocked", () => {
    expect(canTransitionPackage("ready", "blocked")).toBe(true);
    expect(canTransitionPackage("blocked", "ready")).toBe(true);
    // But never straight to research_needed without a new assessment.
    expect(canTransitionPackage("ready", "research_needed")).toBe(false);
    expect(canTransitionPackage("blocked", "research_needed")).toBe(false);
  });

  it("makes cancellation terminal", () => {
    for (const to of PACKAGE_STATUSES) {
      expect(canTransitionPackage("cancelled", to)).toBe(false);
    }
  });

  it("maps every decision action to a reachable target", () => {
    for (const target of Object.values(PACKAGE_DECISION_TARGETS)) {
      expect(PACKAGE_STATUSES).toContain(target);
    }
    for (const status of PACKAGE_STATUSES) {
      expect(PACKAGE_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe("packageDecisionInputSchema", () => {
  it("requires a reason to cancel but not to reassess", () => {
    expect(packageDecisionInputSchema.safeParse({ action: "cancel" }).success).toBe(false);
    expect(
      packageDecisionInputSchema.safeParse({ action: "cancel", reason: "stale" }).success,
    ).toBe(true);
    expect(packageDecisionInputSchema.safeParse({ action: "reassess" }).success).toBe(true);
  });
});

describe("channel/format registry (design §8.9)", () => {
  it("registers each (channel, format) pair exactly once", () => {
    const keys = CHANNEL_FORMAT_REGISTRY.map(
      (entry) => `${entry.channel}:${entry.format}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only uses declared channels and task types", () => {
    for (const entry of CHANNEL_FORMAT_REGISTRY) {
      expect(CHANNELS).toContain(entry.channel);
      expect(TASK_TYPES).toContain(entry.taskType);
    }
  });

  it("looks up capabilities by channel and format", () => {
    expect(formatCapability("linkedin", "linkedin_post")?.taskType).toBe("linkedin_post");
    expect(formatCapability("linkedin", "tiktok_video")).toBeUndefined();
    expect(isRegisteredFormat("instagram", "instagram_carousel")).toBe(true);
    expect(isRegisteredFormat("instagram", "linkedin_post")).toBe(false);
    expect(formatsForChannel("ads").map((entry) => entry.format).sort()).toEqual([
      "google_rsa",
      "meta_ad_creative",
    ]);
  });

  it("declares media honestly: carousels require media", () => {
    expect(formatCapability("instagram", "instagram_carousel")?.requiresMedia).toBe(true);
    expect(formatCapability("instagram", "instagram_post")?.requiresMedia).toBe(false);
  });
});

describe("eligibility rules vocabulary", () => {
  it("keeps the persona rule non-blocking by convention and the rest declared", () => {
    expect(ELIGIBILITY_RULES).toContain("angle_novel_for_lane");
    expect(ELIGIBILITY_RULES).toContain("persona_alignment");
    expect(new Set(ELIGIBILITY_RULES).size).toBe(ELIGIBILITY_RULES.length);
  });
});
