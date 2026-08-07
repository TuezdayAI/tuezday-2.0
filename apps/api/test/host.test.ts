import { describe, expect, it } from "vitest";
import { resolveHost } from "../src/runtime/host";

describe("resolveHost", () => {
  it("defaults to loopback when HOST is unset", () => {
    expect(resolveHost({})).toBe("127.0.0.1");
  });

  it("defaults to loopback when HOST is empty", () => {
    expect(resolveHost({ HOST: "" })).toBe("127.0.0.1");
  });

  it("defaults to loopback when HOST is whitespace-only", () => {
    expect(resolveHost({ HOST: "   " })).toBe("127.0.0.1");
  });

  it("returns an explicit HOST", () => {
    expect(resolveHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveHost({ HOST: "  0.0.0.0  " })).toBe("0.0.0.0");
  });
});
