import { describe, expect, it } from "vitest";
import {
  CHANNEL_GUIDANCE_DEFAULTS,
  TASK_INSTRUCTIONS,
  composeAngleInstruction,
  composeBrandVoiceReviewInstruction,
  composeChannelFitReviewInstruction,
  composePrPitchInstruction,
  defaultResolvedMatrix,
  estimateTokens,
  resolveContext,
  type ResolveInput,
} from "../src/index";

const fullDocs = {
  soul: "We exist to end GTM amnesia. ".repeat(10),
  icp: "Founder-led SaaS companies with small GTM teams. ".repeat(10),
  voice: "Direct, technical, never corporate. ".repeat(10),
  history: "Launched the rebuild in June 2026. ".repeat(10),
  now: "This month we are proving the brain loop. ".repeat(10),
};

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    workspaceName: "Hexalog",
    docs: fullDocs,
    taskType: "linkedin_post",
    channel: "linkedin",
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("built-in defaults", () => {
  it("provides guidance for every channel", () => {
    for (const channel of ["linkedin", "x", "email", "ads", "web", "pr"] as const) {
      expect(CHANNEL_GUIDANCE_DEFAULTS[channel].length).toBeGreaterThan(0);
    }
  });

  it("provides an instruction for every task type", () => {
    for (const task of [
      "linkedin_post",
      "cold_email_opener",
      "ad_copy_variant",
      "landing_page_hero",
    ] as const) {
      expect(TASK_INSTRUCTIONS[task].length).toBeGreaterThan(0);
    }
  });
});

