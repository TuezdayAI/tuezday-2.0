import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "app/workspaces/[id]/brain/page.tsx",
  "app/workspaces/[id]/learning/page.tsx",
  "app/workspaces/[id]/resolver/page.tsx",
  "app/workspaces/[id]/lists/page.tsx",
  "app/workspaces/[id]/crm/page.tsx",
  "app/workspaces/[id]/evidence/page.tsx",
  "app/workspaces/[id]/cadence/page.tsx",
  "app/workspaces/[id]/cadence/cadence-manager.tsx",
  "app/workspaces/[id]/sandbox/page.tsx",
  "src/components/show-more.tsx",
  "src/components/ui/diagram-kit.tsx",
  "src/components/ui/preview-card.tsx",
] as const;

const sources = Object.fromEntries(
  FILES.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]),
) as Record<(typeof FILES)[number], string>;

const SEMANTIC_RAW_ROOTS = new Set([
  "app/workspaces/[id]/brain/page.tsx",
  "src/components/ui/diagram-kit.tsx",
  "src/components/ui/preview-card.tsx",
]);

describe("desktop workflow actions", () => {
  it("uses shared commands and drops legacy button aliases", () => {
    for (const file of FILES) {
      const source = sources[file];
      expect(source, file).not.toMatch(/buttonStyles\.|link-button|button-secondary/);
      expect(source, file).not.toMatch(/<Button\b[^>]*\bsize="(?:sm|md)"/s);
      expect(source, file).not.toContain('variant="ghost"');
      if (!SEMANTIC_RAW_ROOTS.has(file)) expect(source, file).not.toContain("<button");
    }
  });

  it("retains semantic card and diagram roots with minimum target hooks", () => {
    expect(sources["src/components/ui/preview-card.tsx"]).toContain("styles.surface");
    expect(sources["src/components/ui/diagram-kit.tsx"]).toContain("styles.tile");
    expect(sources["app/workspaces/[id]/brain/page.tsx"]).toContain("doc-nav-item");
  });

  it("uses shared navigation and danger commands for workflow decisions", () => {
    expect(sources["app/workspaces/[id]/learning/page.tsx"]).toContain("ButtonLink");
    expect(sources["app/workspaces/[id]/sandbox/page.tsx"]).toContain("ButtonLink");
    expect(sources["app/workspaces/[id]/brain/page.tsx"]).toContain('variant="danger"');
    expect(sources["app/workspaces/[id]/resolver/page.tsx"]).toContain('variant="danger"');
    expect(sources["app/workspaces/[id]/evidence/page.tsx"]).toContain('variant="danger"');
  });
});
