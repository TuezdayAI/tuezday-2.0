import { describe, expect, it } from "vitest";
import {
  comparisonLeader,
  formatCents,
  formatRate,
  pathLabel,
  verdictTally,
} from "./automation-ab-view";

function metrics(approvalRate: number | null) {
  return {
    drafts: 0,
    decided: 0,
    approved: 0,
    rejected: 0,
    approvalRate,
    avgEditDistance: null,
    costCents: 0,
  };
}

describe("pathLabel", () => {
  it("names each path with a consequence", () => {
    expect(pathLabel("legacy").title).toBe("Legacy");
    expect(pathLabel("shadow").title).toBe("Shadow A/B");
    expect(pathLabel("pipeline").title).toBe("Pipeline engine");
    expect(pathLabel("shadow").consequence).toMatch(/comparison only/);
  });
});

describe("formatRate / formatCents", () => {
  it("distinguishes no-data from a measured zero", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(82.4)).toBe("82.4%");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123)).toBe("$1.23");
    expect(formatCents(5)).toBe("$0.05");
  });
});

describe("verdictTally", () => {
  it("counts verdicts and ignores unreviewed pairs", () => {
    expect(
      verdictTally([
        { verdict: "engine" },
        { verdict: "engine" },
        { verdict: "legacy" },
        { verdict: "tie" },
        { verdict: null },
      ]),
    ).toEqual({ engine: 2, legacy: 1, tie: 1 });
  });
});

describe("comparisonLeader", () => {
  it("judges on approval rate only, and never from missing data", () => {
    expect(comparisonLeader({ legacy: metrics(50), engine: metrics(80) })).toBe("engine");
    expect(comparisonLeader({ legacy: metrics(90), engine: metrics(80) })).toBe("legacy");
    expect(comparisonLeader({ legacy: metrics(75), engine: metrics(75) })).toBe("tie");
    expect(comparisonLeader({ legacy: metrics(null), engine: metrics(80) })).toBeNull();
    expect(comparisonLeader({ legacy: metrics(50), engine: metrics(null) })).toBeNull();
  });
});
