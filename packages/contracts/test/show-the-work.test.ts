import { describe, expect, it } from "vitest";
import {
  CONTEXT_KNOBS,
  CONTEXT_KNOB_KEYS,
  KNOB_USAGE_SAMPLE_LIMIT,
  TRACE_KNOB_STATES,
  TRACE_SUBJECT_KINDS,
  artifactTraceSchema,
  contextKnob,
  isTraceSubjectKind,
  knobUsageReportSchema,
} from "../src/index";

const TRACE = {
  subject: {
    kind: "draft" as const,
    id: "d-1",
    title: "A post about usage-based pricing",
    state: "pending_review",
    href: "/workspaces/ws-1/review?tab=approvals&draft=d-1",
    createdAt: 10,
  },
  origin: {
    kind: "signal" as const,
    id: "s-1",
    label: "Signal from reddit",
    detail: "A competitor announced seat-based pricing.",
    href: "/workspaces/ws-1/discovery?signal=s-1",
    at: 5,
  },
  plan: null,
  context: [
    {
      key: "org:voice",
      layer: "org",
      title: "Voice",
      reason: "Org brain (tier 1, constitutional): how the company sounds.",
      tokens: 120,
      included: true,
      tier: 1,
      mode: "full",
      zoomScore: null,
      zoomRank: null,
      excerpt: "Plain, specific, never breathless.",
      href: "/workspaces/ws-1/brain?doc=voice",
    },
  ],
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
    detail: "Nothing configured.",
    href: `/workspaces/ws-1${knob.surface}`,
  })),
  generatedAt: 20,
};

describe("show the work — the trace vocabulary (Sprint 71)", () => {
  it("names exactly the nine knobs atlas conflict #4 is about", () => {
    expect(CONTEXT_KNOBS).toHaveLength(9);
    expect(CONTEXT_KNOBS.map((knob) => knob.key)).toEqual([...CONTEXT_KNOB_KEYS]);
    expect(new Set(CONTEXT_KNOB_KEYS).size).toBe(9);
  });

  it("keeps the knobs in precedence order — the base first, the override last", () => {
    const keys = CONTEXT_KNOBS.map((knob) => knob.key);
    // A guidance override that ranked above the built-in it overrides would
    // make the knob board unreadable as an explanation of what beat what.
    expect(keys.indexOf("channel_guidance_builtin")).toBeLessThan(
      keys.indexOf("channel_guidance_workspace"),
    );
    expect(keys.indexOf("channel_guidance_workspace")).toBeLessThan(
      keys.indexOf("scoped_guidance"),
    );
    expect(keys.indexOf("brain_docs")).toBe(0);
  });

  it("gives every knob a question and a surface to go fix it on", () => {
    for (const knob of CONTEXT_KNOBS) {
      expect(knob.question.endsWith("?"), knob.key).toBe(true);
      expect(knob.surface.startsWith("/"), knob.key).toBe(true);
      expect(contextKnob(knob.key)).toBe(knob);
    }
  });

  it("covers the four artifact kinds a founder can ask about", () => {
    expect([...TRACE_SUBJECT_KINDS]).toEqual([
      "draft",
      "deliverable",
      "publication",
      "external_action",
    ]);
    expect(isTraceSubjectKind("draft")).toBe(true);
    expect(isTraceSubjectKind("campaign")).toBe(false);
  });

  it("distinguishes a knob that is set from a knob that did something", () => {
    // The whole deletion decision lives in this gap: always configured and
    // never applied is the signature of a knob nobody needs.
    expect([...TRACE_KNOB_STATES]).toEqual(["absent", "configured", "applied"]);
  });

  it("round-trips a full trace", () => {
    const parsed = artifactTraceSchema.parse(TRACE);
    expect(parsed.context[0]!.reason).toContain("constitutional");
    expect(parsed.knobs).toHaveLength(9);
  });

  it("lets every block be absent, but never silently", () => {
    const empty = artifactTraceSchema.parse({
      ...TRACE,
      context: [],
      contextReason: "This draft predates trace capture.",
      origin: null,
    });
    expect(empty.contextReason).toBeTruthy();
    // A blank block and a "nothing here" block look identical to a founder;
    // only one of them is trustworthy (D-71.3).
    expect(() => artifactTraceSchema.parse({ ...TRACE, contextReason: undefined })).toThrow();
  });

  it("reports the denominator behind every applied share", () => {
    const report = knobUsageReportSchema.parse({
      knobs: CONTEXT_KNOBS.map((knob) => ({
        key: knob.key,
        label: knob.label,
        question: knob.question,
        href: `/workspaces/ws-1${knob.surface}`,
        configured: false,
        configuredCount: 0,
        lastConfiguredAt: null,
        appliedResolves: 0,
        appliedShare: 0,
      })),
      sampledResolves: 0,
      sampleLimit: KNOB_USAGE_SAMPLE_LIMIT,
      generatedAt: 1,
    });
    // An unqualified percentage over an unbounded scan is both slow and
    // misleading (D-71.7).
    expect(report.sampleLimit).toBe(200);
    expect(report.knobs).toHaveLength(9);
  });
});