describe("resolveContext", () => {
  it("orders sections org -> channel -> campaign -> persona -> signal -> task", () => {
    const result = resolveContext(baseInput());
    expect(result.sections.map((s) => s.key)).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "persona",
      "lead",
      "media_contact",
      "signal",
      "evidence",
      "task",
    ]);
  });

  it("includes filled org docs with a layer reason", () => {
    const result = resolveContext(baseInput());
    const soul = result.sections.find((s) => s.key === "org:soul")!;
    expect(soul.included).toBe(true);
    expect(soul.layer).toBe("org");
    expect(soul.reason.length).toBeGreaterThan(0);
  });

  it("excludes empty org docs with an explicit reason", () => {
    const result = resolveContext(
      baseInput({ docs: { ...fullDocs, history: "" } }),
    );
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.included).toBe(false);
    expect(history.reason).toMatch(/empty/i);
  });

  it("always marks the campaign slot excluded this sprint", () => {
    const result = resolveContext(baseInput());
    const campaign = result.sections.find((s) => s.key === "campaign")!;
    expect(campaign.included).toBe(false);
    expect(campaign.reason).toMatch(/campaign/i);
  });

  it("excludes the persona section when no persona is given", () => {
    const result = resolveContext(baseInput());
    const persona = result.sections.find((s) => s.key === "persona")!;
    expect(persona.included).toBe(false);
    expect(persona.reason).toMatch(/no persona/i);
  });

  it("includes persona overlay content when a persona is given", () => {
    const result = resolveContext(
      baseInput({
        persona: {
          name: "CEO",
          description: "Founder speaking in first person",
          overlay: "Write as Varun. Confident, a little cocky, never corporate.",
        },
      }),
    );
    const persona = result.sections.find((s) => s.key === "persona")!;
    expect(persona.included).toBe(true);
    expect(persona.content).toContain("Write as Varun");
    expect(persona.content).toContain("CEO");
  });

  it("changes only the persona section between two personas", () => {
    const ceo = resolveContext(
      baseInput({ persona: { name: "CEO", description: "", overlay: "First person founder." } }),
    );
    const page = resolveContext(
      baseInput({ persona: { name: "Company page", description: "", overlay: "We voice." } }),
    );
    const ceoOther = ceo.sections.filter((s) => s.key !== "persona");
    const pageOther = page.sections.filter((s) => s.key !== "persona");
    expect(ceoOther).toEqual(pageOther);
    expect(ceo.sections.find((s) => s.key === "persona")!.content).not.toEqual(
      page.sections.find((s) => s.key === "persona")!.content,
    );
  });

  it("always includes the task instruction last", () => {
    const result = resolveContext(baseInput({ taskType: "cold_email_opener" }));
    const last = result.sections[result.sections.length - 1]!;
    expect(last.key).toBe("task");
    expect(last.included).toBe(true);
    expect(last.content).toBe(TASK_INSTRUCTIONS.cold_email_opener);
  });

  it("falls back to the built-in default channel guidance when none is provided", () => {
    const result = resolveContext(baseInput({ channel: "email" }));
    const channel = result.sections.find((s) => s.key === "channel")!;
    expect(channel.included).toBe(true);
    expect(channel.content).toBe(CHANNEL_GUIDANCE_DEFAULTS.email);
    expect(channel.reason).toMatch(/built-in default/i);
  });

  it("uses a provided channel guidance override and labels its source in the trace", () => {
    const override = "Channel: LinkedIn. Always open with a contrarian one-liner.";
    const result = resolveContext(
      baseInput({ channel: "linkedin", channelGuidance: { content: override, source: "workspace" } }),
    );
    const channel = result.sections.find((s) => s.key === "channel")!;
    expect(channel.content).toBe(override);
    expect(channel.reason).toMatch(/workspace override/i);
    // The override text must actually reach the assembled prompt.
    expect(result.prompt).toContain(override);
  });

  it("demotes an over-budget matrix-full history to its outline (Sprint 43 ladder)", () => {
    // pr_pitch keeps history full by default; a huge history + tight budget
    // demotes it to outline instead of dropping it whole (v1 behavior).
    const docs = { ...fullDocs, history: "The launch went well and taught us pricing. ".repeat(400) };
    const result = resolveContext(baseInput({ taskType: "pr_pitch", docs, tokenBudget: 1500 }));
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.included).toBe(true);
    expect(history.mode).toBe("outline");
    expect(history.reason).toMatch(/token budget/i);
    expect(result.includedTokens).toBeLessThanOrEqual(1500);
    expect(result.overBudget).toBe(false);
  });

  it("never drops channel guidance: constitutional overflow flags overBudget instead", () => {
    const docs = {
      soul: "soul ".repeat(1200),
      icp: "icp ".repeat(1200),
      voice: "voice ".repeat(1200),
      history: "history ".repeat(1200),
      now: "now ".repeat(1200),
    };
    const result = resolveContext(baseInput({ docs, tokenBudget: 4000 }));
    const channel = result.sections.find((s) => s.key === "channel")!;
    expect(channel.included).toBe(true);
    expect(result.overBudget).toBe(true);
  });

  it("flags overBudget instead of silently cutting protected sections", () => {
    const docs = { ...fullDocs, soul: "soul ".repeat(5000) };
    const result = resolveContext(baseInput({ docs, tokenBudget: 1000 }));
    expect(result.overBudget).toBe(true);
    const soul = result.sections.find((s) => s.key === "org:soul")!;
    expect(soul.included).toBe(true);
  });

  it("assembles the prompt from included sections only", () => {
    const result = resolveContext(baseInput({ docs: { ...fullDocs, history: "" } }));
    expect(result.prompt).toContain(fullDocs.soul.trim());
    expect(result.prompt).not.toContain("## History");
    expect(result.prompt).toContain(TASK_INSTRUCTIONS.linkedin_post);
  });

  it("places the signal section after persona and before task when given", () => {
    const result = resolveContext(
      baseInput({
        taskType: "signal_response",
        signal: {
          content: "Thread: why does all AI content sound identical?",
          source: "reddit",
          sourceUrl: "https://reddit.com/r/marketing/abc",
        },
      }),
    );
    expect(result.sections.map((s) => s.key)).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "persona",
      "lead",
      "media_contact",
      "signal",
      "evidence",
      "task",
    ]);
    const signal = result.sections.find((s) => s.key === "signal")!;
    expect(signal.included).toBe(true);
    expect(signal.layer).toBe("signal");
    expect(signal.content).toContain("why does all AI content sound identical");
    expect(signal.content).toContain("reddit");
    expect(signal.content).toContain("https://reddit.com/r/marketing/abc");
  });

  it("marks the signal slot excluded when no signal is given", () => {
    const result = resolveContext(baseInput());
    const signal = result.sections.find((s) => s.key === "signal")!;
    expect(signal.included).toBe(false);
    expect(signal.reason).toMatch(/no signal/i);
  });

  it("has a signal_response task instruction that references the signal", () => {
    expect(TASK_INSTRUCTIONS.signal_response).toMatch(/signal/i);
  });

  it("places the evidence section after signal and before task when chunks are given", () => {
    const result = resolveContext(
      baseInput({
        evidence: {
          query: "GTM memory layer linkedin_post",
          chunks: [
            { text: "Our churn dropped 30% after the brain rollout.", title: "Case study notes", documentId: "d1", kind: "manual", score: 0.82, recencyScore: 0.9, sourceWeight: 1, finalScore: 0.8 },
            { text: "Positioning doc: GTM that remembers.", title: "Website copy", documentId: "d2", kind: "manual", score: 0.74, recencyScore: 0.8, sourceWeight: 1, finalScore: 0.7 },
          ],
        },
      }),
    );
    expect(result.sections.map((s) => s.key)).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "persona",
      "lead",
      "media_contact",
      "signal",
      "evidence",
      "task",
    ]);
    const evidence = result.sections.find((s) => s.key === "evidence")!;
    expect(evidence.included).toBe(true);
    expect(evidence.layer).toBe("evidence");
    expect(evidence.content).toContain("[1] Our churn dropped 30%");
    expect(evidence.content).toContain("[2] Positioning doc");
    expect(evidence.content).toContain("Sources:");
    expect(evidence.content).toContain("[1] Case study notes");
    expect(evidence.reason).toContain("GTM memory layer");
  });

  it("marks the evidence slot excluded with the given reason when absent", () => {
    const result = resolveContext(
      baseInput({ evidenceExclusionReason: "Evidence store is not running." }),
    );
    const evidence = result.sections.find((s) => s.key === "evidence")!;
    expect(evidence.included).toBe(false);
    expect(evidence.reason).toContain("Evidence store is not running");
  });

  it("uses a default exclusion reason when no evidence and no reason given", () => {
    const result = resolveContext(baseInput());
    const evidence = result.sections.find((s) => s.key === "evidence")!;
    expect(evidence.included).toBe(false);
    expect(evidence.reason.length).toBeGreaterThan(0);
  });

  const evChunk = (id: string, finalScore: number) => ({
    text: `evidence ${id} ` + "lorem ipsum dolor ".repeat(20),
    title: `Doc ${id}`,
    documentId: id,
    kind: "manual" as const,
    score: 0.9,
    recencyScore: 1,
    sourceWeight: 1,
    finalScore,
  });

  it("degrades evidence chunk-by-chunk under a tight budget, keeping protected sections", () => {
    const chunks = [evChunk("a", 0.95), evChunk("b", 0.9), evChunk("c", 0.85)];
    const base = resolveContext(baseInput({ tokenBudget: 100_000 })).includedTokens;
    const evAll = resolveContext(
      baseInput({ evidence: { query: "q", chunks }, tokenBudget: 100_000 }),
    ).sections.find((s) => s.key === "evidence")!.tokens;

    const result = resolveContext(
      baseInput({ evidence: { query: "q", chunks }, tokenBudget: base + Math.floor(evAll / 2) }),
    );
    const evidence = result.sections.find((s) => s.key === "evidence")!;
    const trace = evidence.evidence!.chunks;
    expect(evidence.included).toBe(true);
    expect(trace.filter((c) => c.kept).length).toBeGreaterThan(0);
    expect(trace.filter((c) => c.kept).length).toBeLessThan(3);
    expect(trace[0]!.kept).toBe(true); // top-ranked survives
    expect(trace[2]!.kept).toBe(false); // lowest-ranked dropped first
    expect(trace.find((c) => !c.kept)!.exclusionReason).toMatch(/budget/i);
    expect(result.sections.find((s) => s.key === "org:soul")!.included).toBe(true);
  });

  it("excludes evidence entirely when no chunk fits, leaving protected sections", () => {
    const chunks = [evChunk("only", 0.9)];
    const base = resolveContext(baseInput({ tokenBudget: 100_000 })).includedTokens;
    const result = resolveContext(
      baseInput({ evidence: { query: "q", chunks }, tokenBudget: base }),
    );
    const evidence = result.sections.find((s) => s.key === "evidence")!;
    expect(evidence.included).toBe(false);
    expect(evidence.reason).toMatch(/budget/i);
    expect(result.sections.find((s) => s.key === "org:soul")!.included).toBe(true);
  });

  it("places the lead section after persona and before signal when given", () => {
    const result = resolveContext(
      baseInput({
        taskType: "outbound_email",
        channel: "email",
        lead: {
          name: "Asha Patel",
          company: "Acme Robotics",
          role: "Head of Growth",
          notes: "Complained about generic AI content on LinkedIn last week.",
        },
      }),
    );
    const keys = result.sections.map((s) => s.key);
    expect(keys.indexOf("lead")).toBe(keys.indexOf("persona") + 1);
    expect(keys.indexOf("lead")).toBe(keys.indexOf("media_contact") - 1);
    const lead = result.sections.find((s) => s.key === "lead")!;
    expect(lead.included).toBe(true);
    expect(lead.layer).toBe("lead");
    expect(lead.content).toContain("Asha Patel");
    expect(lead.content).toContain("Acme Robotics");
    expect(lead.content).toContain("Head of Growth");
    expect(lead.content).toContain("Complained about generic AI content");
  });

  it("marks the lead slot excluded when no lead is given", () => {
    const result = resolveContext(baseInput());
    const lead = result.sections.find((s) => s.key === "lead")!;
    expect(lead.included).toBe(false);
    expect(lead.reason).toMatch(/no lead/i);
  });

  it("has an outbound_email instruction that forbids invented personalization", () => {
    expect(TASK_INSTRUCTIONS.outbound_email).toMatch(/subject/i);
    expect(TASK_INSTRUCTIONS.outbound_email).toMatch(/invent|fabricat|only.*lead/i);
  });

  it("places the media contact section after lead and before signal when given", () => {
    const result = resolveContext(
      baseInput({
        taskType: "pr_pitch",
        channel: "pr",
        mediaContact: {
          name: "Riya Sen",
          type: "journalist",
          outlet: "TechCrunch India",
          beat: "AI startups and developer tools",
          coverageNotes: "Wrote about GTM tooling consolidation in May.",
        },
      }),
    );
    const keys = result.sections.map((s) => s.key);
    expect(keys.indexOf("media_contact")).toBe(keys.indexOf("lead") + 1);
    expect(keys.indexOf("media_contact")).toBe(keys.indexOf("signal") - 1);
    const contact = result.sections.find((s) => s.key === "media_contact")!;
    expect(contact.included).toBe(true);
    expect(contact.layer).toBe("contact");
    expect(contact.content).toContain("Riya Sen");
    expect(contact.content).toContain("TechCrunch India");
    expect(contact.content).toContain("AI startups and developer tools");
    expect(contact.content).toContain("GTM tooling consolidation");
    expect(contact.reason).toMatch(/never invent/i);
    expect(result.prompt).toContain("Riya Sen");
  });

  it("marks the media contact slot excluded when none is given", () => {
    const result = resolveContext(baseInput());
    const contact = result.sections.find((s) => s.key === "media_contact")!;
    expect(contact.included).toBe(false);
    expect(contact.reason).toMatch(/no media contact/i);
  });

  it("composes a distinct pr_pitch instruction per pitch type", () => {
    const announcement = composePrPitchInstruction("announcement");
    const thought = composePrPitchInstruction("thought_leadership");
    const reactive = composePrPitchInstruction("reactive");
    expect(new Set([announcement, thought, reactive]).size).toBe(3);
    for (const instruction of [announcement, thought, reactive]) {
      expect(instruction).toMatch(/subject/i);
      expect(instruction).toMatch(/never invent/i);
      expect(instruction).toMatch(/beat/i);
    }
    expect(announcement).toMatch(/news/i);
    expect(thought).toMatch(/source|point of view/i);
    expect(reactive).toMatch(/signal/i);
    expect(reactive).toMatch(/timeliness/i);
  });

  it("has static instructions and channel guidance for the PR slice", () => {
    expect(TASK_INSTRUCTIONS.pr_pitch).toBe(composePrPitchInstruction("announcement"));
    expect(TASK_INSTRUCTIONS.press_boilerplate).toMatch(/One-liner/);
    expect(TASK_INSTRUCTIONS.press_boilerplate).toMatch(/About/);
    expect(TASK_INSTRUCTIONS.press_boilerplate).toMatch(/Key facts/);
    expect(CHANNEL_GUIDANCE_DEFAULTS.pr).toMatch(/journalist/i);
  });

  it("is deterministic", () => {
    const input = baseInput({
      persona: { name: "CEO", description: "d", overlay: "o" },
      tokenBudget: 6000,
    });
    expect(resolveContext(input)).toEqual(resolveContext(input));
  });
});

