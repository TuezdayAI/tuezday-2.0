import type { ResolveInput } from "@tuezday/brain";
import type { Channel, CtaExpectation } from "@tuezday/contracts";
import type { ScriptedStep } from "../llm/scripted";

/**
 * The golden fixture the CI gate runs against (D-67.8).
 *
 * A live replay needs an API key, real workspace history and a non-deterministic
 * model. This is the same harness code driven by a scripted gateway over a
 * seeded workspace, so it runs offline in seconds and produces the same numbers
 * every time. Cases 2–5 are adversarial on purpose: each carries a scripted
 * output that must fail exactly one hard check, so softening a check shows up
 * as those cases starting to pass.
 */

export interface GoldenCase {
  id: string;
  signalContent: string;
  channel: Channel;
  /** Ground truth: what the founder did with the draft this signal produced. */
  history: { state: "approved" | "rejected"; originalContent: string; content: string };
  /** Four canned agent steps: research, angle, draft, critique. */
  script: ScriptedStep[];
  /** Fragments that must appear in the composed draft-step user message. */
  mustContain: string[];
  expect: { verdict: "pass" | "flag"; failedChecks: string[] };
}

export const GOLDEN_BANNED_CLAIMS = ["the only platform that", "guaranteed results"];
export const GOLDEN_CTA_EXPECTATION: CtaExpectation = "any";

const CITATION_FROM_GOAL = "Retrieve before you judge";

function agentStep(output: unknown): ScriptedStep {
  return { text: JSON.stringify(output) };
}

function steps(draftContent: string, findings: Array<{ issue: string; citation: string }>) {
  return [
    agentStep({
      summary: "Competitor moved to usage-based pricing.",
      keyFacts: ["The competitor published a usage-based pricing page."],
      sources: [],
    }),
    agentStep({
      angles: [{ title: "What usage pricing signals", rationale: "Buyers read pricing as strategy." }],
    }),
    agentStep({ content: draftContent }),
    agentStep({ score: 90, findings, guardrailUncertain: false }),
  ];
}

const CLEAN_DRAFT =
  "A competitor just moved to usage-based pricing. That is not a pricing change, it is a " +
  "positioning change: they are betting their buyers would rather start small than commit " +
  "up front. Worth reading their pricing page as a strategy document.";

