import {
  BRAIN_DOC_TYPES,
  DEFAULT_TOKEN_BUDGET,
  type Channel,
  type TaskType,
} from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainContents } from "./index";

// ---------------------------------------------------------------------------
// Built-in defaults. Channel guidance becomes editable in a later slice;
// task instructions are shared with the Sprint 4 generation sandbox.
// ---------------------------------------------------------------------------

export const CHANNEL_GUIDANCE: Record<Channel, string> = {
  linkedin:
    "Channel: LinkedIn. Professional but human feed. Strong first line (it gets truncated). Short paragraphs, no hashtag walls, no engagement bait. Posts that read like a person, not a brand bulletin.",
  x: "Channel: X (Twitter). Compressed, punchy, idea-first. One thought per post. Threads only when each post stands alone. No corporate phrasing.",
  email:
    "Channel: Email. One reader at a time. Subject and opener decide everything. Short lines, one clear ask, no marketing gloss. Write like a competent person, not a campaign.",
  ads: "Channel: Paid ads. Hook, promise, proof, action - in very few words. One message per variant. Clarity beats cleverness.",
  web: "Channel: Website. Visitors scan. Headline carries the positioning, subhead carries the proof. Concrete claims over adjectives.",
};

export const TASK_INSTRUCTIONS: Record<TaskType, string> = {
  linkedin_post:
    "Task: Write one LinkedIn post grounded in the context above. Use the company's voice and the persona's point of view if one is set. Lead with the sharpest insight, keep it under 200 words, end without a cringe call-to-action. Return only the post text itself - no preamble, labels, or commentary.",
  cold_email_opener:
    "Task: Write the opening two sentences of a cold email grounded in the context above. Make it specific to the ICP's pain, sound human, and earn the next sentence. No flattery openers, no 'I hope this finds you well'. Return only the two sentences - no preamble or commentary.",
  ad_copy_variant:
    "Task: Write one ad copy variant (headline + primary text) grounded in the context above. One message, one promise, proof if available, plain action. Return only the headline and primary text - no preamble or commentary.",
  landing_page_hero:
    "Task: Write a landing page hero (headline + subheadline) grounded in the context above. Headline states the positioning in the company's voice; subheadline makes it concrete and credible. Return only the headline and subheadline - no preamble or commentary.",
  signal_response:
    "Task: Write a response to the market signal above, for the requested channel, grounded in the company context. Engage with what the signal actually says - agree, push back, or add the company's earned point of view. Never sound like a brand inserting itself; sound like someone worth listening to. Return only the response text - no preamble or commentary.",
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ContextLayer =
  | "org"
  | "channel"
  | "campaign"
  | "persona"
  | "signal"
  | "evidence"
  | "task";

export interface ResolvePersona {
  name: string;
  description: string;
  overlay: string;
}

export interface ResolveCampaign {
  name: string;
  overlay: string;
}

export interface ResolveSignal {
  content: string;
  source: string;
  sourceUrl?: string | null;
}

export interface EvidenceChunk {
  text: string;
  score: number;
  documentId: string;
  title: string;
}

export interface ResolveEvidence {
  /** The retrieval query Tuezday composed — shown in the trace. */
  query: string;
  chunks: EvidenceChunk[];
}

export interface ResolveInput {
  workspaceName: string;
  docs: BrainContents;
  taskType: TaskType;
  channel: Channel;
  persona?: ResolvePersona;
  campaign?: ResolveCampaign;
  signal?: ResolveSignal;
  evidence?: ResolveEvidence;
  /** Why evidence is absent (store down, no docs, toggled off) — shown in the trace. */
  evidenceExclusionReason?: string;
  tokenBudget?: number;
}

export interface ContextSection {
  key: string;
  layer: ContextLayer;
  title: string;
  content: string;
  included: boolean;
  reason: string;
  tokens: number;
}

export interface ResolvedContext {
  sections: ContextSection[];
  includedTokens: number;
  tokenBudget: number;
  overBudget: boolean;
  prompt: string;
}

/** Rough token estimate: ~4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sections that may be dropped (whole) to fit the token budget, in sacrifice
 * order. Everything else is protected: going over budget sets `overBudget`
 * instead of silently cutting the docs that define the company.
 */
const BUDGET_SACRIFICE_ORDER = ["org:history", "channel"] as const;

export function resolveContext(input: ResolveInput): ResolvedContext {
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const sections: ContextSection[] = [];

  for (const docType of BRAIN_DOC_TYPES) {
    const meta = BRAIN_DOC_META.find((m) => m.docType === docType)!;
    const content = input.docs[docType].trim();
    sections.push({
      key: `org:${docType}`,
      layer: "org",
      title: meta.title,
      content,
      included: content.length > 0,
      reason:
        content.length > 0
          ? `Org brain: ${meta.description}`
          : `Excluded: the ${meta.title} doc is empty.`,
      tokens: estimateTokens(content),
    });
  }

  const channelContent = CHANNEL_GUIDANCE[input.channel];
  sections.push({
    key: "channel",
    layer: "channel",
    title: `Channel: ${input.channel}`,
    content: channelContent,
    included: true,
    reason: `Built-in default guidance for the ${input.channel} channel.`,
    tokens: estimateTokens(channelContent),
  });

  const campaignContent = input.campaign?.overlay.trim() ?? "";
  sections.push({
    key: "campaign",
    layer: "campaign",
    title: input.campaign ? `Campaign: ${input.campaign.name}` : "Campaign",
    content: campaignContent,
    included: campaignContent.length > 0,
    reason:
      campaignContent.length > 0
        ? `Campaign overlay for "${input.campaign!.name}".`
        : "Excluded: no campaign overlay yet (campaigns arrive in a later slice).",
    tokens: estimateTokens(campaignContent),
  });

  if (input.persona) {
    const lines = [`Speaking as: ${input.persona.name}.`];
    if (input.persona.description.trim()) lines.push(input.persona.description.trim());
    if (input.persona.overlay.trim()) lines.push(input.persona.overlay.trim());
    const personaContent = lines.join("\n\n");
    sections.push({
      key: "persona",
      layer: "persona",
      title: `Persona: ${input.persona.name}`,
      content: personaContent,
      included: true,
      reason: `Persona overlay "${input.persona.name}" adjusts voice and point of view.`,
      tokens: estimateTokens(personaContent),
    });
  } else {
    sections.push({
      key: "persona",
      layer: "persona",
      title: "Persona",
      content: "",
      included: false,
      reason: "Excluded: no persona selected; org voice applies.",
      tokens: 0,
    });
  }

  if (input.signal) {
    const attribution = [`Source: ${input.signal.source}`];
    if (input.signal.sourceUrl) attribution.push(input.signal.sourceUrl);
    const signalContent = `${input.signal.content.trim()}\n\n(${attribution.join(" — ")})`;
    sections.push({
      key: "signal",
      layer: "signal",
      title: "Market signal",
      content: signalContent,
      included: true,
      reason: `The ${input.signal.source} signal this task responds to.`,
      tokens: estimateTokens(signalContent),
    });
  } else {
    sections.push({
      key: "signal",
      layer: "signal",
      title: "Market signal",
      content: "",
      included: false,
      reason: "Excluded: no signal attached to this task.",
      tokens: 0,
    });
  }

  if (input.evidence && input.evidence.chunks.length > 0) {
    const lines = input.evidence.chunks.map((c, i) => `[${i + 1}] ${c.text.trim()}`);
    const sources = input.evidence.chunks.map((c, i) => `[${i + 1}] ${c.title}`);
    const evidenceContent = `${lines.join("\n\n")}\n\nSources:\n${sources.join("\n")}`;
    sections.push({
      key: "evidence",
      layer: "evidence",
      title: "Evidence",
      content: evidenceContent,
      included: true,
      reason: `Retrieved ${input.evidence.chunks.length} evidence chunk(s) for query: "${input.evidence.query}". Ground claims in this evidence.`,
      tokens: estimateTokens(evidenceContent),
    });
  } else {
    sections.push({
      key: "evidence",
      layer: "evidence",
      title: "Evidence",
      content: "",
      included: false,
      reason: `Excluded: ${input.evidenceExclusionReason ?? "no evidence retrieved for this task."}`,
      tokens: 0,
    });
  }

  const taskContent = TASK_INSTRUCTIONS[input.taskType];
  sections.push({
    key: "task",
    layer: "task",
    title: `Task: ${input.taskType}`,
    content: taskContent,
    included: true,
    reason: "Task instruction: always included, always last.",
    tokens: estimateTokens(taskContent),
  });

  // Token budget: drop sacrificial sections whole, in order, until we fit.
  const includedTotal = () =>
    sections.filter((s) => s.included).reduce((sum, s) => sum + s.tokens, 0);

  for (const key of BUDGET_SACRIFICE_ORDER) {
    if (includedTotal() <= tokenBudget) break;
    const section = sections.find((s) => s.key === key)!;
    if (section.included) {
      const over = includedTotal() - tokenBudget;
      section.included = false;
      section.reason = `Excluded: dropped to fit the token budget (bundle was ${over} tokens over).`;
    }
  }

  const includedTokens = includedTotal();
  const prompt = sections
    .filter((s) => s.included)
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join("\n\n");

  return {
    sections,
    includedTokens,
    tokenBudget,
    overBudget: includedTokens > tokenBudget,
    prompt,
  };
}
