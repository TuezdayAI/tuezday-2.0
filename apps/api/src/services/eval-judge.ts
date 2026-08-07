import { evalRubricSchema, type Channel, type EvalRubric } from "@tuezday/contracts";
import type { LlmGateway } from "../llm/gateway";
import { generateStructured } from "../llm/structured";

/**
 * The rubric half of the harness. Reported and trended, never a CI gate
 * (D-67.4): CI has no gateway and no key, so a number it cannot compute must
 * not be allowed to block a merge.
 */

export interface JudgeInput {
  /** The replayed draft under judgement. */
  content: string;
  channel: Channel;
  /** The signal that triggered it — specificity is judged against this. */
  signalContent: string;
  /** The channel's voice/content guidance in effect. */
  guidance: string;
  /** What the founder actually shipped for this signal, as the reference. */
  founderFinalContent: string;
  /** How the founder ruled on the original draft, and why when they said. */
  founderOutcome: string;
  founderReason: string | null;
}

const DIMENSIONS = [
  ["voiceFit", "Does it sound like this company's own writing, per the guidance below?"],
  ["specificity", "Is it concrete and grounded in the signal, or generic filler?"],
  ["channelFit", "Is the length, format, and register right for the channel?"],
  ["brandSafety", "Would publishing this embarrass the company or overclaim?"],
  ["actionability", "Does a reader come away with something to do or think?"],
] as const;

function composePrompt(input: JudgeInput): string {
  return [
    "You are grading a generated social post against a rubric. You are not rewriting it.",
    "",
    "## Triggering signal",
    input.signalContent,
    "",
    `## Channel`,
    input.channel,
    "",
    "## Voice and content guidance in effect",
    input.guidance || "(none recorded)",
    "",
    "## Reference — what the founder actually published for this signal",
    input.founderFinalContent,
    "",
    `## What the founder did with the original draft: ${input.founderOutcome}`,
    input.founderReason ? `Their stated reason: ${input.founderReason}` : "No reason was recorded.",
    "",
    "## The draft you are grading",
    input.content,
    "",
    "## Rubric",
    ...DIMENSIONS.map(([key, question]) => `- ${key} (0–5): ${question}`),
    "",
    "Score each dimension 0–5 with a one-sentence justification, then give an overall 0–100.",
    "Judge the draft on its own merits against the guidance — the reference shows what this",
    "founder considers publishable, it is not a target to match word for word.",
    "Answer with JSON matching the required schema and nothing else.",
  ].join("\n");
}

/**
 * Never throws. A judge that fails degrades the case to unjudged (`null`)
 * rather than failing the eval run — a broken grader must not be able to
 * invalidate the deterministic half of the harness.
 */
export async function judgeDraft(llm: LlmGateway, input: JudgeInput): Promise<EvalRubric | null> {
  try {
    const result = await generateStructured(llm, evalRubricSchema, {
      prompt: composePrompt(input),
      tier: "frontier",
    });
    return result.value;
  } catch {
    return null;
  }
}
