import { describe, expect, it } from "vitest";
import {
  CONTEXT_KNOBS,
  TRACE_SUBJECT_KINDS,
  type ArtifactTrace,
  type TraceContextSection,
} from "@tuezday/contracts";
import {
  PILLAR_CAVEAT,
  TRACE_BLOCKS,
  appliedKnobCount,
  blockHasContent,
  blockTitle,
  changedLabel,
  excludedSections,
  formatCost,
  includedSections,
  knobStateLabel,
  knobsByEffect,
  layerLabel,
  panelTitle,
  traceUrl,
  visibleBlocks,
  zoomBadge,
} from "./artifact-trace-view";

function section(overrides: Partial<TraceContextSection> = {}): TraceContextSection {
  return {
    key: "org:voice",
    layer: "org",
    title: "Voice",
    reason: "Org brain (tier 1, constitutional).",
    tokens: 100,
    included: true,
    tier: 1,
    mode: "full",
    zoomScore: null,
    zoomRank: null,
    excerpt: "Plain, specific, never breathless.",
    href: "/workspaces/ws-1/brain?doc=voice",
    ...overrides,
  };
}

function trace(overrides: Partial<ArtifactTrace> = {}): ArtifactTrace {
  return {
    subject: {
      kind: "draft",
      id: "d-1",
      title: "A post",
      state: "pending_review",
      href: "/workspaces/ws-1/review",
      createdAt: 1,
    },
    origin: null,
    plan: null,
    context: [section()],
    contextReason: null,
    examples: [],
    preferences: [],
    critic: null,
    revisions: [],
    cost: null,
    knobs: CONTEXT_KNOBS.map((knob) => ({
      key: knob.key,
      label: knob.label,
      question: knob.question,
      state: "absent" as const,
      detail: "Not configured.",
      href: `/workspaces/ws-1${knob.surface}`,
    })),
    generatedAt: 2,
    ...overrides,
  };
}

describe("why-this panel view (Sprint 71)", () => {
  it("titles the panel for every artifact kind it can be mounted on", () => {
    for (const kind of TRACE_SUBJECT_KINDS) expect(panelTitle(kind).length).toBeGreaterThan(0);
    for (const block of TRACE_BLOCKS) expect(blockTitle(block).length).toBeGreaterThan(0);
  });

  it("hides empty blocks but never hides the context block", () => {
    const bare = trace({ context: [], contextReason: "This draft predates trace capture." });
    // The context block carries its own written reason for being empty; hiding
    // it would turn "there was never a prompt" into a blank screen (D-71.3).
    expect(blockHasContent(bare, "context")).toBe(true);
    expect(blockHasContent(bare, "examples")).toBe(false);
    expect(visibleBlocks(bare)).toContain("context");
    expect(visibleBlocks(bare)).not.toContain("examples");
  });

  it("keeps what was used and what was not, both answerable", () => {
    const both = trace({
      context: [section(), section({ key: "campaign", layer: "campaign", included: false })],
    });
    expect(includedSections(both)).toHaveLength(1);
    // "Why did it NOT use my campaign?" is the same question.
    expect(excludedSections(both)).toHaveLength(1);
  });

  it("names the ranker on a zoomed section so the lexical limit is visible", () => {
    expect(zoomBadge(section({ zoomScore: 6.03, zoomRank: 1 }))).toBe("#1 · BM25 6.03");
    expect(zoomBadge(section())).toBeNull();
  });

  it("has copy for every layer the resolver can emit", () => {
    for (const layer of ["org", "channel", "plan", "preferences", "examples", "evidence"]) {
      expect(layerLabel(layer)).not.toBe(layer);
    }
    // An unknown layer degrades to its own name rather than to blank.
    expect(layerLabel("future_layer")).toBe("future_layer");
  });

  it("sorts the knobs by what they did, and still shows all nine", () => {
    const withEffect = trace();
    withEffect.knobs[4] = { ...withEffect.knobs[4]!, state: "applied" };
    withEffect.knobs[7] = { ...withEffect.knobs[7]!, state: "configured" };
    const sorted = knobsByEffect(withEffect);
    expect(sorted).toHaveLength(9);
    expect(sorted[0]!.state).toBe("applied");
    expect(sorted[1]!.state).toBe("configured");
    expect(appliedKnobCount(withEffect)).toBe(1);
    // Six "not in use" rows is the finding, not clutter to hide.
    expect(sorted.filter((knob) => knob.state === "absent")).toHaveLength(7);
  });

  it("says out loud whether a knob is merely set or actually did something", () => {
    expect(knobStateLabel("applied")).toBe("Shaped this");
    expect(knobStateLabel("configured")).toContain("not here");
    expect(knobStateLabel("absent")).toBe("Not in use");
  });

  it("labels a priced cost as priced", () => {
    const metered = formatCost({
      inputTokens: 1,
      outputTokens: 1,
      costCents: 2.5,
      model: "m",
      provider: "p",
      durationMs: null,
      estimated: false,
      href: "/workspaces/ws-1/billing",
    });
    expect(metered).toBe("2.50¢");
    const priced = formatCost({
      inputTokens: 1,
      outputTokens: 1,
      costCents: 0.2,
      model: "m",
      provider: "p",
      durationMs: null,
      estimated: true,
      href: "/workspaces/ws-1/billing",
    });
    expect(priced).toContain("priced, not metered");
  });

  it("reports a revision that never finished as such, not as 0% changed", () => {
    expect(changedLabel(0.42)).toBe("42% rewritten");
    expect(changedLabel(null)).toBe("did not complete");
  });

  it("carries the pillar caveat as fixed copy, not as a suggestion", () => {
    expect(PILLAR_CAVEAT).toContain("never recorded");
  });

  it("builds the endpoint the panel fetches", () => {
    expect(traceUrl("ws-1", "publication", "p-1")).toBe("/workspaces/ws-1/trace/publication/p-1");
  });
});