/** Over LinkedIn's 3000-character body limit, and nothing else. */
const LONG_DRAFT = "Usage-based pricing changes how buyers evaluate you. ".repeat(60);

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: "clean-approved",
    signalContent: "A competitor published a usage-based pricing page this morning.",
    channel: "linkedin",
    history: {
      state: "approved",
      originalContent: "Competitor moved to usage-based pricing. Here is what it signals.",
      content: "Competitor moved to usage-based pricing. Here is what it signals.",
    },
    script: steps(CLEAN_DRAFT, [
      {
        issue: "Could name the segment more precisely.",
        citation: `${CITATION_FROM_GOAL} — never critique from memory.`,
      },
    ]),
    mustContain: [
      "## Triggering signal",
      "A competitor published a usage-based pricing page this morning.",
      "## Target channel",
      "## Prior examples from approval history",
      "## Prior step outputs",
    ],
    expect: { verdict: "pass", failedChecks: [] },
  },
  {
    id: "banned-claim",
    signalContent: "A rival announced a partnership with a large cloud vendor.",
    channel: "linkedin",
    history: {
      state: "rejected",
      originalContent: "We are the only platform that does this properly.",
      content: "We are the only platform that does this properly.",
    },
    script: steps(
      "A rival announced a cloud partnership today. We are the only platform that " +
        "connects this to revenue, and that is why the announcement matters to operators.",
      [],
    ),
    mustContain: ["## Triggering signal", "## Prior examples from approval history"],
    expect: { verdict: "flag", failedChecks: ["banned_claims"] },
  },
  {
    id: "over-length",
    signalContent: "Pricing pages across the category shifted to usage tiers this quarter.",
    channel: "linkedin",
    history: {
      state: "rejected",
      originalContent: "Far too long a post about pricing tiers to publish anywhere.",
      content: "Far too long a post about pricing tiers to publish anywhere.",
    },
    script: steps(LONG_DRAFT, []),
    mustContain: ["## Triggering signal", "## Prior examples from approval history"],
    expect: { verdict: "flag", failedChecks: ["length_bounds"] },
  },
  {
    id: "placeholder-leak",
    signalContent: "A prospect asked publicly how our onboarding compares to the incumbent.",
    channel: "linkedin",
    history: {
      state: "rejected",
      originalContent: "Draft that shipped a template placeholder to the review queue.",
      content: "Draft that shipped a template placeholder to the review queue.",
    },
    script: steps(
      "Onboarding comparisons come up constantly. [insert customer name] moved off the " +
        "incumbent in under a week, and the reason was not features — it was the first day.",
      [],
    ),
    mustContain: ["## Triggering signal", "## Prior examples from approval history"],
    expect: { verdict: "flag", failedChecks: ["placeholder_leak"] },
  },
  {
    id: "fabricated-citation",
    signalContent: "An analyst report on category consolidation landed this week.",
    channel: "linkedin",
    history: {
      state: "rejected",
      originalContent: "Draft whose critique cited a guardrail that does not exist.",
      content: "Draft whose critique cited a guardrail that does not exist.",
    },
    script: steps(
      "The analyst report on consolidation is less interesting than what it leaves out: " +
        "nobody is asking what happens to the buyers stranded mid-migration.",
      [
        {
          issue: "Opens too abruptly for this channel.",
          citation:
            "Workspace guardrail 14b: posts must open with a named customer outcome within twelve words.",
        },
      ],
    ),
    mustContain: ["## Triggering signal", "## Prior examples from approval history"],
    expect: { verdict: "flag", failedChecks: ["citation_validity"] },
  },
];

/**
 * The resolver half of the gate. The engine composes its own step prompts and
 * never calls the resolver, so without this a resolver change — a section that
 * stops being pushed, a reordered ladder — would sail through CI (the PRD names
 * the resolver explicitly). `resolveContext` is pure, so a fixed input digests
 * to a fixed prompt.
 */
export const GOLDEN_RESOLVER_INPUT: ResolveInput = {
  workspaceName: "Hexalog",
  docs: {
    soul: "We exist to end GTM amnesia — every team relearns its own positioning every quarter.",
    icp: "Founder-led B2B SaaS between seed and Series B, with a GTM team of fewer than eight.",
    voice: "Direct, technical, specific. Never corporate. Name the mechanism, not the benefit.",
    history: "Rebuilt the platform in June 2026 around a central brain and a context resolver.",
    now: "This quarter we are proving that the agentic path beats the single-shot generator.",
  },
  taskType: "signal_response",
  channel: "linkedin",
  channelGuidance: {
    content: "Open with the observation, not the pitch. Never open with a call to action.",
    source: "workspace",
  },
  signal: {
    content: "A competitor published a usage-based pricing page this morning.",
    source: "other",
    sourceUrl: null,
  },
  examples: {
    query: "usage-based pricing",
    approved: [{ content: "Pricing is positioning. Read their page as a strategy doc.", wasEdited: false }],
    rejected: [
      {
        content: "Big news! Our competitor changed pricing. Book a demo to learn more.",
        reason: "Never pitch on a competitor's news day.",
        outcome: "rejected",
      },
    ],
  },
};

/** Fragments the resolved legacy prompt must still contain. */
export const GOLDEN_RESOLVER_MUST_CONTAIN = [
  "Never open with a call to action.",
  "Prior examples from your approval history",
  "A competitor published a usage-based pricing page this morning.",
  "end GTM amnesia",
];
