import { describe, expect, it } from "vitest";
import { brainAutoDraftViewSchema } from "../src/index";

describe("brain auto-draft contracts", () => {
  it("accepts drafted/skipped doc-type arrays", () => {
    const parsed = brainAutoDraftViewSchema.safeParse({
      insufficient: false,
      drafted: ["soul", "icp", "voice"],
      skipped: ["history", "now"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown doc type", () => {
    expect(
      brainAutoDraftViewSchema.safeParse({ insufficient: false, drafted: ["spleen"], skipped: [] })
        .success,
    ).toBe(false);
  });
});
