import { describe, expect, it } from "vitest";
import { resolveCorsOrigin } from "../src/runtime/cors-origin";

describe("resolveCorsOrigin", () => {
  it("returns true when WEB_ORIGIN is unset", () => {
    expect(resolveCorsOrigin({})).toBe(true);
  });

  it("returns true when WEB_ORIGIN is an empty string", () => {
    expect(resolveCorsOrigin({ WEB_ORIGIN: "" })).toBe(true);
  });

  it("returns true when WEB_ORIGIN is whitespace only", () => {
    expect(resolveCorsOrigin({ WEB_ORIGIN: "   " })).toBe(true);
  });

  it("returns true when WEB_ORIGIN is only separators", () => {
    expect(resolveCorsOrigin({ WEB_ORIGIN: "," })).toBe(true);
  });

  it("returns a single-entry allowlist for one origin", () => {
    expect(resolveCorsOrigin({ WEB_ORIGIN: "https://app.example.com" })).toEqual([
      "https://app.example.com",
    ]);
  });

  it("returns both entries in order for a comma-separated list", () => {
    expect(
      resolveCorsOrigin({
        WEB_ORIGIN: "https://app.example.com,https://admin.example.com",
      }),
    ).toEqual(["https://app.example.com", "https://admin.example.com"]);
  });

  it("trims surrounding whitespace from each entry", () => {
    expect(
      resolveCorsOrigin({
        WEB_ORIGIN: "  https://app.example.com ,  https://admin.example.com  ",
      }),
    ).toEqual(["https://app.example.com", "https://admin.example.com"]);
  });

  it("drops an empty entry from a trailing comma", () => {
    expect(resolveCorsOrigin({ WEB_ORIGIN: "https://app.example.com," })).toEqual([
      "https://app.example.com",
    ]);
  });
});
