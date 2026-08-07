import { describe, expect, it } from "vitest";
import { resolvePort } from "../src/runtime/port";

describe("resolvePort", () => {
  it("defaults to 3001 when PORT is unset", () => {
    expect(resolvePort({})).toBe(3001);
  });

  it("defaults to 3001 when PORT is empty", () => {
    expect(resolvePort({ PORT: "" })).toBe(3001);
  });

  it("defaults to 3001 when PORT is whitespace-only", () => {
    expect(resolvePort({ PORT: "   " })).toBe(3001);
  });

  it("returns an explicit PORT as a number", () => {
    expect(resolvePort({ PORT: "8080" })).toBe(8080);
  });

  it("trims surrounding whitespace", () => {
    expect(resolvePort({ PORT: "  8080  " })).toBe(8080);
  });
});
