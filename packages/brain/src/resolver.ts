import {
  AD_CREATIVE_FORMATS,
  BRAIN_DOC_TYPES,
  CHANNEL_GUIDANCE_DEFAULTS,
  DEFAULT_TOKEN_BUDGET,
  type AdCreativeTaskType,
  type Channel,
  type GuidanceSource,
  type MediaContactType,
  type PrPitchType,
  type TaskType,
} from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainContents } from "./index";

// ---------------------------------------------------------------------------
// Built-in defaults. Channel guidance defaults now live in @tuezday/contracts
// (CHANNEL_GUIDANCE_DEFAULTS) and are editable per workspace at runtime
// (Sprint 21); re-exported here so brain consumers keep one import site. Task
// instructions are shared with the Sprint 4 generation sandbox.
// ---------------------------------------------------------------------------

export { CHANNEL_GUIDANCE_DEFAULTS } from "@tuezday/contracts";

/**
 * Compose the pr_pitch task instruction for a pitch type. A shared spine
 * (subject + short body, personalize only from the contact facts, one
 * low-friction ask) plus the per-type angle - visible in the context trace
 * like any other section.
 */
export function composePrPitchInstruction(pitchType: PrPitchType): string {
  const angles: Record<PrPitchType, string> = {
    announcement:
      "Frame the company's news (see the campaign and Right Now context) as a story for this contact's beat and their outlet's readers - the angle is what it changes for them, not the announcement itself.",
    thought_leadership:
      "Pitch the sender as a source: one sharp, earned point of view from the company's history and convictions, relevant to this contact's beat, offered as expert comment or a contributed piece.",
    reactive:
      "Respond to the market signal above: offer the sender's specific take on the developing story, connect it to this contact's beat, and make the timeliness explicit without manufactured urgency.",
  };
  return (
    "Task: Write a short personalized media pitch email to the contact above: a subject line (prefix 'Subject: ') and a body of at most 150 words. " +
    `${angles[pitchType]} ` +
    "Personalize ONLY from the contact facts given - never invent past coverage, mutual contacts, or relationships. " +
    "Reference the contact's beat where it is genuinely relevant. One clear low-friction ask (an interview, a comment, the full story). " +
    "No flattery openers, no superlatives, no attachments mentioned. Return only the subject and body - no preamble or commentary."
  );
}

/**
 * Compose the task instruction for an ad creative task from the contract's
 * format table, so the limits in the prompt and the limits enforced at the
 * approval gate are provably the same numbers.
 */
export function composeAdCreativeInstruction(
  taskType: AdCreativeTaskType,
  variantCount?: number,
): string {
  const format = AD_CREATIVE_FORMATS[taskType];
  const fieldLines = format.fields.map((f) => {
    const occurrences =
      f.maxCount > 1
        ? `${f.label} 1: through ${f.label} ${f.maxCount}: (${f.maxCount} ${f.label.toLowerCase()}s, max ${f.maxChars} characters each)`
        : `${f.label}: (max ${f.maxChars} characters)`;
    return occurrences;
  });
  const count = variantCount ?? format.variantCount?.default;
  const opening = format.variantCount
    ? `Task: Write ${count} distinct ${format.label} variants grounded in the context above, each taking a different angle on the campaign's offer. Each variant uses exactly these labeled lines:`
    : `Task: Write one ${format.label} asset set grounded in the context above, as labeled lines (each headline must stand alone — Google mixes them in any order):`;
  const separator = format.variantCount
    ? " Separate variants with a line containing only ---."
    : "";
  return (
    `${opening}\n${fieldLines.join("\n")}\n` +
    `The character limits are hard platform limits - count characters and never exceed them.${separator} ` +
    `Return only the labeled lines${format.variantCount ? " and separators" : ""} - no preamble, numbering, or commentary.`
  );
}

// ---------------------------------------------------------------------------
// Generation quality (Sprint 22) — angle-first + dual-LLM pre-review.
// Each is composed as a task instruction and assembled through resolveContext,
// so the brain context the reviewer/angle step sees is the same inspectable
// bundle as a normal generation — never a hardcoded prompt.
// ---------------------------------------------------------------------------

