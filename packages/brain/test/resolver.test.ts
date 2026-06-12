import { describe, expect, it } from "vitest";
import {
  CHANNEL_GUIDANCE,
  TASK_INSTRUCTIONS,
  composePrPitchInstruction,
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
      expect(CHANNEL_GUIDANCE[channel].length).toBeGreaterThan(0);
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

  it("uses the channel guidance for the requested channel", () => {
    const result = resolveContext(baseInput({ channel: "email" }));
    const channel = result.sections.find((s) => s.key === "channel")!;
    expect(channel.included).toBe(true);
    expect(channel.content).toBe(CHANNEL_GUIDANCE.email);
  });

  it("drops history first to fit a tight token budget", () => {
    const docs = { ...fullDocs, history: "history ".repeat(2000) };
    const result = resolveContext(baseInput({ docs, tokenBudget: 1500 }));
    const history = result.sections.find((s) => s.key === "org:history")!;
    expect(history.included).toBe(false);
    expect(history.reason).toMatch(/token budget/i);
    expect(result.includedTokens).toBeLessThanOrEqual(1500);
    expect(result.overBudget).toBe(false);
  });

  it("drops channel guidance after history if still over budget", () => {
    const docs = {
      soul: "soul ".repeat(1200),
      icp: "icp ".repeat(1200),
      voice: "voice ".repeat(1200),
      history: "history ".repeat(1200),
      now: "now ".repeat(1200),
    };
    const result = resolveContext(baseInput({ docs, tokenBudget: 4000 }));
    const channel = result.sections.find((s) => s.key === "channel")!;
    expect(channel.included).toBe(false);
    expect(channel.reason).toMatch(/token budget/i);
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
            { text: "Our churn dropped 30% after the brain rollout.", score: 0.82, documentId: "d1", title: "Case study notes" },
            { text: "Positioning doc: GTM that remembers.", score: 0.74, documentId: "d2", title: "Website copy" },
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
    expect(CHANNEL_GUIDANCE.pr).toMatch(/journalist/i);
  });

  it("is deterministic", () => {
    const input = baseInput({
      persona: { name: "CEO", description: "d", overlay: "o" },
      tokenBudget: 6000,
    });
    expect(resolveContext(input)).toEqual(resolveContext(input));
  });
});
