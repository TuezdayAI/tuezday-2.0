import { describe, expect, it } from "vitest";
import { usageMeter, WORKSPACE_NAV } from "../src/index";

describe("usageMeter", () => {
  it("reports ok under 80%", () => {
    expect(usageMeter(10, 50)).toEqual({ percent: 20, state: "ok" });
  });

  it("reports near at >=80%", () => {
    expect(usageMeter(40, 50)).toEqual({ percent: 80, state: "near" });
  });

  it("reports over at the limit, clamped to 100", () => {
    expect(usageMeter(50, 50)).toEqual({ percent: 100, state: "over" });
    expect(usageMeter(120, 50)).toEqual({ percent: 100, state: "over" });
  });

  it("treats -1 as unlimited and never flags over", () => {
    expect(usageMeter(9999, -1)).toEqual({ percent: 100, state: "unlimited" });
    expect(usageMeter(0, -1)).toEqual({ percent: 100, state: "unlimited" });
  });

  it("handles a zero limit without dividing by zero", () => {
    expect(usageMeter(0, 0)).toEqual({ percent: 0, state: "ok" });
    expect(usageMeter(1, 0)).toEqual({ percent: 100, state: "over" });
  });
});

describe("WORKSPACE_NAV activity entry", () => {
  it("lists Activity under Settings", () => {
    const settings = WORKSPACE_NAV.find((g) => g.label === "Settings");
    expect(settings?.children?.some((c) => c.path === "/activity")).toBe(true);
  });
});