/** Ask the model for N distinct one-line angles before drafting. */
export function composeAngleInstruction(
  taskType: TaskType,
  channel: Channel,
  count: number,
): string {
  return (
    `Task: Before drafting, propose ${count} genuinely DISTINCT angles for a ${taskType} on the ` +
    `${channel} channel, grounded in the context above. Each angle is ONE sentence naming the hook ` +
    "or lens — not the full draft. List the strongest angle FIRST. " +
    `Return EXACTLY ${count} lines, each prefixed with 'ANGLE: ' and nothing else — no preamble, ` +
    "numbering, or commentary."
  );
}

/** Brand-voice reviewer pass: judge voice/soul/positioning match only. */
export function composeBrandVoiceReviewInstruction(): string {
  return (
    "Task: You are a brand-voice editor. Judge ONLY how well the draft under review above matches " +
    "this company's voice, soul, and positioning as given in the context. Ignore length and channel " +
    "formatting — that is a separate review. Respond in EXACTLY this format and nothing else:\n" +
    "SCORE: <integer 0-100, where 100 is a perfect voice match>\n" +
    "ISSUES:\n- <one specific, actionable voice problem>\n" +
    "(If there are no issues, write '- none'. List at most 5 issues.)"
  );
}

/** Channel-fit reviewer pass: judge channel conventions only. */
export function composeChannelFitReviewInstruction(channel: Channel): string {
  return (
    `Task: You are a channel editor for the ${channel} channel. Judge ONLY how well the draft under ` +
    "review above fits the channel guidance above — length, format, hook, tone, and conventions. " +
    "Ignore brand-voice nuance — that is a separate review. Respond in EXACTLY this format and " +
    "nothing else:\n" +
    "SCORE: <integer 0-100, where 100 is a perfect fit>\n" +
    "ISSUES:\n- <one specific, actionable channel-fit problem>\n" +
    "(If there are no issues, write '- none'. List at most 5 issues.)"
  );
}

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
  outbound_email:
    "Task: Write a short personalized cold email to the lead above: a subject line (prefix 'Subject: ') and a body of at most 120 words. Personalize ONLY from the lead facts given - never invent meetings, mutual contacts, or details not in the data. Connect the lead's actual situation to the company's point of view, make one clear low-friction ask, and skip flattery openers. Return only the subject and body - no preamble or commentary.",
  meta_ad_creative: composeAdCreativeInstruction("meta_ad_creative"),
  google_rsa: composeAdCreativeInstruction("google_rsa"),
  pr_pitch: composePrPitchInstruction("announcement"),
  press_boilerplate:
    "Task: Write press boilerplate for the company from the context above, in three labeled parts: 'One-liner:' (a single factual sentence saying what the company is), 'About:' (a roughly 100-word about paragraph in the third person - factual, concrete, no superlatives), and 'Key facts:' (3-5 bullet lines starting with '- '). Ground every claim in the context - never invent numbers, customers, or dates. Return only the three labeled parts - no preamble or commentary.",
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ContextLayer =
  | "org"
  | "channel"
  | "campaign"
  | "persona"
  | "lead"
  | "contact"
  | "signal"
  | "evidence"
  | "angle"
  | "review"
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

export interface ResolveLead {
  name: string;
  company: string;
  role: string;
  notes: string;
}

export interface ResolveMediaContact {
  name: string;
  type: MediaContactType;
  outlet: string;
  beat: string;
  coverageNotes: string;
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
  lead?: ResolveLead;
  mediaContact?: ResolveMediaContact;
  signal?: ResolveSignal;
  evidence?: ResolveEvidence;
  /** Why evidence is absent (store down, no docs, toggled off) — shown in the trace. */
  evidenceExclusionReason?: string;
  /**
   * Replaces the static TASK_INSTRUCTIONS entry — used when the instruction is
   * composed per request (e.g. ad creative variant count). Visible in the
   * trace like any other section.
   */
  taskInstruction?: string;
  /**
   * The channel guidance to use and where it came from (Sprint 21). Omitted →
   * the resolver falls back to the built-in default for `channel`. The API
   * passes the workspace override here when one exists. Surfaced in the trace.
   */
  channelGuidance?: { content: string; source: GuidanceSource };
  /**
   * A chosen angle to draft from (Sprint 22 angle step). When set, becomes the
   * "angle" section, just before the task instruction.
   */
  angle?: string;
  /**
   * The draft text a reviewer pass is judging (Sprint 22 pre-review). When set,
   * becomes the "review_subject" section, just before the task instruction.
   */
  reviewSubject?: string;
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

