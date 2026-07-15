import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "app/workspaces/[id]/page.tsx",
  "app/workspaces/[id]/review/_components/approvals-queue.tsx",
  "app/workspaces/[id]/review/_components/authorizations-queue.tsx",
  "app/workspaces/[id]/review/_components/conversational-editor.tsx",
  "app/workspaces/[id]/review/_components/inbox-queue.tsx",
  "app/workspaces/[id]/content/page.tsx",
  "app/workspaces/[id]/calendar/page.tsx",
  "app/workspaces/[id]/launches/page.tsx",
  "app/workspaces/[id]/outbound/page.tsx",
  "app/workspaces/[id]/pr/page.tsx",
] as const;

const sources = Object.fromEntries(
  FILES.map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]),
) as Record<(typeof FILES)[number], string>;

const RAW_BUTTON_ALLOWLIST: Partial<Record<(typeof FILES)[number], string>> = {
  "app/workspaces/[id]/calendar/page.tsx": "Calendar entries are selectable schedule tiles.",
  "app/workspaces/[id]/review/_components/conversational-editor.tsx":
    "Variant and sibling selectors retain tab/choice semantics.",
};

describe("desktop operating actions", () => {
  it("uses shared action primitives without legacy button composition or sizes", () => {
    for (const file of FILES) {
      const source = sources[file];
      expect(source, file).not.toMatch(/buttonStyles\.|link-button|button-secondary/);
      expect(source, file).not.toMatch(/<Button\b[^>]*\bsize="(?:sm|md)"/s);
      expect(source, file).not.toContain('variant="ghost"');
      if (!RAW_BUTTON_ALLOWLIST[file]) expect(source, file).not.toContain("<button");
    }
  });

  it("keeps navigation in ButtonLink and familiar dense controls compact", () => {
    for (const file of [
      "app/workspaces/[id]/content/page.tsx",
      "app/workspaces/[id]/launches/page.tsx",
      "app/workspaces/[id]/outbound/page.tsx",
      "app/workspaces/[id]/pr/page.tsx",
    ] as const) {
      expect(sources[file], file).toContain("ButtonLink");
    }
    expect(sources["app/workspaces/[id]/calendar/page.tsx"]).toContain("IconButton");
    expect(sources["app/workspaces/[id]/calendar/page.tsx"]).toContain('label="Close details"');
  });

  it("marks destructive commands as dangerous and confirms the exact object", () => {
    const launches = sources["app/workspaces/[id]/launches/page.tsx"];
    const outbound = sources["app/workspaces/[id]/outbound/page.tsx"];
    const pr = sources["app/workspaces/[id]/pr/page.tsx"];
    const content = sources["app/workspaces/[id]/content/page.tsx"];
    const calendar = sources["app/workspaces/[id]/calendar/page.tsx"];
    expect(launches).toContain('variant="danger"');
    expect(launches).toContain('Delete launch "${launch.name}"?');
    expect(outbound).toContain('variant="danger"');
    expect(outbound).toContain('Delete lead "${lead.name}"?');
    expect(pr).toContain('variant="danger"');
    expect(pr).toContain('Delete contact "${contact.name}"?');
    expect(content).toContain('variant="danger"');
    expect(content).toContain("Cancel this scheduled post?");
    expect(calendar).toContain('variant="danger"');
    expect(calendar).toContain("Cancel this scheduled post?");
  });
});
