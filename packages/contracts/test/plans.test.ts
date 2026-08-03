import { describe, expect, it } from "vitest";
import { PLANS, PLAN_IDS, checkoutInputSchema } from "../src/index";

describe("Pricing Plans & Entitlements", () => {
  it("defines free plan entitlements correctly", () => {
    expect(PLANS.free.entitlements.seats).toBe(1);
    expect(PLANS.free.entitlements.connectors).toBe(1);
    expect(PLANS.free.entitlements.monthlyLlmCents).toBe(50);
  });

  it("denominates the LLM budget in cents with -1 as unlimited (D6)", () => {
    expect(PLANS.pro.entitlements.monthlyLlmCents).toBe(1000);
    expect(PLANS.scale.entitlements.monthlyLlmCents).toBe(-1);
  });

  it("includes pro in PLAN_IDS", () => {
    expect(PLAN_IDS).toContain("pro");
  });

  it("validates checkout input for known plans", () => {
    expect(checkoutInputSchema.parse({ plan: "pro" })).toEqual({ plan: "pro" });
    expect(checkoutInputSchema.parse({ plan: "scale" })).toEqual({ plan: "scale" });
  });

  it("rejects unknown plans in checkout input", () => {
    expect(checkoutInputSchema.safeParse({ plan: "free" }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ plan: "enterprise" }).success).toBe(false);
  });
});
