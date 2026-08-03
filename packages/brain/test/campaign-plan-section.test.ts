import { PLAN_SECTION_TOKEN_CAP } from "@tuezday/contracts";
import { describe, expect, it } from "vitest";
import {
  composeCampaignPlanSection,
  composeCompactCampaignPlanSection,
  estimateTokens,
  type ResolveCampaignPlan,
} from "../src/index";

const fullPlan: ResolveCampaignPlan = {
  revision: 3,
  objective: "Win 25 design-partner logos for the agentic GTM tier.",
  kpi: "25 signed design partners by 30 September.",
  timeframe: "Q3 2026 (July–September).",
  pillars: ["GTM amnesia is the real problem", "Agents need a brain, not a prompt"],
  offers: ["Free 30-day design-partner slot", "Migration from spreadsheet GTM"],
  ctas: ["Book a 20-minute teardown", "Reply DESIGN for a slot"],
  guidance: "Never promise a roadmap date. Speak to founders, not to marketers.",
};

/** A plan at every contract maximum: 20×200 pillars, 20×300 offers/ctas, 10k guidance. */
function maximalPlan(): ResolveCampaignPlan {
  return {
    revision: 9,
    objective: "O".repeat(1_000),
    kpi: "K".repeat(500),
    timeframe: "T".repeat(200),
    pillars: Array.from({ length: 20 }, (_, i) => `pillar ${i} ${"p".repeat(190)}`),
    offers: Array.from({ length: 20 }, (_, i) => `offer ${i} ${"o".repeat(290)}`),
    ctas: Array.from({ length: 20 }, (_, i) => `cta ${i} ${"c".repeat(290)}`),
    guidance: "g".repeat(10_000),
  };
}

describe("PLAN_SECTION_TOKEN_CAP", () => {
  it("is a positive cap well under the default bundle budget", () => {
    expect(PLAN_SECTION_TOKEN_CAP).toBeGreaterThan(0);
    expect(PLAN_SECTION_TOKEN_CAP).toBeLessThan(8_000);
  });
});

describe("composeCampaignPlanSection", () => {
  it("composes every field in priority order: objective, KPI, timeframe, pillars, offers, CTAs, guidance", () => {
    const composed = composeCampaignPlanSection(fullPlan);
    expect(composed.truncated).toBe(false);
    expect(composed.omitted).toEqual([]);
    expect(composed.tokens).toBe(estimateTokens(composed.content));

    const positions = [
      composed.content.indexOf("Win 25 design-partner logos"),
      composed.content.indexOf("25 signed design partners"),
      composed.content.indexOf("Q3 2026"),
      composed.content.indexOf("GTM amnesia is the real problem"),
      composed.content.indexOf("Free 30-day design-partner slot"),
      composed.content.indexOf("Book a 20-minute teardown"),
      composed.content.indexOf("Never promise a roadmap date"),
    ];
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);

    // Every list member survives an unconstrained composition.
    for (const item of [...fullPlan.pillars!, ...fullPlan.offers!, ...fullPlan.ctas!]) {
      expect(composed.content).toContain(item);
    }
  });

  it("truncates a maximal plan at the cap and reports that it truncated", () => {
    const composed = composeCampaignPlanSection(maximalPlan());
    expect(composed.tokens).toBeLessThanOrEqual(PLAN_SECTION_TOKEN_CAP);
    expect(composed.tokens).toBe(estimateTokens(composed.content));
    expect(composed.truncated).toBe(true);
    // Highest-priority fields survive; the lowest-priority ones are named as dropped.
    expect(composed.content).toContain("O".repeat(50));
    expect(composed.omitted.length).toBeGreaterThan(0);
    expect(composed.omitted).toContain("guidance");
  });

  it("composes an empty plan — and an absent plan — to empty", () => {
    for (const plan of [undefined, {}, { objective: "", pillars: [], guidance: "  " }]) {
      const composed = composeCampaignPlanSection(plan as ResolveCampaignPlan | undefined);
      expect(composed.content).toBe("");
      expect(composed.tokens).toBe(0);
      expect(composed.truncated).toBe(false);
    }
  });

  it("is deterministic — the same plan composes byte-identically", () => {
    expect(composeCampaignPlanSection(fullPlan)).toEqual(composeCampaignPlanSection(fullPlan));
    const max = maximalPlan();
    expect(composeCampaignPlanSection(max)).toEqual(composeCampaignPlanSection(max));
  });
});

describe("composeCompactCampaignPlanSection", () => {
  it("keeps objective, KPI and pillars, and omits timeframe, offers, CTAs and guidance", () => {
    const compact = composeCompactCampaignPlanSection(fullPlan);
    expect(compact.content).toContain("Win 25 design-partner logos");
    expect(compact.content).toContain("25 signed design partners");
    expect(compact.content).toContain("GTM amnesia is the real problem");
    expect(compact.content).not.toContain("Never promise a roadmap date");
    expect(compact.content).not.toContain("Free 30-day design-partner slot");
    expect(compact.content).not.toContain("Book a 20-minute teardown");
    expect(compact.content).not.toContain("Q3 2026");
    expect(compact.tokens).toBe(estimateTokens(compact.content));
  });

  it("is never larger than the full composition and still respects the cap", () => {
    const max = maximalPlan();
    const compact = composeCompactCampaignPlanSection(max);
    expect(compact.tokens).toBeLessThanOrEqual(composeCampaignPlanSection(max).tokens);
    expect(compact.tokens).toBeLessThanOrEqual(PLAN_SECTION_TOKEN_CAP);
  });

  it("composes an empty plan to empty", () => {
    expect(composeCompactCampaignPlanSection(undefined).content).toBe("");
    expect(composeCompactCampaignPlanSection({}).tokens).toBe(0);
  });
});
