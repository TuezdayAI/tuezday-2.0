import { describe, expect, it } from "vitest";
import type { EvalCheckKind, EvalCheckResult } from "@tuezday/contracts";
import {
  citationsGrounded,
  detectCta,
  hardChecksPassed,
  matchBannedClaims,
  runHardChecks,
  significantNgrams,
  type HardCheckInput,
} from "../src/services/eval-checks";

const BODY =
  "A competitor moved to usage-based pricing this morning. That is a positioning change, " +
  "not a pricing change, and their buyers will read it that way.";

function check(overrides: Partial<HardCheckInput> = {}): EvalCheckResult[] {
  return runHardChecks({
    content: BODY,
    channel: "linkedin",
    bannedClaims: [],
    ctaExpectation: "any",
    citations: [],
    corpus: "",
    ...overrides,
  });
}

function of(results: EvalCheckResult[], kind: EvalCheckKind): EvalCheckResult {
  return results.find((result) => result.kind === kind)!;
}

describe("hard checks (Sprint 67)", () => {
  it("always reports all five kinds, in vocabulary order", () => {
    expect(check().map((result) => result.kind)).toEqual([
      "length_bounds",
      "banned_claims",
      "placeholder_leak",
      "cta_presence",
      "citation_validity",
    ]);
  });

  it("passes a clean draft", () => {
    const results = check();
    expect(hardChecksPassed(results)).toBe(true);
    expect(results.some((result) => result.status === "fail")).toBe(false);
  });

  describe("length_bounds", () => {
    it("fails over the channel limit and under the floor", () => {
      expect(of(check({ content: "x".repeat(3001) }), "length_bounds").status).toBe("fail");
      expect(of(check({ content: "Too short." }), "length_bounds").status).toBe("fail");
    });

    it("still enforces the floor on a channel with no published upper bound", () => {
      const long = of(check({ content: "y".repeat(5000), channel: "pr" }), "length_bounds");
      expect(long.status).toBe("pass");
      expect(long.detail).toContain("no published upper bound");
      expect(of(check({ content: "short", channel: "pr" }), "length_bounds").status).toBe("fail");
    });
  });

  describe("banned_claims", () => {
    it("is skipped when the workspace configured none", () => {
      expect(of(check(), "banned_claims").status).toBe("skipped");
    });

    it("matches on word boundaries, not substrings", () => {
      expect(matchBannedClaims(["AI"], "our AI-first stack")).toEqual(["AI"]);
      // "AI" inside "SAID" must not count — that is what makes a list usable.
      expect(matchBannedClaims(["AI"], "he SAID nothing")).toEqual([]);
      expect(matchBannedClaims(["guaranteed results"], "We promise GUARANTEED RESULTS.")).toEqual([
        "guaranteed results",
      ]);
    });

    it("fails and names the phrase", () => {
      const result = of(
        check({
          content: "We are the only platform that connects this to revenue for teams like yours.",
          bannedClaims: ["the only platform that"],
        }),
        "banned_claims",
      );
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("the only platform that");
    });

    it("treats a regex-looking phrase as literal text", () => {
      expect(matchBannedClaims(["10x (guaranteed)"], "we deliver 10x (guaranteed) growth")).toEqual([
        "10x (guaranteed)",
      ]);
    });
  });

  describe("placeholder_leak", () => {
    it("catches template residue", () => {
      for (const leak of ["[insert name]", "{{ company }}", "TODO polish", "lorem ipsum dolor"]) {
        expect(of(check({ content: `${BODY} ${leak}` }), "placeholder_leak").status).toBe("fail");
      }
    });

    it("does not fire on ordinary prose", () => {
      expect(of(check(), "placeholder_leak").status).toBe("pass");
    });
  });

  describe("cta_presence", () => {
    it("is skipped when the suite has no expectation", () => {
      expect(of(check(), "cta_presence").status).toBe("skipped");
    });

    it("fails a required CTA that is missing and passes one that is present", () => {
      expect(of(check({ ctaExpectation: "required" }), "cta_presence").status).toBe("fail");
      expect(
        of(check({ content: `${BODY} Book a walkthrough.`, ctaExpectation: "required" }), "cta_presence")
          .status,
      ).toBe("pass");
    });

    it("fails a forbidden CTA", () => {
      expect(
        of(check({ content: `${BODY} https://tuezday.ai/demo`, ctaExpectation: "forbidden" }), "cta_presence")
          .status,
      ).toBe("fail");
    });

    it("reads a bare link as a call to action", () => {
      expect(detectCta("Nothing to add here.")).toBeNull();
      expect(detectCta("More at https://example.com")).toBe("a link");
      expect(detectCta("Sign up today")).toBe("sign up");
    });
  });

  describe("citation_validity (D-67.6)", () => {
    const corpus =
      "Workspace guardrail: never open with a call to action on a competitor's news day.";

    it("is skipped when the run produced no findings", () => {
      expect(of(check(), "citation_validity").status).toBe("skipped");
    });

    it("passes a citation whose words occur in what the run retrieved", () => {
      const result = of(
        check({ citations: ["never open with a call to action"], corpus }),
        "citation_validity",
      );
      expect(result.status).toBe("pass");
    });

    it("fails an invented citation", () => {
      const result = of(
        check({
          citations: ["Guardrail 14b: every post must name a customer in the first line"],
          corpus,
        }),
        "citation_validity",
      );
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Guardrail 14b");
    });

    it("separates the grounded from the fabricated", () => {
      const { grounded, fabricated } = citationsGrounded(
        ["never open with a call to action", "the CEO said so on the earnings call"],
        corpus,
      );
      expect(grounded).toHaveLength(1);
      expect(fabricated).toHaveLength(1);
    });

    it("falls back to the whole phrase when a citation is shorter than one n-gram", () => {
      expect(significantNgrams("news day")).toEqual(["news day"]);
      expect(citationsGrounded(["news day"], corpus).grounded).toHaveLength(1);
      expect(citationsGrounded(["news week"], corpus).fabricated).toHaveLength(1);
    });
  });
});