describe("generation quality sections (Sprint 22)", () => {
  it("does not add angle/review sections when neither is set", () => {
    const keys = resolveContext(baseInput()).sections.map((s) => s.key);
    expect(keys).not.toContain("angle");
    expect(keys).not.toContain("review_subject");
  });

  it("inserts the angle section immediately before task", () => {
    const result = resolveContext(baseInput({ angle: "Lead with the contrarian take." }));
    const keys = result.sections.map((s) => s.key);
    expect(keys).toContain("angle");
    expect(keys.indexOf("angle")).toBe(keys.indexOf("task") - 1);
    const angle = result.sections.find((s) => s.key === "angle")!;
    expect(angle.layer).toBe("angle");
    expect(angle.included).toBe(true);
    expect(result.prompt).toContain("Lead with the contrarian take.");
  });

  it("inserts the review_subject section before task", () => {
    const result = resolveContext(baseInput({ reviewSubject: "Here is the draft to judge." }));
    const keys = result.sections.map((s) => s.key);
    expect(keys).toContain("review_subject");
    expect(keys.indexOf("review_subject")).toBeLessThan(keys.indexOf("task"));
    const subject = result.sections.find((s) => s.key === "review_subject")!;
    expect(subject.layer).toBe("review");
    expect(result.prompt).toContain("Here is the draft to judge.");
  });

  it("orders angle before review_subject before task when both are set", () => {
    const result = resolveContext(
      baseInput({ angle: "the angle", reviewSubject: "the draft" }),
    );
    const keys = result.sections.map((s) => s.key);
    expect(keys.indexOf("angle")).toBeLessThan(keys.indexOf("review_subject"));
    expect(keys.indexOf("review_subject")).toBe(keys.indexOf("task") - 1);
  });

  it("composes an angle instruction naming the count and the ANGLE prefix", () => {
    const instruction = composeAngleInstruction("linkedin_post", "linkedin", 4);
    expect(instruction).toContain("ANGLE: ");
    expect(instruction).toMatch(/EXACTLY 4/);
    expect(instruction).toMatch(/distinct/i);
  });

  it("composes distinct brand-voice and channel-fit reviewer instructions", () => {
    const brand = composeBrandVoiceReviewInstruction();
    const fit = composeChannelFitReviewInstruction("linkedin");
    expect(brand).not.toBe(fit);
    for (const instruction of [brand, fit]) {
      expect(instruction).toContain("SCORE:");
      expect(instruction).toContain("ISSUES:");
    }
    expect(brand).toMatch(/voice/i);
    expect(fit).toMatch(/linkedin/i);
  });
});

