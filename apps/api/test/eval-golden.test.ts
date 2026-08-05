import { describe, expect, it } from "vitest";
import { checkGolden, loadExpected, runGoldenSuite, type GoldenOutcome } from "../src/eval/golden";
import { GOLDEN_CASES } from "../src/eval/golden-cases";

/**
 * The CI gate, gated. `npm run eval` is a separate job, but a broken gate that
 * only fails in that job is a gate nobody notices — so `npm test` proves the
 * golden suite still passes, and proves it still fails when it should.
 */
describe("golden eval gate (Sprint 67)", () => {
  let outcome: GoldenOutcome;

  it("runs the real harness over the fixture with no invariant failures", async () => {
    outcome = await runGoldenSuite();
    expect(outcome.invariantFailures).toEqual([]);
    expect(outcome.metrics.cases).toBe(GOLDEN_CASES.length);
    expect(outcome.metrics.completed).toBe(GOLDEN_CASES.length);
  });

  it("matches the checked-in expectation", () => {
    const result = checkGolden(outcome, loadExpected());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails every adversarial case on exactly the check it was built to trip", () => {
    for (const goldenCase of GOLDEN_CASES) {
      const actual = outcome.cases.find((entry) => entry.id === goldenCase.id)!;
      expect(actual.verdict).toBe(goldenCase.expect.verdict);
      expect(actual.failedChecks).toEqual(goldenCase.expect.failedChecks);
    }
  });

  it("blocks on a metric regression", () => {
    const expected = loadExpected();
    const weakened = {
      ...outcome,
      metrics: { ...outcome.metrics, hardCheckPassRate: (outcome.metrics.hardCheckPassRate ?? 0) - 30 },
    };
    const result = checkGolden(weakened, expected);
    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.includes("hardCheckPassRate"))).toBe(true);
  });

  it("blocks when a check stops firing on an adversarial case", () => {
    const expected = loadExpected();
    const softened = {
      ...outcome,
      cases: outcome.cases.map((entry) =>
        entry.id === "banned-claim" ? { ...entry, verdict: "pass", failedChecks: [] } : entry,
      ),
    };
    const result = checkGolden(softened, expected);
    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.includes("banned-claim"))).toBe(true);
  });

  it("blocks on a moved prompt or resolver digest", () => {
    const expected = loadExpected();
    expect(checkGolden({ ...outcome, contextDigest: "0".repeat(64) }, expected).ok).toBe(false);
    expect(
      checkGolden({ ...outcome, contextDigest: "0".repeat(64) }, expected).failures.some(
        (failure) => failure.includes("eval:record"),
      ),
    ).toBe(true);
    expect(checkGolden({ ...outcome, resolverDigest: "0".repeat(64) }, expected).ok).toBe(false);
  });

  it("reports a broken context invariant by name, not as a digest mismatch", () => {
    const result = checkGolden(
      { ...outcome, invariantFailures: ['clean-approved: the draft step\'s context no longer contains "x".'] },
      loadExpected(),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("clean-approved");
  });
});
