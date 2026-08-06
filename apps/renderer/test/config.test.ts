import { describe, expect, it } from "vitest";
import { parseRendererConfig } from "../src/config";

describe("renderer configuration", () => {
  it("requires a dedicated token outside tests", () => {
    expect(() => parseRendererConfig({ NODE_ENV: "production" })).toThrow(
      "TUEZDAY_RENDERER_TOKEN is required",
    );
  });

  it("uses bounded defaults in tests", () => {
    expect(parseRendererConfig({ NODE_ENV: "test" })).toEqual({
      port: 7457,
      token: "test-renderer-token",
      maxConcurrency: 2,
      timeoutMs: 15_000,
    });
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "70000"],
    ["RENDER_MAX_CONCURRENCY", "0"],
    ["RENDER_MAX_CONCURRENCY", "33"],
    ["RENDER_TIMEOUT_MS", "999"],
    ["RENDER_TIMEOUT_MS", "120001"],
  ])("rejects an unsafe %s value", (name, value) => {
    expect(() =>
      parseRendererConfig({
        NODE_ENV: "test",
        [name]: value,
      }),
    ).toThrow(name);
  });
});
