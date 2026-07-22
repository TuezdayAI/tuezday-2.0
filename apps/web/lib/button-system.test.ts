import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/components/ui/button.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../src/components/ui/button.module.css", import.meta.url),
  "utf8",
);
const tokens = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");

describe("desktop action primitives", () => {
  it("defines the approved hierarchy and semantic control sizes", () => {
    expect(source).toContain(
      'type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger"',
    );
    expect(source).toContain(
      'type ButtonSize = "compact" | "standard" | "large"',
    );
    expect(source).toContain("export function ButtonLink");

    expect(css).toMatch(/\.large[\s\S]*min-height:\s*var\(--control-large\)/);
    expect(css).toMatch(/\.standard[\s\S]*min-height:\s*var\(--control-standard\)/);
    expect(css).toMatch(/\.compact[\s\S]*min-height:\s*var\(--control-compact\)/);
    expect(css).toMatch(
      /\.iconStandard[\s\S]*width:\s*var\(--control-standard\)[\s\S]*height:\s*var\(--control-standard\)/,
    );
    expect(css).toMatch(/\.primary[\s\S]*background:\s*var\(--button-primary\)/);
  });

  it("owns action colors and dimensions as semantic tokens", () => {
    for (const token of [
      "--button-primary: var(--ink)",
      "--button-primary-ink: var(--surface)",
      "--button-danger: var(--status-blocked)",
      "--control-compact: 36px",
      "--control-standard: 40px",
      "--control-large: 44px",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("supports loading and accessible icon-only actions", () => {
    expect(source).toContain("loading?: boolean");
    expect(source).toContain("leadingIcon?: ReactNode");
    expect(source).toContain("aria-busy={loading || undefined}");
    expect(source).toContain("title={title ?? label}");
  });
});