// ---------------------------------------------------------------------------
// Resolver v2 — tiered selective context (Sprint 43)
// ---------------------------------------------------------------------------

// Big enough to clear the small-doc escape hatch (> 600 tokens), with real
// H2 sections so outline + zoom have something to work with.
const PAD = " This paragraph is deliberate filler prose to push the document past the small-doc escape hatch so outline mode engages.".repeat(14);

const bigHistory = [
  `## Launch of reporting dashboards\n\nWe shipped weekly reporting dashboards in March. Agencies loved the export.${PAD}`,
  `## Pricing experiment\n\nWe tested usage-based pricing in April. Churn dropped for small agencies.${PAD}`,
  `## Conference talk\n\nThe founder spoke at SaaSCon about onboarding.${PAD}`,
].join("\n\n");

const bigIcp = [
  `## Founder-led SaaS\n\nSmall GTM teams, positioning still in the founder's head.${PAD}`,
  `## Marketing agencies\n\nAgencies drowning in weekly reporting busywork for clients.${PAD}`,
].join("\n\n");

const bigDocs = { ...fullDocs, history: bigHistory, icp: bigIcp };

describe("resolver v2: task matrix (tier 2)", () => {
  it("renders large icp/history as outlines for a linkedin_post, with tier + mode traced", () => {
    const result = resolveContext(baseInput({ docs: bigDocs }));
    const icp = result.sections.find((s) => s.key === "org:icp")!;
    const history = result.sections.find((s) => s.key === "org:history")!;
    for (const section of [icp, history]) {
      expect(section.included).toBe(true);
      expect(section.mode).toBe("outline");
      expect(section.tier).toBe(2);
      expect(section.title).toMatch(/\(outline\)$/);
      expect(section.content).toMatch(/^- /m);
      expect(section.reason).toMatch(/tier 2, task matrix/);
    }
    // Outlines are dramatically smaller than the docs they map.
    expect(icp.tokens).toBeLessThan(estimateTokens(bigIcp) / 4);
    const soul = result.sections.find((s) => s.key === "org:soul")!;
    expect(soul.tier).toBe(1);
    expect(soul.mode).toBe("full");
    expect(soul.reason).toMatch(/tier 1, constitutional/);
  });

  it("keeps small docs whole even in outline mode (escape hatch)", () => {
    const result = resolveContext(baseInput());
    const icp = result.sections.find((s) => s.key === "org:icp")!;
    expect(icp.mode).toBe("full");
    expect(icp.content).toBe(fullDocs.icp.trim());
    expect(icp.reason).toMatch(/included whole/);
  });

  it("omits docs the matrix says to omit, with the cell reason in the trace", () => {
    const result = resolveContext(baseInput({ taskType: "engagement_reply", docs: bigDocs }));
    const icp = result.sections.find((s) => s.key === "org:icp")!;
    expect(icp.included).toBe(false);
    expect(icp.mode).toBe("omit");
    expect(icp.reason).toMatch(/omitted for engagement_reply/);
    expect(result.prompt).not.toContain("Marketing agencies");
  });

  it("honors a workspace matrix override and labels its source", () => {
    const matrix = defaultResolvedMatrix();
    matrix.linkedin_post.history = {
      mode: "full",
      reason: "We want the whole story in every post.",
      source: "workspace",
    };
    const result = resolveContext(baseInput({ docs: bigDocs, matrix }));
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.mode).toBe("full");
    expect(history.content).toBe(bigHistory.trim());
    expect(history.reason).toMatch(/workspace override/);
    expect(history.reason).toContain("We want the whole story in every post.");
  });
});

