import {
  AD_CREATIVE_FORMATS,
  BRAIN_DOC_TYPES,
  CHANNEL_GUIDANCE_DEFAULTS,
  DEFAULT_TASK_DOC_MATRIX,
  DEFAULT_TOKEN_BUDGET,
  MATRIX_DOC_TYPES,
  TASK_TYPES,
  ZOOM_DOC_TOKEN_CAP,
  ZOOM_MAX_SECTIONS_PER_DOC,
  ZOOM_SMALL_DOC_TOKENS,
  type AdCreativeTaskType,
  type BrainDocType,
  type Channel,
  type DocContextMode,
  type DocOutline,
  type EvidenceKind,
  type GuidanceSource,
  type MatrixDocType,
  type MediaContactType,
  type PrPitchType,
  type ResolveMode,
  type ResolvedTaskDocMatrix,
  type SequenceChannel,
  type TaskType,
} from "@tuezday/contracts";
import { BRAIN_DOC_META, type BrainContents } from "./index";
import { PREAMBLE_ID, buildFallbackOutline, parseDocSections, renderOutline } from "./sections";
import { estimateTokens } from "./tokens";
import { composeZoomQuery, rankSections, type ZoomCandidate } from "./zoom";

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
 * Compose the task instruction for a follow-up step in an outbound sequence
 * (Sprint 30). Step 1 uses the channel's default instruction; steps 2+ get this
 * framing — a genuine follow-up that adds a fresh angle and never repeats the
 * earlier touches it is told about. Rides on the resolver's `taskInstruction`
 * override, so the full follow-up prompt shows up in the context trace.
 */
