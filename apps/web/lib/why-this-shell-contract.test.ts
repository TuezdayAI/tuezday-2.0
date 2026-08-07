import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** Every artifact the PRD names, and the surface it is looked at on. */
const MOUNTS = [
  ["draft", "app/workspaces/[id]/review/_components/conversational-editor.tsx"],
  ["deliverable", "app/workspaces/[id]/deliverables/page.tsx"],
  ["publication", "app/workspaces/[id]/content/page.tsx"],
  ["external_action", "app/workspaces/[id]/review/_components/authorizations-queue.tsx"],
] as const;

describe("why-this shell contract (Sprint 71)", () => {
  it("mounts the shared panel on every artifact kind the PRD names", () => {
    for (const [kind, file] of MOUNTS) {
      const source = read(file);
      expect(source, file).toContain("WhyThisPanel");
      expect(source, file).toContain(`kind="${kind}"`);
    }
  });

  it("leaves exactly one why renderer on the draft screen (D-71.8)", () => {
    const editor = read("app/workspaces/[id]/review/_components/conversational-editor.tsx");
    // The bespoke sections/excluded markup the editor used to own is gone; two
    // explanations of the same draft on one screen is what this sprint stops.
    expect(editor).not.toContain("groupEditorSections");
    expect(editor).not.toContain("Sources and context");
    expect(editor).not.toContain("What was not used");
    // The revision composer stays where it is — it writes, the panel reads.
    expect(editor).toContain("Ask Tuezday to revise");
  });

  it("fetches the trace from the one assembled endpoint, never rebuilt client-side", () => {
    const panel = read("components/why-this-panel.tsx");
    expect(panel).toContain("traceUrl(workspaceId, kind, subjectId)");
    // D-71.2: reading state the platform wrote. A client that recomputed would
    // show a bundle nobody was ever prompted with.
    expect(panel).not.toContain("resolveContext");
  });

  it("loads on open, not with the list", () => {
    const panel = read("components/why-this-panel.tsx");
    // A review queue of forty drafts must not fire forty trace calls.
    expect(panel).toContain("onToggle");
  });

  it("shows all nine knobs on the resolver, in the order the API sent them", () => {
    const resolver = read("app/workspaces/[id]/resolver/page.tsx");
    expect(resolver).toContain("bundle.knobs");
    expect(resolver).toContain("knobStateLabel");
    // No client-side filtering: the knobs that did nothing are the finding.
    expect(resolver).not.toMatch(/bundle\.knobs\s*\.filter\([^)]*\)\.map/);
  });

  it("keeps the pillar caveat next to the pillar", () => {
    const panel = read("components/why-this-panel.tsx");
    expect(panel).toContain("PILLAR_CAVEAT");
    expect(panel).toContain("closestPillar");
  });
});
