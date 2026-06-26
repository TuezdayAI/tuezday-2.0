import { describe, expect, it } from "vitest";
import { googleCallbackInputSchema } from "../src/index";

describe("googleCallbackInputSchema", () => {
  it("requires a non-empty code", () => {
    expect(googleCallbackInputSchema.parse({ code: "abc" })).toEqual({ code: "abc" });
    expect(googleCallbackInputSchema.safeParse({ code: "" }).success).toBe(false);
    expect(googleCallbackInputSchema.safeParse({}).success).toBe(false);
  });
});