export function composeFollowupInstruction(args: {
  channel: SequenceChannel;
  stepNumber: number;
  instruction: string;
  priorBodies: string[];
}): string {
  const { channel, stepNumber, instruction, priorBodies } = args;
  const medium = channel === "email" ? "cold email" : "X (Twitter) direct message";
  const base =
    channel === "email"
      ? "Write a short follow-up email to the same lead: a subject line (prefix 'Subject: ') and a body of at most 100 words."
      : "Write a short follow-up X DM to the same person: at most one or two sentences, friendly and low-friction.";
  const angle = instruction.trim()
    ? `Angle for this follow-up: ${instruction.trim()}`
    : "Add a fresh, useful angle - do not merely 'bump' the thread with 'just checking in'.";
  const prior = priorBodies.length
    ? `You already sent these earlier messages to this person (do NOT repeat them):\n${priorBodies
        .map((b, i) => `(${i + 1}) ${b.trim()}`)
        .join("\n")}`
    : "";
  return [
    `Task: This is message #${stepNumber} in an outbound ${medium} follow-up sequence to the same person.`,
    base,
    angle,
    "Personalize ONLY from the lead facts above - never invent meetings, prior replies, or details not in the data. Make one clear, low-friction ask. Skip flattery and 'circling back' clichés.",
    prior,
    "Return only the message - no preamble or commentary.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  x_dm:
    "Task: Write a short personalized first-touch X (Twitter) direct message to the recipient above (treated as the lead). Two or three sentences, plain and human, like a real person sliding into DMs - not a marketing blast. Personalize ONLY from the recipient facts given; never invent shared history. One clear, low-friction ask. No links unless essential, no hashtags, no emoji spam. Return only the DM text - no preamble, greeting label, or commentary.",
  instagram_post:
    "Task: Write one Instagram caption grounded in the context above, to accompany the launch's image/video. Open with a scroll-stopping first line, then a few short, punchy lines in the company's voice. End with one light call to action and 3-5 relevant hashtags on the final line. Keep it under 2200 characters. The caption supports the visual - don't describe the image literally. Return only the caption text - no preamble or commentary.",
  instagram_carousel:
    "Task: (design layer) Split the approved draft into carousel slide copy. This task is served by the deterministic carousel pipeline, not by a text generation - this instruction exists only to keep the task vocabulary exhaustive.",
  engagement_reply:
    "Task: Write a reply to the inbound comment/message in the conversation above, for the requested channel, in the company's voice. Respond to what the person actually said - answer their question, address their point, or thank them specifically - grounded in the company context and our original post. Keep it short and human, like a real person replying in a thread, not a brand statement. No links unless they asked, no hard sell. Return only the reply text - no preamble, greeting label, or commentary.",
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ContextLayer =
  | "org"
  | "channel"
  | "campaign"
  | "persona"
  | "account"
  | "zoom"
  | "lead"
  | "contact"
  | "signal"
  | "conversation"
  | "evidence"
  | "angle"
  | "review"
  | "task";

export interface ResolvePersona {
  name: string;
  description: string;
  overlay: string;
  /** Topics this persona covers (Sprint 44) — also zoom-query material. */
  topics?: string[];
  /** Structured drafting fields (Sprint 44); empty/omitted render nothing. */
  tone?: string;
  styleRules?: string;
  avoid?: string;
}

/**
 * The publishing account (connection) this draft will go out from, when it is
 * known at draft time and has a content profile (Sprint 44). Injected as a
 * tier-1 keyed section; topics also feed the zoom query.
 */
export interface ResolveAccount {
  name: string;
  handle?: string | null;
  provider: string;
  topics?: string[];
  guidance?: string;
}

export interface ResolveCampaign {
  name: string;
  overlay: string;
  /** Campaign objective — zoom-query material (Sprint 43). */
  objective?: string;
  /** Campaign content pillars — zoom-query material (Sprint 43). */
  pillars?: string[];
}

export interface ResolveSignal {
  content: string;
  source: string;
  sourceUrl?: string | null;
}

/** An inbound comment/DM we're replying to, plus our original post (Sprint 29). */
export interface ResolveConversation {
  /** The body of our post/DM that drew the reply, when known. */
  originalPost?: string;
  inboundAuthor: string;
  inboundMessage: string;
  /** Platform the conversation is on (reddit/linkedin/x/instagram). */
  source: string;
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
  title: string;
  documentId: string;
  kind: EvidenceKind;
  /** R2R similarity score (0–1). */
  score: number;
  /** Recency decay applied by the retrieval policy (0–1). */
  recencyScore: number;
  /** Per-origin weight (manual > published > signal). */
  sourceWeight: number;
  /** Blended rank used for ordering and budget trimming. */
  finalScore: number;
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
  /**
   * The publishing account's content profile (Sprint 44), resolved by the API
   * from the persona's primary connection (or the inbox item's connection).
   * Omitted → no account section (existing section lists are unchanged).
   */
  account?: ResolveAccount;
  lead?: ResolveLead;
  mediaContact?: ResolveMediaContact;
  signal?: ResolveSignal;
  conversation?: ResolveConversation;
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
   * `scope` (Sprint 44) is a preformatted label naming the persona/campaign
   * scope that won most-specific-wins resolution, folded into the reason.
   */
  channelGuidance?: { content: string; source: GuidanceSource; scope?: string };
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
  /**
   * Merged Tier-2 task matrix (Sprint 43): how icp/history enter this task's
   * prompt. Omitted → the contracts defaults. The API passes the workspace-
   * merged matrix.
   */
  matrix?: ResolvedTaskDocMatrix;
  /**
   * Stored doc outlines (Sprint 43) — LLM-summarized at save time. Missing
   * docs fall back to a deterministic outline derived from the content.
   */
  outlines?: Partial<Record<BrainDocType, DocOutline>>;
  /**
   * "brief" = the angle-step brief (Sprint 43): matrix `full` cells demote to
   * outline and zoom is skipped — a cheap bundle to pick an angle against.
   * Default "draft".
   */
  resolveMode?: ResolveMode;
}

export interface EvidenceChunkTrace extends EvidenceChunk {
  /** Whether this chunk survived the token budget into the prompt. */
  kept: boolean;
  /** Why a chunk was dropped (budget), when applicable. */
  exclusionReason?: string;
}

export interface ContextSection {
  key: string;
  layer: ContextLayer;
  title: string;
  content: string;
  included: boolean;
  reason: string;
  tokens: number;
  /**
   * Which resolver tier included this section (Sprint 43): 1 = constitutional,
   * 2 = task matrix, 3 = zoom. Absent on sections the tiers don't govern
   * (evidence has its own per-chunk trace) and on pre-43 persisted traces.
   */
  tier?: 1 | 2 | 3;
  /** Effective task-matrix mode, set on the five org-doc sections (Sprint 43). */
  mode?: DocContextMode;
  /** Zoom trace, set on `zoom:*` sections (Sprint 43). */
  zoom?: { score: number; rank: number };
  /**
   * Per-chunk retrieval trace, present only on the evidence section: the
   * composed query and every candidate chunk with its scores + kept/dropped
   * status. Powers the Evidence-retrieval inspection view.
   */
  evidence?: { query: string; chunks: EvidenceChunkTrace[] };
}

export interface ResolvedContext {
  sections: ContextSection[];
  includedTokens: number;
  tokenBudget: number;
  overBudget: boolean;
  prompt: string;
  /** The composed Tier-3 retrieval query (Sprint 43); set when zoom ran. */
  zoomQuery?: string;
  /** Which assembly mode produced this bundle (Sprint 43). */
  resolveMode: ResolveMode;
}

export { estimateTokens } from "./tokens";

/**
 * The contracts default matrix as a ResolvedTaskDocMatrix (every cell marked
 * source "default"). The API overlays workspace `context_matrix_overrides`
 * rows on top of this; the resolver falls back to it when no matrix is passed.
 */
export function defaultResolvedMatrix(): ResolvedTaskDocMatrix {
  const matrix = {} as ResolvedTaskDocMatrix;
  for (const taskType of TASK_TYPES) {
    matrix[taskType] = {} as ResolvedTaskDocMatrix[TaskType];
    for (const docType of MATRIX_DOC_TYPES) {
      matrix[taskType][docType] = {
        ...DEFAULT_TASK_DOC_MATRIX[taskType][docType],
        source: "default",
      };
    }
  }
  return matrix;
}

function isMatrixDoc(docType: BrainDocType): docType is MatrixDocType {
  return (MATRIX_DOC_TYPES as readonly string[]).includes(docType);
}

/** Render evidence chunks as `[n]` citations followed by a numbered source list. */
function renderEvidence(chunks: EvidenceChunk[]): string {
  const lines = chunks.map((c, i) => `[${i + 1}] ${c.text.trim()}`);
  const sources = chunks.map((c, i) => `[${i + 1}] ${c.title}`);
  return `${lines.join("\n\n")}\n\nSources:\n${sources.join("\n")}`;
}

export function resolveContext(input: ResolveInput): ResolvedContext {
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const resolveMode: ResolveMode = input.resolveMode ?? "draft";
  const matrix = input.matrix ?? defaultResolvedMatrix();
  const sections: ContextSection[] = [];

  // --- Tiers 1+2: plan how each org doc enters the bundle -------------------
  // soul/voice/now are constitutional (tier 1, always full). icp/history are
  // informational (tier 2): the task matrix decides full/outline/omit, with a
  // brief-mode demotion and a small-doc escape hatch on top.
  const plans = BRAIN_DOC_TYPES.map((docType) => {
    const meta = BRAIN_DOC_META.find((m) => m.docType === docType)!;
    const content = input.docs[docType].trim();
    const tier: 1 | 2 = isMatrixDoc(docType) ? 2 : 1;
    if (!content) {
      return { docType, meta, content, tier, mode: "omit" as DocContextMode, empty: true, notes: [] as string[], cell: undefined };
    }
    if (!isMatrixDoc(docType)) {
      return { docType, meta, content, tier, mode: "full" as DocContextMode, empty: false, notes: [] as string[], cell: undefined };
    }
    const cell = matrix[input.taskType][docType];
    let mode: DocContextMode = cell.mode;
    const notes: string[] = [];
    if (resolveMode === "brief" && mode === "full") {
      mode = "outline";
      notes.push("brief mode (angle step): full demoted to outline");
    }
    if (mode === "outline" && estimateTokens(content) <= ZOOM_SMALL_DOC_TOKENS) {
      mode = "full";
      notes.push(`included whole (doc ≤ ${ZOOM_SMALL_DOC_TOKENS} tokens — outlining saves nothing)`);
    }
    return { docType, meta, content, tier, mode, empty: false, notes, cell };
  });

  // --- Tier 3: zoom — score outline-mode docs' sections against the query ---
  const outlinePlans = plans.filter((p) => p.mode === "outline" && !p.empty);
  const docSectionCounts = new Map<BrainDocType, number>();
  const zoomSelected = new Map<BrainDocType, { candidate: ZoomCandidate; score: number; rank: number }[]>();
  let zoomQuery: string | undefined;
  if (resolveMode === "draft" && outlinePlans.length > 0) {
    zoomQuery = composeZoomQuery(input);
    const candidates: ZoomCandidate[] = outlinePlans.flatMap((p) => {
      const docSections = parseDocSections(p.content);
      docSectionCounts.set(p.docType, docSections.length);
      return docSections.map((section) => ({ docType: p.docType, section }));
    });
    const ranked = rankSections(zoomQuery, candidates);
    const tokensByDoc = new Map<BrainDocType, number>();
    const closedDocs = new Set<BrainDocType>();
    ranked.forEach((r, i) => {
      if (closedDocs.has(r.docType)) return;
      const picked = zoomSelected.get(r.docType) ?? [];
      const spent = tokensByDoc.get(r.docType) ?? 0;
      if (picked.length >= ZOOM_MAX_SECTIONS_PER_DOC || spent + r.section.tokens > ZOOM_DOC_TOKEN_CAP) {
        closedDocs.add(r.docType);
        return;
      }
      picked.push({ candidate: { docType: r.docType, section: r.section }, score: r.score, rank: i + 1 });
      zoomSelected.set(r.docType, picked);
      tokensByDoc.set(r.docType, spent + r.section.tokens);
    });
  }

  // --- Assemble the five org-doc sections (same keys/order as v1) -----------
  for (const plan of plans) {
    const { docType, meta, content, tier, mode, empty, notes, cell } = plan;
    const source = cell ? ` — ${cell.source === "workspace" ? "workspace override" : "default"}` : "";
    const noteSuffix = notes.length ? ` (${notes.join("; ")})` : "";
    if (empty) {
      sections.push({
        key: `org:${docType}`, layer: "org", title: meta.title, content: "",
        included: false, reason: `Excluded: the ${meta.title} doc is empty.`,
        tokens: 0, tier, mode: "omit",
      });
      continue;
    }
    if (mode === "omit") {
      sections.push({
        key: `org:${docType}`, layer: "org", title: meta.title, content: "",
        included: false,
        reason: `Excluded (tier 2, task matrix${source}): omitted for ${input.taskType} — ${cell!.reason}`,
        tokens: 0, tier, mode,
      });
      continue;
    }
    if (mode === "outline") {
      const outline = input.outlines?.[docType] ?? buildFallbackOutline(content, 0)!;
      const rendered = renderOutline(outline);
      const pulled = zoomSelected.get(docType)?.length ?? 0;
      const total = docSectionCounts.get(docType) ?? outline.sections.length;
      const zoomNote =
        resolveMode === "brief"
          ? "zoom off (brief mode)"
          : pulled > 0
            ? `${pulled} of ${total} sections zoomed in below`
            : "no sections matched the zoom query";
      sections.push({
        key: `org:${docType}`, layer: "org", title: `${meta.title} (outline)`, content: rendered,
        included: true,
        reason: `Org brain (tier 2, task matrix${source}): outline for ${input.taskType} — ${cell!.reason}${noteSuffix}; ${zoomNote}.`,
        tokens: estimateTokens(rendered), tier, mode,
      });
      continue;
    }
    sections.push({
      key: `org:${docType}`, layer: "org", title: meta.title, content,
      included: true,
      reason: cell
        ? `Org brain (tier 2, task matrix${source}): full for ${input.taskType} — ${cell.reason}${noteSuffix}`
        : `Org brain (tier 1, constitutional): ${meta.description}`,
      tokens: estimateTokens(content), tier, mode,
    });
  }

  const guidance = input.channelGuidance ?? {
    content: CHANNEL_GUIDANCE_DEFAULTS[input.channel],
    source: "default" as const,
  };
  // Sprint 44: name the scope that won most-specific-wins resolution. No
  // scope → reasons unchanged byte-for-byte from Sprint 43.
  const scopeSuffix = guidance.scope ? `, scoped: ${guidance.scope}` : "";
  sections.push({
    key: "channel",
    layer: "channel",
    title: `Channel: ${input.channel}`,
    content: guidance.content,
    included: true,
    reason:
      guidance.source === "workspace"
        ? `Channel guidance for ${input.channel} (tier 1, keyed — workspace override${scopeSuffix}).`
        : `Channel guidance for ${input.channel} (tier 1, keyed — built-in default).`,
    tokens: estimateTokens(guidance.content),
    tier: 1,
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
    tier: 1,
  });

  if (input.persona) {
    const lines = [`Speaking as: ${input.persona.name}.`];
    if (input.persona.description.trim()) lines.push(input.persona.description.trim());
    if (input.persona.overlay.trim()) lines.push(input.persona.overlay.trim());
    // Sprint 44: structured drafting fields as labeled lines. Empty fields
    // render nothing, so pre-44 personas produce byte-identical sections.
    if (input.persona.topics?.length) {
      lines.push(`Topics this persona covers: ${input.persona.topics.join(", ")}`);
    }
    if (input.persona.tone?.trim()) lines.push(`Tone: ${input.persona.tone.trim()}`);
    if (input.persona.styleRules?.trim()) {
      lines.push(`Style rules:\n${input.persona.styleRules.trim()}`);
    }
    if (input.persona.avoid?.trim()) {
      lines.push(`Never say / avoid:\n${input.persona.avoid.trim()}`);
    }
    const personaContent = lines.join("\n\n");
    sections.push({
      key: "persona",
      layer: "persona",
      title: `Persona: ${input.persona.name}`,
      content: personaContent,
      included: true,
      reason: `Persona overlay "${input.persona.name}" adjusts voice and point of view.`,
      tokens: estimateTokens(personaContent),
      tier: 1,
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
      tier: 1,
    });
  }

  // The publishing account's content profile (Sprint 44). Pushed only when the
  // API resolved one (persona's primary connection, or the inbox item's own
  // connection), so existing tasks' section lists are byte-identical without it.
  if (input.account) {
    const account = input.account;
    const identity = account.handle?.trim()
      ? `${account.name} (@${account.handle.trim().replace(/^@/, "")})`
      : account.name;
    const lines = [`Publishing as: ${identity} on ${account.provider}.`];
    if (account.topics?.length) lines.push(`This account covers: ${account.topics.join(", ")}`);
    if (account.guidance?.trim()) lines.push(`Account guidelines:\n${account.guidance.trim()}`);
    const accountContent = lines.join("\n\n");
    sections.push({
      key: "account",
      layer: "account",
      title: `Account: ${identity}`,
      content: accountContent,
      included: true,
      reason: `Account content profile for ${identity} (tier 1, keyed): the account this draft publishes from.`,
      tokens: estimateTokens(accountContent),
      tier: 1,
    });
  }

  // --- Tier 3 zoom sections: end of the stable prefix, before the volatile ---
  // task payload. Grouped by doc in canonical order, best score first within
  // each doc — the prompt reads "here is the map, here is what we zoomed into".
  for (const docType of BRAIN_DOC_TYPES) {
    const picked = zoomSelected.get(docType);
    if (!picked) continue;
    const meta = BRAIN_DOC_META.find((m) => m.docType === docType)!;
    for (const { candidate, score, rank } of picked) {
      const heading = candidate.section.id === PREAMBLE_ID ? "(intro)" : candidate.section.heading;
      sections.push({
        key: `zoom:${docType}:${candidate.section.id}`,
        layer: "zoom",
        title: `${meta.title} § ${heading}`,
        content: candidate.section.body,
        included: true,
        reason: `Zoomed in (tier 3): scored ${score.toFixed(2)} (rank ${rank}) against the composed query.`,
        tokens: candidate.section.tokens,
        tier: 3,
        zoom: { score, rank },
      });
    }
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
      tier: 1,
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
      tier: 1,
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
      tier: 1,
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
      tier: 1,
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
      tier: 1,
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
      tier: 1,
    });
  }

  // The inbound conversation we're replying to (Sprint 29). Only present for a
  // reply task — pushed conditionally so other tasks' section lists are unchanged.
  if (input.conversation) {
    const convo = input.conversation;
    const lines: string[] = [];
    if (convo.originalPost?.trim()) lines.push(`Our post:\n${convo.originalPost.trim()}`);
    lines.push(`Reply from ${convo.inboundAuthor} (on ${convo.source}):\n${convo.inboundMessage.trim()}`);
    const conversationContent = lines.join("\n\n");
    sections.push({
      key: "conversation",
      layer: "conversation",
      title: "Conversation to reply to",
      content: conversationContent,
      included: true,
      reason: `The inbound ${convo.source} message this reply answers, plus our original post.`,
      tokens: estimateTokens(conversationContent),
      tier: 1,
    });
  }

  if (input.evidence && input.evidence.chunks.length > 0) {
    const evidenceContent = renderEvidence(input.evidence.chunks);
    sections.push({
      key: "evidence",
      layer: "evidence",
      title: "Evidence",
      content: evidenceContent,
      included: true,
      reason: `Retrieved ${input.evidence.chunks.length} evidence chunk(s) for query: "${input.evidence.query}". Ground claims in this evidence.`,
      tokens: estimateTokens(evidenceContent),
      evidence: {
        query: input.evidence.query,
        chunks: input.evidence.chunks.map((c) => ({ ...c, kept: true })),
      },
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
      tier: 1,
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
      tier: 1,
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
    tier: 1,
  });

  // Token budget. Evidence is the lowest-priority layer: it degrades
  // chunk-by-chunk (lowest-ranked dropped first) before any whole section is.
  const includedTotal = () =>
    sections.filter((s) => s.included).reduce((sum, s) => sum + s.tokens, 0);

  const evidenceSection = sections.find((s) => s.key === "evidence");
  if (evidenceSection?.included && input.evidence) {
    const allChunks = input.evidence.chunks;
    const traces = evidenceSection.evidence!.chunks;
    let keptCount = allChunks.length;
    while (keptCount > 0 && includedTotal() > tokenBudget) {
      keptCount--;
      traces[keptCount]!.kept = false;
      traces[keptCount]!.exclusionReason = "dropped to fit the token budget";
      if (keptCount === 0) {
        evidenceSection.included = false;
        evidenceSection.content = "";
        evidenceSection.tokens = 0;
        evidenceSection.reason = "Excluded: no evidence chunks fit the token budget.";
      } else {
        evidenceSection.content = renderEvidence(allChunks.slice(0, keptCount));
        evidenceSection.tokens = estimateTokens(evidenceSection.content);
        evidenceSection.reason = `Retrieved ${allChunks.length} evidence chunk(s) for query: "${input.evidence.query}"; kept the top ${keptCount} within the token budget. Ground claims in this evidence.`;
      }
    }
  }

  // Ladder step 2 (Sprint 43): drop zoomed sections, lowest score first —
  // they are the most speculative content in the bundle.
  const zoomByScore = sections
    .filter((s) => s.layer === "zoom" && s.included)
    .sort((a, b) => a.zoom!.score - b.zoom!.score || b.zoom!.rank - a.zoom!.rank);
  for (const section of zoomByScore) {
    if (includedTotal() <= tokenBudget) break;
    const over = includedTotal() - tokenBudget;
    section.included = false;
    section.reason = `Excluded: zoomed section dropped to fit the token budget (bundle was ${over} tokens over; lowest score first).`;
  }

  // Ladder step 3: demote matrix-`full` informational docs to their outline —
  // history first, then icp. Constitutional docs (soul/voice/now), channel
  // guidance, overlays, and the task payload are never cut: if the bundle is
  // still over budget after this, it ships flagged `overBudget` and the
  // Brain-page token warnings are the fix.
  for (const docType of ["history", "icp"] as const) {
    if (includedTotal() <= tokenBudget) break;
    const plan = plans.find((p) => p.docType === docType)!;
    const section = sections.find((s) => s.key === `org:${docType}`)!;
    if (!section.included || plan.empty || section.mode !== "full" || !plan.cell) continue;
    const outline = input.outlines?.[docType] ?? buildFallbackOutline(plan.content, 0)!;
    const rendered = renderOutline(outline);
    const outlineTokens = estimateTokens(rendered);
    if (outlineTokens >= section.tokens) continue; // outlining a tiny doc saves nothing
    const over = includedTotal() - tokenBudget;
    section.content = rendered;
    section.tokens = outlineTokens;
    section.mode = "outline";
    section.title = `${plan.meta.title} (outline)`;
    section.reason = `${section.reason} — demoted to outline to fit the token budget (bundle was ${over} tokens over).`;
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
    zoomQuery,
    resolveMode,
  };
}