describe("resolver v2: zoom (tier 3)", () => {
  const signalInput = () =>
    baseInput({
      docs: bigDocs,
      signal: {
        content: "Thread about usage-based pricing and churn for agencies",
        source: "reddit",
      },
    });

  it("pulls matching sections in full, after persona and before lead, with scores", () => {
    const result = resolveContext(signalInput());
    const keys = result.sections.map((s) => s.key);
    const pricing = result.sections.find((s) => s.key === "zoom:history:pricing-experiment")!;
    expect(pricing).toBeDefined();
    expect(pricing.included).toBe(true);
    expect(pricing.tier).toBe(3);
    expect(pricing.layer).toBe("zoom");
    expect(pricing.zoom!.score).toBeGreaterThan(0);
    expect(pricing.title).toBe("History § Pricing experiment");
    expect(pricing.content).toContain("usage-based pricing in April");
    // Placement: stable prefix (…persona) → zoom → volatile payload (lead…).
    expect(keys.indexOf("zoom:history:pricing-experiment")).toBeGreaterThan(keys.indexOf("persona"));
    expect(keys.indexOf("zoom:history:pricing-experiment")).toBeLessThan(keys.indexOf("lead"));
    // The composed query is traced and folds in the signal.
    expect(result.zoomQuery).toContain("usage-based pricing");
    // The outline section says how many sections were pulled.
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.reason).toMatch(/\d+ of 3 sections zoomed in below/);
  });

  it("adds no zoom sections when nothing matches, and says so", () => {
    const result = resolveContext(
      baseInput({ docs: bigDocs, signal: { content: "quantum blockchain metaverse", source: "hn" } }),
    );
    expect(result.sections.some((s) => s.layer === "zoom")).toBe(false);
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.reason).toMatch(/no sections matched the zoom query/);
  });

  it("uses stored outlines (LLM summaries) when provided", () => {
    const result = resolveContext(
      baseInput({
        docs: bigDocs,
        outlines: {
          history: {
            generatedAt: 1,
            sections: [
              {
                id: "pricing-experiment",
                parentId: null,
                heading: "Pricing experiment",
                level: 2,
                summary: "CUSTOM LLM SUMMARY OF PRICING",
                summarySource: "llm",
                tokens: 40,
              },
            ],
          },
        },
      }),
    );
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.content).toContain("CUSTOM LLM SUMMARY OF PRICING");
  });

  it("drops zoomed sections (lowest score first) before demoting anything (budget ladder)", () => {
    const generous = resolveContext(signalInput());
    const zoomed = generous.sections.filter((s) => s.layer === "zoom" && s.included);
    expect(zoomed.length).toBeGreaterThan(0);
    // Budget just below what the generous bundle needs forces the ladder to
    // shed zoom sections; org outlines must survive.
    const tight = resolveContext({ ...signalInput(), tokenBudget: generous.includedTokens - 50 });
    const tightZoomed = tight.sections.filter((s) => s.layer === "zoom");
    expect(tightZoomed.some((s) => !s.included)).toBe(true);
    const droppedFirst = [...tightZoomed].sort((a, b) => a.zoom!.score - b.zoom!.score)[0]!;
    expect(droppedFirst.included).toBe(false);
    expect(droppedFirst.reason).toMatch(/token budget/);
    expect(tight.sections.find((s) => s.key === "org:history")!.included).toBe(true);
    expect(tight.sections.find((s) => s.key === "channel")!.included).toBe(true);
  });
});

describe("resolver v2: brief mode (angle step)", () => {
  it("demotes matrix-full docs to outline, skips zoom, and flags the mode", () => {
    const result = resolveContext(
      baseInput({
        taskType: "pr_pitch",
        docs: bigDocs,
        resolveMode: "brief",
        signal: { content: "usage-based pricing churn agencies", source: "reddit" },
      }),
    );
    expect(result.resolveMode).toBe("brief");
    expect(result.zoomQuery).toBeUndefined();
    expect(result.sections.some((s) => s.layer === "zoom")).toBe(false);
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.mode).toBe("outline");
    expect(history.reason).toMatch(/brief mode/);
    const outlineNote = result.sections.find((s) => s.key === "org:icp")!;
    expect(outlineNote.reason).toMatch(/zoom off \(brief mode\)/);
  });

  it("draft mode is the default and is byte-identical for legacy inputs", () => {
    const result = resolveContext(baseInput());
    expect(result.resolveMode).toBe("draft");
  });
});