  const guidance = input.channelGuidance ?? {
    content: CHANNEL_GUIDANCE_DEFAULTS[input.channel],
    source: "default" as const,
  };
  sections.push({
    key: "channel",
    layer: "channel",
    title: `Channel: ${input.channel}`,
    content: guidance.content,
    included: true,
    reason:
      guidance.source === "workspace"
        ? `Channel guidance for ${input.channel} (workspace override).`
        : `Channel guidance for ${input.channel} (built-in default).`,
    tokens: estimateTokens(guidance.content),
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

  if (input.lead) {
    const lines = [`To: ${input.lead.name}`];
    if (input.lead.role.trim() || input.lead.company.trim()) {
      lines.push(
        [input.lead.role.trim(), input.lead.company.trim()].filter(Boolean).join(" at "),
      );
    }
    if (input.lead.notes.trim()) lines.push(`What we know: ${input.lead.notes.trim()}`);
    const leadContent = lines.join("\n");
    sections.push({
      key: "lead",
      layer: "lead",
      title: `Lead: ${input.lead.name}`,
      content: leadContent,
      included: true,
      reason: "The lead this outbound task addresses. Personalize only from these facts.",
      tokens: estimateTokens(leadContent),
    });
  } else {
    sections.push({
      key: "lead",
      layer: "lead",
      title: "Lead",
      content: "",
      included: false,
      reason: "Excluded: no lead attached to this task.",
      tokens: 0,
    });
  }

  if (input.mediaContact) {
    const contact = input.mediaContact;
    const descriptor = [contact.type, contact.outlet.trim() ? `at ${contact.outlet.trim()}` : ""]
      .filter(Boolean)
      .join(" ");
    const lines = [`Pitching: ${contact.name} — ${descriptor}`];
    if (contact.beat.trim()) lines.push(`Beat: ${contact.beat.trim()}`);
    if (contact.coverageNotes.trim()) lines.push(`Past coverage notes: ${contact.coverageNotes.trim()}`);
    const contactContent = lines.join("\n");
    sections.push({
      key: "media_contact",
      layer: "contact",
      title: `Media contact: ${contact.name}`,
      content: contactContent,
      included: true,
      reason:
        "The media contact this pitch addresses. Personalize only from these facts — never invent past coverage or relationships.",
      tokens: estimateTokens(contactContent),
    });
  } else {
    sections.push({
      key: "media_contact",
      layer: "contact",
      title: "Media contact",
      content: "",
      included: false,
      reason: "Excluded: no media contact attached to this task.",
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

  // Sprint 22: a chosen angle and/or the draft under review are pushed only
  // when set, so an ordinary generation's section list is byte-for-byte
  // unchanged (and the pinned section-order tests don't move). Both sit just
  // before the task instruction and are protected from the token budget.
  if (input.angle && input.angle.trim()) {
    const angleContent = input.angle.trim();
    sections.push({
      key: "angle",
      layer: "angle",
      title: "Chosen angle",
      content: angleContent,
      included: true,
      reason: "The angle this draft was generated from (Sprint 22 angle step).",
      tokens: estimateTokens(angleContent),
    });
  }

  if (input.reviewSubject && input.reviewSubject.trim()) {
    const subject = input.reviewSubject.trim();
    sections.push({
      key: "review_subject",
      layer: "review",
      title: "Draft under review",
      content: subject,
      included: true,
      reason: "The draft this reviewer pass is judging. Score only this text.",
      tokens: estimateTokens(subject),
    });
  }

  const taskContent = input.taskInstruction ?? TASK_INSTRUCTIONS[input.taskType];
  sections.push({
    key: "task",
    layer: "task",
    title: `Task: ${input.taskType}`,
    content: taskContent,
    included: true,
    reason: input.taskInstruction
      ? "Task instruction (composed for this request): always included, always last."
      : "Task instruction: always included, always last.",
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
