import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "src"))];
const sources = files.map((path) => ({
  file: relative(root, path),
  source: readFileSync(path, "utf8"),
}));

describe("desktop action foundation", () => {
  it("has no legacy action classes, size literals, page icon imports, or compatibility mappers", () => {
    for (const { file, source } of sources) {
      expect(source, file).not.toMatch(/buttonStyles\.|link-button|button-secondary/);
      expect(source, file).not.toMatch(/size="(?:sm|md|lg)"/);
      expect(source, file).not.toContain('variant="ghost"');
      if (file.startsWith("app/")) expect(source, file).not.toContain('from "lucide-react"');
    }
    expect(readFileSync(join(root, "src/components/ui/button.tsx"), "utf8")).not.toContain(
      "LEGACY_",
    );
    expect(readFileSync(join(root, "src/components/ui/icon.tsx"), "utf8")).not.toContain(
      "LEGACY_",
    );
  });

  it("keeps direct button CSS private to the shared primitive", () => {
    for (const { file, source } of sources) {
      if (file === "src/components/ui/button.tsx") continue;
      expect(source, file).not.toContain("button.module.css");
    }
  });

  it("requires every IconButton call site to provide a non-empty label", () => {
    for (const { file, source } of sources) {
      if (file === "src/components/ui/button.tsx") continue;
      const calls = source.match(/<IconButton\b[^>]*>/gs) ?? [];
      for (const call of calls) expect(call, file).toMatch(/\blabel=(?:"[^"]+"|\{[^}]+\})/);
    }
  });
});
