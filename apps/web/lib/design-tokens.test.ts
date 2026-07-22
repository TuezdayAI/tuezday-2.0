import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

describe("Tuezday application tokens", () => {
  it("uses the live-site neutral and spectrum foundations", () => {
    expect(css).toContain("--bg: oklch(0.966 0.005 256)");
    expect(css).toContain("--surface: oklch(0.995 0.003 256)");
    expect(css).toContain("--ink: oklch(0.205 0.013 264)");
    expect(css).toContain("--c1: oklch(0.635 0.190 27)");
    expect(css).toContain("--c6: oklch(0.585 0.175 350)");
  });

  it("separates semantic workflow colors from spectrum categories", () => {
    for (const token of [
      "--status-attention",
      "--status-progress",
      "--status-ready",
      "--status-blocked",
      "--status-info",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("uses Archivo, Inter, and JetBrains Mono without Fraunces", () => {
    expect(layout).toContain("Archivo");
    expect(layout).toContain("Inter");
    expect(layout).toContain("JetBrains_Mono");
    expect(layout).not.toContain("Fraunces");
    expect(css).not.toContain("--font-fraunces");
  });
});
