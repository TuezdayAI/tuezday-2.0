import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums — fixed by the rebuild plan. Do not extend casually: every module
// must share these exact values.
// ---------------------------------------------------------------------------

/** The five human-readable brain documents every workspace owns. */
export const BRAIN_DOC_TYPES = ["soul", "icp", "voice", "history", "now"] as const;
export type BrainDocType = (typeof BRAIN_DOC_TYPES)[number];

/** Approval gate states for any generated draft. */
export const APPROVAL_STATES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "edited",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Output ratings stored as training signals. */
export const OUTPUT_RATINGS = ["accepted", "needs_edit", "rejected"] as const;
export type OutputRating = (typeof OUTPUT_RATINGS)[number];

/** GTM task types the resolver and generation sandbox understand. */
export const TASK_TYPES = [
  "linkedin_post",
  "cold_email_opener",
  "ad_copy_variant",
  "landing_page_hero",
  "signal_response",
  "outbound_email",
  "meta_ad_creative",
  "google_rsa",
  "pr_pitch",
  "press_boilerplate",
  // Sprint 26 (targeted launch): a per-recipient X DM and a broadcast IG post.
  "x_dm",
  "instagram_post",
  // Sprint 29 (engagement inbox): a reply to an inbound comment/DM.
  "engagement_reply",
  // Sprint 41 (design layer): a rendered multi-image carousel derived from an
  // approved content draft. Never text-generated — the pipeline renders it.
  "instagram_carousel",
  // Sprint 76 (chat foundations): a GTM strategy conversation. Not a generated
  // artifact — it exists so a chat thread resolves its own row of the context
  // matrix rather than borrowing an unrelated task's cell values. Excluded from
  // GENERATION_TASK_TYPES, so it never appears in a "generate this" picker.
  "gtm_conversation",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * The task types a human can ask the platform to *generate* — every task type
 * except the conversational one. Task-type pickers use this; the resolver, the
 * context matrix and guidance still range over the full TASK_TYPES.
 */
export const GENERATION_TASK_TYPES = TASK_TYPES.filter(
  (t) => t !== "gtm_conversation",
) as readonly Exclude<TaskType, "gtm_conversation">[];
export type GenerationTaskType = (typeof GENERATION_TASK_TYPES)[number];

/** Channels a task can target. */
export const CHANNELS = ["linkedin", "x", "email", "ads", "web", "pr", "instagram"] as const;
export type Channel = (typeof CHANNELS)[number];

// ---------------------------------------------------------------------------
// Channel guidance (Sprint 21)
//
// Built-in per-channel guidance the resolver injects. This is the single source
// of truth and the global fallback; a workspace may override any channel's text
// at runtime (DB holds overrides only). Moved verbatim from the resolver so
// generation behavior is unchanged until a founder edits something.
// ---------------------------------------------------------------------------

export const CHANNEL_GUIDANCE_DEFAULTS: Record<Channel, string> = {
  linkedin:
    "Channel: LinkedIn. Professional but human feed. Strong first line (it gets truncated). Short paragraphs, no hashtag walls, no engagement bait. Posts that read like a person, not a brand bulletin.",
  x: "Channel: X (Twitter). Compressed, punchy, idea-first. One thought per post. Threads only when each post stands alone. No corporate phrasing.",
  email:
    "Channel: Email. One reader at a time. Subject and opener decide everything. Short lines, one clear ask, no marketing gloss. Write like a competent person, not a campaign.",
  ads: "Channel: Paid ads. Hook, promise, proof, action - in very few words. One message per variant. Clarity beats cleverness.",
  web: "Channel: Website. Visitors scan. Headline carries the positioning, subhead carries the proof. Concrete claims over adjectives.",
  pr: "Channel: PR / media pitch. The reader is a journalist triaging a full inbox. The subject line IS the story. Lead with why their readers care, not why the company is proud. Short, factual, zero marketing language - never call your own news exciting. Make the journalist's job easy: the angle, the proof, who they can talk to.",
  instagram:
    "Channel: Instagram. Visual-first feed; caption supports the image/video, it doesn't carry the post alone. Hook in the first line (it gets truncated). Conversational, no corporate phrasing, light hashtag use at most.",
};

/** Human label per channel for the guidance editor. */
export const CHANNEL_LABELS: Record<Channel, string> = {
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  email: "Email",
  ads: "Paid ads",
  web: "Website",
  pr: "PR / media",
  instagram: "Instagram",
};

/** Where a channel's resolved guidance came from: built-in text vs founder-written. */
export const GUIDANCE_SOURCES = ["default", "workspace"] as const;
export type GuidanceSource = (typeof GUIDANCE_SOURCES)[number];

export const GUIDANCE_CONTENT_MAX_CHARS = 4_000;

/**
 * A channel's resolved guidance + its source (read model for the editor).
 * Sprint 44: guidance can be scoped to a persona and/or campaign
 * (most-specific-wins: persona+campaign > persona > campaign > workspace >
 * default); personaId/campaignId name the winning row's scope, both null for
 * workspace-level and default guidance.
 */
export const channelGuidanceSchema = z.object({
  channel: z.enum(CHANNELS),
  content: z.string(),
  source: z.enum(GUIDANCE_SOURCES),
  personaId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  // null when source === "default" (no override row exists).
  updatedAt: z.number().int().nullable(),
});
export type ChannelGuidance = z.infer<typeof channelGuidanceSchema>;

/** One scoped guidance override row (management read model, names joined in). */
export const guidanceOverrideSchema = z.object({
  id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  content: z.string(),
  personaId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  personaName: z.string().nullable(),
  campaignName: z.string().nullable(),
  updatedAt: z.number().int(),
});
export type GuidanceOverride = z.infer<typeof guidanceOverrideSchema>;

export const updateGuidanceInputSchema = z.object({
  content: z.string().trim().min(1, "Guidance cannot be empty").max(GUIDANCE_CONTENT_MAX_CHARS),
  // Sprint 44: optional scope — omit both for the workspace-level override.
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
});
export type UpdateGuidanceInput = z.infer<typeof updateGuidanceInputSchema>;

// ---------------------------------------------------------------------------
// Workspace & onboarding (Sprint 36.1)
// ---------------------------------------------------------------------------

/**
 * The seven visible steps of the guided onboarding wizard, in order. Single
 * source of truth for the wizard's progress rail and the workspace's
 * onboarding cursor — sprints 36.2–36.6 fill the steps in.
 */
export const ONBOARDING_STEPS = [
  "name",
  "website",
  "connect",
  "verify",
  "brain",
  "campaign",
  "draft",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Where a workspace's onboarding stands: any step, or the terminal "done". */
export const ONBOARDING_CURSORS = [...ONBOARDING_STEPS, "done"] as const;
export type OnboardingCursor = (typeof ONBOARDING_CURSORS)[number];

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  websiteUrl: z.string().url().nullable(),
  onboardingStep: z.enum(ONBOARDING_CURSORS).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * Accept a bare domain ("tuezdayai.com", "www.acme.com/path") as a website —
 * no-friction onboarding. Prepends https:// when no scheme is present, then
 * validates. Returns the normalized absolute URL, or null if unusable.
 */
export function normalizeWebsiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A bare hostname must have a dot (reject "not a url at all" → "https://not").
  if (!url.hostname.includes(".")) return null;
  return url.href.replace(/\/$/, "") === withScheme.replace(/\/$/, "") ? withScheme : url.href;
}

export const createWorkspaceInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be 100 characters or fewer"),
  websiteUrl: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() ? (normalizeWebsiteUrl(v) ?? v) : v),
      z.string().url("Enter a valid website, e.g. acme.com").optional(),
    ),
  onboardingStep: z.enum(ONBOARDING_CURSORS).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const updateUserInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name must be 100 characters or fewer"),
});
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;

// ---------------------------------------------------------------------------
// Brand profile (Sprint 36.2)
//
// What Tuezday extracts from the customer's website (later: socials) before
// the brain is drafted. The seven voice dimensions are a fixed, auditable
// vocabulary shared by extraction (36.2), the brain voice doc (36.4), and the
// onboarding verification screen (36.5).
// ---------------------------------------------------------------------------

export const VOICE_DIMENSIONS = [
  "purpose",
  "audience",
  "tone",
  "emotions",
  "character",
  "syntax",
  "language",
] as const;
export type VoiceDimension = (typeof VOICE_DIMENSIONS)[number];

export const brandProfileSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required").max(200),
  tagline: z.string().max(300).default(""),
  summary: z.string().max(2000).default(""),
  targetAgeRange: z.string().max(100).default(""),
  tone: z.string().max(500).default(""),
  voiceDimensions: z.object({
    purpose: z.string().max(500).default(""),
    audience: z.string().max(500).default(""),
    tone: z.string().max(500).default(""),
    emotions: z.string().max(500).default(""),
    character: z.string().max(500).default(""),
    syntax: z.string().max(500).default(""),
    language: z.string().max(500).default(""),
  }),
  pillars: z.array(z.string().trim().min(1).max(200)).max(8, "At most 8 pillars").default([]),
  /** What the model says it could not find — keeps thin extractions honest. */
  sourceNotes: z.string().max(1000).default(""),
});
export type BrandProfile = z.infer<typeof brandProfileSchema>;

export const BRAND_PROFILE_STATUSES = ["scraping", "extracting", "ready", "failed"] as const;
export type BrandProfileStatus = (typeof BRAND_PROFILE_STATUSES)[number];

export const brandProfileViewSchema = z.object({
  status: z.enum([...BRAND_PROFILE_STATUSES, "none"]),
  profile: brandProfileSchema.nullable(),
  sourceUrl: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
});
export type BrandProfileView = z.infer<typeof brandProfileViewSchema>;

export const updateBrandProfileInputSchema = brandProfileSchema.partial();
export type UpdateBrandProfileInput = z.infer<typeof updateBrandProfileInputSchema>;

// ---------------------------------------------------------------------------
// Social corpus (Sprint 36.3)
//
// What onboarding Step 3 reads from the connected social accounts: the
// account's own profile + recent original posts, normalized across
// LinkedIn / X (provider key "twitter") / Instagram. Consumed by the brain
// auto-draft (36.4) alongside the 36.2 website corpus.
// ---------------------------------------------------------------------------

export const SOCIAL_READ_PROVIDERS = ["linkedin", "twitter", "instagram", "reddit"] as const;
export type SocialReadProvider = (typeof SOCIAL_READ_PROVIDERS)[number];

export const socialPostReadSchema = z.object({
  text: z.string().max(5000),
  url: z.string().default(""),
  createdAt: z.number().int().nullable(),
});
export type SocialPostRead = z.infer<typeof socialPostReadSchema>;

export const socialProfileReadSchema = z.object({
  provider: z.enum(SOCIAL_READ_PROVIDERS),
  handle: z.string().default(""),
  displayName: z.string().default(""),
  bio: z.string().max(3000).default(""),
  recentPosts: z.array(socialPostReadSchema).max(25).default([]),
});
export type SocialProfileRead = z.infer<typeof socialProfileReadSchema>;

export const socialCorpusEntrySchema = z.object({
  provider: z.enum(SOCIAL_READ_PROVIDERS),
  profile: socialProfileReadSchema.nullable(),
  error: z.string().nullable(),
});
export type SocialCorpusEntry = z.infer<typeof socialCorpusEntrySchema>;

export const socialCorpusSchema = z.object({
  connected: z.array(z.enum(SOCIAL_READ_PROVIDERS)),
  entries: z.array(socialCorpusEntrySchema),
  /** Concatenated readable text for the brain draft (36.4), capped server-side. */
  corpus: z.string(),
});
export type SocialCorpus = z.infer<typeof socialCorpusSchema>;

// ---------------------------------------------------------------------------
// Brain auto-draft (Sprint 36.4)
// ---------------------------------------------------------------------------

/** Result of POST /workspaces/:id/brain/auto-draft (the BrainView rides along
 * in the route response; only the accounting fields are contract-fixed). */
export const brainAutoDraftViewSchema = z.object({
  insufficient: z.boolean(),
  drafted: z.array(z.enum(BRAIN_DOC_TYPES)),
  skipped: z.array(z.enum(BRAIN_DOC_TYPES)),
});
export type BrainAutoDraftAccounting = z.infer<typeof brainAutoDraftViewSchema>;

// ---------------------------------------------------------------------------
// Onboarding reading progress (Sprint 36.5)
//
// Maps the brand-profile run status to the wizard's "Tuezday is reading…"
// animation. Pure so it is unit-testable (apps/web has no test runner).
// ---------------------------------------------------------------------------

export interface OnboardingReadingProgress {
  percent: number;
  label: string;
}

export function onboardingReadingProgress(
  profileStatus: BrandProfileStatus | "none",
  connectedCount: number,
): OnboardingReadingProgress {
  switch (profileStatus) {
    case "scraping":
      return { percent: 35, label: "Reading your website…" };
    case "extracting":
      return { percent: 70, label: "Understanding your brand…" };
    case "ready":
      return { percent: 100, label: "Done — brand profile ready." };
    case "failed":
      return { percent: 100, label: "We couldn't read your site — you can retry or continue." };
    default:
      return {
        percent: 0,
        label:
          connectedCount > 0
            ? "Waiting for your website… (socials connected)"
            : "Waiting for your website…",
      };
  }
}

// ---------------------------------------------------------------------------
// Onboarding quick campaign (Sprint 36.6)
//
// Pure mappers for the wizard's 3-field campaign step. Tested here because
// apps/web has no test runner.
// ---------------------------------------------------------------------------

export const ONBOARDING_FREQUENCIES = ["daily", "3x_week", "weekly", "biweekly"] as const;
export type OnboardingFrequency = (typeof ONBOARDING_FREQUENCIES)[number];

export const ONBOARDING_FREQUENCY_LABELS: Record<OnboardingFrequency, string> = {
  daily: "Daily",
  "3x_week": "3x per week",
  weekly: "Weekly",
  biweekly: "Every other week",
};

/** The resolver-visible campaign-overlay line recording the frequency intent.
 * Scheduling itself is Sprint 26's job — onboarding records intent only. */
export function frequencyOverlayLine(frequency: OnboardingFrequency): string {
  return `Posting frequency intent: ${ONBOARDING_FREQUENCY_LABELS[frequency]}.`;
}

/** Honest broadcast task per channel. x has no broadcast task type (x_dm is
 * per-lead), so it falls back to linkedin_post — channel guidance still
 * styles the draft for X. */
export function taskTypeForChannel(channel: Channel): TaskType {
  switch (channel) {
    case "linkedin":
      return "linkedin_post";
    case "instagram":
      return "instagram_post";
    case "email":
      return "cold_email_opener";
    case "ads":
      return "ad_copy_variant";
    case "web":
      return "landing_page_hero";
    case "pr":
      return "press_boilerplate";
    default:
      return "linkedin_post";
  }
}

export interface OnboardingQuickCampaignInput {
  workspaceName: string;
  goal: string;
  channels: Channel[];
  frequency: OnboardingFrequency;
  name?: string;
}

/** Map the wizard's 3-field quick form onto the full campaign input. Must
 * round-trip upsertCampaignInputSchema.parse unchanged. */
export function onboardingQuickCampaign(input: OnboardingQuickCampaignInput): UpsertCampaignInput {
  return upsertCampaignInputSchema.parse({
    name: input.name?.trim() || `${input.workspaceName.trim()} launch`,
    objective: input.goal.trim(),
    channels: input.channels,
    overlay: frequencyOverlayLine(input.frequency),
  });
}

// ---------------------------------------------------------------------------
// Users, teams & auth (Sprint 19)
// ---------------------------------------------------------------------------

/** Workspace membership roles. Deliberately just two — no role matrices yet. */
export const WORKSPACE_ROLES = ["owner", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const INVITE_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const PASSWORD_MIN_CHARS = 8;

/** Public user shape — never includes the password hash. */
export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().max(100),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type User = z.infer<typeof userSchema>;

export const registerInputSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  password: z
    .string()
    .min(PASSWORD_MIN_CHARS, `Password must be at least ${PASSWORD_MIN_CHARS} characters`)
    .max(200),
  name: z.string().trim().max(100).default(""),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const workspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(WORKSPACE_ROLES),
  createdAt: z.number().int(),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceInviteSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(WORKSPACE_ROLES),
  token: z.string(),
  status: z.enum(INVITE_STATUSES),
  invitedBy: z.string().uuid(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  acceptedAt: z.number().int().nullable(),
});
export type WorkspaceInvite = z.infer<typeof workspaceInviteSchema>;

export const createInviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

// ---------------------------------------------------------------------------
// Brain documents
// ---------------------------------------------------------------------------

export const BRAIN_DOC_MAX_CHARS = 50_000;

// --- Doc outlines (Sprint 43) — the "map" in map-then-zoom, computed at save time ---

export const OUTLINE_SUMMARY_SOURCES = ["llm", "fallback"] as const;
export type OutlineSummarySource = (typeof OUTLINE_SUMMARY_SOURCES)[number];

export const docOutlineSectionSchema = z.object({
  /** Stable slug path, e.g. "operating-principles/brain-first". */
  id: z.string(),
  /** Parent H2's id for an H3 section; null for top-level sections. */
  parentId: z.string().nullable(),
  heading: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
  /** One-line summary — LLM-composed at save, deterministic fallback otherwise. */
  summary: z.string(),
  summarySource: z.enum(OUTLINE_SUMMARY_SOURCES),
  tokens: z.number().int(),
});
export type DocOutlineSection = z.infer<typeof docOutlineSectionSchema>;

export const docOutlineSchema = z.object({
  sections: z.array(docOutlineSectionSchema),
  generatedAt: z.number().int(),
});
export type DocOutline = z.infer<typeof docOutlineSchema>;

export const brainDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  docType: z.enum(BRAIN_DOC_TYPES),
  content: z.string(),
  // Sprint 43: parsed section outline, regenerated on every save. Null for
  // empty docs and docs saved before outlines existed (derived on the fly).
  outline: docOutlineSchema.nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type BrainDocument = z.infer<typeof brainDocumentSchema>;

export const updateBrainDocInputSchema = z.object({
  content: z
    .string()
    .max(BRAIN_DOC_MAX_CHARS, `Document must be ${BRAIN_DOC_MAX_CHARS} characters or fewer`),
});
export type UpdateBrainDocInput = z.infer<typeof updateBrainDocInputSchema>;

export const brainDocVersionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  version: z.number().int().min(1),
  content: z.string(),
  // Nullable: versions written before auth existed (Sprint 19) have no actor.
  actor: z.string().nullable(),
  actorId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type BrainDocVersion = z.infer<typeof brainDocVersionSchema>;

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export const PERSONA_OVERLAY_MAX_CHARS = 10_000;

// Sprint 44: structured drafting fields + topics. Topics feed the Tier-3 zoom
// query now and discovery matching in Sprint 45.
export const PERSONA_TOPICS_MAX = 20;
export const PERSONA_TOPIC_MAX_CHARS = 80;
export const PERSONA_TONE_MAX_CHARS = 300;
export const PERSONA_STYLE_RULES_MAX_CHARS = 2_000;
export const PERSONA_AVOID_MAX_CHARS = 1_000;

/** Shared by personas and connection content profiles (Sprint 44). */
const topicsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Topics cannot be empty")
      .max(PERSONA_TOPIC_MAX_CHARS, `Topics must be ${PERSONA_TOPIC_MAX_CHARS} characters or fewer`),
  )
  .max(PERSONA_TOPICS_MAX, `At most ${PERSONA_TOPICS_MAX} topics`);

export const personaSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  overlay: z.string().max(PERSONA_OVERLAY_MAX_CHARS),
  topics: z.array(z.string()),
  tone: z.string().max(PERSONA_TONE_MAX_CHARS),
  styleRules: z.string().max(PERSONA_STYLE_RULES_MAX_CHARS),
  avoid: z.string().max(PERSONA_AVOID_MAX_CHARS),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Persona = z.infer<typeof personaSchema>;

export const upsertPersonaInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Persona name is required")
    .max(100, "Persona name must be 100 characters or fewer"),
  description: z.string().trim().max(500, "Description must be 500 characters or fewer").default(""),
  overlay: z
    .string()
    .max(PERSONA_OVERLAY_MAX_CHARS, `Overlay must be ${PERSONA_OVERLAY_MAX_CHARS} characters or fewer`)
    .default(""),
  topics: topicsSchema.default([]),
  tone: z
    .string()
    .trim()
    .max(PERSONA_TONE_MAX_CHARS, `Tone must be ${PERSONA_TONE_MAX_CHARS} characters or fewer`)
    .default(""),
  styleRules: z
    .string()
    .max(PERSONA_STYLE_RULES_MAX_CHARS, `Style rules must be ${PERSONA_STYLE_RULES_MAX_CHARS} characters or fewer`)
    .default(""),
  avoid: z
    .string()
    .max(PERSONA_AVOID_MAX_CHARS, `Avoid list must be ${PERSONA_AVOID_MAX_CHARS} characters or fewer`)
    .default(""),
});
export type UpsertPersonaInput = z.infer<typeof upsertPersonaInputSchema>;

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 8_000;

export const resolveRequestSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
  useEvidence: z.boolean().optional(),
});
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

// ---------------------------------------------------------------------------
// Selective context (Sprint 43) — Resolver v2 vocabulary.
//
// Tier 1 (constitutional: soul/voice/now + keyed overlays + task payload) is
// always included and never scored. Tier 2 is the task matrix below: how each
// *informational* doc (icp/history) enters a given task's prompt. Tier 3
// ("map-then-zoom") applies to docs in `outline` mode: the outline is always
// present, and full sections are pulled only when they score against the
// composed query. The matrix is data — defaults here, per-workspace overrides
// in `context_matrix_overrides` — so the selection policy itself is
// inspectable and editable.
// ---------------------------------------------------------------------------

/** How a doc enters a task's prompt: whole, outline + zoomed sections, or not at all. */
export const DOC_CONTEXT_MODES = ["full", "outline", "omit"] as const;
export type DocContextMode = (typeof DOC_CONTEXT_MODES)[number];

/**
 * The docs the task matrix governs. soul/voice/now are constitutional — always
 * full, never in the matrix (identity is not information).
 */
export const MATRIX_DOC_TYPES = ["icp", "history"] as const;
export type MatrixDocType = (typeof MATRIX_DOC_TYPES)[number];

/** Resolver assembly modes. "brief" = angle-step brief: full→outline demotion, no zoom. */
export const RESOLVE_MODES = ["draft", "brief"] as const;
export type ResolveMode = (typeof RESOLVE_MODES)[number];

/** Docs at or under this size are included whole even in `outline` mode. */
export const ZOOM_SMALL_DOC_TOKENS = 600;
/** Per-doc token cap on zoomed-in full sections. */
export const ZOOM_DOC_TOKEN_CAP = 1_500;
/** Per-doc cap on how many sections zoom may pull. */
export const ZOOM_MAX_SECTIONS_PER_DOC = 4;
/** Brain-editor warning threshold for constitutional docs (they ride every prompt). */
export const BRAIN_DOC_TOKEN_WARNING = 2_000;
/**
 * Hard cap on the campaign-plan context section (Sprint 53). The plan is tier 1
 * — never cut by the sacrifice ladder's first three steps — and a maximal plan
 * (10k-char guidance + 20 pillars + 20 offers + 20 CTAs) would otherwise exceed
 * the whole DEFAULT_TOKEN_BUDGET on its own. Composition stops here and the
 * section's reason records what was dropped.
 */
export const PLAN_SECTION_TOKEN_CAP = 1_200;
export const MATRIX_CELL_REASON_MAX_CHARS = 300;

export interface TaskDocMatrixCell {
  mode: DocContextMode;
  /** Human-readable why — shown in the matrix editor and the resolve trace. */
  reason: string;
}

/**
 * Shipped defaults: every task type × every matrix doc, each cell with a
 * reason. Outreach tasks keep `icp` full (pain specificity is the task); PR
 * tasks keep `history` full (the company story is the material); replies omit
 * both (the conversation is the context; identity docs suffice).
 */
export const DEFAULT_TASK_DOC_MATRIX: Record<
  TaskType,
  Record<MatrixDocType, TaskDocMatrixCell>
> = {
  linkedin_post: {
    icp: { mode: "outline", reason: "Audience awareness helps a post; the full ICP catalogue rarely does. Zoom pulls the segment the query touches." },
    history: { mode: "outline", reason: "Lessons and launches are pulled per topic — the full history buries the hook." },
  },
  cold_email_opener: {
    icp: { mode: "full", reason: "The opener lives or dies on ICP pain specificity." },
    history: { mode: "outline", reason: "Only the history relevant to this lead's situation earns tokens." },
  },
  ad_copy_variant: {
    icp: { mode: "full", reason: "Ad copy targets the ICP's pains and objections directly." },
    history: { mode: "outline", reason: "Past angle learnings zoom in when the query touches them." },
  },
  landing_page_hero: {
    icp: { mode: "full", reason: "The hero speaks to the ICP's exact pain and trigger." },
    history: { mode: "outline", reason: "Proof points zoom in; the full timeline doesn't belong in a hero." },
  },
  signal_response: {
    icp: { mode: "outline", reason: "The signal decides which audience matters; zoom follows the signal." },
    history: { mode: "outline", reason: "Only history related to the signal's topic is useful." },
  },
  outbound_email: {
    icp: { mode: "full", reason: "Personalized outbound needs the full pain/trigger detail." },
    history: { mode: "outline", reason: "Relevant proof zooms in against the lead facts." },
  },
  meta_ad_creative: {
    icp: { mode: "full", reason: "Creative variants target ICP pains and objections." },
    history: { mode: "outline", reason: "Past creative learnings zoom in by campaign topic." },
  },
  google_rsa: {
    icp: { mode: "full", reason: "RSA assets speak to the searcher's (ICP's) intent." },
    history: { mode: "outline", reason: "Proof points zoom in; the timeline doesn't fit 30-char headlines." },
  },
  pr_pitch: {
    icp: { mode: "outline", reason: "The journalist's readers matter more than our ICP detail." },
    history: { mode: "full", reason: "The pitch is built from what actually happened — milestones, traction, story." },
  },
  press_boilerplate: {
    icp: { mode: "outline", reason: "Boilerplate states who it's for in one line — the outline carries that." },
    history: { mode: "full", reason: "Boilerplate is facts: founding, milestones, numbers — all history." },
  },
  x_dm: {
    icp: { mode: "full", reason: "A cold DM needs the same pain specificity as cold email." },
    history: { mode: "outline", reason: "Only history relevant to this recipient earns space in two sentences." },
  },
  instagram_post: {
    icp: { mode: "outline", reason: "The caption rides the visual; audience outline suffices, zoom follows the topic." },
    history: { mode: "outline", reason: "Topical lessons zoom in; the full history drowns a caption." },
  },
  instagram_carousel: {
    icp: { mode: "outline", reason: "Carousel copy is derived from an approved draft; audience detail was already spent there." },
    history: { mode: "outline", reason: "The deterministic render pipeline never re-writes copy from history." },
  },
  engagement_reply: {
    icp: { mode: "omit", reason: "The reply answers a specific person in a live thread — the conversation is the context." },
    history: { mode: "omit", reason: "Thread replies are voice + the conversation; company history is a distractor here." },
  },
  gtm_conversation: {
    icp: { mode: "full", reason: "A strategy conversation is *about* the audience — segments, pains and objections are the substance, not background." },
    history: { mode: "full", reason: "Planning the next launch means knowing every prior one: what shipped, what worked, what was learned." },
  },
};

/** A merged matrix cell as the API serves it (default overlaid by any workspace row). */
export const matrixCellSchema = z.object({
  taskType: z.enum(TASK_TYPES),
  docType: z.enum(MATRIX_DOC_TYPES),
  mode: z.enum(DOC_CONTEXT_MODES),
  reason: z.string(),
  // Reuses the guidance vocabulary: "default" (shipped) or "workspace" (override row).
  source: z.enum(GUIDANCE_SOURCES),
  // null when source === "default".
  updatedAt: z.number().int().nullable(),
});
export type MatrixCell = z.infer<typeof matrixCellSchema>;

export const updateMatrixCellInputSchema = z.object({
  mode: z.enum(DOC_CONTEXT_MODES),
  reason: z
    .string()
    .trim()
    .max(MATRIX_CELL_REASON_MAX_CHARS, `Reason must be ${MATRIX_CELL_REASON_MAX_CHARS} characters or fewer`)
    .optional(),
});
export type UpdateMatrixCellInput = z.infer<typeof updateMatrixCellInputSchema>;

/** The resolver-facing merged matrix (built by the API from defaults + overrides). */
export type ResolvedTaskDocMatrix = Record<
  TaskType,
  Record<MatrixDocType, { mode: DocContextMode; reason: string; source: GuidanceSource }>
>;

// (Doc outline schemas live in the Brain documents section above, so
// brainDocumentSchema can embed them.)

// ---------------------------------------------------------------------------
// Generation quality (Sprint 22) — angle-first + dual-LLM pre-review.
// Vocabulary lives here (the rule: enum vocabularies are defined only in
// contracts). Review is advisory: a flagged draft is never blocked from
// approval; the founder override always works.
// ---------------------------------------------------------------------------

/** Reviewer passes. brand_voice judges voice/soul match; channel_fit judges channel conventions. */
export const GENERATION_REVIEW_CHECKS = ["brand_voice", "channel_fit"] as const;
export type GenerationReviewCheck = (typeof GENERATION_REVIEW_CHECKS)[number];

export const REVIEW_CHECK_LABELS: Record<GenerationReviewCheck, string> = {
  brand_voice: "Brand voice",
  channel_fit: "Channel fit",
};

export const DEFAULT_REVIEW_FLAG_THRESHOLD = 70;
export const DEFAULT_ANGLE_COUNT = 3;
export const ANGLE_COUNT_MIN = 2;
export const ANGLE_COUNT_MAX = 5;
export const REVIEW_SCORE_MIN = 0;
export const REVIEW_SCORE_MAX = 100;
export const ANGLE_MAX_CHARS = 2_000;

/**
 * One reviewer pass's result. `score` is null when the reviewer call failed or
 * its output couldn't be parsed — review is best-effort and never blocks.
 */
export const reviewCheckResultSchema = z.object({
  check: z.enum(GENERATION_REVIEW_CHECKS),
  score: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX).nullable(),
  issues: z.array(z.string()),
  // The exact reviewer prompt sent (resolver-assembled) — for the trace.
  prompt: z.string(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int(),
});
export type ReviewCheckResult = z.infer<typeof reviewCheckResultSchema>;

export const generationReviewSchema = z.object({
  checks: z.array(reviewCheckResultSchema),
  threshold: z.number().int(),
  // True when any check has a non-null score below the threshold.
  flagged: z.boolean(),
  createdAt: z.number().int(),
});
export type GenerationReview = z.infer<typeof generationReviewSchema>;

/** A draft is flagged when any check scored (non-null) below the threshold. */
export function isReviewFlagged(checks: ReviewCheckResult[], threshold: number): boolean {
  return checks.some((c) => c.score !== null && c.score < threshold);
}

// Per-workspace generation-quality settings (defaults applied on read).
export const generationSettingsSchema = z.object({
  workspaceId: z.string().uuid(),
  reviewEnabled: z.boolean(),
  angleEnabled: z.boolean(),
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX),
  flagThreshold: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  updatedAt: z.number().int(),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const updateGenerationSettingsInputSchema = z
  .object({
    reviewEnabled: z.boolean(),
    angleEnabled: z.boolean(),
    angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX),
    flagThreshold: z.number().int().min(REVIEW_SCORE_MIN).max(REVIEW_SCORE_MAX),
  })
  .partial();
export type UpdateGenerationSettingsInput = z.infer<typeof updateGenerationSettingsInputSchema>;

/** Angle generation takes the same inputs as resolve, plus an optional count. */
export const generateAnglesInputSchema = resolveRequestSchema.extend({
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX).optional(),
});
export type GenerateAnglesInput = z.infer<typeof generateAnglesInputSchema>;

// ---------------------------------------------------------------------------
// Generations (sandbox outputs + training signals)
// ---------------------------------------------------------------------------

export const generationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  leadId: z.string().uuid().nullable(),
  mediaContactId: z.string().uuid().nullable(),
  prompt: z.string(),
  output: z.string(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int(),
  rating: z.enum(OUTPUT_RATINGS).nullable(),
  ratedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  // The dual-LLM pre-review of `output` (Sprint 22). Null when review is off.
  review: generationReviewSchema.nullable().optional(),
});
export type Generation = z.infer<typeof generationSchema>;

/**
 * Generate takes the resolve inputs plus the Sprint 22 angle controls. A
 * superset of resolveRequestSchema, so /resolve stays unaffected.
 */
export const generateRequestSchema = resolveRequestSchema.extend({
  // Draft from this chosen angle (manual pick). Injected as a context section.
  angle: z.string().trim().max(ANGLE_MAX_CHARS).optional(),
  // Generate angles, auto-pick the strongest, then draft — all server-side.
  autoAngle: z.boolean().optional(),
  angleCount: z.number().int().min(ANGLE_COUNT_MIN).max(ANGLE_COUNT_MAX).optional(),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const rateGenerationInputSchema = z.object({
  rating: z.enum(OUTPUT_RATINGS),
});
export type RateGenerationInput = z.infer<typeof rateGenerationInputSchema>;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const CAMPAIGN_ORIGINS = ["user", "system"] as const;
export type CampaignOrigin = (typeof CAMPAIGN_ORIGINS)[number];

export const CAMPAIGN_PURPOSES = ["initiative", "evergreen"] as const;
export type CampaignPurpose = (typeof CAMPAIGN_PURPOSES)[number];

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_OVERLAY_MAX_CHARS = 10_000;

/**
 * Per-campaign social automation mode (Sprint 28). `manual` = the founder drives
 * generation/approval/publishing by hand. `human_in_the_loop` = discovery signals
 * auto-generate drafts that wait at the approval gate. `scheduled_auto` = drafts are
 * auto-approved (a real, logged `system` approval) and posted on the campaign's
 * cadence, bounded by the social-automation guardrails.
 */
export const AUTOMATION_MODES = ["manual", "human_in_the_loop", "scheduled_auto"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** Default daily auto-post caps (Sprint 28) when a workspace hasn't set its own. */
export const DEFAULT_PER_CONNECTION_DAILY_CAP = 10;
export const DEFAULT_PER_CAMPAIGN_DAILY_CAP = 5;

export const campaignSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  origin: z.enum(CAMPAIGN_ORIGINS),
  purpose: z.enum(CAMPAIGN_PURPOSES),
  objective: z.string().max(1000),
  kpi: z.string().max(500),
  timeframe: z.string().max(200),
  audience: z.string().max(1000),
  pillars: z.array(z.string().max(200)).max(10),
  channels: z.array(z.enum(CHANNELS)),
  personaIds: z.array(z.string().uuid()),
  overlay: z.string().max(CAMPAIGN_OVERLAY_MAX_CHARS),
  status: z.enum(CAMPAIGN_STATUSES),
  automationMode: z.enum(AUTOMATION_MODES),
  /** Per-campaign override of the daily auto-post cap; null = use the workspace default. */
  autoDailyCap: z.number().int().positive().max(1000).nullable(),
  currentPlanRevisionId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Campaign = z.infer<typeof campaignSchema>;

export const upsertCampaignInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Campaign name is required")
    .max(200, "Campaign name must be 200 characters or fewer"),
  purpose: z.enum(CAMPAIGN_PURPOSES).default("initiative"),
  objective: z.string().trim().max(1000).default(""),
  kpi: z.string().trim().max(500).default(""),
  timeframe: z.string().trim().max(200).default(""),
  audience: z.string().trim().max(1000).default(""),
  pillars: z.array(z.string().trim().min(1).max(200)).max(10, "At most 10 pillars").default([]),
  channels: z.array(z.enum(CHANNELS)).default([]),
  personaIds: z.array(z.string().uuid()).default([]),
  overlay: z.string().max(CAMPAIGN_OVERLAY_MAX_CHARS).default(""),
  status: z.enum(CAMPAIGN_STATUSES).default("active"),
  automationMode: z.enum(AUTOMATION_MODES).default("manual"),
  autoDailyCap: z.number().int().positive().max(1000).nullable().default(null),
});
export type UpsertCampaignInput = z.infer<typeof upsertCampaignInputSchema>;

/** Focused payload for the campaign automation toggle (Sprint 28). */
export const updateCampaignAutomationInputSchema = z.object({
  automationMode: z.enum(AUTOMATION_MODES),
  autoDailyCap: z.number().int().positive().max(1000).nullable().default(null),
});
export type UpdateCampaignAutomationInput = z.infer<typeof updateCampaignAutomationInputSchema>;

// ---------------------------------------------------------------------------
// GTM orchestration control plane
// ---------------------------------------------------------------------------

export const PLAN_REVISION_STATUSES = ["draft", "active", "superseded"] as const;
export type PlanRevisionStatus = (typeof PLAN_REVISION_STATUSES)[number];

export const LANE_STATUSES = ["active", "paused", "retired"] as const;
export type LaneStatus = (typeof LANE_STATUSES)[number];

export const DELIVERY_MODES = ["planned", "reactive", "planned_and_reactive"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const REACTIVE_PERIODS = ["day", "week", "month"] as const;
export type ReactivePeriod = (typeof REACTIVE_PERIODS)[number];

// Activated in Sprint 62 (`package_sources.role`, design §8.7). `trigger` and
// `evidence` have producers; the rest are active vocabulary awaiting theirs.
export const PACKAGE_SOURCE_ROLES = [
  "trigger",
  "evidence",
  "inspiration",
  "instruction",
  "repurposed_from",
] as const;
export type PackageSourceRole = (typeof PACKAGE_SOURCE_ROLES)[number];

// Activated in Sprint 63 (`deliverables.status`, design §8.10). `assessing`
// and `research_needed` are active vocabulary awaiting their producers
// (deliverable-level re-assessment propagation, D-63.11); every other status
// has one.
export const DELIVERABLE_PRODUCTION_STATUSES = [
  "planned",
  "assessing",
  "research_needed",
  "ready",
  "generating",
  "candidate_ready",
  "fulfilled",
  "stale",
  "blocked",
  "cancelled",
] as const;
export type DeliverableProductionStatus = (typeof DELIVERABLE_PRODUCTION_STATUSES)[number];

export const EXTERNAL_ACTION_KINDS = [
  "publish",
  "send",
  "reply",
  "paid_launch",
  "budget_change",
  "targeting_change",
] as const;
export type ExternalActionKind = (typeof EXTERNAL_ACTION_KINDS)[number];

export const EXTERNAL_ACTION_STATUSES = [
  "proposed",
  "authorization_required",
  "authorized",
  "scheduled",
  "dispatching",
  "succeeded",
  "failed",
  "blocked",
  "stale",
  "cancelled",
] as const;
export type ExternalActionStatus = (typeof EXTERNAL_ACTION_STATUSES)[number];

export const EXTERNAL_ACTION_POLICY_SCOPES = [
  "workspace",
  "campaign",
  "persona",
  "connection",
  "lane",
] as const;
export type ExternalActionPolicyScope = (typeof EXTERNAL_ACTION_POLICY_SCOPES)[number];

export const EXTERNAL_ACTION_POLICY_RULES = [
  "inherit",
  "autonomous",
  "human_required",
] as const;
export type ExternalActionPolicyRule = (typeof EXTERNAL_ACTION_POLICY_RULES)[number];

export const EXTERNAL_ACTION_EFFECTIVE_POLICIES = ["autonomous", "human_required"] as const;
export type ExternalActionEffectivePolicy =
  (typeof EXTERNAL_ACTION_EFFECTIVE_POLICIES)[number];

export const EXTERNAL_ACTION_DECISIONS = ["authorize", "deny"] as const;
export type ExternalActionDecisionValue = (typeof EXTERNAL_ACTION_DECISIONS)[number];

/**
 * Who proposed an action (Sprint 69). Distinct from `proposedBy`, which names
 * the actor: two system-actor proposals can come from a cadence and from an
 * agent's propose tool, and the authorization queue has to be able to say
 * which. Deliberately absent from the action fingerprint (D-69.3) — the gate
 * must treat an agent-originated action exactly as a human-originated one.
 */
export const EXTERNAL_ACTION_ORIGINS = ["human", "system", "agent"] as const;
export type ExternalActionOrigin = (typeof EXTERNAL_ACTION_ORIGINS)[number];

export const EXTERNAL_ACTION_SUBJECT_KINDS = [
  "draft",
  "inbox_item",
  "launch_message",
  "ad_launch",
  "campaign",
] as const;
export type ExternalActionSubjectKind = (typeof EXTERNAL_ACTION_SUBJECT_KINDS)[number];

export const EXTERNAL_ACTION_EXECUTION_KINDS = [
  "publication",
  "inbox_reply",
  "launch_message",
  "ad_launch",
  "ad_mutation",
  "email_delivery",
] as const;
export type ExternalActionExecutionKind = (typeof EXTERNAL_ACTION_EXECUTION_KINDS)[number];

export const PRIORITY_ITEM_KINDS = [
  "execution_failure",
  "stale_action",
  "policy_block",
  "authorization",
  "content_review",
  "signal_triage",
  "learning_review",
  "connection_health",
  "campaign_risk",
] as const;
export type PriorityItemKind = (typeof PRIORITY_ITEM_KINDS)[number];

export const externalActionPolicyRuleSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    scope: z.enum(EXTERNAL_ACTION_POLICY_SCOPES),
    scopeId: z.string().uuid(),
    actionKind: z.enum(EXTERNAL_ACTION_KINDS),
    rule: z.enum(EXTERNAL_ACTION_POLICY_RULES),
    createdBy: z.string().uuid().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "workspace" && value.scopeId !== value.workspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeId"],
        message: "A workspace policy must use the workspace id as its scope id.",
      });
    }
    if (value.scope === "workspace" && value.rule === "inherit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rule"],
        message: "Workspace policy cannot inherit.",
      });
    }
  });
export type ExternalActionPolicyRuleRecord = z.infer<typeof externalActionPolicyRuleSchema>;

export const externalActionPolicyContributionSchema = z.object({
  scope: z.enum(EXTERNAL_ACTION_POLICY_SCOPES),
  scopeId: z.string().uuid(),
  scopeLabel: z.string().trim().min(1),
  rule: z.enum(EXTERNAL_ACTION_POLICY_RULES),
});
export type ExternalActionPolicyContribution = z.infer<
  typeof externalActionPolicyContributionSchema
>;

export const effectiveExternalActionPolicySchema = z.object({
  effective: z.enum(EXTERNAL_ACTION_EFFECTIVE_POLICIES),
  contributingRules: z.array(externalActionPolicyContributionSchema),
});
export type EffectiveExternalActionPolicy = z.infer<typeof effectiveExternalActionPolicySchema>;

export const externalActionSubjectSchema = z.object({
  kind: z.enum(EXTERNAL_ACTION_SUBJECT_KINDS),
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  summary: z.string(),
  channel: z.string().nullable(),
  destination: z.string().nullable(),
});
export type ExternalActionSubject = z.infer<typeof externalActionSubjectSchema>;

export const externalActionContextSchema = z.object({
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  personaId: z.string().uuid().nullable(),
  personaName: z.string().nullable(),
  connectionId: z.string().uuid().nullable(),
  connectionName: z.string().nullable(),
  laneRevisionId: z.string().uuid().nullable(),
  laneName: z.string().nullable(),
});
export type ExternalActionContext = z.infer<typeof externalActionContextSchema>;

export const externalActionBlockerSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  retryable: z.boolean(),
});
export type ExternalActionBlocker = z.infer<typeof externalActionBlockerSchema>;

export const externalActionExecutionRefSchema = z.object({
  kind: z.enum(EXTERNAL_ACTION_EXECUTION_KINDS),
  id: z.string().uuid(),
  status: z.string().trim().min(1),
  url: z.string().url().nullable(),
  error: z.string().nullable(),
});
export type ExternalActionExecutionRef = z.infer<typeof externalActionExecutionRefSchema>;

export const externalActionActorSchema = z.object({
  userId: z.string().uuid().nullable(),
  label: z.string().trim().min(1),
});
export type ExternalActionActor = z.infer<typeof externalActionActorSchema>;

export const externalActionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    kind: z.enum(EXTERNAL_ACTION_KINDS),
    status: z.enum(EXTERNAL_ACTION_STATUSES),
    subject: externalActionSubjectSchema,
    context: externalActionContextSchema,
    requestedFor: z.number().int().nullable(),
    idempotencyKey: z.string().trim().min(1).max(300),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policy: effectiveExternalActionPolicySchema,
    blocker: externalActionBlockerSchema.nullable(),
    supersedesActionId: z.string().uuid().nullable(),
    supersededByActionId: z.string().uuid().nullable(),
    execution: externalActionExecutionRefSchema.nullable(),
    proposedBy: externalActionActorSchema,
    origin: z.enum(EXTERNAL_ACTION_ORIGINS),
    /** The agent run whose propose tool minted this — `agent` origin only. */
    originRunId: z.string().uuid().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    authorizedAt: z.number().int().nullable(),
    dispatchedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === "blocked" || value.status === "stale") && !value.blocker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocker"],
        message: `${value.status} actions require a durable blocker.`,
      });
    }
    if (value.status === "succeeded" && !value.execution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution"],
        message: "Succeeded actions require an execution receipt.",
      });
    }
    // An agent-originated action that cannot name the run that proposed it is
    // unattributable, which is the one thing Sprint 69 owed the queue.
    if (value.origin === "agent" && !value.originRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["originRunId"],
        message: "Agent-originated actions must name the agent run that proposed them.",
      });
    }
    if (value.origin !== "agent" && value.originRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["originRunId"],
        message: "Only agent-originated actions carry an agent run id.",
      });
    }
  });
export type ExternalAction = z.infer<typeof externalActionSchema>;

export const externalActionDecisionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actionId: z.string().uuid(),
  decision: z.enum(EXTERNAL_ACTION_DECISIONS),
  reason: z.string().max(1_000).nullable(),
  actor: externalActionActorSchema,
  subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policy: effectiveExternalActionPolicySchema,
  createdAt: z.number().int(),
});
export type ExternalActionDecision = z.infer<typeof externalActionDecisionSchema>;

export const externalActionDetailSchema = z.object({
  action: externalActionSchema,
  decisions: z.array(externalActionDecisionSchema),
});
export type ExternalActionDetail = z.infer<typeof externalActionDetailSchema>;

export const externalActionSubmissionSchema = z.object({
  action: externalActionSchema,
  execution: externalActionExecutionRefSchema.nullable(),
});
export type ExternalActionSubmission = z.infer<typeof externalActionSubmissionSchema>;

export const AUTHORIZATION_BATCH_MODES = ["selected", "campaign"] as const;
export type AuthorizationBatchMode = (typeof AUTHORIZATION_BATCH_MODES)[number];

export const AUTHORIZATION_BATCH_STATUSES = [
  "preview",
  "running",
  "completed",
  "partially_completed",
  "failed",
] as const;
export type AuthorizationBatchStatus = (typeof AUTHORIZATION_BATCH_STATUSES)[number];

export const AUTHORIZATION_BATCH_ITEM_STATUSES = [
  "pending",
  "succeeded",
  "scheduled",
  "failed",
  "blocked",
  "stale",
  "skipped",
] as const;
export type AuthorizationBatchItemStatus =
  (typeof AUTHORIZATION_BATCH_ITEM_STATUSES)[number];

const selectedAuthorizationBatchSchema = z
  .object({
    mode: z.literal("selected"),
    actionIds: z.array(z.string().uuid()).min(1).max(25),
  })
  .strict();

const campaignAuthorizationBatchSchema = z
  .object({
    mode: z.literal("campaign"),
    campaignId: z.string().uuid(),
    kinds: z
      .array(z.enum(EXTERNAL_ACTION_KINDS))
      .min(1)
      .max(EXTERNAL_ACTION_KINDS.length)
      .nullable()
      .default(null),
  })
  .strict();

export const authorizationBatchSelectionSchema = z
  .discriminatedUnion("mode", [selectedAuthorizationBatchSchema, campaignAuthorizationBatchSchema])
  .superRefine((value, ctx) => {
    const values = value.mode === "selected" ? value.actionIds : (value.kinds ?? []);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.mode === "selected" ? "actionIds" : "kinds"],
        message: "Batch selections cannot contain duplicates.",
      });
    }
  });
export type AuthorizationBatchSelection = z.infer<typeof authorizationBatchSelectionSchema>;

export const createAuthorizationBatchInputSchema = z
  .object({
    requestId: z.string().uuid(),
    selection: authorizationBatchSelectionSchema,
  })
  .strict();
export type CreateAuthorizationBatchInput = z.infer<
  typeof createAuthorizationBatchInputSchema
>;

const TERMINAL_AUTHORIZATION_BATCH_STATUSES: ReadonlySet<AuthorizationBatchStatus> = new Set([
  "completed",
  "partially_completed",
  "failed",
]);

const TERMINAL_AUTHORIZATION_BATCH_ITEM_STATUSES: ReadonlySet<AuthorizationBatchItemStatus> =
  new Set(["succeeded", "scheduled", "failed", "blocked", "stale", "skipped"]);

export const authorizationBatchSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    requestId: z.string().uuid(),
    selection: authorizationBatchSelectionSchema,
    status: z.enum(AUTHORIZATION_BATCH_STATUSES),
    continuationCount: z.number().int().nonnegative(),
    includedCount: z.number().int().min(0).max(100),
    excludedCount: z.number().int().nonnegative(),
    createdBy: externalActionActorSchema,
    createdAt: z.number().int(),
    confirmedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.selection.mode === "selected" && value.continuationCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuationCount"],
        message: "Selected batches cannot have continuation items.",
      });
    }
    if (value.status === "preview" && (value.confirmedAt !== null || value.completedAt !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Preview batches cannot be confirmed or completed.",
      });
    }
    if (value.status === "running" && (value.confirmedAt === null || value.completedAt !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Running batches require confirmation and cannot be completed.",
      });
    }
    if (
      TERMINAL_AUTHORIZATION_BATCH_STATUSES.has(value.status) &&
      (value.confirmedAt === null || value.completedAt === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Terminal batches require confirmation and completion timestamps.",
      });
    }
    if (value.confirmedAt !== null && value.confirmedAt < value.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmedAt"],
        message: "Confirmation cannot predate batch creation.",
      });
    }
    if (
      value.completedAt !== null &&
      value.completedAt < (value.confirmedAt ?? value.createdAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "Completion cannot predate confirmation.",
      });
    }
  });
export type AuthorizationBatch = z.infer<typeof authorizationBatchSchema>;

export const authorizationBatchItemSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    batchId: z.string().uuid(),
    actionId: z.string().uuid(),
    actionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    actionUpdatedAt: z.number().int(),
    kind: z.enum(EXTERNAL_ACTION_KINDS),
    campaignId: z.string().uuid().nullable(),
    impact: z.string().trim().min(1).max(1_000),
    eligible: z.boolean(),
    exclusionReason: z.string().trim().min(1).max(500).nullable(),
    status: z.enum(AUTHORIZATION_BATCH_ITEM_STATUSES),
    error: z.string().max(1_000).nullable(),
    submission: externalActionSubmissionSchema.nullable(),
    processedAt: z.number().int().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.eligible === (value.exclusionReason !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exclusionReason"],
        message: "Only excluded items require an exclusion reason.",
      });
    }
    if (value.eligible === (value.status === "skipped")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Only excluded items may be skipped.",
      });
    }
    if (
      value.status === "pending" &&
      (value.submission !== null || value.error !== null || value.processedAt !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Pending items cannot carry an outcome.",
      });
    }
    if (
      value.eligible &&
      TERMINAL_AUTHORIZATION_BATCH_ITEM_STATUSES.has(value.status) &&
      value.processedAt === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processedAt"],
        message: "Processed eligible items require a timestamp.",
      });
    }
    if ((value.status === "succeeded" || value.status === "scheduled") && !value.submission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["submission"],
        message: `${value.status} items require an action submission.`,
      });
    }
    if (
      value.eligible &&
      value.status !== "pending" &&
      !value.submission &&
      value.error === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "Processed items require a submission or durable error.",
      });
    }
    if (
      !value.eligible &&
      (value.submission !== null || value.error !== null || value.processedAt !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Preview-excluded items cannot carry execution outcomes.",
      });
    }
    if (value.submission) {
      const action = value.submission.action;
      if (
        action.id !== value.actionId ||
        action.fingerprint !== value.actionFingerprint ||
        action.kind !== value.kind ||
        action.context.campaignId !== value.campaignId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["submission"],
          message: "The submission must belong to the snapshotted action.",
        });
      }
      const expectedStatus =
        value.status === "succeeded"
          ? "succeeded"
          : value.status === "scheduled"
            ? "scheduled"
            : value.status === "failed"
              ? "failed"
              : value.status === "blocked"
                ? "blocked"
                : value.status === "stale"
                  ? "stale"
                  : null;
      if (expectedStatus !== null && action.status !== expectedStatus) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["submission", "action", "status"],
          message: "The submission status must match the stored item outcome.",
        });
      }
    }
  });
export type AuthorizationBatchItem = z.infer<typeof authorizationBatchItemSchema>;

export const authorizationBatchDetailSchema = z
  .object({
    batch: authorizationBatchSchema,
    items: z.array(authorizationBatchItemSchema),
  })
  .superRefine((value, ctx) => {
    const included = value.items.filter((item) => item.eligible);
    const excluded = value.items.filter((item) => !item.eligible);
    if (
      included.length !== value.batch.includedCount ||
      excluded.length !== value.batch.excludedCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Batch item counts must match the immutable preview.",
      });
    }
    for (const [index, item] of value.items.entries()) {
      if (item.batchId !== value.batch.id || item.workspaceId !== value.batch.workspaceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index],
          message: "Batch items must belong to the same batch and workspace.",
        });
      }
    }
    if (
      TERMINAL_AUTHORIZATION_BATCH_STATUSES.has(value.batch.status) &&
      included.some((item) => !TERMINAL_AUTHORIZATION_BATCH_ITEM_STATUSES.has(item.status))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Terminal batches cannot contain pending included items.",
      });
    }
    if (
      value.batch.status === "preview" &&
      value.items.some(
        (item) =>
          (item.eligible && item.status !== "pending") ||
          (!item.eligible && item.status !== "skipped"),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Preview items must be pending or preview-excluded.",
      });
    }
  });
export type AuthorizationBatchDetail = z.infer<typeof authorizationBatchDetailSchema>;

// ---------------------------------------------------------------------------
// Governed native email — verified sender identity, explicit recipient safety,
// durable delivery snapshots, and immutable provider event projections.
// ---------------------------------------------------------------------------

export const EMAIL_SENDER_STATUSES = [
  "not_configured",
  "pending",
  "verified",
  "failed",
] as const;
export type EmailSenderStatus = (typeof EMAIL_SENDER_STATUSES)[number];

export const EMAIL_PERMISSION_STATUSES = ["unknown", "allowed", "suppressed"] as const;
export type EmailPermissionStatus = (typeof EMAIL_PERMISSION_STATUSES)[number];

export const EMAIL_DELIVERY_STATUSES = [
  "queued",
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "failed",
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const EMAIL_DELIVERY_ORIGINS = [
  "launch_message",
  "outbound_draft",
  "pr_draft",
] as const;
export type EmailDeliveryOrigin = (typeof EMAIL_DELIVERY_ORIGINS)[number];

export const normalizedEmailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .email("A valid email address is required");

const emailSenderDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "A valid sender domain is required",
  );

const emailSenderLocalPartSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/,
    "Use a domain-free email local part",
  );

export const emailDnsRecordSchema = z
  .object({
    name: z.string().trim().min(1).max(253),
    type: z.string().trim().min(1).max(16),
    value: z.string().trim().min(1).max(4_096),
    priority: z.number().int().min(0).max(65_535).nullable(),
    status: z.string().trim().min(1).max(100),
  })
  .strict();
export type EmailDnsRecord = z.infer<typeof emailDnsRecordSchema>;

export const emailSenderSchema = z
  .object({
    workspaceId: z.string().uuid(),
    domain: emailSenderDomainSchema,
    fromLocalPart: emailSenderLocalPartSchema,
    fromName: z.string().trim().min(1).max(200),
    fromAddress: normalizedEmailAddressSchema,
    replyTo: normalizedEmailAddressSchema.nullable(),
    status: z.enum(EMAIL_SENDER_STATUSES),
    provider: z.literal("resend"),
    providerDomainId: z.string().trim().min(1).max(300).nullable(),
    dnsRecords: z.array(emailDnsRecordSchema).max(20),
    killSwitch: z.boolean(),
    dailyCap: z.number().int().min(1).max(100_000),
    lastCheckedAt: z.number().int().nullable(),
    lastError: z.string().max(1_000).nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type EmailSender = z.infer<typeof emailSenderSchema>;

export const updateEmailSenderInputSchema = z
  .object({
    domain: emailSenderDomainSchema,
    fromLocalPart: emailSenderLocalPartSchema,
    fromName: z.string().trim().min(1).max(200),
    replyTo: normalizedEmailAddressSchema.nullable(),
  })
  .strict();
export type UpdateEmailSenderInput = z.infer<typeof updateEmailSenderInputSchema>;

export const emailRecipientPermissionSchema = z
  .object({
    workspaceId: z.string().uuid(),
    normalizedEmail: normalizedEmailAddressSchema,
    status: z.enum(EMAIL_PERMISSION_STATUSES),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type EmailRecipientPermission = z.infer<typeof emailRecipientPermissionSchema>;

export const updateEmailPermissionInputSchema = z
  .object({
    status: z.enum(["allowed", "suppressed"]),
  })
  .strict();
export type UpdateEmailPermissionInput = z.infer<typeof updateEmailPermissionInputSchema>;

export const emailSafetySettingsSchema = z
  .object({
    killSwitch: z.boolean(),
    dailyCap: z.number().int().min(1).max(100_000),
  })
  .strict();
export type EmailSafetySettings = z.infer<typeof emailSafetySettingsSchema>;

export const updateEmailSafetyInputSchema = emailSafetySettingsSchema;
export type UpdateEmailSafetyInput = z.infer<typeof updateEmailSafetyInputSchema>;

export const emailSuppressionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    normalizedEmail: normalizedEmailAddressSchema,
    reason: z.string().trim().min(1).max(200),
    createdAt: z.number().int(),
  })
  .strict();
export type EmailSuppression = z.infer<typeof emailSuppressionSchema>;

export const emailDeliverySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    externalActionId: z.string().uuid(),
    origin: z.enum(EMAIL_DELIVERY_ORIGINS),
    originId: z.string().uuid(),
    normalizedRecipient: normalizedEmailAddressSchema,
    senderAddress: normalizedEmailAddressSchema,
    replyTo: normalizedEmailAddressSchema.nullable(),
    subject: z.string().min(1).max(998),
    text: z.string().min(1).max(2_000_000),
    html: z.string().max(5_000_000).nullable(),
    idempotencyKey: z.string().trim().min(1).max(256),
    provider: z.literal("resend"),
    providerMessageId: z.string().trim().min(1).max(300).nullable(),
    status: z.enum(EMAIL_DELIVERY_STATUSES),
    acceptedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
    lastError: z.string().max(1_000).nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type EmailDelivery = z.infer<typeof emailDeliverySchema>;

export const emailDeliveryEventSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    provider: z.literal("resend"),
    providerEventId: z.string().trim().min(1).max(300),
    eventType: z.string().trim().min(1).max(200),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.number().int(),
    createdAt: z.number().int(),
  })
  .strict();
export type EmailDeliveryEvent = z.infer<typeof emailDeliveryEventSchema>;

const EMAIL_DELIVERY_TRANSITIONS: Record<EmailDeliveryStatus, ReadonlySet<EmailDeliveryStatus>> = {
  queued: new Set(["accepted", "failed"]),
  accepted: new Set(["delivered", "bounced", "complained", "failed"]),
  delivered: new Set(),
  bounced: new Set(),
  complained: new Set(),
  failed: new Set(),
};

export function canTransitionEmailDelivery(
  from: EmailDeliveryStatus,
  to: EmailDeliveryStatus,
): boolean {
  return EMAIL_DELIVERY_TRANSITIONS[from].has(to);
}

export const externalActionListFiltersSchema = z.object({
  status: z.enum(EXTERNAL_ACTION_STATUSES).optional(),
  kind: z.enum(EXTERNAL_ACTION_KINDS).optional(),
  campaign: z.string().uuid().optional(),
  channel: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ExternalActionListFilters = z.infer<typeof externalActionListFiltersSchema>;

export const authorizeExternalActionInputSchema = z.object({}).strict();
export const denyExternalActionInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().optional(),
});
/**
 * Withdrawing an authorization that was already granted — the collapsed publish
 * gate (Sprint 52) authorizes at propose time, so such an action never sits in
 * the queue for `deny` to reach. Legality is the contracts state machine's call:
 * anything with an edge to `cancelled` can still be withdrawn, and `succeeded`
 * has none.
 */
export const cancelExternalActionInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().optional(),
});
export const reproposeExternalActionInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(300),
});

const externalActionPolicyWriteSchema = z.object({
  actionKind: z.enum(EXTERNAL_ACTION_KINDS),
  rule: z.enum(EXTERNAL_ACTION_POLICY_RULES),
});

export const upsertExternalActionPoliciesInputSchema = z
  .object({
    scope: z.enum(EXTERNAL_ACTION_POLICY_SCOPES),
    scopeId: z.string().uuid(),
    expectedUpdatedAt: z.number().int().nullable(),
    rules: z.array(externalActionPolicyWriteSchema).length(EXTERNAL_ACTION_KINDS.length),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "workspace" && value.rules.some((rule) => rule.rule === "inherit")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "Workspace policy cannot inherit.",
      });
    }
    const kinds = value.rules.map((rule) => rule.actionKind);
    if (new Set(kinds).size !== kinds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "Each action kind may appear only once.",
      });
    }
  });
export type UpsertExternalActionPoliciesInput = z.infer<
  typeof upsertExternalActionPoliciesInputSchema
>;

export const externalActionPolicyViewSchema = z.object({
  scope: z.enum(EXTERNAL_ACTION_POLICY_SCOPES),
  scopeId: z.string().uuid(),
  scopeLabel: z.string().trim().min(1),
  rules: z.array(externalActionPolicyRuleSchema),
  effective: z.array(
    z.object({
      actionKind: z.enum(EXTERNAL_ACTION_KINDS),
      policy: effectiveExternalActionPolicySchema,
    }),
  ),
  updatedAt: z.number().int().nullable(),
});
export type ExternalActionPolicyView = z.infer<typeof externalActionPolicyViewSchema>;

export const DELIVERABLE_TRANSITIONS: Record<
  DeliverableProductionStatus,
  readonly DeliverableProductionStatus[]
> = {
  planned: ["assessing", "ready", "stale", "blocked", "cancelled"],
  assessing: ["research_needed", "ready", "blocked", "cancelled"],
  research_needed: ["assessing", "ready", "stale", "cancelled"],
  ready: ["generating", "stale", "blocked", "cancelled"],
  generating: ["candidate_ready", "ready", "blocked", "cancelled"],
  candidate_ready: ["fulfilled", "generating", "stale", "cancelled"],
  fulfilled: [],
  stale: ["assessing", "cancelled"],
  blocked: ["assessing", "cancelled"],
  cancelled: [],
};

export function canTransitionDeliverable(
  from: DeliverableProductionStatus,
  to: DeliverableProductionStatus,
): boolean {
  return DELIVERABLE_TRANSITIONS[from].includes(to);
}

export function transitionDeliverable(
  from: DeliverableProductionStatus,
  to: DeliverableProductionStatus,
): DeliverableProductionStatus | undefined {
  return canTransitionDeliverable(from, to) ? to : undefined;
}

export const EXTERNAL_ACTION_TRANSITIONS: Record<
  ExternalActionStatus,
  readonly ExternalActionStatus[]
> = {
  proposed: ["authorization_required", "authorized", "blocked", "stale", "cancelled"],
  authorization_required: ["authorized", "stale", "cancelled"],
  authorized: ["scheduled", "dispatching", "blocked", "stale", "cancelled"],
  scheduled: ["dispatching", "blocked", "stale", "cancelled"],
  dispatching: ["succeeded", "failed"],
  succeeded: [],
  failed: ["scheduled", "dispatching", "cancelled"],
  blocked: ["proposed", "cancelled"],
  stale: ["cancelled"],
  cancelled: [],
};

export function canTransitionExternalAction(
  from: ExternalActionStatus,
  to: ExternalActionStatus,
): boolean {
  return EXTERNAL_ACTION_TRANSITIONS[from].includes(to);
}

const campaignPlanFields = {
  objective: z.string().trim().max(1_000).default(""),
  kpi: z.string().trim().max(500).default(""),
  timeframe: z.string().trim().max(200).default(""),
  startAt: z.number().int().nullable(),
  endAt: z.number().int().nullable(),
  audienceIds: z.array(z.string().uuid()).default([]),
  pillars: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  offers: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  ctas: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  guidance: z.string().trim().max(CAMPAIGN_OVERLAY_MAX_CHARS).default(""),
};

function validatePlanWindow(
  value: { startAt: number | null; endAt: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.startAt !== null && value.endAt !== null && value.endAt <= value.startAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endAt"],
      message: "Campaign end must be after its start.",
    });
  }
}

export const campaignPlanRevisionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    revision: z.number().int().positive(),
    status: z.enum(PLAN_REVISION_STATUSES),
    ...campaignPlanFields,
    createdBy: z.string().uuid().nullable(),
    createdAt: z.number().int(),
    activatedAt: z.number().int().nullable(),
  })
  .superRefine(validatePlanWindow);
export type CampaignPlanRevision = z.infer<typeof campaignPlanRevisionSchema>;

export const createCampaignPlanRevisionInputSchema = z
  .object(campaignPlanFields)
  .superRefine(validatePlanWindow);
export type CreateCampaignPlanRevisionInput = z.infer<
  typeof createCampaignPlanRevisionInputSchema
>;

/**
 * `POST /workspaces/:id/resolve` only (Sprint 53 Task 5). The campaign plan
 * form previews what the LLM will see for the revision **being edited**, which
 * is unsaved React state — there is no row to point a `planRevisionId` at — so
 * the draft is sent inline and composed in place of the stored active plan.
 *
 * Three properties keep that safe on a route that composes prompts:
 *
 * 1. It is a **superset** of `resolveRequestSchema`, declared here rather than
 *    on the base, so the generation routes (`generateRequestSchema`,
 *    `generateAnglesInputSchema`) can never accept an inline plan — only the
 *    read-only, non-persisting inspector route can.
 * 2. The draft is `createCampaignPlanRevisionInputSchema` verbatim — the exact
 *    schema a *stored* revision is created through — so every field cap
 *    (objective 1k, pillars 20×200, guidance `CAMPAIGN_OVERLAY_MAX_CHARS`, the
 *    start/end window rule) applies identically. A preview cannot widen a limit.
 * 3. `PLAN_SECTION_TOKEN_CAP` still governs composition downstream, so even a
 *    maximal valid draft is truncated exactly as a stored one would be.
 *
 * It is declared here, not beside `resolveRequestSchema`, because the plan field
 * schemas are defined further down the file.
 */
export const resolvePreviewRequestSchema = resolveRequestSchema.extend({
  campaignPlanDraft: createCampaignPlanRevisionInputSchema.optional(),
});
export type ResolvePreviewRequest = z.infer<typeof resolvePreviewRequestSchema>;

export const campaignLaneSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case lane key."),
  name: z.string().trim().min(1).max(120),
  status: z.enum(LANE_STATUSES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type CampaignLane = z.infer<typeof campaignLaneSchema>;

export const laneScheduleSchema = z.object({
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a HH:MM 24-hour time"),
  timezone: z.string().min(1).refine(isValidTimeZone, "Unknown time zone"),
});
export type LaneSchedule = z.infer<typeof laneScheduleSchema>;

const campaignLaneRevisionFields = {
  personaId: z.string().uuid(),
  audienceId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  format: z.string().trim().min(1).max(100),
  publishingConnectionId: z.string().uuid().nullable(),
  providerTarget: z.string().trim().max(200).default(""),
  deliveryMode: z.enum(DELIVERY_MODES),
  plannedQuantity: z.number().int().min(0).max(1_000),
  schedule: laneScheduleSchema.nullable(),
  reactivePeriod: z.enum(REACTIVE_PERIODS).nullable(),
  reactiveCap: z.number().int().positive().max(1_000).nullable(),
  status: z.enum(LANE_STATUSES),
};

function validateLaneDelivery(
  value: {
    deliveryMode: DeliveryMode;
    plannedQuantity: number;
    schedule: LaneSchedule | null;
    reactivePeriod: ReactivePeriod | null;
    reactiveCap: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.deliveryMode !== "reactive") {
    if (!value.schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "Planned delivery requires a schedule.",
      });
    }
    if (value.plannedQuantity < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plannedQuantity"],
        message: "Planned delivery requires a positive quantity.",
      });
    }
  }
  if (value.deliveryMode !== "planned" && (!value.reactivePeriod || !value.reactiveCap)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reactiveCap"],
      message: "Reactive delivery requires a period and positive cap.",
    });
  }
}

export const campaignLaneRevisionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    laneId: z.string().uuid(),
    planRevisionId: z.string().uuid(),
    ...campaignLaneRevisionFields,
    createdAt: z.number().int(),
  })
  .superRefine(validateLaneDelivery);
export type CampaignLaneRevision = z.infer<typeof campaignLaneRevisionSchema>;

export const campaignPlanIssueSchema = z.object({
  path: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type CampaignPlanIssue = z.infer<typeof campaignPlanIssueSchema>;

export const campaignLaneRevisionViewSchema = campaignLaneRevisionSchema.and(
  z.object({
    key: campaignLaneSchema.shape.key,
    name: campaignLaneSchema.shape.name,
  }),
);
export type CampaignLaneRevisionView = z.infer<typeof campaignLaneRevisionViewSchema>;

export const campaignPlanDetailSchema = z.object({
  plan: campaignPlanRevisionSchema,
  lanes: z.array(campaignLaneRevisionViewSchema),
});
export type CampaignPlanDetail = z.infer<typeof campaignPlanDetailSchema>;

export const campaignPlanWorkspaceSchema = z.object({
  currentPlanRevisionId: z.string().uuid().nullable(),
  revisions: z.array(campaignPlanDetailSchema),
  issues: z.array(campaignPlanIssueSchema),
});
export type CampaignPlanWorkspace = z.infer<typeof campaignPlanWorkspaceSchema>;

export const upsertCampaignLaneRevisionInputSchema = z
  .object({
    laneId: z.string().uuid().optional(),
    key: campaignLaneSchema.shape.key,
    name: campaignLaneSchema.shape.name,
    ...campaignLaneRevisionFields,
  })
  .superRefine(validateLaneDelivery);
export type UpsertCampaignLaneRevisionInput = z.infer<
  typeof upsertCampaignLaneRevisionInputSchema
>;

// ---------------------------------------------------------------------------
// Signals (manual market input — source adapters arrive in a later slice)
// ---------------------------------------------------------------------------

export const SIGNAL_SOURCES = [
  "reddit",
  "x",
  "linkedin",
  "instagram",
  "rss",
  "news",
  "hacker_news",
  "youtube",
  "podcast",
  "google_trends",
  "funding",
  "g2",
  "capterra",
  "intent",
  "other",
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_MAX_CHARS = 10_000;

// Persona×campaign matching (Sprint 45) — one candidate pairing a discovered
// item (or signal) scored as a fit for. Declared here (before `signalSchema`)
// because both `signalSchema` and `discoveredItemSchema` embed it.

/**
 * Default minimum match score (0–100) a candidate needs before automation
 * routes a signal to its campaign. Workspace-overridable via `matchThreshold`
 * on social automation settings.
 */
export const DEFAULT_MATCH_THRESHOLD = 50;
/** Scoring keeps at most this many candidates per item/signal (top scores win). */
export const DISCOVERY_MAX_MATCHES_PER_ITEM = 5;

export const discoveredItemMatchSchema = z.object({
  personaId: z.string().uuid().nullable(),
  personaName: z.string().nullable(),
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  score: z.number().int().min(0).max(100),
  reason: z.string(),
});
export type DiscoveredItemMatch = z.infer<typeof discoveredItemMatchSchema>;

export const signalSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  content: z.string().min(1).max(SIGNAL_MAX_CHARS),
  source: z.enum(SIGNAL_SOURCES),
  sourceUrl: z.string().nullable(),
  // Auto-mapping (Sprint 31): carried from a discovered item on accept so the
  // Content draft can pre-fill persona + campaign. Null for manual signals.
  suggestedPersonaId: z.string().uuid().nullable(),
  suggestedCampaignId: z.string().uuid().nullable(),
  // Sprint 45: every persona×campaign candidate this signal matched (names
  // joined in for display). Empty when nothing cleared scoring.
  matches: z.array(discoveredItemMatchSchema),
  createdAt: z.number().int(),
});
export type Signal = z.infer<typeof signalSchema>;

export const createSignalInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Signal content is required")
    .max(SIGNAL_MAX_CHARS, `Signal must be ${SIGNAL_MAX_CHARS} characters or fewer`),
  source: z.enum(SIGNAL_SOURCES),
  sourceUrl: z.string().trim().url("Source URL must be a valid URL").optional(),
  suggestedPersonaId: z.string().uuid().optional(),
  suggestedCampaignId: z.string().uuid().optional(),
});
export type CreateSignalInput = z.infer<typeof createSignalInputSchema>;

/** Drafting a response to a signal: the task type is implied (signal_response). */
export const draftSignalRequestSchema = z.object({
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
  useEvidence: z.boolean().optional(),
});
export type DraftSignalRequest = z.infer<typeof draftSignalRequestSchema>;

// ---------------------------------------------------------------------------
// Signal discovery (sourcing infrastructure)
// ---------------------------------------------------------------------------

/**
 * All registered source types. `rss`, `google_news`, and `reddit` fetch live
 * today; `x` and `linkedin` are registered infrastructure that flips live
 * when API credentials exist (status `needs_api_key` until then).
 */
export const DISCOVERY_SOURCE_TYPES = [
  "rss",
  "google_news",
  "reddit",
  "hacker_news",
  "youtube",
  "podcast",
  "google_trends",
  "funding_news",
  "x",
  "linkedin",
  "instagram",
  // Reserved. Activation sprint is not scheduled; a provider-specific sprint
  // must be created before g2, capterra, or intent becomes available.
  "g2",
  "capterra",
  "intent",
] as const;
export type DiscoverySourceType = (typeof DISCOVERY_SOURCE_TYPES)[number];

export const DISCOVERY_SOURCE_STATUSES = [
  "active",
  "needs_api_key",
  "reserved",
  "error",
] as const;
export type DiscoverySourceStatus = (typeof DISCOVERY_SOURCE_STATUSES)[number];

export const RESERVED_DISCOVERY_SOURCE_TYPES = [
  "google_trends",
  "g2",
  "capterra",
  "intent",
] as const satisfies readonly DiscoverySourceType[];

const RESERVED_DISCOVERY_SOURCE_TYPE_SET = new Set<DiscoverySourceType>(
  RESERVED_DISCOVERY_SOURCE_TYPES,
);

export function isReservedDiscoverySourceType(
  type: DiscoverySourceType,
): boolean {
  return RESERVED_DISCOVERY_SOURCE_TYPE_SET.has(type);
}

// Connected sourcing (Sprint 46): how a source listens. Keyless sources leave
// `mode` unset; connected sources pick a provider-supported mode (X: query /
// account_timeline / list_timeline; Reddit: subreddit / query; LinkedIn:
// account_timeline; Instagram: account_timeline / hashtag).
export const DISCOVERY_SOURCE_MODES = [
  "query",
  "account_timeline",
  "list_timeline",
  "subreddit",
  "hashtag",
] as const;
export type DiscoverySourceMode = (typeof DISCOVERY_SOURCE_MODES)[number];

// `duplicate` (Sprint 45): a cross-source copy of an already-seen story,
// linked to the canonical item via `duplicateOfId` — never enters triage.
export const DISCOVERED_ITEM_STATUSES = ["new", "accepted", "skipped", "duplicate"] as const;
export type DiscoveredItemStatus = (typeof DISCOVERED_ITEM_STATUSES)[number];

export const DISCOVERY_MATCHING_STATES = [
  "pending",
  "running",
  "ready",
  "retryable_error",
  "frozen",
] as const;
export type DiscoveryMatchingState =
  (typeof DISCOVERY_MATCHING_STATES)[number];

export const discoverySourceConfigSchema = z.object({
  feedUrl: z.string().url().optional(),
  query: z.string().trim().max(300).optional(),
  subreddit: z.string().trim().max(100).optional(),
  channelId: z.string().trim().max(100).optional(),
  geo: z.string().trim().max(10).optional(),
  sector: z.string().trim().max(100).optional(),
  // Connected sourcing (Sprint 46): mode + provider-specific targets. All
  // optional here; type/mode combinations are validated on source create.
  mode: z.enum(DISCOVERY_SOURCE_MODES).optional(),
  handle: z.string().trim().max(100).optional(),
  handles: z.array(z.string().trim().max(100)).max(25).optional(),
  listId: z.string().trim().max(100).optional(),
  hashtag: z.string().trim().max(100).optional(),
  trackedAccountId: z.string().uuid().optional(),
  trackedAccountIds: z.array(z.string().uuid()).max(25).optional(),
});
export type DiscoverySourceConfig = z.infer<typeof discoverySourceConfigSchema>;

export const discoveryCursorProgressSchema = z.object({
  version: z.literal(1),
  targetCount: z.number().int().nonnegative(),
  backlog: z.boolean(),
  lastCheckpointAt: z.number().int().nullable(),
});
export type DiscoveryCursorProgress = z.infer<
  typeof discoveryCursorProgressSchema
>;

export const discoverySourceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: z.enum(DISCOVERY_SOURCE_TYPES),
  name: z.string().min(1).max(200),
  config: discoverySourceConfigSchema,
  enabled: z.boolean(),
  status: z.enum(DISCOVERY_SOURCE_STATUSES),
  lastError: z.string().nullable(),
  lastFetchedAt: z.number().int().nullable(),
  // Connected sourcing (Sprint 46): the workspace connection this source reads
  // through. Null for keyless sources (RSS, Google News, keyless Reddit, ...).
  connectionId: z.string().uuid().nullable(),
  // Safe progress summary. Provider cursors and target identities stay
  // internal to the execution service.
  cursor: discoveryCursorProgressSchema,
  // Rate-limit back-pressure: the source is not enqueued until this passes.
  backoffUntil: z.number().int().nullable(),
  lastAttemptedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

/**
 * Connected-mode target check (Sprint 46): does the config name at least one
 * account to listen to (inline handle(s) or tracked account reference(s))?
 */
function hasAccountTarget(config: DiscoverySourceConfig): boolean {
  return Boolean(
    config.handle?.trim() ||
      config.handles?.length ||
      config.trackedAccountId ||
      config.trackedAccountIds?.length,
  );
}

export const createDiscoverySourceInputSchema = z
  .object({
    type: z.enum(DISCOVERY_SOURCE_TYPES),
    name: z.string().trim().min(1).max(200).optional(),
    config: discoverySourceConfigSchema.default({}),
    // Connected sourcing (Sprint 46): the workspace connection to read
    // through. Validated against the workspace/provider in the service.
    connectionId: z.string().uuid().nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === "rss" && !input.config.feedUrl) {
      ctx.addIssue({ code: "custom", message: "An RSS source needs a feedUrl" });
    }
    if (input.type === "google_news" && !input.config.query?.trim()) {
      ctx.addIssue({ code: "custom", message: "A Google News source needs a query" });
    }
    if (input.type === "reddit" && !input.config.query?.trim() && !input.config.subreddit?.trim()) {
      ctx.addIssue({ code: "custom", message: "A Reddit source needs a query or a subreddit" });
    }
    if (input.type === "hacker_news" && !input.config.query?.trim()) {
      ctx.addIssue({ code: "custom", message: "A Hacker News source needs a query" });
    }
    if (input.type === "youtube" && !input.config.channelId?.trim()) {
      ctx.addIssue({ code: "custom", message: "A YouTube source needs a channelId" });
    }
    if (input.type === "podcast" && !input.config.feedUrl) {
      ctx.addIssue({ code: "custom", message: "A podcast source needs a feedUrl" });
    }
    if (input.type === "funding_news" && !input.config.query?.trim()) {
      ctx.addIssue({ code: "custom", message: "A funding-news source needs a query" });
    }
    if (
      (input.type === "g2" || input.type === "capterra" || input.type === "intent") &&
      !input.config.query?.trim()
    ) {
      ctx.addIssue({ code: "custom", message: `A ${input.type} source needs a query` });
    }
    // Connected sourcing (Sprint 46). Keyless x/linkedin sources (no mode)
    // keep the legacy query requirement; a mode makes them connected sources
    // with per-mode target requirements. Instagram is connected-only.
    if (input.type === "x" || input.type === "linkedin") {
      const mode = input.config.mode;
      if (!mode && !input.config.query?.trim()) {
        ctx.addIssue({ code: "custom", message: `An ${input.type} source needs a query` });
      }
      if (input.type === "linkedin" && mode && mode !== "account_timeline") {
        ctx.addIssue({
          code: "custom",
          message: "A LinkedIn source only supports account_timeline mode",
        });
      }
      if (mode === "query" && !input.config.query?.trim()) {
        ctx.addIssue({ code: "custom", message: "A query-mode source needs a query" });
      }
      if (mode === "account_timeline" && !hasAccountTarget(input.config)) {
        ctx.addIssue({
          code: "custom",
          message: "An account_timeline source needs a handle or a tracked account",
        });
      }
      if (mode === "list_timeline" && !input.config.listId?.trim()) {
        ctx.addIssue({ code: "custom", message: "A list_timeline source needs a listId" });
      }
    }
    if (input.type === "instagram") {
      if (input.config.mode === "account_timeline") {
        if (!hasAccountTarget(input.config)) {
          ctx.addIssue({
            code: "custom",
            message: "An Instagram account_timeline source needs a handle or a tracked account",
          });
        }
      } else if (input.config.mode === "hashtag") {
        if (!input.config.hashtag?.trim()) {
          ctx.addIssue({ code: "custom", message: "An Instagram hashtag source needs a hashtag" });
        }
      } else {
        ctx.addIssue({
          code: "custom",
          message: "An Instagram source needs mode account_timeline or hashtag",
        });
      }
    }
  });
export type CreateDiscoverySourceInput = z.infer<typeof createDiscoverySourceInputSchema>;

export const updateDiscoverySourceInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  config: discoverySourceConfigSchema.optional(),
  // undefined = keep the current connection; null = detach it.
  connectionId: z.string().uuid().nullable().optional(),
});
export type UpdateDiscoverySourceInput = z.infer<typeof updateDiscoverySourceInputSchema>;

export const discoveredItemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceId: z.string().uuid(),
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  summary: z.string(),
  publishedAt: z.number().int().nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  suggestedPersonaId: z.string().uuid().nullable(),
  suggestedCampaignId: z.string().uuid().nullable(),
  scoreReason: z.string().nullable(),
  status: z.enum(DISCOVERED_ITEM_STATUSES),
  signalId: z.string().uuid().nullable(),
  matchingState: z.enum(DISCOVERY_MATCHING_STATES),
  matchingError: z.string().nullable(),
  // Sprint 45: every persona×campaign candidate this item matched (names
  // joined in for display). The item's suggested*/score fields stay the
  // top-scoring match, kept for triage sort order and accept pre-fill.
  matches: z.array(discoveredItemMatchSchema),
  // Sprint 45 cross-source dedup: set when this row is a `duplicate`-status
  // copy of an earlier canonical item.
  duplicateOfId: z.string().uuid().nullable(),
  // Number of linked duplicates for a canonical item (0 for plain/duplicate rows).
  duplicateCount: z.number().int(),
  createdAt: z.number().int(),
});
export type DiscoveredItem = z.infer<typeof discoveredItemSchema>;

export const discoveryRunSourceResultSchema = z.object({
  sourceId: z.string().uuid(),
  name: z.string().min(1),
  fetched: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type DiscoveryRunSourceResult = z.infer<
  typeof discoveryRunSourceResultSchema
>;

export const discoveryRunSummarySchema = z.object({
  busy: z.boolean(),
  budgetExhausted: z.boolean(),
  queued: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  sources: z.array(discoveryRunSourceResultSchema),
  scored: z.number().int().nonnegative(),
  /** Sprint 61: stories routed into campaign opportunities this tick. */
  storiesRouted: z.number().int().nonnegative().default(0),
  opportunitiesCreated: z.number().int().nonnegative().default(0),
  /** Sprint 62: package pipeline work performed this tick. */
  packagesCreated: z.number().int().nonnegative().default(0),
  packagesAssessed: z.number().int().nonnegative().default(0),
  /** Sprint 63: deliverable pipeline work performed this tick. */
  deliverablesCreated: z.number().int().nonnegative().default(0),
  variantsGenerated: z.number().int().nonnegative().default(0),
});
export type DiscoveryRunSummary = z.infer<
  typeof discoveryRunSummarySchema
>;

// Discovery job ledger (Sprint 46): one row per source fetch attempt.
// `/discovery/run` enqueues due sources and processes a bounded batch, so one
// slow source cannot serialize the whole workspace and runs stay observable.
export const DISCOVERY_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type DiscoveryJobStatus = (typeof DISCOVERY_JOB_STATUSES)[number];

export const discoveryJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceId: z.string().uuid(),
  status: z.enum(DISCOVERY_JOB_STATUSES),
  attempt: z.number().int().min(0),
  lockedAt: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  fetchedCount: z.number().int().min(0),
  newCount: z.number().int().min(0),
  error: z.string().nullable(),
  createdAt: z.number().int(),
});
export type DiscoveryJob = z.infer<typeof discoveryJobSchema>;

// Tracked social accounts (Sprint 46): first-class competitor/source accounts
// a workspace listens to. Discovery sources reference them by id instead of
// re-typing handles into every source config.
export const TRACKED_SOCIAL_PLATFORMS = ["x", "linkedin", "instagram", "reddit"] as const;
export type TrackedSocialPlatform = (typeof TRACKED_SOCIAL_PLATFORMS)[number];

export const trackedSocialAccountSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  platform: z.enum(TRACKED_SOCIAL_PLATFORMS),
  handle: z.string().min(1).max(100),
  displayName: z.string().nullable(),
  /** Provider-side id (e.g. a LinkedIn author URN) once resolved. */
  externalId: z.string().nullable(),
  url: z.string().nullable(),
  notes: z.string(),
  enabled: z.boolean(),
  lastResolvedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TrackedSocialAccount = z.infer<typeof trackedSocialAccountSchema>;

export const createTrackedSocialAccountInputSchema = z.object({
  platform: z.enum(TRACKED_SOCIAL_PLATFORMS),
  handle: z.string().trim().min(1).max(100),
  displayName: z.string().trim().max(200).optional(),
  url: z.string().url().optional(),
  notes: z.string().trim().max(2_000).optional(),
});
export type CreateTrackedSocialAccountInput = z.infer<
  typeof createTrackedSocialAccountInputSchema
>;

export const updateTrackedSocialAccountInputSchema = z.object({
  handle: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().max(200).nullable().optional(),
  url: z.string().url().nullable().optional(),
  notes: z.string().trim().max(2_000).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTrackedSocialAccountInput = z.infer<
  typeof updateTrackedSocialAccountInputSchema
>;

export const resolveTrackedSocialAccountInputSchema = z.object({
  connectionId: z.string().uuid(),
});
export type ResolveTrackedSocialAccountInput = z.infer<
  typeof resolveTrackedSocialAccountInputSchema
>;

// ---------------------------------------------------------------------------
// Canonical stories & source occurrences (Sprint 60, design §8.1–8.4)
//
// The durable intelligence layer behind discovery: immutable source
// occurrences resolve — by exact identity keys only — into workspace-owned
// canonical stories with reversible occurrence membership and versioned
// enrichment. Runs in shadow beside discovered-items triage; `signals` stay
// the manual-input seam.
// ---------------------------------------------------------------------------

export const STORY_STATUSES = ["active", "archived"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

// How an occurrence relates to its story. `redirect` is reserved: adapters do
// not surface post-redirect final URLs yet, so nothing emits it in Sprint 60.
export const STORY_OCCURRENCE_RELATIONSHIP_KINDS = [
  "exact",
  "redirect",
  "provider",
  "similarity",
  "manual",
] as const;
export type StoryOccurrenceRelationshipKind =
  (typeof STORY_OCCURRENCE_RELATIONSHIP_KINDS)[number];

// Exact identity keys. Resolution priority: provider_id > normalized_url >
// content_fingerprint. Conflicting keys never auto-merge stories.
export const STORY_KEY_KINDS = [
  "provider_id",
  "normalized_url",
  "content_fingerprint",
] as const;
export type StoryKeyKind = (typeof STORY_KEY_KINDS)[number];

/** Exact-key resolver generation stamped on memberships it creates. */
export const STORY_MATCHER_VERSION = 1;
/** Deterministic (no-LLM) enricher generation. */
export const STORY_ENRICHER_VERSION = 1;

export const storyOccurrenceRelationshipSchema = z.object({
  kind: z.enum(STORY_OCCURRENCE_RELATIONSHIP_KINDS),
  confidence: z.number().int().min(0).max(100),
  matcherVersion: z.number().int(),
  attachedAt: z.number().int(),
  /** Null when the system resolver attached it. */
  attachedByUserId: z.string().uuid().nullable(),
  attachReason: z.string().nullable(),
  /** Set when the membership was closed by a merge or split; rows persist. */
  detachedAt: z.number().int().nullable(),
  detachedByUserId: z.string().uuid().nullable(),
  detachReason: z.string().nullable(),
});
export type StoryOccurrenceRelationship = z.infer<
  typeof storyOccurrenceRelationshipSchema
>;

export const storyOccurrenceSchema = z.object({
  id: z.string().uuid(),
  /** No FK — occurrences survive source deletion; the snapshot below stays. */
  sourceId: z.string().uuid(),
  sourceType: z.enum(DISCOVERY_SOURCE_TYPES),
  sourceName: z.string(),
  /** discovery_jobs row of the fetch attempt; null for backfilled rows. */
  fetchRunId: z.string().uuid().nullable(),
  providerExternalId: z.string(),
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
  author: z.string().nullable(),
  providerPublishedAt: z.number().int().nullable(),
  observedAt: z.number().int(),
  relationship: storyOccurrenceRelationshipSchema,
});
export type StoryOccurrence = z.infer<typeof storyOccurrenceSchema>;

export const canonicalStorySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  status: z.enum(STORY_STATUSES),
  canonicalUrl: z.string(),
  title: z.string(),
  firstObservedAt: z.number().int(),
  lastObservedAt: z.number().int(),
  currentEnrichmentVersion: z.number().int(),
  /** Set when this story was archived by a manual merge. */
  mergedIntoStoryId: z.string().uuid().nullable(),
  /** Active memberships. */
  occurrenceCount: z.number().int(),
  /** Distinct sources among active memberships. */
  corroborationCount: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type CanonicalStory = z.infer<typeof canonicalStorySchema>;

export const storyEnrichmentPayloadSchema = z.object({
  occurrenceCount: z.number().int(),
  distinctSourceTypes: z.array(z.string()),
  earliestObservedAt: z.number().int().nullable(),
  latestObservedAt: z.number().int().nullable(),
  titleVariants: z.array(z.string()).max(5),
});
export type StoryEnrichmentPayload = z.infer<
  typeof storyEnrichmentPayloadSchema
>;

export const storyEnrichmentSchema = z.object({
  id: z.string().uuid(),
  storyId: z.string().uuid(),
  storyFingerprint: z.string(),
  enricherVersion: z.number().int(),
  corroborationCount: z.number().int(),
  payload: storyEnrichmentPayloadSchema,
  createdAt: z.number().int(),
});
export type StoryEnrichment = z.infer<typeof storyEnrichmentSchema>;

export const storyDetailSchema = z.object({
  story: canonicalStorySchema,
  /** Active memberships, oldest observation first. */
  occurrences: z.array(storyOccurrenceSchema),
  /** Closed memberships — merge/split history, never deleted. */
  history: z.array(storyOccurrenceSchema),
  /** Latest enrichment for the current membership fingerprint. */
  enrichment: storyEnrichmentSchema.nullable(),
});
export type StoryDetail = z.infer<typeof storyDetailSchema>;

export const listStoriesResponseSchema = z.object({
  stories: z.array(canonicalStorySchema),
  total: z.number().int(),
});
export type ListStoriesResponse = z.infer<typeof listStoriesResponseSchema>;

export const updateStoryInputSchema = z.object({
  status: z.enum(STORY_STATUSES),
});
export type UpdateStoryInput = z.infer<typeof updateStoryInputSchema>;

export const mergeStoryInputSchema = z.object({
  intoStoryId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});
export type MergeStoryInput = z.infer<typeof mergeStoryInputSchema>;

export const splitOccurrenceInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type SplitOccurrenceInput = z.infer<typeof splitOccurrenceInputSchema>;

export const storyBackfillResultSchema = z.object({
  scanned: z.number().int(),
  occurrencesCreated: z.number().int(),
  storiesCreated: z.number().int(),
  membershipsCreated: z.number().int(),
});
export type StoryBackfillResult = z.infer<typeof storyBackfillResultSchema>;

// ---------------------------------------------------------------------------
// Campaign routing profiles & opportunities (Sprint 61, design §8.5–§8.6, §9)
//
// Opportunities replace the flat 0–100 relevance score as the autonomy
// governor: separate score dimensions, campaign-scoped decisions, and policy
// bands. Shadow layer — the legacy discovered_item_matches flow is untouched.
// ---------------------------------------------------------------------------

/** Per-campaign routing autonomy band (design §9.4). */
export const ROUTING_POLICY_BANDS = ["off", "review", "auto_package"] as const;
export type RoutingPolicyBand = (typeof ROUTING_POLICY_BANDS)[number];

// `qualified` is an operator's qualification, `auto_qualified` is policy's;
// both feed package creation. `package_created` is reserved until Sprint 62
// ships packages (same convention as PACKAGE_SOURCE_ROLES).
export const OPPORTUNITY_STATUSES = [
  "candidate",
  "auto_qualified",
  "qualified",
  "needs_review",
  "watchlisted",
  "dismissed",
  "package_created",
  "expired",
  "superseded",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_DECISION_ACTIONS = [
  "qualify",
  "dismiss",
  "watch",
  "reopen",
] as const;
export type OpportunityDecisionAction =
  (typeof OPPORTUNITY_DECISION_ACTIONS)[number];

/** Story routing queue states — mirrors the discovered-items matching queue. */
export const STORY_ROUTING_STATES = [
  "pending",
  "in_progress",
  "routed",
  "failed",
] as const;
export type StoryRoutingState = (typeof STORY_ROUTING_STATES)[number];

/** Story×campaign matcher generation stamped on every opportunity. */
export const OPPORTUNITY_MATCHER_VERSION = 1;
/** Routing-profile compiler generation folded into profile fingerprints. */
export const ROUTING_PROFILE_COMPILER_VERSION = 1;

export const OPPORTUNITY_TRANSITIONS: Record<
  OpportunityStatus,
  readonly OpportunityStatus[]
> = {
  candidate: [
    "auto_qualified",
    "needs_review",
    "watchlisted",
    "dismissed",
    "expired",
    "superseded",
  ],
  auto_qualified: ["dismissed", "expired", "superseded", "package_created"],
  qualified: ["dismissed", "expired", "superseded", "package_created"],
  needs_review: ["qualified", "dismissed", "watchlisted", "expired", "superseded"],
  watchlisted: ["qualified", "dismissed", "needs_review", "expired", "superseded"],
  // Reopen/undo (§11.5) — dismissal stays reversible while nothing consumed it.
  dismissed: ["needs_review"],
  package_created: [],
  expired: [],
  superseded: [],
};

export function canTransitionOpportunity(
  from: OpportunityStatus,
  to: OpportunityStatus,
): boolean {
  return OPPORTUNITY_TRANSITIONS[from].includes(to);
}

export function transitionOpportunity(
  from: OpportunityStatus,
  to: OpportunityStatus,
): OpportunityStatus | undefined {
  return canTransitionOpportunity(from, to) ? to : undefined;
}

/** Operator decision actions → target statuses. */
export const OPPORTUNITY_DECISION_TARGETS: Record<
  OpportunityDecisionAction,
  OpportunityStatus
> = {
  qualify: "qualified",
  dismiss: "dismissed",
  watch: "watchlisted",
  reopen: "needs_review",
};

/** Compiled projection of a plan revision + active lanes — snapshot only. */
export const routingProfilePayloadSchema = z.object({
  campaignName: z.string(),
  objective: z.string(),
  kpi: z.string(),
  timeframe: z.string(),
  startAt: z.number().int().nullable(),
  endAt: z.number().int().nullable(),
  audiences: z.array(z.string()),
  pillars: z.array(z.string()),
  offers: z.array(z.string()),
  ctas: z.array(z.string()),
  guidance: z.string(),
  /** Personas represented by active lane revisions. */
  personaIds: z.array(z.string()),
  channels: z.array(z.string()),
  formats: z.array(z.string()),
  exclusions: z.array(z.string()),
});
export type RoutingProfilePayload = z.infer<typeof routingProfilePayloadSchema>;

export const campaignRoutingProfileSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  planRevisionId: z.string().uuid(),
  profileVersion: z.number().int(),
  profileFingerprint: z.string(),
  routingBand: z.enum(ROUTING_POLICY_BANDS),
  minFit: z.number().int().min(0).max(100),
  minConfidence: z.number().int().min(0).max(100),
  minTrust: z.number().int().min(0).max(100),
  compilerVersion: z.number().int(),
  payload: routingProfilePayloadSchema,
  createdAt: z.number().int(),
});
export type CampaignRoutingProfile = z.infer<
  typeof campaignRoutingProfileSchema
>;

export const routingPolicyPatchSchema = z.object({
  band: z.enum(ROUTING_POLICY_BANDS).optional(),
  minFit: z.number().int().min(0).max(100).optional(),
  minConfidence: z.number().int().min(0).max(100).optional(),
  minTrust: z.number().int().min(0).max(100).optional(),
  exclusions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});
export type RoutingPolicyPatch = z.infer<typeof routingPolicyPatchSchema>;

export const opportunityPolicyCheckSchema = z.object({
  rule: z.string(),
  threshold: z.number().nullable(),
  value: z.number().nullable(),
  passed: z.boolean(),
});
export const opportunityPolicySchema = z.object({
  band: z.enum(ROUTING_POLICY_BANDS),
  checks: z.array(opportunityPolicyCheckSchema),
});
export type OpportunityPolicy = z.infer<typeof opportunityPolicySchema>;

export const opportunitySupportedClaimSchema = z.object({
  claim: z.string(),
  /** Validated against the story's active occurrence memberships at write. */
  occurrenceIds: z.array(z.string()),
});
export type OpportunitySupportedClaim = z.infer<
  typeof opportunitySupportedClaimSchema
>;

export const campaignOpportunitySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** Exactly one of canonicalStoryId / manualSignalId is set (§8.6 XOR). */
  canonicalStoryId: z.string().uuid().nullable(),
  manualSignalId: z.string().uuid().nullable(),
  campaignId: z.string().uuid(),
  planRevisionId: z.string().uuid(),
  routingProfileId: z.string().uuid(),
  status: z.enum(OPPORTUNITY_STATUSES),
  angle: z.string(),
  angleHash: z.string(),
  workspaceRelevance: z.number().int().min(0).max(100),
  campaignFit: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  actionability: z.number().int().min(0).max(100),
  sourceTrust: z.number().int().min(0).max(100),
  /** Recommendation only; the lane revision stays the execution authority. */
  suggestedPersonaId: z.string().uuid().nullable(),
  supportedClaims: z.array(opportunitySupportedClaimSchema),
  reason: z.string(),
  matcherVersion: z.number().int(),
  policy: opportunityPolicySchema,
  expiresAt: z.number().int().nullable(),
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.number().int().nullable(),
  decisionReason: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** List projection context. */
  storyTitle: z.string().nullable(),
  storyUrl: z.string().nullable(),
  campaignName: z.string(),
});
export type CampaignOpportunity = z.infer<typeof campaignOpportunitySchema>;

export const opportunityEventSchema = z.object({
  id: z.string().uuid(),
  /** Null on the creation event. */
  fromStatus: z.enum(OPPORTUNITY_STATUSES).nullable(),
  toStatus: z.enum(OPPORTUNITY_STATUSES),
  /** Null when the system (policy, sweep, supersede) transitioned it. */
  actorUserId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
});
export type OpportunityEvent = z.infer<typeof opportunityEventSchema>;

export const opportunityDetailSchema = z.object({
  opportunity: campaignOpportunitySchema,
  /** The exact profile version the matcher decided against. */
  profile: campaignRoutingProfileSchema,
  events: z.array(opportunityEventSchema),
});
export type OpportunityDetail = z.infer<typeof opportunityDetailSchema>;

export const listOpportunitiesResponseSchema = z.object({
  opportunities: z.array(campaignOpportunitySchema),
  total: z.number().int(),
});
export type ListOpportunitiesResponse = z.infer<
  typeof listOpportunitiesResponseSchema
>;

export const opportunityDecisionInputSchema = z
  .object({
    action: z.enum(OPPORTUNITY_DECISION_ACTIONS),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.action === "dismiss" || value.action === "reopen") &&
      !value.reason
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `A reason is required to ${value.action} an opportunity.`,
      });
    }
  });
export type OpportunityDecisionInput = z.infer<
  typeof opportunityDecisionInputSchema
>;

export const opportunityMatchRunResultSchema = z.object({
  storiesConsidered: z.number().int(),
  storiesRouted: z.number().int(),
  opportunitiesCreated: z.number().int(),
  failures: z.number().int(),
});
export type OpportunityMatchRunResult = z.infer<
  typeof opportunityMatchRunResultSchema
>;

// ---------------------------------------------------------------------------
// Content packages, sufficiency & lane eligibility (Sprint 62, design
// §8.7–§8.9)
//
// The narrative unit between a qualified opportunity and Sprint 63's
// deliverables. Grounding invariant: every generated claim is supported by
// package sources, or the package remains research_needed. Shadow layer —
// no deliverables, no generation, no dispatch.
// ---------------------------------------------------------------------------

// Package lifecycle. `assessing`/`research_needed` deliberately mirror the
// reserved deliverable vocabulary by name — intentional layering, distinct
// machines (D-62.8).
export const PACKAGE_STATUSES = [
  "assessing",
  "research_needed",
  "ready",
  "blocked",
  "cancelled",
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/**
 * Sufficiency-assessment queue states — infrastructure, never a judgment.
 * `failed` means retries exhausted and an operator reassess is needed;
 * business outcomes live on `PackageStatus` (design §8.11 separation).
 */
export const PACKAGE_ASSESSMENT_STATES = [
  "pending",
  "in_progress",
  "complete",
  "failed",
] as const;
export type PackageAssessmentState =
  (typeof PACKAGE_ASSESSMENT_STATES)[number];

export const PACKAGE_DECISION_ACTIONS = ["reassess", "cancel"] as const;
export type PackageDecisionAction = (typeof PACKAGE_DECISION_ACTIONS)[number];

export const SUFFICIENCY_VERDICTS = ["sufficient", "research_needed"] as const;
export type SufficiencyVerdict = (typeof SUFFICIENCY_VERDICTS)[number];

/** Assessor generation stamped on every sufficiency assessment. */
export const SUFFICIENCY_ASSESSOR_VERSION = 1;
/** Evaluator generation stamped on every lane eligibility decision. */
export const LANE_ELIGIBILITY_EVALUATOR_VERSION = 1;
/** Window for the deterministic angle-overlap novelty score (D-62.3). */
export const PACKAGE_NOVELTY_WINDOW_DAYS = 30;

export const PACKAGE_TRANSITIONS: Record<
  PackageStatus,
  readonly PackageStatus[]
> = {
  assessing: ["ready", "research_needed", "blocked", "cancelled"],
  research_needed: ["assessing", "cancelled"],
  ready: ["assessing", "blocked", "cancelled"],
  blocked: ["assessing", "ready", "cancelled"],
  cancelled: [],
};

export function canTransitionPackage(
  from: PackageStatus,
  to: PackageStatus,
): boolean {
  return PACKAGE_TRANSITIONS[from].includes(to);
}

export function transitionPackage(
  from: PackageStatus,
  to: PackageStatus,
): PackageStatus | undefined {
  return canTransitionPackage(from, to) ? to : undefined;
}

/** Operator decision actions → target statuses. */
export const PACKAGE_DECISION_TARGETS: Record<
  PackageDecisionAction,
  PackageStatus
> = {
  reassess: "assessing",
  cancel: "cancelled",
};

/** Lane eligibility rule ids (design §8.8; evaluation is deterministic). */
export const ELIGIBILITY_RULES = [
  "lane_active",
  "format_registered",
  "format_supported",
  "media_available",
  "angle_novel_for_lane",
  /** Non-blocking: suggested persona is a recommendation only (§7). */
  "persona_alignment",
] as const;
export type EligibilityRule = (typeof ELIGIBILITY_RULES)[number];

/**
 * Channel/format registry (design §8.9). A format is *operational* only when
 * its generation and execution path exist — appearing in an enum is not
 * enough. v1 registers the formats with native generation/publish flows;
 * consumed by lane eligibility only (D-62.6) until the registry replaces
 * free-string lane formats at cutover.
 */
export interface ChannelFormatCapability {
  channel: Channel;
  format: string;
  label: string;
  taskType: TaskType;
  requiresMedia: boolean;
  state: "active" | "deprecated";
}

export const CHANNEL_FORMAT_REGISTRY: readonly ChannelFormatCapability[] = [
  { channel: "linkedin", format: "linkedin_post", label: "LinkedIn post", taskType: "linkedin_post", requiresMedia: false, state: "active" },
  { channel: "instagram", format: "instagram_post", label: "Instagram post", taskType: "instagram_post", requiresMedia: false, state: "active" },
  // Carousels are rendered from media, never text-generated (Sprint 41).
  { channel: "instagram", format: "instagram_carousel", label: "Instagram carousel", taskType: "instagram_carousel", requiresMedia: true, state: "active" },
  { channel: "x", format: "x_dm", label: "X direct message", taskType: "x_dm", requiresMedia: false, state: "active" },
  { channel: "email", format: "outbound_email", label: "Outbound email", taskType: "outbound_email", requiresMedia: false, state: "active" },
  { channel: "ads", format: "meta_ad_creative", label: "Meta ad creative", taskType: "meta_ad_creative", requiresMedia: false, state: "active" },
  { channel: "ads", format: "google_rsa", label: "Google RSA", taskType: "google_rsa", requiresMedia: false, state: "active" },
  { channel: "pr", format: "pr_pitch", label: "PR pitch", taskType: "pr_pitch", requiresMedia: false, state: "active" },
  { channel: "web", format: "landing_page_hero", label: "Landing page hero", taskType: "landing_page_hero", requiresMedia: false, state: "active" },
];

export function formatCapability(
  channel: string,
  format: string,
): ChannelFormatCapability | undefined {
  return CHANNEL_FORMAT_REGISTRY.find(
    (entry) => entry.channel === channel && entry.format === format,
  );
}

export function formatsForChannel(
  channel: string,
): ChannelFormatCapability[] {
  return CHANNEL_FORMAT_REGISTRY.filter((entry) => entry.channel === channel);
}

export function isRegisteredFormat(channel: string, format: string): boolean {
  return formatCapability(channel, format) !== undefined;
}

export const packageSourceSchema = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  role: z.enum(PACKAGE_SOURCE_ROLES),
  /** Nullable refs survive deletion of the referenced rows; the snapshot stays. */
  canonicalStoryId: z.string().uuid().nullable(),
  occurrenceId: z.string().uuid().nullable(),
  signalId: z.string().uuid().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  excerpt: z.string(),
  createdAt: z.number().int(),
});
export type PackageSource = z.infer<typeof packageSourceSchema>;

export const sufficiencyClaimSchema = z.object({
  claim: z.string(),
  /** Validated ⊆ the package's source rows at write (grounding invariant). */
  sourceIds: z.array(z.string()),
});
export type SufficiencyClaim = z.infer<typeof sufficiencyClaimSchema>;

export const sufficiencyIneligibleFormatSchema = z.object({
  format: z.string(),
  reason: z.string(),
});

export const sufficiencyAssessmentSchema = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  assessmentVersion: z.number().int(),
  verdict: z.enum(SUFFICIENCY_VERDICTS),
  confidence: z.number().int().min(0).max(100),
  supportedClaims: z.array(sufficiencyClaimSchema),
  missingFacts: z.array(z.string()),
  missingMedia: z.array(z.string()),
  eligibleFormats: z.array(z.string()),
  ineligibleFormats: z.array(sufficiencyIneligibleFormatSchema),
  researchActions: z.array(z.string()),
  assessorVersion: z.number().int(),
  createdAt: z.number().int(),
});
export type SufficiencyAssessment = z.infer<typeof sufficiencyAssessmentSchema>;

export const laneEligibilityCheckSchema = z.object({
  rule: z.enum(ELIGIBILITY_RULES),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type LaneEligibilityCheck = z.infer<typeof laneEligibilityCheckSchema>;

export const laneEligibilityDecisionSchema = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  assessmentId: z.string().uuid(),
  laneId: z.string().uuid(),
  laneRevisionId: z.string().uuid(),
  eligible: z.boolean(),
  checks: z.array(laneEligibilityCheckSchema),
  evaluatorVersion: z.number().int(),
  createdAt: z.number().int(),
  /** Lane projection context. */
  laneName: z.string(),
  channel: z.string(),
  format: z.string(),
});
export type LaneEligibilityDecision = z.infer<
  typeof laneEligibilityDecisionSchema
>;

export const contentPackageSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  planRevisionId: z.string().uuid(),
  /** Null after the source opportunity was deleted; the package survives. */
  opportunityId: z.string().uuid().nullable(),
  canonicalStoryId: z.string().uuid().nullable(),
  angle: z.string(),
  angleHash: z.string(),
  novelty: z.number().int().min(0).max(100),
  status: z.enum(PACKAGE_STATUSES),
  assessmentState: z.enum(PACKAGE_ASSESSMENT_STATES),
  assessmentAttempts: z.number().int(),
  assessedAt: z.number().int().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** List projection context. */
  campaignName: z.string(),
  storyTitle: z.string().nullable(),
  latestVerdict: z.enum(SUFFICIENCY_VERDICTS).nullable(),
});
export type ContentPackage = z.infer<typeof contentPackageSchema>;

export const packageEventSchema = z.object({
  id: z.string().uuid(),
  /** Null on the creation event. */
  fromStatus: z.enum(PACKAGE_STATUSES).nullable(),
  toStatus: z.enum(PACKAGE_STATUSES),
  /** Null when the system (assessment commit, auto-packaging) moved it. */
  actorUserId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
});
export type PackageEvent = z.infer<typeof packageEventSchema>;

export const packageDetailSchema = z.object({
  package: contentPackageSchema,
  sources: z.array(packageSourceSchema),
  assessments: z.array(sufficiencyAssessmentSchema),
  eligibility: z.array(laneEligibilityDecisionSchema),
  events: z.array(packageEventSchema),
});
export type PackageDetail = z.infer<typeof packageDetailSchema>;

export const listPackagesResponseSchema = z.object({
  packages: z.array(contentPackageSchema),
  total: z.number().int(),
});
export type ListPackagesResponse = z.infer<typeof listPackagesResponseSchema>;

export const packageDecisionInputSchema = z
  .object({
    action: z.enum(PACKAGE_DECISION_ACTIONS),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "cancel" && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required to cancel a package.",
      });
    }
  });
export type PackageDecisionInput = z.infer<typeof packageDecisionInputSchema>;

export const packageRunResultSchema = z.object({
  packagesCreated: z.number().int(),
  packagesAssessed: z.number().int(),
  failures: z.number().int(),
});
export type PackageRunResult = z.infer<typeof packageRunResultSchema>;

// ---------------------------------------------------------------------------
// Deliverables, variants & context snapshots (Sprint 63, design §8.10)
//
// A deliverable is one campaign commitment for one lane and time; a variant
// is one candidate execution; every variant retains a replayable context
// snapshot and never overwrites a prior candidate. The production lifecycle
// is DELIVERABLE_PRODUCTION_STATUSES (activated above). Shadow layer — no
// drafts, no external actions, no dispatch.
// ---------------------------------------------------------------------------

export const DELIVERABLE_KINDS = ["planned", "reactive"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/**
 * Variant-generation queue states — infrastructure, never content. `failed`
 * means retries exhausted and an operator regenerate is needed; production
 * outcomes live on `DeliverableProductionStatus` (design §8.11 separation).
 */
export const DELIVERABLE_GENERATION_STATES = [
  "pending",
  "in_progress",
  "complete",
  "failed",
] as const;
export type DeliverableGenerationState =
  (typeof DELIVERABLE_GENERATION_STATES)[number];

export const DELIVERABLE_DECISION_ACTIONS = [
  "regenerate",
  "select",
  "cancel",
] as const;
export type DeliverableDecisionAction =
  (typeof DELIVERABLE_DECISION_ACTIONS)[number];

/** One candidate execution's lifecycle — append-only rows, terminal ends. */
export const VARIANT_STATUSES = ["candidate", "selected", "superseded"] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const VARIANT_TRANSITIONS: Record<
  VariantStatus,
  readonly VariantStatus[]
> = {
  candidate: ["selected", "superseded"],
  selected: [],
  superseded: [],
};

export function canTransitionVariant(
  from: VariantStatus,
  to: VariantStatus,
): boolean {
  return VARIANT_TRANSITIONS[from].includes(to);
}

export function transitionVariant(
  from: VariantStatus,
  to: VariantStatus,
): VariantStatus | undefined {
  return canTransitionVariant(from, to) ? to : undefined;
}

/** How far ahead planned slots are materialized from a lane schedule (D-63.2). */
export const DELIVERABLE_SLOT_HORIZON_DAYS = 14;
/** Grace after a planned slot passes before the deliverable goes stale (D-63.10). */
export const DELIVERABLE_STALE_GRACE_MS = 24 * 60 * 60 * 1000;

export const deliverableSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  planRevisionId: z.string().uuid(),
  laneId: z.string().uuid(),
  laneRevisionId: z.string().uuid(),
  kind: z.enum(DELIVERABLE_KINDS),
  /** Immutable slot identity for planned deliverables; null for reactive. */
  originalScheduledFor: z.number().int().nullable(),
  /** Null before assignment (planned) or after the package was deleted. */
  packageId: z.string().uuid().nullable(),
  angle: z.string(),
  angleHash: z.string(),
  status: z.enum(DELIVERABLE_PRODUCTION_STATUSES),
  generationState: z.enum(DELIVERABLE_GENERATION_STATES),
  generationAttempts: z.number().int(),
  generatedAt: z.number().int().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** List projection context. */
  laneName: z.string(),
  channel: z.string(),
  format: z.string(),
  campaignName: z.string(),
  variantCount: z.number().int(),
  latestVariantStatus: z.enum(VARIANT_STATUSES).nullable(),
});
export type Deliverable = z.infer<typeof deliverableSchema>;

export const variantSchema = z.object({
  id: z.string().uuid(),
  deliverableId: z.string().uuid(),
  variantVersion: z.number().int(),
  contextSnapshotId: z.string().uuid(),
  status: z.enum(VARIANT_STATUSES),
  content: z.string(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int(),
  /** Null when the system tick generated it; set for operator-triggered runs. */
  createdByUserId: z.string().uuid().nullable(),
  selectedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Variant = z.infer<typeof variantSchema>;

/**
 * The replay/audit record behind one variant: the entire resolved context
 * (sections with include/exclude trace, final prompt, token accounting) plus
 * the identity and grounding inputs. Stored JSON is projected tolerantly —
 * the resolver's shape is owned by `@tuezday/brain`, not re-declared here.
 */
export const contextSnapshotSchema = z.object({
  id: z.string().uuid(),
  deliverableId: z.string().uuid(),
  packageId: z.string().uuid().nullable(),
  resolvedContext: z.unknown(),
  inputs: z.unknown(),
  model: z.string(),
  provider: z.string(),
  createdAt: z.number().int(),
});
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

export const deliverableEventSchema = z.object({
  id: z.string().uuid(),
  /** Null on the creation event. */
  fromStatus: z.enum(DELIVERABLE_PRODUCTION_STATUSES).nullable(),
  toStatus: z.enum(DELIVERABLE_PRODUCTION_STATUSES),
  /** Null when the system (tick, fan-out, sweep) moved it. */
  actorUserId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number().int(),
});
export type DeliverableEvent = z.infer<typeof deliverableEventSchema>;

export const deliverableDetailSchema = z.object({
  deliverable: deliverableSchema,
  variants: z.array(variantSchema),
  events: z.array(deliverableEventSchema),
});
export type DeliverableDetail = z.infer<typeof deliverableDetailSchema>;

export const listDeliverablesResponseSchema = z.object({
  deliverables: z.array(deliverableSchema),
  total: z.number().int(),
});
export type ListDeliverablesResponse = z.infer<
  typeof listDeliverablesResponseSchema
>;

export const deliverableDecisionInputSchema = z
  .object({
    action: z.enum(DELIVERABLE_DECISION_ACTIONS),
    variantId: z.string().uuid().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "cancel" && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required to cancel a deliverable.",
      });
    }
    if (value.action === "select" && !value.variantId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variantId"],
        message: "Selecting requires the variant to select.",
      });
    }
  });
export type DeliverableDecisionInput = z.infer<
  typeof deliverableDecisionInputSchema
>;

/** §9.5 fan-out outcome for one package, with per-lane skip reasons. */
export const FAN_OUT_SKIP_REASONS = [
  "already_delivered",
  "no_planned_slot",
  "reactive_cap",
] as const;
export type FanOutSkipReason = (typeof FAN_OUT_SKIP_REASONS)[number];

export const fanOutResultSchema = z.object({
  deliverablesCreated: z.number().int(),
  skipped: z.array(
    z.object({
      laneRevisionId: z.string().uuid(),
      reason: z.enum(FAN_OUT_SKIP_REASONS),
    }),
  ),
});
export type FanOutResult = z.infer<typeof fanOutResultSchema>;

export const deliverableRunResultSchema = z.object({
  slotsMaterialized: z.number().int(),
  packagesFannedOut: z.number().int(),
  deliverablesCreated: z.number().int(),
  variantsGenerated: z.number().int(),
  staled: z.number().int(),
  failures: z.number().int(),
});
export type DeliverableRunResult = z.infer<typeof deliverableRunResultSchema>;

// ---------------------------------------------------------------------------
// Evidence corpus (RAG behind the Brain Gateway boundary)
// ---------------------------------------------------------------------------

export const EVIDENCE_STATUSES = ["processing", "ready", "failed"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// Provenance (Sprint 30): where an evidence document came from. `manual` is
// pasted by hand; `signal`/`published` are accepted from the ingest queue.
export const EVIDENCE_KINDS = ["manual", "signal", "published"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_MAX_CHARS = 200_000;

export const evidenceDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  r2rDocumentId: z.string().nullable(),
  title: z.string().min(1).max(200),
  chars: z.number().int(),
  status: z.enum(EVIDENCE_STATUSES),
  error: z.string().nullable(),
  kind: z.enum(EVIDENCE_KINDS),
  sourceRef: z.string().nullable(),
  sourceCreatedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type EvidenceDocument = z.infer<typeof evidenceDocumentSchema>;

export const createEvidenceInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Evidence title is required")
    .max(200, "Title must be 200 characters or fewer"),
  content: z
    .string()
    .trim()
    .min(1, "Evidence content is required")
    .max(EVIDENCE_MAX_CHARS, `Evidence must be ${EVIDENCE_MAX_CHARS} characters or fewer`),
});
export type CreateEvidenceInput = z.infer<typeof createEvidenceInputSchema>;

// Founder-gated ingest queue (Sprint 30). The worker proposes signals +
// published posts as candidates; the founder accepts them into the corpus.
// Eligible candidate kinds are a subset of EVIDENCE_KINDS (manual is never a
// candidate — it is only ever a hand-pasted document).
export const EVIDENCE_CANDIDATE_KINDS = ["signal", "published"] as const;
export type EvidenceCandidateKind = (typeof EVIDENCE_CANDIDATE_KINDS)[number];

export const EVIDENCE_CANDIDATE_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type EvidenceCandidateStatus = (typeof EVIDENCE_CANDIDATE_STATUSES)[number];

export const evidenceCandidateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  kind: z.enum(EVIDENCE_CANDIDATE_KINDS),
  sourceRef: z.string(),
  title: z.string(),
  content: z.string(),
  sourceCreatedAt: z.number().int(),
  status: z.enum(EVIDENCE_CANDIDATE_STATUSES),
  evidenceDocumentId: z.string().nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
});
export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>;

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

export const APPROVAL_ACTIONS = ["submit", "edit", "resubmit", "approve", "reject"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * The approval state machine. Single source of truth for which action is
 * legal from which state — enforced by the API and mirrored by the UI.
 */
const TRANSITIONS: Record<ApprovalAction, Partial<Record<ApprovalState, ApprovalState>>> = {
  submit: { draft: "pending_review" },
  edit: { pending_review: "edited", edited: "edited" },
  resubmit: { edited: "pending_review" },
  approve: { pending_review: "approved", edited: "approved" },
  reject: { pending_review: "rejected", edited: "rejected" },
};

/** The state an action leads to from the given state, or undefined if illegal. */
export function transitionTo(from: ApprovalState, action: ApprovalAction): ApprovalState | undefined {
  return TRANSITIONS[action][from];
}

export function canTransition(from: ApprovalState, action: ApprovalAction): boolean {
  return transitionTo(from, action) !== undefined;
}

export const LAUNCH_MEDIA_TYPES = ["image", "video"] as const;
export type LaunchMediaType = (typeof LAUNCH_MEDIA_TYPES)[number];

export const launchMediaSchema = z.object({
  url: z.string().trim().url("A valid media URL is required"),
  type: z.enum(LAUNCH_MEDIA_TYPES),
});
export type LaunchMedia = z.infer<typeof launchMediaSchema>;

export const draftSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceGenerationId: z.string().uuid().nullable(),
  sourceSignalId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  leadId: z.string().uuid().nullable(),
  mediaContactId: z.string().uuid().nullable(),
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().nullable(),
  originalContent: z.string(),
  content: z.string(),
  state: z.enum(APPROVAL_STATES),
  // Rendered visuals attached to the draft (Sprint 41): what a reviewer SEES,
  // while content holds what they READ. Same shape launches use.
  media: z.array(launchMediaSchema).nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  // The pre-review copied from the source generation at submit, or refreshed
  // by the Re-run review action (Sprint 22). Null when never reviewed.
  review: generationReviewSchema.nullable().optional(),
});
export type Draft = z.infer<typeof draftSchema>;

export const approvalDecisionSchema = z.object({
  id: z.string().uuid(),
  draftId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  action: z.enum(APPROVAL_ACTIONS),
  fromState: z.enum(APPROVAL_STATES),
  toState: z.enum(APPROVAL_STATES),
  contentSnapshot: z.string().nullable(),
  // Sprint 52: sha256 of exactly what a human approved (draft id + content +
  // media). Null for every non-approve action and for system approvals — only
  // a human approval can authorize publication without a second click.
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  actor: z.string(),
  // Nullable: decisions logged before auth existed (Sprint 19), or by the worker.
  actorId: z.string().uuid().nullable(),
  // Sprint 66: the human's stated rationale — today only rejections capture
  // one (optional at the gate). Null everywhere it wasn't given.
  reason: z.string().nullable(),
  createdAt: z.number().int(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Sprint 66: an optional reject rationale — every provided reason compounds
 * (few-shot retrieval, critique grounding, preference memory). */
export const rejectDraftInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RejectDraftInput = z.infer<typeof rejectDraftInputSchema>;

export const editDraftInputSchema = z.object({
  content: z
    .string()
    .min(1, "Draft content cannot be empty")
    .max(BRAIN_DOC_MAX_CHARS, `Draft must be ${BRAIN_DOC_MAX_CHARS} characters or fewer`),
});
export type EditDraftInput = z.infer<typeof editDraftInputSchema>;

// ---------------------------------------------------------------------------
// Conversational draft revision — persisted turns attached to the approval
// object. Successful turns still move through the canonical edit transition.
// ---------------------------------------------------------------------------

export const DRAFT_REVISION_STATUSES = ["running", "completed", "failed"] as const;
export type DraftRevisionStatus = (typeof DRAFT_REVISION_STATUSES)[number];

export const DRAFT_REVISION_INSTRUCTION_MAX_CHARS = 2_000;

export const editorEvidenceCitationSchema = z.object({
  documentId: z.string().min(1),
  title: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().url().nullable(),
  score: z.number(),
  finalScore: z.number(),
  kept: z.boolean(),
  exclusionReason: z.string().nullable(),
});
export type EditorEvidenceCitation = z.infer<typeof editorEvidenceCitationSchema>;

export const editorContextSectionSchema = z.object({
  key: z.string().min(1),
  layer: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  included: z.boolean(),
  reason: z.string(),
  tokens: z.number().int().nonnegative(),
  evidence: z
    .object({
      query: z.string(),
      chunks: z.array(editorEvidenceCitationSchema),
    })
    .nullable(),
});
export type EditorContextSection = z.infer<typeof editorContextSectionSchema>;

export const draftRevisionTurnSchema = z
  .object({
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    draftId: z.string().uuid(),
    actorId: z.string().uuid().nullable(),
    instruction: z.string().min(1).max(DRAFT_REVISION_INSTRUCTION_MAX_CHARS),
    sourceContent: z.string(),
    resultContent: z.string().nullable(),
    contextSections: z.array(editorContextSectionSchema),
    status: z.enum(DRAFT_REVISION_STATUSES),
    error: z.string().nullable(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int(),
    completedAt: z.number().int().nullable(),
  })
  .superRefine((turn, ctx) => {
    if (
      turn.status === "completed" &&
      (!turn.resultContent || !turn.model || !turn.provider || turn.completedAt === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Completed revisions require result and provider metadata.",
      });
    }
    if (turn.status === "failed" && !turn.error) {
      ctx.addIssue({ code: "custom", message: "Failed revisions require an error." });
    }
  });
export type DraftRevisionTurn = z.infer<typeof draftRevisionTurnSchema>;

export const reviseDraftInputSchema = z.object({
  requestId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(DRAFT_REVISION_INSTRUCTION_MAX_CHARS),
  expectedDraftUpdatedAt: z.number().int().nonnegative(),
});
export type ReviseDraftInput = z.infer<typeof reviseDraftInputSchema>;

// ---------------------------------------------------------------------------
// Outbound leads
// ---------------------------------------------------------------------------

export const leadSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().email(),
  company: z.string().max(200),
  role: z.string().max(200),
  notes: z.string().max(2000),
  // X (Twitter) handle without the leading "@" — used for per-recipient X DMs
  // in a launch (Sprint 26). Empty when unknown.
  xHandle: z.string().max(50),
  createdAt: z.number().int(),
});
export type Lead = z.infer<typeof leadSchema>;

/** Normalize an X handle: strip a leading "@" and surrounding whitespace. */
const xHandleSchema = z
  .string()
  .trim()
  .max(51)
  .transform((v) => v.replace(/^@+/, "").trim())
  .pipe(z.string().max(50));

export const createLeadInputSchema = z.object({
  name: z.string().trim().min(1, "Lead name is required").max(200),
  email: z.string().trim().email("A valid email is required"),
  company: z.string().trim().max(200).default(""),
  role: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(2000).default(""),
  xHandle: xHandleSchema.default(""),
});
export type CreateLeadInput = z.infer<typeof createLeadInputSchema>;

/** Partial edit of an existing lead (e.g. setting an X handle). */
export const updateLeadInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email(),
    company: z.string().trim().max(200),
    role: z.string().trim().max(200),
    notes: z.string().trim().max(2000),
    xHandle: xHandleSchema,
  })
  .partial();
export type UpdateLeadInput = z.infer<typeof updateLeadInputSchema>;

export const importLeadsInputSchema = z.object({
  csv: z.string().trim().min(1, "CSV content is required").max(500_000),
});
export type ImportLeadsInput = z.infer<typeof importLeadsInputSchema>;

export const outboundDraftRequestSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1, "Select at least one lead").max(25, "At most 25 leads per batch"),
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
  useEvidence: z.boolean().optional(),
});
export type OutboundDraftRequest = z.infer<typeof outboundDraftRequestSchema>;

// ---------------------------------------------------------------------------
// Learning loop
// ---------------------------------------------------------------------------

export const engagementMetricSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  draftId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  description: z.string().max(300),
  impressions: z.number().int().min(0).nullable(),
  engagements: z.number().int().min(0).nullable(),
  clicks: z.number().int().min(0).nullable(),
  notes: z.string().max(1000),
  recordedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type EngagementMetric = z.infer<typeof engagementMetricSchema>;

export const createMetricInputSchema = z.object({
  draftId: z.string().uuid().optional(),
  channel: z.enum(CHANNELS),
  description: z.string().trim().max(300).default(""),
  impressions: z.number().int().min(0).optional(),
  engagements: z.number().int().min(0).optional(),
  clicks: z.number().int().min(0).optional(),
  notes: z.string().trim().max(1000).default(""),
  recordedAt: z.number().int().optional(),
});
export type CreateMetricInput = z.infer<typeof createMetricInputSchema>;

export const SYNTHESIS_STATUSES = ["proposed", "accepted", "dismissed"] as const;
export type SynthesisStatus = (typeof SYNTHESIS_STATUSES)[number];

export const nowSynthesisSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  proposal: z.string(),
  rationale: z.string(),
  basedOnJson: z.string(),
  status: z.enum(SYNTHESIS_STATUSES),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
});
export type NowSynthesis = z.infer<typeof nowSynthesisSchema>;

// ---------------------------------------------------------------------------
// Connector fabric
// ---------------------------------------------------------------------------

// access_token = the founder pastes an OAuth access token (e.g. a Meta
// system-user token); oauth = needs a per-provider OAuth app + popup flow.
export const CONNECTOR_AUTH_MODES = ["api_key", "basic", "oauth", "access_token", "none"] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

export const CONNECTOR_CATEGORIES = ["crm", "outbound", "ads", "social"] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export interface ConnectorProvider {
  key: string;
  label: string;
  /** Provider template name in Nango's providers.yaml. */
  nangoProvider: string;
  authMode: ConnectorAuthMode;
  /** Capabilities Tuezday can use this provider for (e.g. CRM sync). */
  categories?: readonly ConnectorCategory[];
  /** Base URL + path for the connection test request (proxied through Nango). */
  baseUrl?: string;
  testPath?: string;
  /** The founder must supply the account base URL at connect time. */
  requiresBaseUrl?: boolean;
  /**
   * OAuth scopes provisioned on the Nango integration (comma-separated),
   * only meaningful for authMode "oauth".
   */
  oauthScopes?: string;
  /**
   * Nango connection_config key that receives the founder's base URL
   * (protocol stripped) at import time — e.g. freshsales' bundleAlias.
   */
  baseUrlConfigKey?: string;
}

/**
 * The connector registry. OAuth providers are registered infrastructure —
 * they become connectable once per-provider OAuth apps exist (status
 * needs_oauth_app until then), same pattern as discovery's needs_api_key.
 */
export const CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = [
  {
    key: "smartlead",
    label: "Smartlead",
    nangoProvider: "smartlead",
    authMode: "api_key",
    categories: ["outbound"],
    baseUrl: "https://server.smartlead.ai/api/v1",
    testPath: "/campaigns",
  },
  {
    key: "instantly",
    label: "Instantly",
    nangoProvider: "instantly",
    authMode: "api_key",
    categories: ["outbound"],
    baseUrl: "https://api.instantly.ai/api/v2",
    testPath: "/campaigns",
  },
  {
    // The founder's account base URL ("bundle alias", e.g.
    // https://acme.myfreshworks.com/crm/sales) doubles as Nango's
    // connection_config.bundleAlias — its template resolves the API host
    // from it and applies "Authorization: Token token=<apiKey>".
    key: "freshsales",
    label: "Freshsales",
    nangoProvider: "freshsales",
    authMode: "api_key",
    categories: ["crm"],
    testPath: "/api/settings/contacts/fields",
    requiresBaseUrl: true,
    baseUrlConfigKey: "bundleAlias",
  },
  {
    key: "pipedrive",
    label: "Pipedrive",
    nangoProvider: "pipedrive",
    authMode: "oauth",
    categories: ["crm"],
  },
  {
    key: "hubspot",
    label: "HubSpot",
    nangoProvider: "hubspot",
    authMode: "oauth",
    categories: ["crm"],
  },
  {
    // Read-only ads reporting (Sprint 14). Token paste (system-user tokens
    // never expire); the OAuth popup flow arrives with integration expansion.
    key: "meta_ads",
    label: "Meta Ads",
    nangoProvider: "facebook",
    authMode: "access_token",
    categories: ["ads"],
    baseUrl: "https://graph.facebook.com",
    testPath: "/v23.0/me?fields=id,name",
  },
  {
    key: "slack",
    label: "Slack",
    nangoProvider: "slack",
    authMode: "oauth",
  },
  {
    // First social publishing platform (Sprint 17) — OAuth popup via a
    // Nango connect session; the founder's Reddit app creds come from
    // REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in the root .env.
    // `read` (Sprint 46) lets connected discovery sources use the OAuth
    // listing/search endpoints; existing connections need a reconnect to
    // pick it up.
    key: "reddit",
    label: "Reddit",
    nangoProvider: "reddit",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://oauth.reddit.com",
    testPath: "/api/v1/me",
    // history: read the connected user's own posts for the onboarding brain draft.
    oauthScopes: "identity,submit,read,history",
  },
  {
    // Sprint 25 social trio. OAuth popup like Reddit; creds come from
    // LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in the root .env. testPath
    // hits /v2/userinfo (OpenID) so a connection verifies the member identity.
    // w_member_social is provisioned now so Sprint 26 can broadcast posts
    // (LinkedIn's API forbids cold per-person DMs) without a reconnect.
    // r_member_social and r_organization_social are the read scopes connected
    // discovery needs. LinkedIn grants them through Community Management
    // approval, so discovery surfaces permission_required until approval.
    key: "linkedin",
    label: "LinkedIn",
    nangoProvider: "linkedin",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://api.linkedin.com",
    testPath: "/v2/userinfo",
    // The two read scopes stay OUT of the default because an unapproved scope
    // blocks the whole grant. The API adds both only when the operator sets
    // LINKEDIN_COMMUNITY_APPROVED to a strict true value; existing connections
    // must reconnect after approval.
    oauthScopes: "openid,profile,email,w_member_social",
  },
  {
    // Key stays "twitter" to match Nango's twitter-v2 template family; the UI
    // shows the "X (Twitter)" label. tweet.* + dm.* are provisioned now so
    // Sprint 26 can post AND send per-recipient DMs; offline.access keeps the
    // token refreshable. Scopes are stored comma-separated like every other
    // provider — Nango's twitter-v2 template emits the space separator X wants.
    // list.read (Sprint 46) enables list_timeline discovery sources; existing
    // connections need a reconnect to gain it.
    key: "twitter",
    label: "X (Twitter)",
    nangoProvider: "twitter-v2",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://api.twitter.com",
    testPath: "/2/users/me",
    oauthScopes: "tweet.read,tweet.write,users.read,dm.read,dm.write,offline.access,list.read",
  },
  {
    // Direct Instagram Login for professional Business/Creator accounts.
    // OAuth completion binds the returned account id and username so every
    // later read/write is scoped to that one account without Facebook Pages.
    key: "instagram",
    label: "Instagram",
    nangoProvider: "instagram",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://graph.instagram.com",
    testPath: "/me?fields=id,user_id,username,name,account_type",
    oauthScopes:
      "instagram_business_basic,instagram_business_content_publish",
  },
  {
    // Sprint 47: the outreach mailbox. OAuth popup via Nango like the social
    // trio; creds are GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in the root .env
    // (a GCP OAuth app with the Gmail scopes; "Testing" mode works for the
    // founder's own account, app verification needed for customers).
    // gmail.send = outreach sends from the founder's real mailbox;
    // gmail.readonly = polling inbound replies to Tuezday-sent threads only
    // (the privacy invariant — unrelated mail is never ingested).
    key: "gmail",
    label: "Gmail",
    nangoProvider: "google-mail",
    authMode: "oauth",
    categories: ["outbound"],
    baseUrl: "https://gmail.googleapis.com",
    testPath: "/gmail/v1/users/me/profile",
    oauthScopes:
      "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly",
  },
  {
    // Proxy any API without auth (your own services, public APIs). Keyed
    // custom APIs arrive when a generic API-key template is wired up.
    key: "custom",
    label: "Custom API (no auth)",
    nangoProvider: "unauthenticated",
    authMode: "none",
    requiresBaseUrl: true,
  },
] as const;

export const CONNECTION_STATUSES = ["connected", "error", "disconnected"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

// Spec §5.7: the Integrations hub groups providers by what they unlock, not by
// auth mechanics. Order is the hub's display order; uncategorized providers
// (Slack, custom proxy) trail as "other".
export const CONNECTOR_HUB_GROUP_META: readonly {
  category: ConnectorCategory | "other";
  title: string;
  unlocks: string;
}[] = [
  { category: "social", title: "Publishing", unlocks: "Approved posts go out on schedule, replies come back in" },
  { category: "ads", title: "Ads", unlocks: "Ad results feed the learning loop" },
  { category: "crm", title: "CRM", unlocks: "Your CRM stays the system of record" },
  { category: "outbound", title: "Outbound", unlocks: "Sequences send from your own sender" },
  { category: "other", title: "Workspace", unlocks: "Everything else the workspace talks to" },
] as const;

export interface ConnectorHubGroup<P extends ConnectorProvider = ConnectorProvider> {
  category: ConnectorCategory | "other";
  title: string;
  unlocks: string;
  providers: P[];
}

export function connectorHubGroups<P extends ConnectorProvider>(
  providers: readonly P[],
): ConnectorHubGroup<P>[] {
  return CONNECTOR_HUB_GROUP_META.map((meta) => ({
    ...meta,
    providers: providers.filter((p) =>
      meta.category === "other" ? !p.categories?.length : p.categories?.includes(meta.category),
    ),
  })).filter((group) => group.providers.length > 0);
}

/**
 * Nav progress for the Integrations entry ("1/4"): connected capabilities
 * (categories with at least one live connection) over the capabilities the
 * registry offers. Accounts don't stack — two social accounts still count one.
 */
export function integrationProgress(
  providers: readonly ConnectorProvider[],
  connections: readonly Pick<Connection, "providerKey" | "status">[],
): { connected: number; total: number } {
  const categoryOf = new Map<string, readonly ConnectorCategory[]>(
    providers.map((p) => [p.key, p.categories ?? []]),
  );
  const all = new Set<ConnectorCategory>();
  for (const p of providers) for (const c of p.categories ?? []) all.add(c);
  const live = new Set<ConnectorCategory>();
  for (const connection of connections) {
    if (connection.status !== "connected") continue;
    for (const c of categoryOf.get(connection.providerKey) ?? []) live.add(c);
  }
  return { connected: live.size, total: all.size };
}

// Sprint 44: what this account posts about + how — injected as the tier-1
// "account" context section when the publishing account is known at draft time.
export const CONNECTION_GUIDANCE_MAX_CHARS = 2_000;

export const connectionContentProfileSchema = z.object({
  topics: topicsSchema.default([]),
  guidance: z
    .string()
    .trim()
    .max(CONNECTION_GUIDANCE_MAX_CHARS, `Guidance must be ${CONNECTION_GUIDANCE_MAX_CHARS} characters or fewer`)
    .default(""),
});
export type ConnectionContentProfile = z.infer<typeof connectionContentProfileSchema>;

export const updateConnectionContentProfileInputSchema = connectionContentProfileSchema;
export type UpdateConnectionContentProfileInput = z.infer<
  typeof updateConnectionContentProfileInputSchema
>;

export const connectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  providerKey: z.string(),
  nangoConnectionId: z.string(),
  config: z.object({
    baseUrl: z.string().optional(),
    testPath: z.string().optional(),
    authArchitecture: z.literal("instagram_login").optional(),
  }),
  contentProfile: connectionContentProfileSchema,
  displayName: z.string(),
  externalAccountId: z.string().nullable(),
  externalAccountName: z.string().nullable(),
  externalAccountHandle: z.string().nullable(),
  externalAccountUrl: z.string().nullable(),
  status: z.enum(CONNECTION_STATUSES),
  lastCheckedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const SOCIAL_ACCOUNT_CHANNELS = ["linkedin", "instagram", "x", "reddit"] as const;
export type SocialAccountChannel = (typeof SOCIAL_ACCOUNT_CHANNELS)[number];

export const personaSocialAccountSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  personaId: z.string().uuid(),
  connectionId: z.string().uuid(),
  providerKey: z.string(),
  channel: z.enum(SOCIAL_ACCOUNT_CHANNELS),
  isPrimary: z.boolean(),
  defaultTarget: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PersonaSocialAccount = z.infer<typeof personaSocialAccountSchema>;

export const upsertPersonaSocialAccountInputSchema = z.object({
  connectionId: z.string().uuid(),
  channel: z.enum(SOCIAL_ACCOUNT_CHANNELS),
  isPrimary: z.boolean().default(false),
  defaultTarget: z.string().trim().min(1).max(200).default("feed"),
});
export type UpsertPersonaSocialAccountInput = z.infer<
  typeof upsertPersonaSocialAccountInputSchema
>;

export const updateConnectionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
});
export type UpdateConnectionInput = z.infer<typeof updateConnectionInputSchema>;

/** Credential requirements are enforced per provider auth mode at the route. */
export const connectInputSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).optional(),
  accessToken: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  testPath: z.string().trim().startsWith("/", "Test path must start with /").optional(),
});
export type ConnectInput = z.infer<typeof connectInputSchema>;

// ---------------------------------------------------------------------------
// CRM mirror (Sprint 13)
// ---------------------------------------------------------------------------

/**
 * A synced mirror of a CRM contact. The CRM stays the system of record;
 * Tuezday keeps only what lead generation needs, plus the link back.
 */
export const crmContactSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string(),
  name: z.string(),
  // CRMs allow contacts without an email address.
  email: z.string(),
  company: z.string(),
  role: z.string(),
  leadId: z.string().uuid().nullable(),
  // Set when the founder discards the contact locally (Sprint 23). A discarded
  // row is a tombstone: hidden from the working set and skipped by re-sync so
  // it is not resurrected; restore clears it. Discard never touches the CRM.
  discardedAt: z.number().int().nullable(),
  lastSyncedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type CrmContact = z.infer<typeof crmContactSchema>;

export const crmSyncInputSchema = z.object({
  connectionId: z.string().uuid(),
});
export type CrmSyncInput = z.infer<typeof crmSyncInputSchema>;

/**
 * Per-connection sync filter (Sprint 23). Empty object = today's behavior
 * (the CRM's default "all contacts" view, all dates). The CRM stays the system
 * of record — the filter only controls what is pulled into Tuezday's mirror.
 */
export const crmSyncFilterSchema = z.object({
  /** CRM view/list/segment id to pull from instead of the default view. */
  viewId: z.string().optional(),
  /** Human label for the chosen view, stored for display. */
  viewName: z.string().optional(),
  /** Epoch ms; only sync contacts whose CRM updated_at is at/after this. */
  updatedSince: z.number().int().optional(),
});
export type CrmSyncFilter = z.infer<typeof crmSyncFilterSchema>;

export const crmSyncFilterInputSchema = z.object({
  connectionId: z.string().uuid(),
  filter: crmSyncFilterSchema,
});
export type CrmSyncFilterInput = z.infer<typeof crmSyncFilterInputSchema>;

/** A CRM view/list/segment the founder can scope a sync to. */
export const crmViewSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type CrmView = z.infer<typeof crmViewSchema>;

export const pushLeadInputSchema = z.object({
  leadId: z.string().uuid(),
  connectionId: z.string().uuid(),
});
export type PushLeadInput = z.infer<typeof pushLeadInputSchema>;

export const logDraftInputSchema = z.object({
  draftId: z.string().uuid(),
});
export type LogDraftInput = z.infer<typeof logDraftInputSchema>;

// ---------------------------------------------------------------------------
// Ads reporting (Sprint 14)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD — the daily metric grain; stored as text, sorts correctly. */
export const metricDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const AD_METRIC_SOURCES = ["sync", "csv"] as const;
export type AdMetricSource = (typeof AD_METRIC_SOURCES)[number];

/**
 * An ad platform account Tuezday reports on. connectionId null = the
 * workspace's CSV-only account (reporting works with nothing connected).
 */
export const adAccountSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid().nullable(),
  externalId: z.string(),
  name: z.string(),
  currency: z.string(),
  lastSyncedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
});
export type AdAccount = z.infer<typeof adAccountSchema>;

/** A campaign on the ad platform; campaignId links it to a Tuezday campaign. */
export const adCampaignSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  adAccountId: z.string().uuid(),
  externalId: z.string(),
  name: z.string(),
  campaignId: z.string().uuid().nullable(),
  lastSyncedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type AdCampaign = z.infer<typeof adCampaignSchema>;

/** Daily grain. Money is integer cents in the account currency — no floats. */
export const adDailyMetricSchema = z.object({
  id: z.string().uuid(),
  adCampaignId: z.string().uuid(),
  date: metricDateSchema,
  spendCents: z.number().int().min(0),
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  conversions: z.number().int().min(0),
  source: z.enum(AD_METRIC_SOURCES),
});
export type AdDailyMetric = z.infer<typeof adDailyMetricSchema>;

export const importAdAccountsInputSchema = z.object({
  connectionId: z.string().uuid(),
});
export type ImportAdAccountsInput = z.infer<typeof importAdAccountsInputSchema>;

export const adsSyncInputSchema = z.object({
  since: metricDateSchema.optional(),
  until: metricDateSchema.optional(),
});
export type AdsSyncInput = z.infer<typeof adsSyncInputSchema>;

export const linkAdCampaignInputSchema = z.object({
  campaignId: z.string().uuid().nullable(),
});
export type LinkAdCampaignInput = z.infer<typeof linkAdCampaignInputSchema>;

/** CSV rows arrive parsed (the client splits the file); spend is in currency
 * units (12.34) and is converted to cents at the service boundary. */
export const adsCsvRowSchema = z.object({
  date: metricDateSchema,
  campaignName: z.string().trim().min(1, "Campaign name is required"),
  spend: z.number().min(0),
  impressions: z.number().int().min(0).default(0),
  clicks: z.number().int().min(0).default(0),
  conversions: z.number().int().min(0).default(0),
});
export type AdsCsvRow = z.infer<typeof adsCsvRowSchema>;

export const adsCsvImportInputSchema = z.object({
  accountName: z.string().trim().max(100).optional(),
  currency: z.string().trim().toUpperCase().length(3).default("USD"),
  rows: z.array(adsCsvRowSchema).min(1, "No rows to import").max(5000, "Import at most 5000 rows at a time"),
});
export type AdsCsvImportInput = z.infer<typeof adsCsvImportInputSchema>;

// ---------------------------------------------------------------------------
// Ad creative generation (Sprint 15)
// ---------------------------------------------------------------------------

/** Task types whose drafts carry platform ad creative with hard format limits. */
export const AD_CREATIVE_TASK_TYPES = ["meta_ad_creative", "google_rsa"] as const;
export type AdCreativeTaskType = (typeof AD_CREATIVE_TASK_TYPES)[number];

export function isAdCreativeTaskType(taskType: string): taskType is AdCreativeTaskType {
  return (AD_CREATIVE_TASK_TYPES as readonly string[]).includes(taskType);
}

export interface AdCreativeField {
  /** Stable field key — column names in exports derive from this. */
  key: string;
  /** Canonical label in the draft text format ("Headline 3: ..."). */
  label: string;
  maxChars: number;
  /** Required / allowed occurrences. maxCount > 1 ⇒ numbered labels. */
  minCount: number;
  maxCount: number;
}

export interface AdCreativeFormat {
  taskType: AdCreativeTaskType;
  label: string;
  fields: readonly AdCreativeField[];
  /** How many drafts one generation produces; null ⇒ one asset set = one draft. */
  variantCount: { min: number; max: number; default: number } | null;
}

/**
 * The single source of truth for platform format constraints. Meta limits are
 * the display-safe limits (before "…see more" truncation) — the API accepts
 * more, but "paste without rework" means display-safe. Google RSA limits are
 * the platform's hard caps.
 */
export const AD_CREATIVE_FORMATS: Record<AdCreativeTaskType, AdCreativeFormat> = {
  meta_ad_creative: {
    taskType: "meta_ad_creative",
    label: "Meta ad",
    fields: [
      { key: "primary_text", label: "Primary text", maxChars: 125, minCount: 1, maxCount: 1 },
      { key: "headline", label: "Headline", maxChars: 40, minCount: 1, maxCount: 1 },
      { key: "description", label: "Description", maxChars: 30, minCount: 1, maxCount: 1 },
    ],
    variantCount: { min: 1, max: 10, default: 3 },
  },
  google_rsa: {
    taskType: "google_rsa",
    label: "Google responsive search ad",
    fields: [
      { key: "headline", label: "Headline", maxChars: 30, minCount: 3, maxCount: 15 },
      { key: "description", label: "Description", maxChars: 90, minCount: 2, maxCount: 4 },
    ],
    variantCount: null,
  },
};

export interface AdCreativeFieldValue {
  key: string;
  /** 1-based; always 1 for single-occurrence fields. */
  index: number;
  value: string;
}

export interface AdCreativeViolation {
  /** Human field name ("Headline 3") or "content" for parse-level problems. */
  field: string;
  message: string;
}

function fieldDisplayName(field: AdCreativeField, index: number): string {
  return field.maxCount > 1 ? `${field.label} ${index}` : field.label;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the canonical labeled-text draft format. A line starting with a known
 * label opens a field; following lines belong to it (multi-line primary text
 * round-trips). Labels are case-insensitive. Returns null when the content has
 * no recognizable leading label — i.e. it is not ad creative at all.
 * (A value line that itself looks like a label splits the field — validation
 * surfaces that as a count violation for the founder to fix.)
 */
export function parseAdCreative(
  taskType: AdCreativeTaskType,
  content: string,
): { fields: AdCreativeFieldValue[] } | null {
  const format = AD_CREATIVE_FORMATS[taskType];
  const labelPattern = new RegExp(
    `^\\s*(${format.fields.map((f) => escapeRegExp(f.label)).join("|")})(?:\\s+(\\d{1,2}))?\\s*:\\s?(.*)$`,
    "i",
  );
  const labelToKey = new Map(format.fields.map((f) => [f.label.toLowerCase(), f.key]));

  const fields: AdCreativeFieldValue[] = [];
  const seenPerKey = new Map<string, number>();
  let current: AdCreativeFieldValue | undefined;

  for (const line of content.split(/\r?\n/)) {
    const match = labelPattern.exec(line);
    if (match) {
      const key = labelToKey.get(match[1]!.toLowerCase())!;
      const occurrence = (seenPerKey.get(key) ?? 0) + 1;
      seenPerKey.set(key, occurrence);
      current = {
        key,
        index: match[2] ? Number(match[2]) : occurrence,
        value: match[3] ?? "",
      };
      fields.push(current);
    } else if (current) {
      current.value += `\n${line}`;
    } else if (line.trim().length > 0) {
      return null; // content before any label — not the canonical format
    }
  }
  if (fields.length === 0) return null;
  for (const field of fields) field.value = field.value.trim();
  return { fields };
}

/** Validate draft content against the platform's hard format limits. */
export function validateAdCreative(
  taskType: AdCreativeTaskType,
  content: string,
): { ok: boolean; violations: AdCreativeViolation[] } {
  const format = AD_CREATIVE_FORMATS[taskType];
  const parsed = parseAdCreative(taskType, content);
  if (!parsed) {
    const labels = format.fields.map((f) => `"${f.label}:"`).join(", ");
    return {
      ok: false,
      violations: [
        { field: "content", message: `Not in the ${format.label} format — expected ${labels} lines.` },
      ],
    };
  }

  const violations: AdCreativeViolation[] = [];
  for (const field of format.fields) {
    const values = parsed.fields.filter((f) => f.key === field.key);
    if (values.length < field.minCount || values.length > field.maxCount) {
      const range =
        field.minCount === field.maxCount
          ? `exactly ${field.minCount}`
          : `${field.minCount}–${field.maxCount}`;
      violations.push({
        field: field.label,
        message: `${format.label} needs ${range} ${field.label.toLowerCase()}${
          field.maxCount > 1 ? "s" : ""
        } (got ${values.length}).`,
      });
    }
    const seenIndexes = new Set<number>();
    for (const value of values) {
      const name = fieldDisplayName(field, value.index);
      if (value.index < 1 || value.index > field.maxCount) {
        violations.push({ field: name, message: `${name} is out of range (max ${field.maxCount}).` });
      } else if (seenIndexes.has(value.index)) {
        violations.push({ field: name, message: `${name} appears more than once.` });
      }
      seenIndexes.add(value.index);
      if (value.value.length === 0) {
        violations.push({ field: name, message: `${name} is empty.` });
      } else if (value.value.length > field.maxChars) {
        violations.push({
          field: name,
          message: `${name} is ${value.value.length} characters (max ${field.maxChars}).`,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Serialize field values back to the canonical labeled-text format. */
export function formatAdCreative(
  taskType: AdCreativeTaskType,
  fields: AdCreativeFieldValue[],
): string {
  const format = AD_CREATIVE_FORMATS[taskType];
  const lines: string[] = [];
  for (const field of format.fields) {
    const values = fields
      .filter((f) => f.key === field.key)
      .sort((a, b) => a.index - b.index);
    for (const value of values) {
      lines.push(`${fieldDisplayName(field, value.index)}: ${value.value}`);
    }
  }
  return lines.join("\n");
}

export const generateAdCreativesInputSchema = z
  .object({
    taskType: z.enum(AD_CREATIVE_TASK_TYPES),
    campaignId: z.string().uuid(),
    personaId: z.string().uuid().optional(),
    variantCount: z.number().int().min(1).max(10).optional(),
    tokenBudget: z.number().int().min(500).max(200_000).optional(),
    useEvidence: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    const counts = AD_CREATIVE_FORMATS[input.taskType].variantCount;
    if (input.variantCount === undefined) return;
    if (!counts) {
      ctx.addIssue({
        code: "custom",
        message: `${AD_CREATIVE_FORMATS[input.taskType].label} generates one asset set — variantCount does not apply`,
      });
    } else if (input.variantCount < counts.min || input.variantCount > counts.max) {
      ctx.addIssue({
        code: "custom",
        message: `variantCount must be between ${counts.min} and ${counts.max}`,
      });
    }
  });
export type GenerateAdCreativesInput = z.infer<typeof generateAdCreativesInputSchema>;

// ---------------------------------------------------------------------------
// PR & media outreach (Sprint 16)
// ---------------------------------------------------------------------------

export const MEDIA_CONTACT_TYPES = ["journalist", "publication", "podcast"] as const;
export type MediaContactType = (typeof MEDIA_CONTACT_TYPES)[number];

export const mediaContactSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().email(),
  type: z.enum(MEDIA_CONTACT_TYPES),
  outlet: z.string().max(200),
  beat: z.string().max(200),
  coverageNotes: z.string().max(2000),
  createdAt: z.number().int(),
});
export type MediaContact = z.infer<typeof mediaContactSchema>;

export const createMediaContactInputSchema = z.object({
  name: z.string().trim().min(1, "Contact name is required").max(200),
  email: z.string().trim().email("A valid email is required"),
  type: z.enum(MEDIA_CONTACT_TYPES).default("journalist"),
  outlet: z.string().trim().max(200).default(""),
  beat: z.string().trim().max(200).default(""),
  coverageNotes: z.string().trim().max(2000).default(""),
});
export type CreateMediaContactInput = z.infer<typeof createMediaContactInputSchema>;

export const importMediaContactsInputSchema = z.object({
  csv: z.string().trim().min(1, "CSV content is required").max(500_000),
});
export type ImportMediaContactsInput = z.infer<typeof importMediaContactsInputSchema>;

/** What kind of story the pitch tells — selects the composed task instruction. */
export const PR_PITCH_TYPES = ["announcement", "thought_leadership", "reactive"] as const;
export type PrPitchType = (typeof PR_PITCH_TYPES)[number];

export const prPitchRequestSchema = z
  .object({
    contactIds: z
      .array(z.string().uuid())
      .min(1, "Select at least one contact")
      .max(25, "At most 25 contacts per batch"),
    pitchType: z.enum(PR_PITCH_TYPES),
    signalId: z.string().uuid().optional(),
    personaId: z.string().uuid().optional(),
    campaignId: z.string().uuid().optional(),
    tokenBudget: z.number().int().min(500).max(200_000).optional(),
    useEvidence: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    // A stale signal silently steering an announcement pitch is a footgun —
    // signals pair with the reactive type only, and reactive demands one.
    if (input.pitchType === "reactive" && !input.signalId) {
      ctx.addIssue({ code: "custom", message: "A reactive pitch needs a signal" });
    }
    if (input.pitchType !== "reactive" && input.signalId) {
      ctx.addIssue({ code: "custom", message: "Only reactive pitches take a signal" });
    }
  });
export type PrPitchRequest = z.infer<typeof prPitchRequestSchema>;

export const pressKitRequestSchema = z.object({
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
  useEvidence: z.boolean().optional(),
});
export type PressKitRequest = z.infer<typeof pressKitRequestSchema>;

// ---------------------------------------------------------------------------
// Social publishing (Sprint 17)
// ---------------------------------------------------------------------------

/** Hard platform limits checked before any post leaves Tuezday. */
export interface SocialPostConstraints {
  /** User-facing name for the platform's destination (e.g. "Subreddit"). */
  targetLabel: string;
  titleMaxChars: number;
  bodyMaxChars: number;
  /** The platform cannot publish without at least one media item (Instagram). */
  requiresMedia?: boolean;
}

export const SOCIAL_POST_CONSTRAINTS = {
  // https://www.reddit.com — self (text) posts.
  reddit: { targetLabel: "Subreddit", titleMaxChars: 300, bodyMaxChars: 40_000 },
  // Member share via /v2/ugcPosts (w_member_social) — no title; ~3000 char body.
  linkedin: { targetLabel: "LinkedIn feed", titleMaxChars: 200, bodyMaxChars: 3000 },
  // IG Graph API publish — caption max 2200 chars; needs ≥1 image/video.
  instagram: { targetLabel: "Instagram", titleMaxChars: 200, bodyMaxChars: 2200, requiresMedia: true },
} satisfies Record<string, SocialPostConstraints>;

export interface SocialPostViolation {
  field: "target" | "title" | "body";
  message: string;
}

export interface SocialPostValidation {
  ok: boolean;
  violations: SocialPostViolation[];
}

export function validateSocialPost(
  providerKey: string,
  input: { target: string; title: string; body: string },
): SocialPostValidation {
  const constraints = (SOCIAL_POST_CONSTRAINTS as Record<string, SocialPostConstraints>)[
    providerKey
  ];
  if (!constraints) {
    return {
      ok: false,
      violations: [{ field: "target", message: `"${providerKey}" is not a publishable platform.` }],
    };
  }
  const violations: SocialPostViolation[] = [];
  if (!input.target.trim()) {
    violations.push({ field: "target", message: `${constraints.targetLabel} is required.` });
  }
  if (!input.title.trim()) {
    violations.push({ field: "title", message: "Title is required." });
  } else if (input.title.length > constraints.titleMaxChars) {
    violations.push({
      field: "title",
      message: `Title is ${input.title.length} characters — the platform limit is ${constraints.titleMaxChars}.`,
    });
  }
  if (input.body.length > constraints.bodyMaxChars) {
    violations.push({
      field: "body",
      message: `Body is ${input.body.length} characters — the platform limit is ${constraints.bodyMaxChars}.`,
    });
  }
  return { ok: violations.length === 0, violations };
}

export const PUBLICATION_STATUSES = ["scheduled", "published", "failed"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const publicationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  draftId: z.string().uuid(),
  connectionId: z.string().uuid(),
  providerKey: z.string(),
  target: z.string(),
  title: z.string(),
  // The posting cadence that auto-slotted this receipt (Sprint 27); null for a
  // manual one-off publish.
  cadenceId: z.string().uuid().nullable(),
  status: z.enum(PUBLICATION_STATUSES),
  scheduledFor: z.number().int(),
  publishedAt: z.number().int().nullable(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Governing action for new receipts; absent/null on legacy rows. */
  externalActionId: z.string().uuid().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Publication = z.infer<typeof publicationSchema>;

/** scheduledFor must be in the future — enforced at the route against now. */
export const publishDraftInputSchema = z.object({
  connectionId: z.string().uuid(),
  target: z.string().trim().min(1, "Target is required"),
  title: z.string().trim().min(1, "Title is required"),
  scheduledFor: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
});
export type PublishDraftInput = z.infer<typeof publishDraftInputSchema>;

// ---------------------------------------------------------------------------
// Posting cadence + calendar (Sprint 27)
// ---------------------------------------------------------------------------

export const CADENCE_STATUSES = ["active", "paused"] as const;
export type CadenceStatus = (typeof CADENCE_STATUSES)[number];

/** Day-of-week integers, Sunday = 0 — matches JS Date.getUTCDay(). */
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a HH:MM 24-hour time");

/** True when the runtime recognises the IANA time-zone id (Node + browser). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z.string().min(1, "A time zone is required").refine(isValidTimeZone, {
  message: "Unknown time zone",
});

const daysOfWeekSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1, "Pick at least one day")
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

export const postingCadenceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  campaignId: z.string().uuid().nullable(),
  personaId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  connectionId: z.string().uuid(),
  target: z.string(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)),
  timeOfDay: timeOfDaySchema,
  timezone: z.string(),
  status: z.enum(CADENCE_STATUSES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PostingCadence = z.infer<typeof postingCadenceSchema>;

export const createPostingCadenceInputSchema = z.object({
  name: z.string().trim().min(1, "A cadence name is required").max(120),
  campaignId: z.string().uuid(),
  personaId: z.string().uuid().optional(),
  channel: z.enum(CHANNELS),
  connectionId: z.string().uuid().optional(),
  target: z.string().trim().min(1, "A target is required").max(200),
  daysOfWeek: daysOfWeekSchema,
  timeOfDay: timeOfDaySchema,
  timezone: timeZoneSchema,
  status: z.enum(CADENCE_STATUSES).default("active"),
});
export type CreatePostingCadenceInput = z.infer<typeof createPostingCadenceInputSchema>;

export const updatePostingCadenceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    campaignId: z.string().uuid(),
    personaId: z.string().uuid().nullable(),
    channel: z.enum(CHANNELS),
    connectionId: z.string().uuid(),
    target: z.string().trim().min(1).max(200),
    daysOfWeek: daysOfWeekSchema,
    timeOfDay: timeOfDaySchema,
    timezone: timeZoneSchema,
    status: z.enum(CADENCE_STATUSES),
  })
  .partial();
export type UpdatePostingCadenceInput = z.infer<typeof updatePostingCadenceInputSchema>;

/** A calendar cell: either a published/scheduled receipt or an empty slot. */
export const CALENDAR_ENTRY_STATUSES = [
  "open",
  "authorization_required",
  "authorized",
  "scheduled",
  "published",
  "failed",
  "blocked",
  "stale",
] as const;
export type CalendarEntryStatus = (typeof CALENDAR_ENTRY_STATUSES)[number];

export const calendarEntrySchema = z.object({
  kind: z.enum(["slot", "publication", "external_action"]),
  at: z.number().int(),
  cadenceId: z.string().uuid().nullable(),
  cadenceName: z.string().nullable(),
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  providerKey: z.string().nullable(),
  status: z.enum(CALENDAR_ENTRY_STATUSES),
  title: z.string(),
  draftId: z.string().uuid().nullable(),
  publicationId: z.string().uuid().nullable(),
  externalActionId: z.string().uuid().nullable().optional(),
  url: z.string().nullable(),
  /** Last failure detail for a failed publication; null otherwise. */
  error: z.string().nullable(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

// ---------------------------------------------------------------------------
// Transactional mail (Sprint 27)
// ---------------------------------------------------------------------------

export const mailResultSchema = z.object({
  delivered: z.boolean(),
  id: z.string().nullable(),
  detail: z.string(),
});
export type MailResultDto = z.infer<typeof mailResultSchema>;

export const sendTestMailInputSchema = z.object({
  to: z.string().trim().email("A valid email address is required"),
});
export type SendTestMailInput = z.infer<typeof sendTestMailInputSchema>;

// ---------------------------------------------------------------------------
// Native ads execution (Sprint 20)
// ---------------------------------------------------------------------------

/**
 * Launch setup statuses. `launched` is terminal — runtime platform state
 * (active/paused/disapproved) lives in platformStatus, and spend governance
 * lives entirely in the external-action lifecycle (Sprint 54).
 */
export const AD_LAUNCH_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "launched",
] as const;
export type AdLaunchStatus = (typeof AD_LAUNCH_STATUSES)[number];

export const AD_LAUNCH_ACTIONS = ["submit", "approve", "reject", "revise"] as const;
export type AdLaunchAction = (typeof AD_LAUNCH_ACTIONS)[number];

/**
 * The one bespoke launch rule that survives Sprint 54 Task 4 (spec §2.2).
 *
 * A launch is editable only while it is a draft; `PATCH .../launches/:id` is
 * refused otherwise, and `revise` is the only door back. This is an
 * **editability** rule, not a dispatch state, which is exactly why it could not
 * fold into the external-action lifecycle: `stale` there is a property of the
 * *action*, and nothing in that lifecycle says "the subject is editable again".
 *
 * It replaces `adLaunchTransitionTo` / `AD_LAUNCH_TRANSITIONS` — a second,
 * bespoke state machine sitting beside the canonical `transitionTo`. Deriving
 * editability from the status the launch already carries keeps one source of
 * truth: a separate `editable` column could disagree with `status`, and would
 * not have let `status` go anyway (`approved` gates spend in
 * `preparePaidLaunchAction`, `launched` feeds `isSpending`).
 */
export function isAdLaunchEditable(status: AdLaunchStatus): boolean {
  return status === "draft";
}

/**
 * What the setup-approval trail can contain when *read*. Writers emit only
 * `AD_LAUNCH_ACTIONS` — `"launch"` is **retired** (Sprint 54 Task 2).
 *
 * It is kept in the read vocabulary because rows carrying it already exist:
 * until Sprint 54, `performLaunch` appended a synthetic `approved → launched`
 * row that looked like a spend authorization but was fabricated (the
 * transition was never a gate move, and the actor was reconstructed with
 * `human: false`). Those rows are history and must stay describable — dropping
 * the verb here would leave the contract unable to parse data that exists.
 * Nothing writes it any more; spend authorization lives solely in
 * `external_action_decisions`.
 */
export const AD_LAUNCH_DECISION_ACTIONS = [...AD_LAUNCH_ACTIONS, "launch"] as const;
export type AdLaunchDecisionAction = (typeof AD_LAUNCH_DECISION_ACTIONS)[number];

/**
 * v1 objectives launch with just a Page + link. Leads/Sales need form/pixel
 * setup on the Meta side — they arrive under integration expansion.
 */
export const AD_LAUNCH_OBJECTIVES = ["OUTCOME_TRAFFIC", "OUTCOME_AWARENESS"] as const;
export type AdLaunchObjective = (typeof AD_LAUNCH_OBJECTIVES)[number];

export const AD_LAUNCH_OBJECTIVE_LABELS: Record<AdLaunchObjective, string> = {
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_AWARENESS: "Awareness",
};

export const adLaunchSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  adAccountId: z.string().uuid(),
  // Copied from the creative draft — the Tuezday campaign reporting links to.
  campaignId: z.string().uuid().nullable(),
  creativeDraftId: z.string().uuid(),
  name: z.string(),
  objective: z.enum(AD_LAUNCH_OBJECTIVES),
  pageId: z.string(),
  linkUrl: z.string(),
  dailyBudgetCents: z.number().int().min(100),
  startAt: z.number().int().nullable(),
  endAt: z.number().int().nullable(),
  countries: z.array(z.string()),
  ageMin: z.number().int(),
  ageMax: z.number().int(),
  status: z.enum(AD_LAUNCH_STATUSES),
  externalCampaignId: z.string().nullable(),
  externalAdSetId: z.string().nullable(),
  externalCreativeId: z.string().nullable(),
  externalAdId: z.string().nullable(),
  // Meta adimages hash (Sprint 41 Part 5) — set after uploadAdImage succeeds,
  // consumed by createAdCreative; null for text-only creatives.
  metaImageHash: z.string().nullable(),
  // The Sprint 14 ad_campaigns mirror row created on launch.
  adCampaignId: z.string().uuid().nullable(),
  // Raw platform effective_status, stamped by the sync job and pause/resume.
  platformStatus: z.string().nullable(),
  launchedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** Governing paid-launch action; absent/null on legacy rows. */
  externalActionId: z.string().uuid().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type AdLaunch = z.infer<typeof adLaunchSchema>;

export const adLaunchDecisionSchema = z.object({
  id: z.string().uuid(),
  launchId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  action: z.enum(AD_LAUNCH_DECISION_ACTIONS),
  fromState: z.enum(AD_LAUNCH_STATUSES),
  toState: z.enum(AD_LAUNCH_STATUSES),
  actor: z.string(),
  actorId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type AdLaunchDecision = z.infer<typeof adLaunchDecisionSchema>;

const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use 2-letter country codes (e.g. US, DE)");

const normalizedCountryCodesSchema = z
  .array(countryCodeSchema)
  .min(1, "Target at least one country")
  .max(25)
  .transform((values) => Array.from(new Set(values)).sort());

const dailyBudgetCentsSchema = z
  .number()
  .int()
  .min(100, "Daily budget must be at least 100 cents")
  .max(100_000_000);

const targetingFieldsSchema = z.object({
  countries: normalizedCountryCodesSchema,
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
});

function refineTargetingAgeRange(
  value: { ageMin: number; ageMax: number },
  ctx: z.RefinementCtx,
): void {
  if (value.ageMin > value.ageMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ageMax"],
      message: "Maximum age must be at least the minimum age",
    });
  }
}

const targetingSnapshotSchema = targetingFieldsSchema.superRefine(refineTargetingAgeRange);

export const metaAdSetStateSchema = targetingFieldsSchema
  .extend({
    externalAdSetId: z.string().trim().min(1),
    dailyBudgetCents: dailyBudgetCentsSchema,
    updatedAt: z.number().int().nonnegative().nullable(),
  })
  .superRefine(refineTargetingAgeRange);
export type MetaAdSetState = z.infer<typeof metaAdSetStateSchema>;

const adMutationIdentitySchema = z.object({
  launchId: z.string().uuid(),
  adAccountId: z.string().uuid(),
  externalAccountId: z.string().trim().min(1),
  externalAdSetId: z.string().trim().min(1),
  providerUpdatedAt: z.number().int().nonnegative().nullable(),
});

export const budgetChangeIntentSchema = adMutationIdentitySchema
  .extend({
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    beforeDailyBudgetCents: dailyBudgetCentsSchema,
    afterDailyBudgetCents: dailyBudgetCentsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.beforeDailyBudgetCents === value.afterDailyBudgetCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["afterDailyBudgetCents"],
        message: "The requested budget must differ from the provider budget",
      });
    }
  });
export type BudgetChangeIntent = z.infer<typeof budgetChangeIntentSchema>;

export const targetingChangeIntentSchema = adMutationIdentitySchema
  .extend({
    before: targetingSnapshotSchema,
    after: targetingSnapshotSchema,
  })
  .superRefine((value, ctx) => {
    const unchanged =
      value.before.ageMin === value.after.ageMin &&
      value.before.ageMax === value.after.ageMax &&
      value.before.countries.length === value.after.countries.length &&
      value.before.countries.every((country, index) => country === value.after.countries[index]);
    if (unchanged) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after"],
        message: "The requested targeting must differ from the provider targeting",
      });
    }
  });
export type TargetingChangeIntent = z.infer<typeof targetingChangeIntentSchema>;

export const proposeBudgetChangeInputSchema = z.object({
  dailyBudgetCents: dailyBudgetCentsSchema,
  idempotencyKey: z.string().uuid(),
});
export type ProposeBudgetChangeInput = z.infer<typeof proposeBudgetChangeInputSchema>;

export const proposeTargetingChangeInputSchema = targetingFieldsSchema
  .extend({ idempotencyKey: z.string().uuid() })
  .strict("Only countries and age range can be changed")
  .superRefine(refineTargetingAgeRange);
export type ProposeTargetingChangeInput = z.infer<typeof proposeTargetingChangeInputSchema>;

const adLaunchFieldsSchema = z.object({
  adAccountId: z.string().uuid(),
  creativeDraftId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(100),
  objective: z.enum(AD_LAUNCH_OBJECTIVES),
  pageId: z.string().trim().regex(/^\d+$/, "Page ID is the numeric Facebook Page id"),
  linkUrl: z
    .string()
    .trim()
    .url("A valid destination URL is required")
    .regex(/^https:\/\//, "Use an https destination URL"),
  // Meta's minimum daily budget is on the order of $1/day.
  dailyBudgetCents: dailyBudgetCentsSchema,
  startAt: z.number().int().positive().optional(),
  endAt: z.number().int().positive().optional(),
  countries: z.array(countryCodeSchema).min(1, "Target at least one country").max(25),
  ageMin: z.number().int().min(18).max(65).default(18),
  ageMax: z.number().int().min(18).max(65).default(65),
});

function refineAdLaunch(
  value: { ageMin?: number; ageMax?: number; startAt?: number; endAt?: number },
  ctx: z.RefinementCtx,
): void {
  if (value.ageMin !== undefined && value.ageMax !== undefined && value.ageMin > value.ageMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ageMax"],
      message: "Maximum age must be at least the minimum age",
    });
  }
  if (value.endAt !== undefined && value.endAt <= (value.startAt ?? Date.now())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endAt"],
      message: "End must be after the start",
    });
  }
}

export const createAdLaunchInputSchema = adLaunchFieldsSchema.superRefine(refineAdLaunch);
export type CreateAdLaunchInput = z.infer<typeof createAdLaunchInputSchema>;

/** Draft-only edits; absent fields stay unchanged. */
export const updateAdLaunchInputSchema = adLaunchFieldsSchema.partial().superRefine(refineAdLaunch);
export type UpdateAdLaunchInput = z.infer<typeof updateAdLaunchInputSchema>;

/**
 * Workspace spend guardrails. The daily cap bounds the summed daily budgets
 * of currently-spending Tuezday launches (committed budgets, not observed
 * spend — deterministic and immediate). Compared in integer cents across
 * accounts regardless of currency.
 */
export const adSettingsSchema = z.object({
  workspaceId: z.string().uuid(),
  dailyCapCents: z.number().int().min(0),
  killSwitch: z.boolean(),
  updatedAt: z.number().int(),
});
export type AdSettings = z.infer<typeof adSettingsSchema>;

export const updateAdSettingsInputSchema = z.object({
  dailyCapCents: z.number().int().min(0).max(100_000_000).optional(),
  killSwitch: z.boolean().optional(),
});
export type UpdateAdSettingsInput = z.infer<typeof updateAdSettingsInputSchema>;

// ---------------------------------------------------------------------------
// Social automation guardrails + run results (Sprint 28)
// ---------------------------------------------------------------------------

/**
 * Sprint 65 (D-65.1): which path automation uses to turn a matched signal into
 * a draft. `legacy` — the single-prompt `generateSignalDraft` path. `shadow` —
 * legacy still produces the live draft, and the pipeline engine replays the
 * same (signal, campaign, channel) as a paired `shadow`-mode run for the A/B.
 * `pipeline` — the engine produces the live draft; legacy generation is skipped
 * (with a legacy fallback when no active pipeline definition resolves, D-65.6).
 */
export const AUTOMATION_GENERATION_PATHS = ["legacy", "shadow", "pipeline"] as const;
export type AutomationGenerationPath = (typeof AUTOMATION_GENERATION_PATHS)[number];

/**
 * Per-workspace guardrails for `scheduled_auto` campaigns — the safety net that
 * replaces the human gate. The kill switch is the hard stop; the caps bound how
 * many auto-posts land per UTC day. Mirrors `ad_settings`.
 */
export const socialAutomationSettingsSchema = z.object({
  workspaceId: z.string().uuid(),
  killSwitch: z.boolean(),
  perConnectionDailyCap: z.number().int().positive(),
  perCampaignDailyCap: z.number().int().positive(),
  // Sprint 29: master switch for auto-posting engagement replies. Off by default —
  // even scheduled_auto campaigns gate their replies until the founder opts in.
  autoReplyEnabled: z.boolean(),
  // Sprint 45: minimum persona×campaign match score (0–100) a signal needs
  // before automation generates for that campaign. Default DEFAULT_MATCH_THRESHOLD.
  matchThreshold: z.number().int().min(0).max(100),
  // Sprint 65: legacy | shadow | pipeline. Default legacy — flipping is a
  // founder action, normally recorded through a rollout decision.
  generationPath: z.enum(AUTOMATION_GENERATION_PATHS),
  updatedAt: z.number().int(),
});
export type SocialAutomationSettings = z.infer<typeof socialAutomationSettingsSchema>;

export const updateSocialAutomationSettingsInputSchema = z.object({
  killSwitch: z.boolean().optional(),
  perConnectionDailyCap: z.number().int().positive().max(1000).optional(),
  perCampaignDailyCap: z.number().int().positive().max(1000).optional(),
  autoReplyEnabled: z.boolean().optional(),
  matchThreshold: z.number().int().min(0).max(100).optional(),
  generationPath: z.enum(AUTOMATION_GENERATION_PATHS).optional(),
});
export type UpdateSocialAutomationSettingsInput = z.infer<
  typeof updateSocialAutomationSettingsInputSchema
>;

/** What the orchestrator did for one campaign in a run. */
export const automationCampaignResultSchema = z.object({
  campaignId: z.string().uuid(),
  campaignName: z.string(),
  mode: z.enum(AUTOMATION_MODES),
  generated: z.number().int(),
  autoApproved: z.number().int(),
  skipped: z.number().int(),
  // Sprint 65: engine runs queued this tick — live runs replacing legacy
  // generation (pipeline path) and paired shadow runs (shadow path). Zero on
  // the legacy path or when no active pipeline definition resolves (D-65.6).
  engineQueued: z.number().int(),
  shadowQueued: z.number().int(),
  blocked: z.string().nullable(),
});
export type AutomationCampaignResult = z.infer<typeof automationCampaignResultSchema>;

export const automationRunResultSchema = z.object({
  results: z.array(automationCampaignResultSchema),
  ranAt: z.number().int(),
});
export type AutomationRunResult = z.infer<typeof automationRunResultSchema>;

// ---------------------------------------------------------------------------
// Engagement & reply inbox (Sprint 29)
// ---------------------------------------------------------------------------

/**
 * A comment on one of our posts, a reply to one of our outbound DMs, or an
 * inbound email reply to an outreach email sent from a connected mailbox
 * (Sprint 47).
 */
export const INBOX_ITEM_KINDS = ["comment", "dm", "email"] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

/**
 * Best-effort LLM classification of an inbound email reply (Sprint 47).
 * Labels only — reply-driven actions (stop chain, suppress, retry) are
 * Sprint 49. `null` on the item means unclassified (LLM unavailable/failed);
 * classification assists, never gates.
 */
export const EMAIL_REPLY_LABELS = [
  "positive",
  "not_interested",
  "out_of_office",
  "unsubscribe_request",
  "bounce",
  "other",
] as const;
export type EmailReplyLabel = (typeof EMAIL_REPLY_LABELS)[number];

export const INBOX_ITEM_STATUSES = ["unread", "read", "replied", "dismissed"] as const;
export type InboxItemStatus = (typeof INBOX_ITEM_STATUSES)[number];

export const inboxItemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  providerKey: z.string(),
  kind: z.enum(INBOX_ITEM_KINDS),
  channel: z.enum(CHANNELS),
  /** Platform id of the inbound item — the idempotency key per connection. */
  externalId: z.string(),
  /** Platform id of the thing it replies to (our post/comment/DM). */
  parentExternalId: z.string().nullable(),
  /** The published post this engages, when mappable. */
  publicationId: z.string().uuid().nullable(),
  /** The outbound DM this replies to (X). */
  launchMessageId: z.string().uuid().nullable(),
  authorHandle: z.string(),
  authorName: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  status: z.enum(INBOX_ITEM_STATUSES),
  /** The gated reply draft, once one is generated. */
  replyDraftId: z.string().uuid().nullable(),
  postedReplyExternalId: z.string().nullable(),
  postedReplyUrl: z.string().nullable(),
  /** Governing reply action; absent/null until a reply proposal exists. */
  externalActionId: z.string().uuid().nullable().optional(),
  /** The sent outreach email this replies to (kind "email" only — Sprint 47). */
  emailDeliveryId: z.string().uuid().nullable().optional(),
  /** LLM classification of an email reply; null = unclassified. */
  replyLabel: z.enum(EMAIL_REPLY_LABELS).nullable().optional(),
  replyLabeledAt: z.number().int().nullable().optional(),
  externalCreatedAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

/** An inbox item joined with its reply draft + the post it answers, for the UI. */
export const inboxItemWithContextSchema = inboxItemSchema.extend({
  replyDraft: z
    .object({ id: z.string().uuid(), state: z.enum(APPROVAL_STATES), content: z.string() })
    .nullable(),
  post: z
    .object({
      publicationId: z.string().uuid(),
      title: z.string(),
      url: z.string().nullable(),
    })
    .nullable(),
  /** The outreach email a kind:"email" item replies to (Sprint 47). */
  sentEmail: z
    .object({
      deliveryId: z.string().uuid(),
      subject: z.string(),
      sentAt: z.number().int().nullable(),
    })
    .nullable()
    .optional(),
});
export type InboxItemWithContext = z.infer<typeof inboxItemWithContextSchema>;

/** Only `read`/`dismissed` are hand-settable; `replied` is system-set on a posted reply. */
export const updateInboxItemStatusInputSchema = z.object({
  status: z.enum(["read", "dismissed"]),
});
export type UpdateInboxItemStatusInput = z.infer<typeof updateInboxItemStatusInputSchema>;

/**
 * Engagement snapshot windows after publish — the capture path's subset of the
 * unified METRIC_WINDOWS vocabulary (Sprint 55). Kept narrow so a publication
 * metric row can never claim a window the capture path does not produce.
 */
export const PUBLICATION_METRIC_WINDOWS = ["24h", "7d"] as const;
export type PublicationMetricWindow = (typeof PUBLICATION_METRIC_WINDOWS)[number];

export const publicationMetricSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  publicationId: z.string().uuid(),
  window: z.enum(PUBLICATION_METRIC_WINDOWS),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  shares: z.number().int().nullable(),
  impressions: z.number().int().nullable(),
  clicks: z.number().int().nullable(),
  capturedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type PublicationMetric = z.infer<typeof publicationMetricSchema>;

/** What one inbox orchestrator run did. */
export const inboxRunResultSchema = z.object({
  polled: z.number().int(),
  newItems: z.number().int(),
  metricsCaptured: z.number().int(),
  repliesGenerated: z.number().int(),
  repliesAutoApproved: z.number().int(),
  repliesPosted: z.number().int(),
  ranAt: z.number().int(),
});
export type InboxRunResult = z.infer<typeof inboxRunResultSchema>;

// ---------------------------------------------------------------------------
// Lead lists & segments (Sprint 24)
// ---------------------------------------------------------------------------

/**
 * An audience is either a hand-picked `static` list or a `dynamic` segment
 * whose members are computed live from a rule tree. Both group the same unified
 * "people pool": all leads plus CRM contacts not yet linked to a lead.
 */
export const AUDIENCE_KINDS = ["static", "dynamic"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

/** A person in an audience is either a lead or a synced CRM contact. */
export const AUDIENCE_MEMBER_TYPES = ["lead", "contact"] as const;
export type AudienceMemberType = (typeof AUDIENCE_MEMBER_TYPES)[number];

/**
 * Fields a segment rule can test. Common to both member types so rules apply
 * uniformly — `notes` (leads only) is deliberately excluded. `email_domain` is
 * derived (everything after the first `@`); `type` is the member type itself.
 */
export const SEGMENT_FIELDS = ["name", "email", "email_domain", "company", "role", "type"] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const SEGMENT_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "is_set",
  "is_empty",
] as const;
export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number];

/** Operators that ignore `value` — presence checks. */
const VALUELESS_OPERATORS: readonly SegmentOperator[] = ["is_set", "is_empty"];

/** Bounds that keep "simple rule-based" honest — guarded by the schema. */
export const SEGMENT_MAX_DEPTH = 5;
export const SEGMENT_MAX_CONDITIONS = 50;

/** A unified person drawn from the workspace's people pool. */
export const personSchema = z.object({
  type: z.enum(AUDIENCE_MEMBER_TYPES),
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  company: z.string(),
  role: z.string(),
  // Only populated for `lead` people (Sprint 26) — contacts have no handle.
  xHandle: z.string().optional(),
});
export type Person = z.infer<typeof personSchema>;

export const segmentConditionSchema = z
  .object({
    field: z.enum(SEGMENT_FIELDS),
    operator: z.enum(SEGMENT_OPERATORS),
    // Optional: presence operators (is_set/is_empty) ignore it. Absent === "".
    value: z.string().max(500).optional(),
  })
  .superRefine((cond, ctx) => {
    const needsValue = !VALUELESS_OPERATORS.includes(cond.operator);
    const value = (cond.value ?? "").trim();
    if (needsValue && value.length === 0) {
      ctx.addIssue({ code: "custom", message: `"${cond.operator}" needs a value` });
    }
    if (cond.field === "type" && needsValue && value.length > 0) {
      if (!(AUDIENCE_MEMBER_TYPES as readonly string[]).includes(value)) {
        ctx.addIssue({ code: "custom", message: `type must be one of: ${AUDIENCE_MEMBER_TYPES.join(", ")}` });
      }
    }
  });
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

export const SEGMENT_COMBINATORS = ["and", "or"] as const;
export type SegmentCombinator = (typeof SEGMENT_COMBINATORS)[number];

/** A rule node is either a leaf condition or a nested group. */
export type SegmentRuleNode = SegmentCondition | SegmentRuleGroup;
export interface SegmentRuleGroup {
  combinator: SegmentCombinator;
  rules: SegmentRuleNode[];
}

/** Recursive AND/OR rule tree. A group with no rules matches everyone. */
export const segmentRuleGroupSchema: z.ZodType<SegmentRuleGroup> = z.lazy(() =>
  z.object({
    combinator: z.enum(SEGMENT_COMBINATORS),
    rules: z.array(z.union([segmentConditionSchema, segmentRuleGroupSchema])).max(SEGMENT_MAX_CONDITIONS),
  }),
);

function isRuleGroup(node: SegmentRuleNode): node is SegmentRuleGroup {
  return (node as SegmentRuleGroup).combinator !== undefined;
}

/** Depth and total-condition guards, run as a refinement on whole trees. */
function ruleTreeStats(node: SegmentRuleNode, depth = 1): { depth: number; conditions: number } {
  if (!isRuleGroup(node)) return { depth, conditions: 1 };
  let maxDepth = depth;
  let conditions = 0;
  for (const child of node.rules) {
    const stats = ruleTreeStats(child, depth + 1);
    maxDepth = Math.max(maxDepth, stats.depth);
    conditions += stats.conditions;
  }
  return { depth: maxDepth, conditions };
}

export const segmentRulesSchema = segmentRuleGroupSchema.superRefine((group, ctx) => {
  const stats = ruleTreeStats(group);
  if (stats.depth > SEGMENT_MAX_DEPTH) {
    ctx.addIssue({ code: "custom", message: `Rules nest too deep (max ${SEGMENT_MAX_DEPTH} levels)` });
  }
  if (stats.conditions > SEGMENT_MAX_CONDITIONS) {
    ctx.addIssue({ code: "custom", message: `Too many conditions (max ${SEGMENT_MAX_CONDITIONS})` });
  }
});

function fieldValue(person: Person, field: SegmentField): string {
  switch (field) {
    case "email_domain":
      return person.email.includes("@") ? person.email.slice(person.email.indexOf("@") + 1) : "";
    case "type":
      return person.type;
    default:
      return person[field];
  }
}

function matchesCondition(person: Person, cond: SegmentCondition): boolean {
  const actual = fieldValue(person, cond.field).toLowerCase().trim();
  const expected = (cond.value ?? "").toLowerCase().trim();
  switch (cond.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "not_contains":
      return !actual.includes(expected);
    case "starts_with":
      return actual.startsWith(expected);
    case "is_set":
      return actual.length > 0;
    case "is_empty":
      return actual.length === 0;
  }
}

/**
 * Evaluate a person against a rule tree. Pure and case-insensitive. An empty
 * group is vacuously true (a brand-new segment matches everyone until rules are
 * added). Shared by the service (live resolution) and the UI preview.
 */
export function evaluateSegment(person: Person, group: SegmentRuleGroup): boolean {
  if (group.rules.length === 0) return true;
  const results = group.rules.map((node) =>
    isRuleGroup(node) ? evaluateSegment(person, node) : matchesCondition(person, node),
  );
  return group.combinator === "and" ? results.every(Boolean) : results.some(Boolean);
}

export const audienceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000),
  kind: z.enum(AUDIENCE_KINDS),
  // The rule tree for dynamic segments; null for static lists.
  rules: segmentRuleGroupSchema.nullable(),
  memberCount: z.number().int().min(0),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Audience = z.infer<typeof audienceSchema>;

/** A resolved member: a pool Person, plus when it was added (static lists). */
export const audienceMemberSchema = personSchema.extend({
  addedAt: z.number().int().nullable(),
});
export type AudienceMember = z.infer<typeof audienceMemberSchema>;

export const audienceDetailSchema = z.object({
  audience: audienceSchema,
  members: z.array(audienceMemberSchema),
});
export type AudienceDetail = z.infer<typeof audienceDetailSchema>;

export const upsertAudienceInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Audience name is required")
      .max(200, "Name must be 200 characters or fewer"),
    description: z.string().trim().max(1000).default(""),
    kind: z.enum(AUDIENCE_KINDS),
    rules: segmentRulesSchema.nullable().default(null),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "dynamic" && !input.rules) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "A segment needs rules" });
    }
    if (input.kind === "static" && input.rules) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "A static list cannot have rules" });
    }
  });
export type UpsertAudienceInput = z.infer<typeof upsertAudienceInputSchema>;

const audienceMemberRefSchema = z.object({
  type: z.enum(AUDIENCE_MEMBER_TYPES),
  id: z.string().uuid(),
});
export type AudienceMemberRef = z.infer<typeof audienceMemberRefSchema>;

export const addAudienceMembersInputSchema = z.object({
  members: z.array(audienceMemberRefSchema).min(1, "Select at least one member").max(500),
});
export type AddAudienceMembersInput = z.infer<typeof addAudienceMembersInputSchema>;

export const attachAudienceInputSchema = z.object({
  audienceId: z.string().uuid(),
});
export type AttachAudienceInput = z.infer<typeof attachAudienceInputSchema>;

/** A campaign's attached audience, summarised for the campaign detail view. */
export const campaignAudienceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(AUDIENCE_KINDS),
  memberCount: z.number().int().min(0),
});
export type CampaignAudience = z.infer<typeof campaignAudienceSchema>;

// ---------------------------------------------------------------------------
// Events + webhooks
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "draft.approved",
  "draft.rejected",
  "discovery.item.accepted",
  "synthesis.accepted",
  "crm.contact.created",
  "crm.note.logged",
  "ads.synced",
  "ad.launched",
  "post.published",
  "reply.posted",
  "webhook.ping",
  // Outreach reply outcomes (Sprint 49).
  "outreach.reply.positive",
  "outreach.reply.unsubscribed",
  "outreach.reply.bounced",
  "crm.task.created",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const tuezdayEventSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  payloadJson: z.string(),
  createdAt: z.number().int(),
});
export type TuezdayEvent = z.infer<typeof tuezdayEventSchema>;

export const webhookSubscriptionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  url: z.string().url(),
  secret: z.string(),
  eventTypes: z.array(z.enum(EVENT_TYPES)),
  enabled: z.boolean(),
  createdAt: z.number().int(),
});
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

export const createWebhookInputSchema = z.object({
  url: z.string().trim().url("A valid URL is required"),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1, "Pick at least one event type"),
  secret: z.string().trim().min(8, "Secret must be at least 8 characters").optional(),
});
export type CreateWebhookInput = z.infer<typeof createWebhookInputSchema>;

// ---------------------------------------------------------------------------
// Targeted campaign launch (Sprint 26)
// ---------------------------------------------------------------------------

/** The channels a launch can drive: per-recipient email/X, broadcast LinkedIn/IG. */
export const LAUNCH_CHANNELS = ["email", "linkedin", "instagram", "x"] as const;
export type LaunchChannel = (typeof LAUNCH_CHANNELS)[number];

/** Coarse launch lifecycle; per-message detail lives on launch_messages. */
export const LAUNCH_STATUSES = ["draft", "generating", "ready", "completed"] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

/** Per-recipient personalized message, or one platform-wide broadcast post. */
export const LAUNCH_MESSAGE_KINDS = ["personalized", "broadcast"] as const;
export type LaunchMessageKind = (typeof LAUNCH_MESSAGE_KINDS)[number];

/** Dispatch lifecycle of one message (approval state is read from its draft). */
export const LAUNCH_MESSAGE_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type LaunchMessageStatus = (typeof LAUNCH_MESSAGE_STATUSES)[number];

// launchMediaSchema/LaunchMedia moved above draftSchema (Sprint 41 Part 4)
// so drafts can carry the same media shape launches use.

export const launchSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  audienceId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  personaId: z.string().uuid().nullable(),
  channels: z.array(z.enum(LAUNCH_CHANNELS)),
  status: z.enum(LAUNCH_STATUSES),
  // Sequence config (Sprint 30): the control level + stop-on-reply + the X
  // connection auto-dispatch uses. A launch with no sequence_steps ignores these.
  automationMode: z.enum(AUTOMATION_MODES),
  stopOnReply: z.boolean(),
  xConnectionId: z.string().uuid().nullable(),
  messageCount: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Launch = z.infer<typeof launchSchema>;

export const launchMessageSchema = z.object({
  id: z.string().uuid(),
  launchId: z.string().uuid(),
  channel: z.enum(LAUNCH_CHANNELS),
  kind: z.enum(LAUNCH_MESSAGE_KINDS),
  recipientType: z.enum(AUDIENCE_MEMBER_TYPES).nullable(),
  recipientId: z.string().nullable(),
  recipientName: z.string(),
  recipientEmail: z.string(),
  recipientHandle: z.string().nullable(),
  draftId: z.string().uuid().nullable(),
  status: z.enum(LAUNCH_MESSAGE_STATUSES),
  skipReason: z.string().nullable(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  sentAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** Governing send action; absent/null on legacy rows. */
  externalActionId: z.string().uuid().nullable().optional(),
  // Which sequence step produced this message (Sprint 30). First-touch = 1.
  stepNumber: z.number().int(),
  // The linked draft's current approval state + content, for the launch UI.
  draftState: z.enum(APPROVAL_STATES).nullable(),
  draftContent: z.string().nullable(),
});
export type LaunchMessage = z.infer<typeof launchMessageSchema>;

export const createLaunchInputSchema = z.object({
  name: z.string().trim().min(1, "Launch name is required").max(200),
  audienceId: z.string().uuid("Pick an audience to target"),
  campaignId: z.string().uuid().optional(),
  personaId: z.string().uuid().optional(),
  channels: z.array(z.enum(LAUNCH_CHANNELS)).min(1, "Pick at least one channel"),
  automationMode: z.enum(AUTOMATION_MODES).default("manual"),
  stopOnReply: z.boolean().default(true),
});
export type CreateLaunchInput = z.infer<typeof createLaunchInputSchema>;

export const generateLaunchInputSchema = z.object({
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
  useEvidence: z.boolean().optional(),
});
export type GenerateLaunchInput = z.infer<typeof generateLaunchInputSchema>;

export const dispatchChannelInputSchema = z.object({
  connectionId: z.string().uuid().optional(),
  media: z.array(launchMediaSchema).max(10, "At most 10 media items").optional(),
  idempotencyKey: z.string().trim().min(1).max(300).optional(),
});
export type DispatchChannelInput = z.infer<typeof dispatchChannelInputSchema>;

// ---------------------------------------------------------------------------
// Multi-step outbound sequences (Sprint 30) — follow-up chains on a launch
// ---------------------------------------------------------------------------

/** The personalized launch channels that can be sequenced into follow-up chains. */
export const SEQUENCE_CHANNELS = ["email", "x"] as const;
export type SequenceChannel = (typeof SEQUENCE_CHANNELS)[number];

/** Per-recipient progression through a launch's follow-up chain. */
export const SEQUENCE_RECIPIENT_STATUSES = [
  "active",
  "replied",
  "stopped",
  "completed",
  "failed",
] as const;
export type SequenceRecipientStatus = (typeof SEQUENCE_RECIPIENT_STATUSES)[number];

/** Hard cap on steps per channel — keeps a chain comprehensible and bounds fan-out. */
export const MAX_SEQUENCE_STEPS = 10;

export const sequenceStepSchema = z.object({
  id: z.string().uuid(),
  launchId: z.string().uuid(),
  channel: z.enum(SEQUENCE_CHANNELS),
  stepNumber: z.number().int().min(1),
  instruction: z.string(),
  delayHours: z.number().int().min(0),
});
export type SequenceStep = z.infer<typeof sequenceStepSchema>;

export const sequenceStepInputSchema = z.object({
  channel: z.enum(SEQUENCE_CHANNELS),
  stepNumber: z.number().int().min(1).max(MAX_SEQUENCE_STEPS),
  instruction: z.string().trim().max(1000).default(""),
  delayHours: z.number().int().min(0).max(8760).default(0),
});
export type SequenceStepInput = z.infer<typeof sequenceStepInputSchema>;

export const setSequenceInputSchema = z
  .object({
    steps: z
      .array(sequenceStepInputSchema)
      .min(1, "Add at least one step")
      .max(MAX_SEQUENCE_STEPS * SEQUENCE_CHANNELS.length),
  })
  .superRefine((val, ctx) => {
    // Per channel, step numbers must be a contiguous 1..N with no gaps/duplicates.
    for (const channel of SEQUENCE_CHANNELS) {
      const nums = val.steps
        .filter((s) => s.channel === channel)
        .map((s) => s.stepNumber)
        .sort((a, b) => a - b);
      for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== i + 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${channel} steps must be numbered 1..N with no gaps or duplicates.`,
          });
          break;
        }
      }
    }
  });
export type SetSequenceInput = z.infer<typeof setSequenceInputSchema>;

export const sequenceRecipientSchema = z.object({
  id: z.string().uuid(),
  launchId: z.string().uuid(),
  channel: z.enum(SEQUENCE_CHANNELS),
  recipientType: z.enum(AUDIENCE_MEMBER_TYPES),
  recipientId: z.string(),
  recipientName: z.string(),
  recipientEmail: z.string(),
  recipientHandle: z.string().nullable(),
  currentStep: z.number().int(),
  totalSteps: z.number().int(),
  status: z.enum(SEQUENCE_RECIPIENT_STATUSES),
  nextDueAt: z.number().int().nullable(),
  lastSentAt: z.number().int().nullable(),
  stoppedReason: z.string().nullable(),
  updatedAt: z.number().int(),
});
export type SequenceRecipient = z.infer<typeof sequenceRecipientSchema>;

/** Focused payload for the launch's automation toggle — never resets on a name edit. */
export const updateLaunchSequenceConfigInputSchema = z.object({
  automationMode: z.enum(AUTOMATION_MODES).optional(),
  stopOnReply: z.boolean().optional(),
  xConnectionId: z.string().uuid().nullable().optional(),
});
export type UpdateLaunchSequenceConfigInput = z.infer<typeof updateLaunchSequenceConfigInputSchema>;

export const stopSequenceInputSchema = z
  .object({
    channel: z.enum(SEQUENCE_CHANNELS).optional(),
    recipients: z.array(audienceMemberRefSchema).optional(),
    emails: z.array(z.string().trim().toLowerCase().email()).optional(),
    all: z.boolean().optional(),
    reason: z.enum(["manual", "replied"]).default("manual"),
  })
  .superRefine((v, ctx) => {
    if (!v.all && !v.recipients?.length && !v.emails?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select recipients, paste emails to suppress, or set all=true.",
      });
    }
  });
export type StopSequenceInput = z.infer<typeof stopSequenceInputSchema>;

export const sequenceRunResultSchema = z.object({
  enrolled: z.number().int(),
  generated: z.number().int(),
  autoApproved: z.number().int(),
  sent: z.number().int(),
  stopped: z.number().int(),
  completed: z.number().int(),
  ranAt: z.number().int(),
});
export type SequenceRunResult = z.infer<typeof sequenceRunResultSchema>;

export const launchDetailSchema = z.object({
  launch: launchSchema,
  messages: z.array(launchMessageSchema),
  steps: z.array(sequenceStepSchema),
  sequenceRecipients: z.array(sequenceRecipientSchema),
  recipientCount: z.number().int(),
});
export type LaunchDetail = z.infer<typeof launchDetailSchema>;

// ---------------------------------------------------------------------------
// Pricing plans & feature gating (Sprint 37)
// ---------------------------------------------------------------------------

export const PLAN_IDS = ["free", "pro", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Entitlements {
  seats: number;          // -1 = unlimited
  connectors: number;
  /** Rolling-30-day LLM spend budget in cents (Sprint 59, decision D6). -1 = unlimited. */
  monthlyLlmCents: number;
  /**
   * Reserved — declared but deliberately unread (Sprint 54, D4d). Activation
   * sprint is not scheduled; a pricing sprint must be created before anything
   * enforces this. The free tier is `0`, so wiring it up as written would
   * silently disable ad launching for every free workspace — a pricing
   * decision, not a refactor. The live spend guardrail is the workspace-owned
   * `adSettings.dailyCapCents` (`services/ad-launches.ts`), which is unrelated
   * to plan entitlements.
   */
  adSpendCapCents: number;
}

export const PLANS: Record<PlanId, { label: string; priceEnv: string | null; entitlements: Entitlements }> = {
  free:  { label: "Free",  priceEnv: null,                entitlements: { seats: 1,  connectors: 1,  monthlyLlmCents: 50,   adSpendCapCents: 0 } },
  pro:   { label: "Pro",   priceEnv: "STRIPE_PRICE_PRO",  entitlements: { seats: 5,  connectors: 10, monthlyLlmCents: 1000, adSpendCapCents: 500_00 } },
  scale: { label: "Scale", priceEnv: "STRIPE_PRICE_SCALE",entitlements: { seats: -1, connectors: -1, monthlyLlmCents: -1,   adSpendCapCents: -1 } },
};

export const entitlementUsageSchema = z.object({
  seats: z.number().int(),
  connectors: z.number().int(),
  monthlyLlmCents: z.number(),
});
export type EntitlementUsage = z.infer<typeof entitlementUsageSchema>;

export const checkoutInputSchema = z.object({
  plan: z.enum(["pro", "scale"]),
});
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

/** UI state for a plan-usage meter. A limit of -1 means unlimited. */
export type UsageMeterState = "ok" | "near" | "over" | "unlimited";
export interface UsageMeterView {
  percent: number; // 0–100, clamped
  state: UsageMeterState;
}

/** Pure meter logic for the billing page's usage bars (kept here so it is Vitest-tested). */
export function usageMeter(used: number, limit: number): UsageMeterView {
  if (limit === -1) return { percent: 100, state: "unlimited" };
  if (limit <= 0) return used > 0 ? { percent: 100, state: "over" } : { percent: 0, state: "ok" };
  if (used >= limit) return { percent: 100, state: "over" };
  const raw = (used / limit) * 100;
  return { percent: Math.min(100, Math.round(raw)), state: raw >= 80 ? "near" : "ok" };
}

// ---------------------------------------------------------------------------
// Model routing, usage ledger & workspace spend (Sprint 59)
// ---------------------------------------------------------------------------

/** Model tiers a call site may declare; the gateway resolves tier -> model from config. */
export const MODEL_TIERS = ["cheap", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Every LLM-burning surface, as attributed in the llm_usage_events ledger. */
export const LLM_PIPELINES = [
  "generation",
  "angles",
  "review",
  "revision",
  "outbound_draft",
  "pr_pitch",
  "press_kit",
  "ad_creative",
  "signal_draft",
  "engagement_reply",
  "launch",
  "launch_sequence",
  "outreach_step",
  "copilot",
  "copilot_action",
  "signal_matching",
  "discovery_matching",
  "opportunity_matching",
  "sufficiency_assessment",
  "variant_generation",
  "mailbox_classification",
  "outline_summaries",
  "source_suggestions",
  "brand_profile",
  "brain_autodraft",
  "learning_synthesis",
  "design_render",
  "agent_run",
  // Sprint 64: every LLM step of a pipeline_runs execution.
  "pipeline_run",
  // Sprint 68: turning a batch of founder edits into learned preference rules.
  "preference_extraction",
] as const;
export type LlmPipeline = (typeof LLM_PIPELINES)[number];

export const pipelineSpendSchema = z.object({
  pipeline: z.enum(LLM_PIPELINES),
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedTokens: z.number().int(),
  costCents: z.number(),
});
export type PipelineSpend = z.infer<typeof pipelineSpendSchema>;

/** The `spend` block on GET /workspaces/:id/billing. */
export const workspaceSpendSchema = z.object({
  periodStart: z.string(),
  budgetCents: z.number(), // -1 = unlimited
  spentCents: z.number(),
  state: z.enum(["ok", "near", "over", "unlimited"]),
  /** sum(cachedTokens) / sum(inputTokens) over the window; null when no input tokens. */
  cacheHitRate: z.number().nullable(),
  byPipeline: z.array(pipelineSpendSchema),
});
export type WorkspaceSpend = z.infer<typeof workspaceSpendSchema>;

// GTM insights (Sprint 34) — read-only response schemas for native insights.
// No new enums; reuses CHANNELS, APPROVAL_STATES, OUTPUT_RATINGS, BRAIN_DOC_TYPES.
// ---------------------------------------------------------------------------

export const metricTotalsSchema = z.object({
  spendCents: z.number().int(),
  impressions: z.number().int(),
  clicks: z.number().int(),
  conversions: z.number().int(),
});
export type MetricTotals = z.infer<typeof metricTotalsSchema>;

export const campaignInsightsSchema = z.object({
  campaign: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  paid: z
    .object({
      totals: metricTotalsSchema,
      adCampaigns: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          accountName: z.string(),
          currency: z.string(),
          totals: metricTotalsSchema,
        }),
      ),
    })
    .nullable(),
  organic: z.object({
    publishedCount: z.number().int(),
    scheduledCount: z.number().int(),
    platform: z.object({
      likes: z.number().int(),
      comments: z.number().int(),
      shares: z.number().int(),
      impressions: z.number().int(),
      clicks: z.number().int(),
    }),
    learning: z.object({
      impressions: z.number().int(),
      engagements: z.number().int(),
      clicks: z.number().int(),
    }),
  }),
  outbound: z.object({
    launchCount: z.number().int(),
    sentCount: z.number().int(),
    failedCount: z.number().int(),
    repliedCount: z.number().int(),
    replyRate: z.number(),
  }),
  // Outreach funnel rollup across this campaign's sequences (Sprint 50).
  // Structurally identical to campaignOutreachInsightsSchema (defined later).
  outreach: z
    .object({
      sent: z.number().int(),
      opened: z.number().int(),
      clicked: z.number().int(),
      replied: z.number().int(),
      positive: z.number().int(),
      meetings: z.number().int(),
      won: z.number().int(),
      lost: z.number().int(),
      sequenceCount: z.number().int(),
      replyRate: z.number(),
      positiveRate: z.number(),
    })
    .optional(),
  quality: z.object({
    draftCounts: z.record(z.string(), z.number().int()),
    approvalRate: z.number(),
    ratings: z.record(z.string(), z.number().int()),
  }),
  byChannel: z.array(
    z.object({
      channel: z.string(),
      published: z.number().int(),
      impressions: z.number().int(),
      spendCents: z.number().int(),
      sent: z.number().int(),
      replied: z.number().int(),
    }),
  ),
});
export type CampaignInsights = z.infer<typeof campaignInsightsSchema>;

export const workspaceInsightsSchema = z.object({
  campaigns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      spendCents: z.number().int(),
      publishedCount: z.number().int(),
      sentCount: z.number().int(),
      approvalRate: z.number(),
    }),
  ),
  byChannel: z.array(
    z.object({
      channel: z.string(),
      published: z.number().int(),
      impressions: z.number().int(),
      spendCents: z.number().int(),
      sent: z.number().int(),
      replied: z.number().int(),
    }),
  ),
  brain: z.object({
    docs: z.array(z.object({ type: z.string(), filled: z.boolean() })),
    overlayCount: z.number().int(),
    personaCount: z.number().int(),
    campaignCount: z.number().int(),
    generationsTotal: z.number().int(),
    completenessPct: z.number(),
  }),
});
export type WorkspaceInsights = z.infer<typeof workspaceInsightsSchema>;


// ---------------------------------------------------------------------------
// API error shape
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Canonical workflow status vocabulary
// ---------------------------------------------------------------------------

export const WORKFLOW_STATUS_FAMILIES = [
  "attention",
  "progress",
  "ready",
  "blocked",
  "informational",
] as const;
export type WorkflowStatusFamily = (typeof WORKFLOW_STATUS_FAMILIES)[number];

export const WORKFLOW_STATUSES = [
  "draft",
  "review_required",
  "authorization_required",
  "changes_requested",
  "generating",
  "regenerating",
  "scheduling",
  "publishing",
  "sending",
  "launching",
  "approved",
  "rejected",
  "authorized",
  "scheduled",
  "active",
  "connected",
  "completed",
  "setup_required",
  "connection_lost",
  "policy_blocked",
  "partially_failed",
  "failed",
  "stale",
  "paused",
  "superseded",
  "archived",
  "experimental",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const workflowStatusSchema = z.enum(WORKFLOW_STATUSES);

export const WORKFLOW_STATUS_META: Record<
  WorkflowStatus,
  { label: string; family: WorkflowStatusFamily }
> = {
  draft: { label: "Draft", family: "attention" },
  review_required: { label: "Review required", family: "attention" },
  authorization_required: { label: "Authorization required", family: "attention" },
  changes_requested: { label: "Changes requested", family: "attention" },
  generating: { label: "Generating", family: "progress" },
  regenerating: { label: "Regenerating", family: "progress" },
  scheduling: { label: "Scheduling", family: "progress" },
  publishing: { label: "Publishing", family: "progress" },
  sending: { label: "Sending", family: "progress" },
  launching: { label: "Launching", family: "progress" },
  approved: { label: "Approved", family: "ready" },
  rejected: { label: "Rejected", family: "informational" },
  authorized: { label: "Authorized", family: "ready" },
  scheduled: { label: "Scheduled", family: "ready" },
  active: { label: "Active", family: "ready" },
  connected: { label: "Connected", family: "ready" },
  completed: { label: "Completed", family: "ready" },
  setup_required: { label: "Setup required", family: "blocked" },
  connection_lost: { label: "Connection lost", family: "blocked" },
  policy_blocked: { label: "Policy blocked", family: "blocked" },
  partially_failed: { label: "Partially failed", family: "blocked" },
  failed: { label: "Failed", family: "blocked" },
  stale: { label: "Stale", family: "blocked" },
  paused: { label: "Paused", family: "informational" },
  superseded: { label: "Superseded", family: "informational" },
  archived: { label: "Archived", family: "informational" },
  experimental: { label: "Experimental", family: "informational" },
};

export const priorityItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(PRIORITY_ITEM_KINDS),
  status: workflowStatusSchema,
  title: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  href: z.string().startsWith("/"),
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  dueAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type PriorityItem = z.infer<typeof priorityItemSchema>;

export const priorityQueueSchema = z.object({
  items: z.array(priorityItemSchema),
  generatedAt: z.number().int(),
});
export type PriorityQueue = z.infer<typeof priorityQueueSchema>;

// ---------------------------------------------------------------------------
// Unified execution results (UI revamp golden loop) — one read-only projection
// over publications, targeted launches, and ad launches. External actions join
// this vocabulary once their API foundation exists.
// ---------------------------------------------------------------------------

export const EXECUTION_RESULT_KINDS = [
  "publication",
  "launch",
  "ad_launch",
  "ad_mutation",
  "email_delivery",
] as const;
export type ExecutionResultKind = (typeof EXECUTION_RESULT_KINDS)[number];

export const EXECUTION_RESULT_STATUSES = [
  "running",
  "completed",
  "partially_failed",
  "failed",
] as const;
export type ExecutionResultStatus = (typeof EXECUTION_RESULT_STATUSES)[number];

const executionDestinationsSchema = z.object({
  total: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  pending: z.number().int().min(0),
});
export type ExecutionDestinations = z.infer<typeof executionDestinationsSchema>;

export const executionResultSchema = z
  .object({
    kind: z.enum(EXECUTION_RESULT_KINDS),
    /** Id of the underlying publication / launch / ad launch row. */
    id: z.string().uuid(),
    title: z.string(),
    channel: z.string().nullable(),
    campaignId: z.string().uuid().nullable(),
    campaignName: z.string().nullable(),
    status: z.enum(EXECUTION_RESULT_STATUSES),
    /** When the execution happened (or last progressed, for running launches). */
    at: z.number().int(),
    url: z.string().nullable(),
    error: z.string().nullable(),
    /** Raw platform effective_status — ad launches only; null elsewhere. */
    platformStatus: z.string().nullable(),
    destinations: executionDestinationsSchema,
    draftId: z.string().uuid().nullable(),
    /** Governed mutation kind; absent/null for legacy execution projections. */
    actionKind: z.enum(EXTERNAL_ACTION_KINDS).nullable().optional(),
    /** Empty for legacy results; launch rollups may carry several message actions. */
    externalActionIds: z.array(z.string().uuid()).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "ad_mutation" &&
      value.actionKind !== "budget_change" &&
      value.actionKind !== "targeting_change"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionKind"],
        message: "Ad mutation results require a budget or targeting action kind",
      });
    }
    if (value.kind !== "ad_mutation" && value.actionKind != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionKind"],
        message: "Legacy execution results cannot carry an action kind",
      });
    }
  });
export type ExecutionResult = z.infer<typeof executionResultSchema>;

// ---------------------------------------------------------------------------
// Conversational editor read model. Declared after publication and execution
// schemas so this composite projection can reuse their canonical contracts.
// ---------------------------------------------------------------------------

export const editorCampaignSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  automationMode: z.enum(AUTOMATION_MODES),
});
export type EditorCampaign = z.infer<typeof editorCampaignSchema>;

export const editorPersonaSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type EditorPersona = z.infer<typeof editorPersonaSchema>;

export const editorStalenessSchema = z.object({
  stale: z.boolean(),
  planActivatedAt: z.number().int().nullable(),
  contextResolvedAt: z.number().int(),
  reason: z.string(),
});
export type EditorStaleness = z.infer<typeof editorStalenessSchema>;

export const editorSiblingSchema = z.object({
  draftId: z.string().uuid(),
  channel: z.enum(CHANNELS),
  state: z.enum(APPROVAL_STATES),
});
export type EditorSibling = z.infer<typeof editorSiblingSchema>;

export const editorDestinationSchema = z.object({
  providerKey: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(CONNECTION_STATUSES),
  error: z.string().nullable(),
});
export type EditorDestination = z.infer<typeof editorDestinationSchema>;

export const draftEditorContextSchema = z.object({
  draft: draftSchema,
  decisions: z.array(approvalDecisionSchema),
  turns: z.array(draftRevisionTurnSchema),
  contextSections: z.array(editorContextSectionSchema),
  evidenceCitations: z.array(editorEvidenceCitationSchema),
  campaign: editorCampaignSchema.nullable(),
  persona: editorPersonaSchema.nullable(),
  staleness: editorStalenessSchema,
  siblings: z.array(editorSiblingSchema),
  destination: editorDestinationSchema.nullable(),
  publications: z.array(publicationSchema),
  executions: z.array(executionResultSchema),
  actions: z.array(externalActionSchema).optional(),
});
export type DraftEditorContext = z.infer<typeof draftEditorContextSchema>;

// ---------------------------------------------------------------------------
// Product analytics (internal — PostHog). NOT the native customer dashboard.
// ---------------------------------------------------------------------------

/** Curated product-funnel events. Non-PII payloads only (ids/enums/counts). */
export const ANALYTICS_EVENTS = [
  "user.registered",
  "generation.created",
  "draft.approved",
  "draft.published",
  "connector.connected",
  "publication.started",
  "home.next_action_opened",
  "campaign.context_opened",
  "review.item_opened",
  "review.revision_requested",
  "review.content_decided",
  "review.action_authorized",
  // Sprint 52: a publish authorized by the earlier draft approval, with no
  // click to attribute. Kept distinct so `review.action_authorized` keeps
  // meaning "a human clicked Authorize"; total authorizations is the sum.
  "review.action_authorized_collapsed",
  "calendar.item_scheduled",
  "execution.result_viewed",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export const setAnalyticsOptOutInputSchema = z.object({ optOut: z.boolean() });
export type SetAnalyticsOptOutInput = z.infer<typeof setAnalyticsOptOutInputSchema>;

// ---------------------------------------------------------------------------
// Google OAuth login (Sprint 36)
// ---------------------------------------------------------------------------

export const googleCallbackInputSchema = z.object({
  code: z.string().min(1, "Missing authorization code"),
});
export type GoogleCallbackInput = z.infer<typeof googleCallbackInputSchema>;

/** Internal: the verified identity we extract from Google's userinfo. */
export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

// ---------------------------------------------------------------------------
// Sprint 33: Dashboard IA and Nav Visibility
// ---------------------------------------------------------------------------

export const workspaceCapabilitiesSchema = z.object({
  hasAds: z.boolean(),
  hasInsights: z.boolean(),
  hasCrm: z.boolean(),
  hasConnections: z.boolean(),
  draftCount: z.number().int(),
  generationCount: z.number().int(),
  // Spec §5.7.1 nav progress ("1/4") — from integrationProgress(); optional so
  // older API responses stay valid and the badge simply hides until reported.
  integrationsConnected: z.number().int().optional(),
  integrationsTotal: z.number().int().optional(),
});
export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>;

export type NavRequirement = "ads" | "insights" | "crm" | "connections";

export const NAV_SECTIONS = [
  { id: "operate", label: "Operate" },
  { id: "grow", label: "Grow" },
  { id: "foundations", label: "Foundations" },
  { id: "library", label: "Work" },
  { id: "workspace", label: "Workspace" },
] as const;
export type NavSection = (typeof NAV_SECTIONS)[number]["id"];

export interface NavChild {
  label: string;
  path: string;
  summary?: string;
  icon?: string;
  tone?: "belief" | "voice" | "history" | "icp" | "system" | "signal";
  requires?: NavRequirement;
}

export interface NavItem {
  label: string;
  path: string;
  section: NavSection;
  summary?: string;
  icon?: string;
  tone?: "belief" | "voice" | "history" | "icp" | "system" | "signal";
  requires?: NavRequirement;
  children?: NavChild[];
}

export const WORKSPACE_NAV: NavItem[] = [
  {
    label: "Home",
    path: "",
    summary: "What needs attention now",
    tone: "system",
    icon: "home",
    section: "operate",
  },
  {
    label: "Calendar",
    path: "/calendar",
    summary: "Planned, scheduled, and completed work",
    tone: "history",
    icon: "calendar",
    section: "operate",
  },
  {
    label: "Campaigns",
    path: "/campaigns",
    summary: "Plans, work, channels, and results",
    tone: "voice",
    icon: "campaigns",
    section: "operate",
    children: [
      { label: "Campaign home", path: "/campaigns", summary: "Goals and GTM pushes", tone: "voice", icon: "campaigns" },
      { label: "Schedule", path: "/cadence", summary: "Publishing rhythm", tone: "history", icon: "calendar" },
      { label: "Automation", path: "/automation", summary: "Human-in-the-loop rules", tone: "signal", icon: "regenerate" },
    ],
  },
  {
    // Approvals and Inbox are sibling tabs inside the unified Review
    // workspace (/review?tab=approvals|inbox), not separate nav children.
    label: "Review",
    path: "/review",
    summary: "Approve, authorize, and respond",
    tone: "icp",
    icon: "review",
    section: "operate",
  },
  {
    label: "Discover",
    path: "/discovery",
    summary: "Market signals worth acting on",
    tone: "signal",
    icon: "discover",
    section: "grow",
    children: [
      { label: "Signal inbox", path: "/discovery", summary: "Triage discovered items", tone: "signal", icon: "discover" },
      // Sprint 61: campaign-scoped opportunity decisions (design §11.2's
      // daily view; Signal inbox keeps the top-level path until cutover).
      { label: "Opportunities", path: "/opportunities", summary: "Campaign-scoped story opportunities", tone: "signal", icon: "discover" },
      // Sprint 62: source-grounded packages between opportunity and deliverable.
      { label: "Packages", path: "/packages", summary: "Source-grounded content packages", tone: "signal", icon: "discover" },
      // Sprint 63: lane commitments and their candidate executions.
      { label: "Deliverables", path: "/deliverables", summary: "Lane commitments and candidate variants", tone: "signal", icon: "discover" },
      // Sprint 64: pipeline definitions as data + the run/dry-run views.
      { label: "Pipelines", path: "/pipelines", summary: "Versioned generation pipelines and their runs", tone: "signal", icon: "discover" },
      // Sprint 60: canonical stories — the shadow intelligence layer.
      { label: "Stories", path: "/stories", summary: "Canonical stories across sources", tone: "signal", icon: "blog" },
    ],
  },
  {
    label: "Audience",
    path: "/outbound",
    summary: "Recipients, lists, sequences, CRM, and media",
    tone: "icp",
    icon: "audience",
    section: "grow",
    children: [
      { label: "Outbound", path: "/outbound", summary: "Lead-driven drafts", tone: "icp", icon: "external" },
      { label: "Lists & segments", path: "/lists", summary: "Reusable audiences", tone: "icp", icon: "audience" },
      { label: "Sequences", path: "/launches", summary: "Targeted campaign sends", tone: "voice", icon: "campaigns" },
      { label: "CRM", path: "/crm", summary: "Contacts and account context", tone: "icp", icon: "user" },
      { label: "PR & media", path: "/pr", summary: "Media contacts and pitches", tone: "belief", icon: "notification" },
    ],
  },
  {
    label: "Ads",
    path: "/ads",
    summary: "Creative, launch, spend, and results",
    tone: "belief",
    icon: "ad",
    section: "grow",
    requires: "ads",
    children: [
      { label: "Overview", path: "/ads", summary: "Paid channel performance", tone: "belief", icon: "ad" },
      { label: "Creative", path: "/ad-creatives", summary: "Platform-ready variants", tone: "voice", icon: "post" },
      { label: "Launch & spend", path: "/ad-launches", summary: "Spend-controlled launches", tone: "belief", icon: "status-live" },
    ],
  },
  {
    label: "Insights",
    path: "/insights",
    summary: "Performance and accepted learning",
    tone: "history",
    icon: "status-learning",
    section: "grow",
    requires: "insights",
    children: [
      { label: "Performance", path: "/insights", summary: "What worked and why", tone: "icp", icon: "status-learning" },
      { label: "Learning", path: "/learning", summary: "Brain updates from decisions", tone: "history", icon: "doc-history" },
    ],
  },
  {
    label: "Brain",
    path: "/brain",
    summary: "Brand, voice, evidence, and context",
    tone: "system",
    icon: "brain",
    section: "foundations",
    children: [
      { label: "Brain docs", path: "/brain", summary: "The editable GTM memory", tone: "system", icon: "brain" },
      { label: "Content Preferences", path: "/brain#content-preferences", summary: "Channel and scoped guidance", tone: "voice", icon: "edit" },
      { label: "Source materials", path: "/evidence", summary: "Proof and evidence", tone: "history", icon: "doc-history" },
      { label: "Advanced context", path: "/resolver", summary: "Inspect what Tuezday will use", tone: "icp", icon: "search" },
      { label: "Agent inspector", path: "/inspector", summary: "Watch what agents did and why", tone: "system", icon: "info" },
    ],
  },
  {
    label: "Integrations",
    path: "/connectors",
    summary: "Connect the GTM stack",
    tone: "system",
    icon: "connect",
    section: "foundations",
  },
  {
    label: "Create New",
    path: "/content",
    summary: "Draft cross-channel work",
    tone: "belief",
    icon: "create",
    section: "library",
    children: [
      { label: "Create", path: "/content", summary: "Posts and signal responses", tone: "belief", icon: "post" },
      { label: "Advanced", path: "/sandbox", summary: "Generate directly from the Brain", tone: "system", icon: "status-generating" },
    ],
  },
  {
    label: "Settings",
    path: "/team",
    summary: "Workspace administration",
    tone: "system",
    icon: "settings",
    section: "workspace",
    children: [
      { label: "Team", path: "/team", summary: "Members and invites", tone: "icp", icon: "audience" },
      { label: "Billing", path: "/billing", summary: "Plan and usage", tone: "history", icon: "doc-history" },
      { label: "Notifications", path: "/notifications", summary: "Email and Telegram alerts", tone: "signal", icon: "notification" },
      { label: "Activity", path: "/activity", summary: "Event log and audit trail", tone: "system", icon: "info" },
    ],
  },
];

function navRequirementMet(requirement: NavRequirement | undefined, caps: WorkspaceCapabilities): boolean {
  if (!requirement) return true;
  if (requirement === "ads") return caps.hasAds;
  if (requirement === "insights") return caps.hasInsights;
  if (requirement === "crm") return caps.hasCrm;
  return caps.hasConnections;
}

function legacyNavRequirementMet(item: NavItem | NavChild, caps: WorkspaceCapabilities): boolean {
  if (item.label === "Insights" && !caps.hasInsights) return false;
  if (
    !caps.hasAds &&
    (item.label === "Ads" || item.label === "Ad creatives" || item.label === "Launch ads")
  ) {
    return false;
  }
  return true;
}

/**
 * Pure predicate to filter navigation items based on workspace capabilities.
 */
export function visibleNavItems(nav: NavItem[], caps: WorkspaceCapabilities): NavItem[] {
  return nav
    .filter((item) => {
      return navRequirementMet(item.requires, caps) && legacyNavRequirementMet(item, caps);
    })
    .map((item) => {
      const children = item.children?.filter(
        (child) => navRequirementMet(child.requires, caps) && legacyNavRequirementMet(child, caps),
      );
      return children ? { ...item, children } : item;
    });
}

export interface NavEntry {
  label: string;
  icon?: string;
  tone?: NavItem["tone"];
  parentLabel?: string;
}

/**
 * Resolve a workspace-relative path ("" | "/approvals" | "/campaigns/abc") to
 * the nav entry that owns it. Longest path wins so children beat their group
 * and detail sub-routes resolve to their page. Used by the TopBar for titles.
 */
export function navEntryForPath(nav: NavItem[], relativePath: string): NavEntry | null {
  if (relativePath === "") {
    const home = nav.find((item) => item.path === "");
    return home ? { label: home.label, icon: home.icon, tone: home.tone } : null;
  }
  let best: NavEntry | null = null;
  let bestDepth = 0;
  // ">=" so on equal depth the LAST considered wins — children are considered
  // after their group, so a child sharing its group's path (e.g. "/approvals")
  // beats the group, giving "Approval queue" with parentLabel "Review".
  const consider = (path: string, entry: NavEntry) => {
    if (path === "") return;
    if (path.includes("#")) return;
    if (relativePath === path || relativePath.startsWith(`${path}/`)) {
      if (path.length >= bestDepth) {
        best = entry;
        bestDepth = path.length;
      }
    }
  };
  for (const item of nav) {
    consider(item.path, { label: item.label, icon: item.icon, tone: item.tone });
    for (const child of item.children ?? []) {
      consider(child.path, {
        label: child.label,
        icon: child.icon,
        tone: child.tone ?? item.tone,
        parentLabel: item.label,
      });
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Notification channels (Sprint 39)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNEL_TYPES = ["telegram", "email"] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const createNotificationChannelInputSchema = z.object({
  type: z.enum(NOTIFICATION_CHANNEL_TYPES),
  target: z.string().trim().min(1, "Target is required"),
  enabled: z.boolean().default(true),
});
export type CreateNotificationChannelInput = z.infer<typeof createNotificationChannelInputSchema>;

// ---------------------------------------------------------------------------
// Public API Keys (Sprint 40)
// ---------------------------------------------------------------------------

export const API_SCOPES = [
  "ideas:write",
  "drafts:read",
  "drafts:write",
  "analytics:read",
  "campaigns:launch",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

// ---------------------------------------------------------------------------
// Next-action engine (UI industry-ready spec §5.1). Pure priority function —
// the API exposes the computed value; guide dot / smart landing / Home
// checklist all derive from this ONE answer so they can never disagree.
// ---------------------------------------------------------------------------

export const SETUP_CHECKLIST_ITEMS = [
  "brain_reviewed",
  "channel_connected",
  "first_campaign",
  "first_approval",
  "insights_live",
  "team_invited",
] as const;
export type SetupChecklistItem = (typeof SETUP_CHECKLIST_ITEMS)[number];

export const nextActionStateSchema = z.object({
  draftCount: z.number().int().min(0),
  blockedPublishCount: z.number().int().min(0),
  liveCampaignsWithoutContent: z.number().int().min(0),
  insightsAvailableUnconnected: z.boolean(),
  generatingCount: z.number().int().min(0),
  checklist: z.object({
    brain_reviewed: z.boolean(),
    channel_connected: z.boolean(),
    first_campaign: z.boolean(),
    first_approval: z.boolean(),
    insights_live: z.boolean(),
    team_invited: z.boolean(),
  }),
});
export type NextActionState = z.infer<typeof nextActionStateSchema>;

export type NextActionKind =
  | "review"
  | "connect_blocked"
  | "campaign_content"
  | "connect_insights"
  | "checklist"
  | "system_working"
  | "none";

export interface NextAction {
  kind: NextActionKind;
  /** Workspace-relative nav path the guide dot attaches to ("" = Home). */
  module: string;
  /** Short imperative label, e.g. "Review drafts". */
  label: string;
  /** Hover explanation for the guide dot, e.g. "1 draft waiting for review". */
  reason: string;
  checklistItem?: SetupChecklistItem;
}

const CHECKLIST_TARGETS: Record<SetupChecklistItem, { module: string; label: string; reason: string }> = {
  brain_reviewed: { module: "/brain", label: "Review your Brain", reason: "Your GTM memory needs a first review" },
  channel_connected: { module: "/connectors", label: "Connect a channel", reason: "No publishing channel is connected yet" },
  first_campaign: { module: "/campaigns", label: "Create your first campaign", reason: "No campaign exists yet" },
  first_approval: { module: "/review", label: "Approve your first draft", reason: "Nothing has been approved yet" },
  insights_live: { module: "/connectors", label: "Turn on insights", reason: "Connect a channel with analytics to see results" },
  team_invited: { module: "/team", label: "Invite your team", reason: "You are the only member of this workspace" },
};

export function checklistProgress(state: NextActionState): { done: number; total: number; complete: boolean } {
  const total = SETUP_CHECKLIST_ITEMS.length;
  const done = SETUP_CHECKLIST_ITEMS.filter((item) => state.checklist[item]).length;
  return { done, total, complete: done === total };
}

/**
 * The setup answer: which activation step is still missing.
 *
 * Sprint 70 (D-70.9) deleted the four branches that ranked *work* — pending
 * drafts, blocked publishes, live campaigns without content, unconnected
 * insights. Each re-derived, from raw counts, something the inbox already
 * computes as a ranked item with a reason and a consequence, and the two could
 * disagree in front of the founder. The inbox now answers "what needs you";
 * this answers "what setup step is left", and the answers no longer overlap.
 *
 * The `review` / `connect_blocked` / `campaign_content` / `connect_insights`
 * kinds remain in `NextActionKind` for stored/legacy payloads; nothing returns
 * them any more.
 */
export function nextActionFor(state: NextActionState): NextAction {
  for (const item of SETUP_CHECKLIST_ITEMS) {
    if (!state.checklist[item]) {
      const target = CHECKLIST_TARGETS[item];
      return { kind: "checklist", checklistItem: item, ...target };
    }
  }
  if (state.generatingCount > 0) {
    const n = state.generatingCount;
    return {
      kind: "system_working",
      module: "",
      label: "Generating",
      reason: `${n} post${n === 1 ? "" : "s"} generating — nothing needs you right now`,
    };
  }
  return { kind: "none", module: "", label: "All clear", reason: "Nothing needs you right now" };
}

// ---------------------------------------------------------------------------
// Design systems (Sprint 41 Part 2)
//
// Brain-adjacent visual identity: a DESIGN.md-shaped markdown doc per named
// design system, plus channel/persona/campaign overlays resolved
// most-specific-wins (Sprint 44's guidance pattern, scoped to a system).
// Deliberately NOT a brain doc type — never added to BRAIN_DOC_TYPES, never
// resolved by packages/brain; only the design pipeline reads it.
// ---------------------------------------------------------------------------

export const DESIGN_CONTENT_MAX_CHARS = 24_000;
export const DESIGN_SYSTEM_NAME_MAX_CHARS = 80;

export const designSystemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  content: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type DesignSystem = z.infer<typeof designSystemSchema>;

export const updateDesignSystemInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Design system cannot be empty")
    .max(DESIGN_CONTENT_MAX_CHARS),
});
export type UpdateDesignSystemInput = z.infer<typeof updateDesignSystemInputSchema>;

/** One overlay row (management read model, scope names joined in). */
export const designOverlaySchema = z.object({
  id: z.string().uuid(),
  designSystemId: z.string().uuid(),
  channel: z.enum(CHANNELS),
  content: z.string(),
  personaId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  personaName: z.string().nullable(),
  campaignName: z.string().nullable(),
  updatedAt: z.number().int(),
});
export type DesignOverlay = z.infer<typeof designOverlaySchema>;

export const upsertDesignOverlayInputSchema = z.object({
  channel: z.enum(CHANNELS),
  content: z
    .string()
    .trim()
    .min(1, "Overlay cannot be empty")
    .max(DESIGN_CONTENT_MAX_CHARS),
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  // Multi-system readiness: omit to target the workspace default system.
  designSystemId: z.string().uuid().optional(),
});
export type UpsertDesignOverlayInput = z.infer<typeof upsertDesignOverlayInputSchema>;

/** Which rung of the winner chain produced the resolved content. */
export const DESIGN_TRACE_SOURCES = [
  "persona+campaign",
  "persona",
  "campaign",
  "channel",
  "base",
] as const;
export type DesignTraceSource = (typeof DESIGN_TRACE_SOURCES)[number];

/**
 * Resolved design context: base system content plus (at most) the single
 * winning overlay appended as an addendum, and a trace explaining why —
 * readable before any template is authored, same transparency contract as
 * the brain resolver.
 */
export const resolvedDesignSystemSchema = z.object({
  content: z.string(),
  trace: z.object({
    source: z.enum(DESIGN_TRACE_SOURCES),
    overlayId: z.string().uuid().nullable(),
    designSystemId: z.string().uuid(),
  }),
});
export type ResolvedDesignSystem = z.infer<typeof resolvedDesignSystemSchema>;

/**
 * Starter DESIGN.md seeded into every workspace's default system. Field set
 * informed by the Sprint 41 competitor scan (docs/research/): semantic color
 * roles (the one field no consumer brand kit has — Material's on-X convention
 * gives templates auto-contrast), heading/body font roles with weights and
 * fallbacks, a spacing/radius scale, an author strip block, and a "never do"
 * list. Voice stays in the `voice` brain doc — linked, not duplicated.
 */
export const DEFAULT_DESIGN_SYSTEM_CONTENT = `# Visual identity

The design pipeline reads this document every time it authors a slide or ad
template — the palette, type, and rules below become the rendered look.
How the brand *sounds* lives in the Voice brain doc; this doc is only how it
*looks*.

## Palette (semantic roles)

- primary: #111827 — brand color; hook-slide and CTA backgrounds
- on-primary: #FFFFFF — text and icons placed on primary
- background: #FFFFFF — default slide background
- surface: #F3F4F6 — cards, stat blocks, quote panels
- text: #111827 — body copy on background/surface
- accent: #2563EB — highlights, big numbers, swipe cues (use sparingly)

## Typography

- Heading: Inter, weight 800, tight line height. Fallback: system-ui, sans-serif.
- Body: Inter, weight 450, line height 1.4. Fallback: system-ui, sans-serif.
- At most two font families anywhere. Body text no smaller than ~40px on a
  1080px canvas.

## Spacing & shape

- Spacing scale (1080px canvas): 8 / 16 / 24 / 40 / 64px.
- Corner radius: 24px on cards and panels.
- Shadows: flat by default; one soft shadow only when a card needs lift.

## Logo & author strip

- Logo: (paste a public URL; note light/dark variants if you have them)
- Author strip: name, @handle, headshot URL — rendered small on every slide,
  full-size on the CTA/outro slide.

## Never do

- Never place text over busy imagery without a solid or gradient scrim.
- Never use colors outside the palette above.
- Never use more than two font families or crop the hook headline out of the
  center 3:4 safe zone.
`;

// ---------------------------------------------------------------------------
// Slide archetypes (Sprint 41 Parts 3-4)
//
// Explicit, named slide roles for carousel templates — competitor tools bake
// these into templates implicitly (only Taplio names any in its UI), so a
// first-class vocabulary is a differentiator (see
// docs/research/sprint-41-competitor-scan.md). Template authoring produces one
// layout per archetype; the splitter assigns archetypes and enforces the word
// budgets at generation time, which is cheaper than text-fit-at-render.
// ---------------------------------------------------------------------------

export const SLIDE_ARCHETYPES = [
  "hook", // cover: 5-8 word headline, biggest type on deck, swipe cue
  "body", // heading + 15-30 word body
  "list_item", // one idea, big index number
  "stat", // one oversized metric + one-line context
  "quote", // large quotation + attribution
  "tldr", // mid/late-deck recap
  "cta", // outro: save/follow ask + author strip, strongest branding
] as const;
export type SlideArchetype = (typeof SLIDE_ARCHETYPES)[number];

/** Word budgets enforced when copy is written, not fitted at render. */
export const SLIDE_WORD_BUDGETS: Record<SlideArchetype, { title: number; body: number }> = {
  hook: { title: 8, body: 12 },
  body: { title: 10, body: 30 },
  list_item: { title: 10, body: 30 },
  stat: { title: 6, body: 20 },
  quote: { title: 30, body: 10 }, // title carries the quote, body the attribution
  tldr: { title: 8, body: 40 },
  cta: { title: 8, body: 20 },
};

/** Meta Ads static image shape (Part 5) — same template machinery, single slide. */
export const AD_IMAGE_SLIDE_SHAPE = "ad-1080x1080" as const;

/** The only Open Design skills Tuezday will ever request (umbrella Decision 9). */
export const DESIGN_SKILL_ALLOWLIST = ["social-carousel"] as const;
export type DesignSkillId = (typeof DESIGN_SKILL_ALLOWLIST)[number];

// ---------------------------------------------------------------------------
// Outreach mailboxes (Sprint 47)
// ---------------------------------------------------------------------------

/**
 * A connected sending/receiving mailbox — the outreach send identity AND the
 * reply source, in one object. Modeled as a pool from day one (founder
 * decision 05): a workspace can hold many mailboxes even while early
 * sequences use a single one. Distinct from `workspaceEmailSenders` (the
 * Resend DNS-domain identity for transactional/broadcast email) — the two
 * send paths coexist.
 */
export const MAILBOX_PROVIDERS = ["gmail"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const MAILBOX_STATUSES = ["connected", "error", "disconnected"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

/** Founder decision: per-mailbox daily cap is customizable, default 50. */
export const MAILBOX_DEFAULT_DAILY_CAP = 50;
export const MAILBOX_MAX_DAILY_CAP = 500;

/**
 * When the mailbox may send, enforced by the Sprint 48 sequence scheduler
 * (stored from Sprint 47 so settings survive). Empty object = always.
 */
export const mailboxSendingWindowSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday. Empty/absent = every day. */
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    /** Local hour bounds, half-open [startHour, endHour). */
    startHour: z.number().int().min(0).max(23).optional(),
    endHour: z.number().int().min(1).max(24).optional(),
    /** IANA timezone, e.g. "Asia/Kolkata". Absent = workspace default. */
    timezone: z.string().max(64).optional(),
  })
  .strict();
export type MailboxSendingWindow = z.infer<typeof mailboxSendingWindowSchema>;

export const mailboxSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** The gmail connector row this mailbox rides (tokens live in Nango). */
  connectionId: z.string().uuid(),
  provider: z.enum(MAILBOX_PROVIDERS),
  /** The mailbox address, filled from the provider profile at connect time. */
  address: z.string().email(),
  displayName: z.string(),
  replyTo: z.string().email().nullable(),
  signature: z.string(),
  dailyCap: z.number().int().min(1).max(MAILBOX_MAX_DAILY_CAP),
  sendingWindow: mailboxSendingWindowSchema,
  defaultPersonaId: z.string().uuid().nullable(),
  status: z.enum(MAILBOX_STATUSES),
  lastPolledAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

/** A mailbox as the UI needs it: the row plus today's send usage. */
export const mailboxWithUsageSchema = mailboxSchema.extend({
  /** Accepted sends since UTC midnight, counted from email deliveries. */
  sentToday: z.number().int(),
});
export type MailboxWithUsage = z.infer<typeof mailboxWithUsageSchema>;

/** Create = point at a connected gmail connector; the address comes from the provider profile. */
export const createMailboxInputSchema = z.object({
  connectionId: z.string().uuid(),
});
export type CreateMailboxInput = z.infer<typeof createMailboxInputSchema>;

export const updateMailboxInputSchema = z
  .object({
    displayName: z.string().max(200).optional(),
    replyTo: z.string().email().nullable().optional(),
    signature: z.string().max(2000).optional(),
    dailyCap: z.number().int().min(1).max(MAILBOX_MAX_DAILY_CAP).optional(),
    sendingWindow: mailboxSendingWindowSchema.optional(),
    defaultPersonaId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateMailboxInput = z.infer<typeof updateMailboxInputSchema>;

/** Send an approved, lead-linked outbound email draft from a mailbox (Sprint 47 send surface). */
export const sendDraftFromMailboxInputSchema = z.object({
  mailboxId: z.string().uuid(),
});
export type SendDraftFromMailboxInput = z.infer<typeof sendDraftFromMailboxInputSchema>;

/** What one mailbox-inbox poll run did. */
export const mailboxInboxRunResultSchema = z.object({
  mailboxesPolled: z.number().int(),
  messagesSeen: z.number().int(),
  newItems: z.number().int(),
  labeled: z.number().int(),
  ranAt: z.number().int(),
});
export type MailboxInboxRunResult = z.infer<typeof mailboxInboxRunResultSchema>;

// ---------------------------------------------------------------------------
// Outreach sequences (Sprint 48)
// ---------------------------------------------------------------------------

/**
 * A first-class, always-on outreach sequence: an ordered chain of email steps
 * sent from a mailbox pool to a live segment, brain-resolved + approval-gated
 * per recipient, that auto-enrolls new segment matches and stops on reply.
 * Distinct from S26/S30 launch sequences (which stay frozen).
 */
export const OUTREACH_SEQUENCE_STATUSES = ["draft", "active", "paused", "completed"] as const;
export type OutreachSequenceStatus = (typeof OUTREACH_SEQUENCE_STATUSES)[number];

export const OUTREACH_ENROLLMENT_STATUSES = [
  "active",
  "replied",
  "stopped",
  "completed",
  "failed",
] as const;
export type OutreachEnrollmentStatus = (typeof OUTREACH_ENROLLMENT_STATUSES)[number];

/** Manual terminal outcome on an enrollment (Sprint 50) — the funnel's tail. */
export const OUTREACH_ENROLLMENT_OUTCOMES = ["none", "meeting", "won", "lost"] as const;
export type OutreachEnrollmentOutcome = (typeof OUTREACH_ENROLLMENT_OUTCOMES)[number];

/** Open/click engagement events on a sent outreach email (Sprint 50). */
export const TRACKING_EVENT_TYPES = ["open", "click"] as const;
export type TrackingEventType = (typeof TRACKING_EVENT_TYPES)[number];

export const OUTREACH_MESSAGE_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type OutreachMessageStatus = (typeof OUTREACH_MESSAGE_STATUSES)[number];

/** Founder decision: per-sequence daily new-enrollment cap is customizable, default 50. */
export const OUTREACH_DEFAULT_ENROLLMENT_CAP = 50;
export const OUTREACH_MAX_ENROLLMENT_CAP = 1000;
export const OUTREACH_MAX_STEPS = 10;

export const outreachSequenceStepSchema = z.object({
  id: z.string().uuid(),
  sequenceId: z.string().uuid(),
  stepNumber: z.number().int().min(1),
  instruction: z.string(),
  delayHours: z.number().int().min(0),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type OutreachSequenceStep = z.infer<typeof outreachSequenceStepSchema>;

export const outreachSequenceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  name: z.string(),
  goal: z.string(),
  personaId: z.string().uuid(),
  audienceId: z.string().uuid(),
  automationMode: z.enum(AUTOMATION_MODES),
  status: z.enum(OUTREACH_SEQUENCE_STATUSES),
  dailyEnrollmentCap: z.number().int().min(1).max(OUTREACH_MAX_ENROLLMENT_CAP),
  stopOnReply: z.boolean(),
  // Open/click tracking (Sprint 50) — off by default (deliverability-first).
  trackOpens: z.boolean(),
  trackClicks: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type OutreachSequence = z.infer<typeof outreachSequenceSchema>;

export const createOutreachSequenceInputSchema = z.object({
  campaignId: z.string().uuid(),
  personaId: z.string().uuid(),
  audienceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  goal: z.string().max(500).optional(),
  automationMode: z.enum(AUTOMATION_MODES).optional(),
  dailyEnrollmentCap: z.number().int().min(1).max(OUTREACH_MAX_ENROLLMENT_CAP).optional(),
  stopOnReply: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
});
export type CreateOutreachSequenceInput = z.infer<typeof createOutreachSequenceInputSchema>;

/** Config edits never reset on a rename (S28 pattern) — every field optional. */
export const updateOutreachSequenceInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    goal: z.string().max(500).optional(),
    personaId: z.string().uuid().optional(),
    campaignId: z.string().uuid().optional(),
    audienceId: z.string().uuid().optional(),
    automationMode: z.enum(AUTOMATION_MODES).optional(),
    dailyEnrollmentCap: z.number().int().min(1).max(OUTREACH_MAX_ENROLLMENT_CAP).optional(),
    stopOnReply: z.boolean().optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
  })
  .strict();
export type UpdateOutreachSequenceInput = z.infer<typeof updateOutreachSequenceInputSchema>;

export const outreachSequenceStepInputSchema = z.object({
  stepNumber: z.number().int().min(1),
  instruction: z.string().max(1000),
  delayHours: z.number().int().min(0).max(8760),
});

/** Steps 1..N contiguous, unique, ≤10, and step 1 has no delay. */
export const setOutreachStepsInputSchema = z
  .object({ steps: z.array(outreachSequenceStepInputSchema).min(1).max(OUTREACH_MAX_STEPS) })
  .superRefine((value, ctx) => {
    const numbers = value.steps.map((s) => s.stepNumber).sort((a, b) => a - b);
    numbers.forEach((n, i) => {
      if (n !== i + 1) {
        ctx.addIssue({ code: "custom", message: "step numbers must be contiguous 1..N" });
      }
    });
    const first = value.steps.find((s) => s.stepNumber === 1);
    if (first && first.delayHours !== 0) {
      ctx.addIssue({ code: "custom", message: "step 1 must have delayHours 0" });
    }
  });
export type SetOutreachStepsInput = z.infer<typeof setOutreachStepsInputSchema>;

/** The mailbox pool a sequence rotates across (≥1; "pool, start with one"). */
export const setOutreachMailboxesInputSchema = z.object({
  mailboxIds: z.array(z.string().uuid()).min(1),
});
export type SetOutreachMailboxesInput = z.infer<typeof setOutreachMailboxesInputSchema>;

export const outreachEnrollmentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sequenceId: z.string().uuid(),
  recipientType: z.enum(AUDIENCE_MEMBER_TYPES),
  recipientId: z.string(),
  recipientEmail: z.string(),
  mailboxId: z.string().uuid().nullable(),
  lastThreadId: z.string().nullable(),
  currentStep: z.number().int(),
  status: z.enum(OUTREACH_ENROLLMENT_STATUSES),
  nextDueAt: z.number().int().nullable(),
  lastSentAt: z.number().int().nullable(),
  stoppedReason: z.string().nullable(),
  // Manual funnel outcome (Sprint 50).
  outcome: z.enum(OUTREACH_ENROLLMENT_OUTCOMES),
  enrolledAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type OutreachEnrollment = z.infer<typeof outreachEnrollmentSchema>;

/** Manual stop: at least one selector required. */
export const stopOutreachInputSchema = z
  .object({
    enrollmentIds: z.array(z.string().uuid()).optional(),
    emails: z.array(z.string()).optional(),
    all: z.boolean().optional(),
    reason: z.enum(["manual", "replied"]).default("manual"),
  })
  .refine(
    (v) => (v.enrollmentIds?.length ?? 0) > 0 || (v.emails?.length ?? 0) > 0 || v.all === true,
    { message: "provide enrollmentIds, emails, or all" },
  );
export type StopOutreachInput = z.infer<typeof stopOutreachInputSchema>;

export const outreachSequenceDetailSchema = outreachSequenceSchema.extend({
  steps: z.array(outreachSequenceStepSchema),
  mailboxIds: z.array(z.string().uuid()),
  enrollments: z.array(outreachEnrollmentSchema),
});
export type OutreachSequenceDetail = z.infer<typeof outreachSequenceDetailSchema>;

export const outreachRunResultSchema = z.object({
  enrolled: z.number().int(),
  generated: z.number().int(),
  dispatched: z.number().int(),
  stopped: z.number().int(),
  completed: z.number().int(),
  ranAt: z.number().int(),
});
export type OutreachRunResult = z.infer<typeof outreachRunResultSchema>;

// ---------------------------------------------------------------------------
// Reply-driven actions + compliance (Sprint 49)
// ---------------------------------------------------------------------------

/** Default pause before retrying a recipient who sent an out-of-office autoreply. */
export const OUTREACH_OOO_RETRY_HOURS = 72;

/** A workspace's CAN-SPAM postal address — required before outreach can send. */
export const workspaceComplianceSchema = z.object({
  workspaceId: z.string().uuid(),
  postalAddress: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkspaceCompliance = z.infer<typeof workspaceComplianceSchema>;

export const updateComplianceInputSchema = z
  .object({ postalAddress: z.string().max(500) })
  .strict();
export type UpdateComplianceInput = z.infer<typeof updateComplianceInputSchema>;

/** Paste a batch of emails to block up front (suppression-list import). */
export const importSuppressionsInputSchema = z.object({
  emails: z.array(z.string()).min(1).max(1000),
});
export type ImportSuppressionsInput = z.infer<typeof importSuppressionsInputSchema>;

export const importSuppressionsResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
});
export type ImportSuppressionsResult = z.infer<typeof importSuppressionsResultSchema>;

// ---------------------------------------------------------------------------
// Outreach tracking, funnel & attribution (Sprint 50)
// ---------------------------------------------------------------------------

export const setEnrollmentOutcomeInputSchema = z.object({
  outcome: z.enum(OUTREACH_ENROLLMENT_OUTCOMES),
});
export type SetEnrollmentOutcomeInput = z.infer<typeof setEnrollmentOutcomeInputSchema>;

/** The counters at any funnel node (whole sequence or an attribution slice). */
export const funnelCountsSchema = z.object({
  sent: z.number().int(),
  // Opens are a SOFT signal — Apple Mail Privacy Protection inflates them.
  opened: z.number().int(),
  clicked: z.number().int(),
  replied: z.number().int(),
  positive: z.number().int(),
  meetings: z.number().int(),
  won: z.number().int(),
  lost: z.number().int(),
});
export type FunnelCounts = z.infer<typeof funnelCountsSchema>;

/** One attribution row: a label (step / persona / segment) + its counts. */
export const funnelSliceSchema = funnelCountsSchema.extend({
  key: z.string(),
  label: z.string(),
});
export type FunnelSlice = z.infer<typeof funnelSliceSchema>;

export const outreachFunnelSchema = funnelCountsSchema.extend({
  sequenceId: z.string().uuid(),
  openRate: z.number(),
  clickRate: z.number(),
  replyRate: z.number(),
  positiveRate: z.number(),
  attribution: z.object({
    byStep: z.array(funnelSliceSchema),
    byPersona: z.array(funnelSliceSchema),
    bySegment: z.array(funnelSliceSchema),
  }),
});
export type OutreachFunnel = z.infer<typeof outreachFunnelSchema>;

/** Compact outreach rollup folded into a campaign's insights (Sprint 34 + 50). */
export const campaignOutreachInsightsSchema = funnelCountsSchema.extend({
  sequenceCount: z.number().int(),
  replyRate: z.number(),
  positiveRate: z.number(),
});
export type CampaignOutreachInsights = z.infer<typeof campaignOutreachInsightsSchema>;

// ---------------------------------------------------------------------------
// Unified metric model (Sprint 55) — one fact table for every observed number.
//
// Three legacy stores measured time three different ways: a manual reading at
// an instant, a cumulative snapshot at 24h/7d of age, and a per-day bucket.
// These vocabularies make the differences explicit instead of implied, and the
// classifier below is the load-bearing guard: cumulative and periodic values
// must never be summed together. (`insights` violates that rule today —
// spec §2.3 — and carries the one commented escape hatch while it migrates.)
// ---------------------------------------------------------------------------

/**
 * Every metric key, defined once. No `replies`: it is derivable from
 * `inboxItems` at any moment, so storing it as a fact would create a snapshot
 * that silently goes stale — two answers to one question.
 */
export const METRIC_KEYS = [
  "impressions",
  "clicks",
  "likes",
  "comments",
  "shares",
  "engagements",
  "conversions",
  "spend",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * point = a reading at capturedAt, covering no defined period (manual entry).
 * 24h/7d = CUMULATIVE since the subject went live, observed at >= that age.
 * 1d = that calendar day's total, periodStart = the day.
 */
export const METRIC_WINDOWS = ["point", "24h", "7d", "1d"] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

/** No lane/sequence — nothing writes them. Subject-less manual rows are channel-level readings. */
export const METRIC_SUBJECT_TYPES = ["publication", "campaign", "ad_campaign", "channel"] as const;
export type MetricSubjectType = (typeof METRIC_SUBJECT_TYPES)[number];

/** No `derived` — nothing derives in Sprint 55. `imported` covers the ads CSV path. */
export const METRIC_SOURCES = ["manual", "captured", "synced", "imported"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export type MetricWindowKindValue = "cumulative" | "periodic" | "point";

/**
 * Classify a window so a reader cannot mix incompatible time semantics by
 * accident. Throws on unknown input rather than guessing — a wrong
 * classification here silently corrupts every aggregate built on it.
 */
export function metricWindowKind(window: MetricWindow): MetricWindowKindValue {
  switch (window) {
    case "24h":
    case "7d":
      return "cumulative";
    case "1d":
      return "periodic";
    case "point":
      return "point";
    default: {
      const exhaustive: never = window;
      throw new Error(`Unknown metric window: ${String(exhaustive)}`);
    }
  }
}

/** One observed number. `value` is an integer; money is cents, never floats. */
export const metricSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectType: z.enum(METRIC_SUBJECT_TYPES),
  subjectId: z.string().min(1),
  metricKey: z.enum(METRIC_KEYS),
  value: z.number().int(),
  window: z.enum(METRIC_WINDOWS),
  periodStart: z.number().int(),
  source: z.enum(METRIC_SOURCES),
  capturedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type Metric = z.infer<typeof metricSchema>;

// ---------------------------------------------------------------------------
// Agent runtime (Sprint 56 — Gateway v2 & AgentRunner)
//
// Vocabulary for bounded, tool-using, fully-traced agent loops. The gateway
// makes single model calls; the AgentRunner (apps/api/src/agents) drives the
// loop and persists every step. These schemas validate persisted transcripts
// and become the Agent Inspector API contract in Sprint 57.
// ---------------------------------------------------------------------------

/** Why an agent run stopped. Every finished run records exactly one. */
export const AGENT_STOP_REASONS = [
  "complete",
  "max_steps",
  "max_tokens",
  "timeout",
  "needs_human",
  "error",
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

/** Run lifecycle: `stop_reason` is set iff the run is done. */
export const AGENT_RUN_STATUSES = ["running", "done"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Transcript roles. The system prompt is NOT a message — it travels as a
 * separate stable prefix so providers can cache it (Sprint 59). */
export const AGENT_MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

/** Persisted step kinds: one model invocation, or one tool dispatch. */
export const AGENT_STEP_KINDS = ["model_call", "tool_call"] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

/** A tool invocation requested by the model. Ids are minted by the gateway
 * (providers like Gemini do not supply them) and are unique within a run. */
export const agentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Parsed JSON arguments as the model produced them — validated by the
   * tool's own input schema at dispatch time, not here. */
  arguments: z.unknown(),
});
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** One transcript message. Assistant messages may carry tool calls; tool
 * messages carry the result of exactly one call (linked by toolCallId). */
export const agentMessageSchema = z.object({
  role: z.enum(AGENT_MESSAGE_ROLES),
  content: z.string(),
  toolCalls: z.array(agentToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

/** Token + cost accounting, recorded per model-call step and totalled per
 * run. costCents is telemetry-grade (REAL); Sprint 59 hardens it into
 * entitlements. */
export const agentUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  costCents: z.number().min(0),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

// ---------------------------------------------------------------------------
// Internal tool registry (Sprint 57)
//
// The registry (apps/api/src/agents/registry.ts) exposes platform
// capabilities as model-callable tools. Three access tiers: `read` tools
// are unrestricted inside the workspace (the same membership rule that
// scopes HTTP routes); `propose` tools never execute — they mint a gated
// item and return its id (Sprint 69 shipped the five of them); `ask` tools
// write nothing at all — they record a question and stop the run until a
// human answers it (Sprint 70). There is deliberately no "execute" tier.
// ---------------------------------------------------------------------------

export const TOOL_ACCESS_LEVELS = ["read", "propose", "ask"] as const;
export type ToolAccessLevel = (typeof TOOL_ACCESS_LEVELS)[number];

/** The Sprint 57 read-tool surface: unrestricted inside the workspace. */
export const READ_TOOL_NAMES = [
  "search_evidence",
  "get_brain_section",
  "get_campaign_plan",
  "list_recent_publications_with_metrics",
  "find_similar_approved_drafts",
  "find_instructive_rejections",
  "get_persona",
  "list_channel_guardrails",
  "search_discovery_items",
  "get_prior_posts_on_topic",
  "safe_fetch_url",
  // Sprint 76 — the analytics and inventory reads a strategy conversation
  // needs. They join the shared registry rather than a chat-only list (D-76.2):
  // a metric read is as useful to a critic or a pipeline step as it is to chat.
  "list_campaigns",
  "list_personas",
  "get_campaign_insights",
  "get_workspace_insights",
  "get_metric_summary",
  "get_sequence_funnel",
] as const;

/**
 * The Sprint 69 propose surface. Each hands its intent to a gate that already
 * governs that write: four mint a `proposed` external action and let the policy
 * tree decide, and `propose_draft` submits to the approval gate, because a
 * draft is the subject of an external action rather than one itself (D-69.2).
 */
export const PROPOSE_TOOL_NAMES = [
  "propose_draft",
  "propose_publication",
  "propose_reply",
  "propose_sequence_step",
  "propose_ad_mutation",
] as const;

/**
 * The Sprint 70 ask surface. The only tool that produces no artefact at all: it
 * records a question, suspends the run, and waits. One tool, because "ask the
 * founder something" is one capability — the *type* of question is an argument,
 * not a separate tool the model has to choose between.
 */
export const ASK_TOOL_NAMES = ["ask_founder"] as const;

/** The whole registry. Tests assert registry and contracts stay in lockstep. */
export const AGENT_TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  ...PROPOSE_TOOL_NAMES,
  ...ASK_TOOL_NAMES,
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type ProposeToolName = (typeof PROPOSE_TOOL_NAMES)[number];
export type AskToolName = (typeof ASK_TOOL_NAMES)[number];

export function isProposeToolName(name: string): name is ProposeToolName {
  return (PROPOSE_TOOL_NAMES as readonly string[]).includes(name);
}

export function isAskToolName(name: string): name is AskToolName {
  return (ASK_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Proposal caps (Sprint 69, D-69.8). The per-run one is shared across all five
 * tools — a per-tool cap would let one run make three publications *and* three
 * ad mutations, which is not what "three proposals" means to a founder. The
 * daily one is per workspace across every run.
 */
export const AGENT_PROPOSALS_PER_RUN = 3;
export const AGENT_PROPOSALS_PER_DAY = 20;
export const PROPOSAL_RATIONALE_MAX_CHARS = 500;

/**
 * What an agent can be stuck on (Sprint 70). Four kinds, because they are
 * answered differently and mean different things about the workspace:
 * `disambiguation` — several readings of the same instruction;
 * `missing_permission` — the plan does not say whether this is allowed;
 * `missing_fact` — the platform does not hold something it needs;
 * `policy_escalation` — it would be acting outside what it was configured for.
 */
export const AGENT_QUESTION_TYPES = [
  "disambiguation",
  "missing_permission",
  "missing_fact",
  "policy_escalation",
] as const;
export type AgentQuestionType = (typeof AGENT_QUESTION_TYPES)[number];

export const AGENT_QUESTION_STATUSES = ["open", "answered", "dismissed"] as const;
export type AgentQuestionStatus = (typeof AGENT_QUESTION_STATUSES)[number];

/**
 * Question caps (D-70.4, D-70.6). The per-run one is counted over the *pipeline*
 * run, so it survives the resumes that asking causes — an agent-run-scoped cap
 * would reset every time a question suspended the run, and bound nothing. The
 * open cap is per workspace: the ask lane's value is that a question there is
 * worth reading, and twenty of them is a queue.
 */
export const AGENT_QUESTIONS_PER_RUN = 2;
export const AGENT_QUESTIONS_OPEN_MAX = 10;
export const QUESTION_TEXT_MAX_CHARS = 300;
export const QUESTION_WHY_MAX_CHARS = 500;
export const QUESTION_ANSWER_MAX_CHARS = 1_000;

/** Content profiles `safe_fetch_url` accepts — mirrors the Sprint 48
 * safe-fetch policy's MIME allowlists (apps/api/src/safe-fetch/policy.ts,
 * which predates this vocabulary; the tool asserts the two stay equal). */
export const SAFE_FETCH_PROFILES = ["feed", "json", "website"] as const;

/**
 * Per-tool input schemas — the single definition each registry tool
 * validates against and derives its model-facing JSON Schema from.
 * Cross-field rules (e.g. get_brain_section needing sectionId OR query)
 * are enforced in the tool's run() and returned to the model as
 * instructive error data, keeping these schemas plain objects the
 * JSON-Schema deriver can walk.
 */
export const toolInputSchemas = {
  search_evidence: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  get_brain_section: z.object({
    docType: z.enum(BRAIN_DOC_TYPES).optional(),
    sectionId: z.string().min(1).optional(),
    query: z.string().min(1).max(500).optional(),
  }),
  get_campaign_plan: z.object({
    campaignId: z.string().min(1),
  }),
  list_recent_publications_with_metrics: z.object({
    limit: z.number().int().min(1).max(10).optional(),
    channel: z.enum(CHANNELS).optional(),
    campaignId: z.string().min(1).optional(),
  }),
  find_similar_approved_drafts: z.object({
    query: z.string().min(1).max(500),
    taskType: z.enum(TASK_TYPES).optional(),
    channel: z.enum(CHANNELS).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  }),
  find_instructive_rejections: z.object({
    query: z.string().min(1).max(500).optional(),
    taskType: z.enum(TASK_TYPES).optional(),
    channel: z.enum(CHANNELS).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  }),
  get_persona: z.object({
    personaId: z.string().min(1),
  }),
  list_channel_guardrails: z.object({
    channel: z.enum(CHANNELS).optional(),
  }),
  search_discovery_items: z.object({
    query: z.string().min(1).max(500).optional(),
    status: z.enum(DISCOVERED_ITEM_STATUSES).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  get_prior_posts_on_topic: z.object({
    topic: z.string().min(1).max(500),
    channel: z.enum(CHANNELS).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  }),
  safe_fetch_url: z.object({
    url: z.string().url(),
    profile: z.enum(SAFE_FETCH_PROFILES).optional(),
  }),

  // -------------------------------------------------------------------------
  // Analytics & inventory reads (Sprint 76). The first two are how a model
  // turns "the launch campaign" into an id it can pass to anything else; the
  // rest answer performance questions from the Sprint 55 metric model.
  // -------------------------------------------------------------------------
  list_campaigns: z.object({
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  list_personas: z.object({
    limit: z.number().int().min(1).max(50).optional(),
  }),
  get_campaign_insights: z.object({
    campaignId: z.string().min(1),
  }),
  get_workspace_insights: z.object({}),
  /**
   * A windowed rollup over the metric fact table. `window` is required, not
   * defaulted: the Sprint 55 classifier forbids mixing cumulative and periodic
   * semantics in one number, so the caller must say which question it is
   * asking rather than have one picked for it.
   */
  get_metric_summary: z.object({
    subjectType: z.enum(METRIC_SUBJECT_TYPES),
    subjectId: z.string().min(1).optional(),
    metricKeys: z.array(z.enum(METRIC_KEYS)).min(1).max(8).optional(),
    window: z.enum(METRIC_WINDOWS),
    sinceDays: z.number().int().min(1).max(365).optional(),
  }),
  get_sequence_funnel: z.object({
    sequenceId: z.string().min(1),
  }),

  // -------------------------------------------------------------------------
  // Propose tools (Sprint 69). Every one takes a `rationale`: it is written to
  // the proposal ledger and is what the authorization queue shows a founder who
  // asks why the agent wanted this. Routing (connection, target, recipient) is
  // resolved by the platform rather than asked of the model (D-69.9).
  // -------------------------------------------------------------------------
  propose_draft: z.object({
    content: z.string().min(1).max(20_000),
    channel: z.enum(CHANNELS),
    taskType: z.enum(TASK_TYPES).optional(),
    campaignId: z.string().min(1).optional(),
    personaId: z.string().min(1).optional(),
    rationale: z.string().min(1).max(PROPOSAL_RATIONALE_MAX_CHARS),
  }),
  propose_publication: z.object({
    draftId: z.string().min(1),
    /** Epoch ms; omit to publish as soon as the gate clears. */
    scheduledFor: z.number().int().positive().optional(),
    /** Channel-specific destination (e.g. a subreddit). Defaults to the last
     * destination this workspace successfully published to on this account. */
    target: z.string().trim().min(1).max(300).optional(),
    connectionId: z.string().min(1).optional(),
    rationale: z.string().min(1).max(PROPOSAL_RATIONALE_MAX_CHARS),
  }),
  propose_reply: z.object({
    inboxItemId: z.string().min(1),
    rationale: z.string().min(1).max(PROPOSAL_RATIONALE_MAX_CHARS),
  }),
  propose_sequence_step: z.object({
    launchMessageId: z.string().min(1),
    rationale: z.string().min(1).max(PROPOSAL_RATIONALE_MAX_CHARS),
  }),
  propose_ad_mutation: z.object({
    launchId: z.string().min(1),
    /** Exactly one of a budget change or a targeting change per call. A
     * targeting change needs all three fields: the ads API replaces the whole
     * targeting spec, so a partial change would silently reset the rest. */
    dailyBudgetCents: z.number().int().positive().optional(),
    countries: z.array(z.string().trim().min(2).max(2)).min(1).max(25).optional(),
    ageMin: z.number().int().min(18).max(65).optional(),
    ageMax: z.number().int().min(18).max(65).optional(),
    rationale: z.string().min(1).max(PROPOSAL_RATIONALE_MAX_CHARS),
  }),

  // -------------------------------------------------------------------------
  // Ask tool (Sprint 70). `why` is not decoration: a question without the
  // reason it is being asked is unanswerable in one click, which is the only
  // form of asking worth building. `options` are advisory (D-70.12) — they
  // become one-click answers, and the free-text answer always remains open.
  // -------------------------------------------------------------------------
  ask_founder: z.object({
    type: z.enum(AGENT_QUESTION_TYPES),
    question: z.string().trim().min(1).max(QUESTION_TEXT_MAX_CHARS),
    why: z.string().trim().min(1).max(QUESTION_WHY_MAX_CHARS),
    options: z.array(z.string().trim().min(1).max(80)).min(2).max(4).optional(),
  }),
} as const satisfies Record<AgentToolName, z.ZodType<Record<string, unknown>>>;

// ---------------------------------------------------------------------------
// Chat (Sprint 42 → rebuilt in Sprint 76, "chat foundations")
//
// A thread is a GTM strategy conversation scoped to a workspace and optionally
// a campaign / persona / channel. Its system prefix is a resolved context
// bundle from packages/brain — the same resolver generation uses — not a
// hand-written preamble, which is the difference between this and a generic
// assistant pointed at an export.
//
// Every assistant turn is an `agent_run` driven by the AgentRunner over the
// Sprint 57 registry, so the Agent Inspector works for chat with no new
// tracing code. Sprint 76 offers `read` tools only: chat cannot change
// anything, and the boundary is the registry's `access` field, not an
// instruction in the prompt. The write half arrives in Sprint 78.
// ---------------------------------------------------------------------------

/**
 * Transcript roles. `compaction` (Sprint 76) is a summary of older turns that
 * replaced them in the model's message list — persisted as a visible message
 * so a folded conversation never silently disappears.
 */
export const CHAT_MESSAGE_ROLES = ["user", "assistant", "tool", "compaction"] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

/**
 * Hard per-thread lifetime token cap (Sprint 76, D-76.4). Enforced in chat
 * rather than deferred to the Sprint 59 workspace budget: this is the runaway
 * backstop for a single conversation, not the economic control.
 */
export const CHAT_THREAD_TOKEN_CAP = 250_000;

/** Per-turn AgentRunner bounds for a chat turn. */
export const CHAT_TURN_BOUNDS = {
  maxSteps: 8,
  maxTokens: 32_000,
  timeoutMs: 120_000,
} as const;

/**
 * Compaction fires when the estimated transcript exceeds this fraction of the
 * per-turn token bound, and keeps this many newest messages verbatim.
 */
export const CHAT_COMPACTION_THRESHOLD = 0.6;
export const CHAT_COMPACTION_KEEP_RECENT = 6;

/** Bound on a thread's goal — one or two sentences of intent, not a brief. */
export const CHAT_GOAL_MAX_CHARS = 500;

/** Where a grounded answer's claim came from — surfaced as an inspectable chip. */
export const CHAT_CITATION_KINDS = ["brain", "evidence", "data"] as const;
export type ChatCitationKind = (typeof CHAT_CITATION_KINDS)[number];

export const chatCitationSchema = z.object({
  kind: z.enum(CHAT_CITATION_KINDS),
  /** Stable anchor: a brain section slug, an evidence document id, or a tool name. */
  ref: z.string(),
  label: z.string(),
  detail: z.string().optional(),
});
export type ChatCitation = z.infer<typeof chatCitationSchema>;

/**
 * A thread. `campaignId` / `personaId` / `channel` are its **scope binding**:
 * they select the context bundle the conversation runs against, exactly as a
 * generation request would. `goal` is the standing intent (Sprint 76 D-76.12) —
 * derived once from the opening message and thereafter user-editable, never
 * rewritten by the model.
 */
export const chatSessionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  title: z.string(),
  goal: z.string(),
  campaignId: z.string().uuid().nullable(),
  personaId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  /** Lifetime totals, for the in-thread cost display and the token cap. */
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalCostCents: z.number(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  role: z.enum(CHAT_MESSAGE_ROLES),
  content: z.string(),
  toolName: z.string().nullable(),
  citations: z.array(chatCitationSchema),
  /** The agent_run behind this assistant turn — the Agent Inspector link. */
  agentRunId: z.string().uuid().nullable(),
  /** Per-turn metering, shown inline. */
  costCents: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Why the turn's run stopped; a turn that hit a bound says so in the UI. */
  stopReason: z.enum(AGENT_STOP_REASONS).nullable(),
  /**
   * What a write turn created. Unwritten in Sprint 76 (chat is read-only) —
   * Sprint 78 repopulates it, which is why the field and its column survive.
   */
  producedRef: z.string().nullable().optional(),
  createdAt: z.number().int(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Thread scope, shared by create and patch. */
const chatScopeFields = {
  campaignId: z.string().uuid().nullable().optional(),
  personaId: z.string().uuid().nullable().optional(),
  channel: z.enum(CHANNELS).nullable().optional(),
  goal: z.string().max(CHAT_GOAL_MAX_CHARS).optional(),
};

export const createChatSessionInputSchema = z.object({
  title: z.string().max(200).optional(),
  ...chatScopeFields,
});
export type CreateChatSessionInput = z.infer<typeof createChatSessionInputSchema>;

export const updateChatSessionInputSchema = z.object({
  title: z.string().max(200).optional(),
  ...chatScopeFields,
});
export type UpdateChatSessionInput = z.infer<typeof updateChatSessionInputSchema>;

export const sendChatMessageInputSchema = z.object({
  message: z.string().min(1).max(4000),
});
export type SendChatMessageInput = z.infer<typeof sendChatMessageInputSchema>;

/** The outcome of one turn: the grounded answer, its provenance and its cost. */
export const chatTurnResultSchema = z.object({
  answer: z.string(),
  citations: z.array(chatCitationSchema),
  toolCalls: z.array(z.object({ tool: z.string(), ok: z.boolean() })),
  /** The persisted assistant message, so a client needs no refetch. */
  message: chatMessageSchema,
  agentRunId: z.string().uuid().nullable(),
  stopReason: z.enum(AGENT_STOP_REASONS),
  costCents: z.number(),
  /** Thread lifetime after this turn — what the cap is measured against. */
  threadTokens: z.number().int(),
  threadCostCents: z.number(),
});
export type ChatTurnResult = z.infer<typeof chatTurnResultSchema>;

export const chatSessionDetailSchema = chatSessionSchema.extend({
  messages: z.array(chatMessageSchema),
});
export type ChatSessionDetail = z.infer<typeof chatSessionDetailSchema>;

/**
 * SSE frames streamed by POST .../messages (Sprint 76). The five middle kinds
 * mirror AgentRunEvent so the client renders the runner's own step boundaries;
 * `tool_call_end` deliberately drops the tool's result payload — results are
 * large and the citation mapper already extracts what the client needs.
 */
export const CHAT_STREAM_EVENTS = [
  "session",
  "compaction",
  "step_start",
  "text_delta",
  "tool_call_start",
  "tool_call_end",
  "step_end",
  "message",
  "done",
  "error",
] as const;
export type ChatStreamEventKind = (typeof CHAT_STREAM_EVENTS)[number];

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string(), userMessageId: z.string() }),
  z.object({
    type: z.literal("compaction"),
    messageId: z.string(),
    summarizedThrough: z.string(),
    agentRunId: z.string().nullable(),
  }),
  z.object({ type: z.literal("step_start"), stepIndex: z.number().int() }),
  z.object({ type: z.literal("text_delta"), stepIndex: z.number().int(), text: z.string() }),
  z.object({
    type: z.literal("tool_call_start"),
    stepIndex: z.number().int(),
    callId: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_end"),
    stepIndex: z.number().int(),
    callId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("step_end"),
    stepIndex: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  }),
  z.object({ type: z.literal("message"), message: chatMessageSchema }),
  z.object({
    type: z.literal("done"),
    stopReason: z.enum(AGENT_STOP_REASONS),
    costCents: z.number(),
    threadTokens: z.number().int(),
    threadCostCents: z.number(),
  }),
  z.object({ type: z.literal("error"), error: z.string(), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

// ---------------------------------------------------------------------------
// Agent proposals (Sprint 69)
//
// One durable row per successful propose-tool call. It answers two questions a
// column on `external_actions` cannot: "what did this run propose" (across
// kinds, including drafts, which are not external actions) and "how many
// proposals has this workspace made today" — the daily cap's only honest
// source (D-69.4).
// ---------------------------------------------------------------------------

export const AGENT_PROPOSAL_TARGET_KINDS = ["draft", "external_action"] as const;
export type AgentProposalTargetKind = (typeof AGENT_PROPOSAL_TARGET_KINDS)[number];

export const agentProposalSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    agentRunId: z.string().uuid(),
    tool: z.enum(PROPOSE_TOOL_NAMES),
    targetKind: z.enum(AGENT_PROPOSAL_TARGET_KINDS),
    /** Null once the thing proposed has been deleted; the record of the
     * proposal survives it. */
    draftId: z.string().uuid().nullable(),
    externalActionId: z.string().uuid().nullable(),
    summary: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    createdAt: z.number().int(),
  })
  .superRefine((value, ctx) => {
    if (value.targetKind === "draft" && value.externalActionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalActionId"],
        message: "A draft proposal does not point at an external action.",
      });
    }
    if (value.targetKind === "external_action" && value.draftId && !value.externalActionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalActionId"],
        message: "An external-action proposal must name its action.",
      });
    }
  });
export type AgentProposal = z.infer<typeof agentProposalSchema>;

// ---------------------------------------------------------------------------
// Agent questions — the ask lane (Sprint 70)
//
// A question is durable state, not a message (D-70.2): the run that asked it is
// gone from memory long before the answer arrives, and the row is the only
// thing that survives to reconnect the two. It carries what it blocks
// (`pipelineRunId` + `stepKey`) and what it needs, so the queue and the run
// point at each other without reading a transcript.
//
// The answer input lives further down — it re-uses the preference vocabulary,
// which is declared after this.
// ---------------------------------------------------------------------------

export const agentQuestionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    agentRunId: z.string().uuid(),
    /** Null when nothing is suspended — a one-shot run has no resume point. */
    pipelineRunId: z.string().uuid().nullable(),
    stepKey: z.string().nullable(),
    type: z.enum(AGENT_QUESTION_TYPES),
    question: z.string().trim().min(1).max(QUESTION_TEXT_MAX_CHARS),
    why: z.string().trim().min(1).max(QUESTION_WHY_MAX_CHARS),
    options: z.array(z.string()).max(4),
    status: z.enum(AGENT_QUESTION_STATUSES),
    answer: z.string().nullable(),
    answeredByUserId: z.string().uuid().nullable(),
    answeredByLabel: z.string().nullable(),
    answeredAt: z.number().int().nullable(),
    /** The preference rule this answer minted, if the founder kept it. */
    ruleId: z.string().uuid().nullable(),
    createdAt: z.number().int(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "answered" && (value.answer === null || value.answer.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "An answered question carries the answer.",
      });
    }
    if (value.status === "open" && value.answeredAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answeredAt"],
        message: "An open question has not been answered.",
      });
    }
  });
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

// ---------------------------------------------------------------------------
// The agent inbox (Sprint 70) — one ranked feed, three lanes.
//
// Closes atlas conflict #7. `priorities` and `next-action` both answered "what
// should you look at", read the same tables, and could disagree in front of the
// founder. There is now one ranker (apps/api/src/services/agent-inbox.ts) and
// both of those endpoints are projections of it (D-70.8, D-70.9).
//
// The lanes come from the ambient-agent triad: `notify` — something happened
// you should know; `ask` — the agent is stopped and only you can start it;
// `review` — something is waiting on your judgment.
// ---------------------------------------------------------------------------

export const AGENT_INBOX_LANES = ["notify", "ask", "review"] as const;
export type AgentInboxLane = (typeof AGENT_INBOX_LANES)[number];

/** The nine priority kinds plus the two the merge brings in. */
export const AGENT_INBOX_ITEM_KINDS = [
  ...PRIORITY_ITEM_KINDS,
  /** An open agent question (the ask lane's only kind). */
  "agent_question",
  /** An unmet setup checklist item, folded in from the next-action engine. */
  "setup_task",
] as const;
export type AgentInboxItemKind = (typeof AGENT_INBOX_ITEM_KINDS)[number];

const AGENT_INBOX_LANE_BY_KIND: Record<AgentInboxItemKind, AgentInboxLane> = {
  // Waiting on the founder's judgment.
  agent_question: "ask",
  authorization: "review",
  content_review: "review",
  signal_triage: "review",
  learning_review: "review",
  // Statements of fact about the system: true whether or not anyone decides.
  execution_failure: "notify",
  policy_block: "notify",
  stale_action: "notify",
  connection_health: "notify",
  campaign_risk: "notify",
  setup_task: "notify",
};

/** Total over the kinds, so the API and the UI can never lane an item differently. */
export function agentInboxLaneFor(kind: AgentInboxItemKind): AgentInboxLane {
  return AGENT_INBOX_LANE_BY_KIND[kind];
}

export const agentInboxItemSchema = z.object({
  id: z.string().min(1),
  lane: z.enum(AGENT_INBOX_LANES),
  kind: z.enum(AGENT_INBOX_ITEM_KINDS),
  status: workflowStatusSchema,
  title: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  href: z.string().startsWith("/"),
  campaignId: z.string().uuid().nullable(),
  campaignName: z.string().nullable(),
  dueAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  /** Carried on ask-lane items so the answer form needs no second fetch. */
  question: agentQuestionSchema.nullable(),
});
export type AgentInboxItem = z.infer<typeof agentInboxItemSchema>;

export const agentInboxFeedSchema = z.object({
  items: z.array(agentInboxItemSchema),
  counts: z.object({
    notify: z.number().int().min(0),
    ask: z.number().int().min(0),
    review: z.number().int().min(0),
  }),
  /** Activation state, unchanged — displayed, never ranked against the feed. */
  checklist: z.object({
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    complete: z.boolean(),
  }),
  generatedAt: z.number().int(),
});
export type AgentInboxFeed = z.infer<typeof agentInboxFeedSchema>;

// ---------------------------------------------------------------------------
// Agent Inspector API (Sprint 57)
//
// Wire contract for /workspaces/:id/agent-runs — a straight read of the
// Sprint 56 agent_runs / agent_run_steps rows with JSON columns parsed
// server-side. Timestamps are epoch ms integers, per API convention.
// ---------------------------------------------------------------------------

export const agentRunSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  task: z.string(),
  createdBy: z.string(),
  status: z.enum(AGENT_RUN_STATUSES),
  stopReason: z.enum(AGENT_STOP_REASONS).nullable(),
  error: z.string().nullable(),
  model: z.string(),
  provider: z.string(),
  usage: agentUsageSchema,
  stepCount: z.number().int().min(0),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;

export const agentRunStepSchema = z.object({
  id: z.string().min(1),
  stepIndex: z.number().int().min(0),
  kind: z.enum(AGENT_STEP_KINDS),
  /** model_call: the assistant message (text and/or tool calls). */
  message: agentMessageSchema.nullable(),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  toolArgs: z.unknown(),
  toolResult: z.unknown(),
  toolError: z.string().nullable(),
  usage: agentUsageSchema,
  durationMs: z.number().int().min(0),
  createdAt: z.number().int(),
});
export type AgentRunStep = z.infer<typeof agentRunStepSchema>;

export const agentRunDetailSchema = agentRunSummarySchema.extend({
  system: z.string(),
  inputMessages: z.array(agentMessageSchema),
  output: z.unknown(),
  steps: z.array(agentRunStepSchema),
  /** What this run actually proposed (Sprint 69) — the durable ledger, not a
   * re-read of the transcript, so a deleted draft still leaves its proposal. */
  proposals: z.array(agentProposalSchema),
  /** What this run asked (Sprint 70), with the answers it got. A run that
   * stopped at `needs_human` is unreadable without the question that stopped it. */
  questions: z.array(agentQuestionSchema),
});
export type AgentRunDetail = z.infer<typeof agentRunDetailSchema>;

/** Trigger a proof run over the read-tool registry (Inspector ignition). */
export const proofAgentRunInputSchema = z.object({
  question: z.string().min(1).max(2000),
});
export type ProofAgentRunInput = z.infer<typeof proofAgentRunInputSchema>;

// ---------------------------------------------------------------------------
// Pipeline definitions as data + execution engine (Sprint 64, direction
// doc Move 3)
//
// A content pipeline is an explicit, versioned record — an ordered list of
// bounded agent steps — instead of control flow in automation.ts. The engine
// is deterministic between steps and agentic within a step: it owns
// sequencing, retries, budgets, idempotency, escalation, and the approval-
// gate handoff; the agent owns judgment inside one AgentRunner turn with a
// tool allowlist, step cap, token cap, and a required output schema.
// Definitions are scoped workspace → campaign → lane (most specific active
// definition wins) and versioned like brain docs (D-64.1/D-64.2).
// ---------------------------------------------------------------------------

/** What a pipeline produces. v1 ships the reference signal → social post. */
export const PIPELINE_TASK_KEYS = ["signal_social_post"] as const;
export type PipelineTaskKey = (typeof PIPELINE_TASK_KEYS)[number];

export const PIPELINE_DEFINITION_STATUSES = [
  "draft",
  "active",
  "archived",
] as const;
export type PipelineDefinitionStatus =
  (typeof PIPELINE_DEFINITION_STATUSES)[number];

/**
 * Run lifecycle. `escalated` is the paused ask-the-founder state (D-64.8);
 * resume re-enters `running`. Terminal: succeeded / failed / cancelled.
 */
export const PIPELINE_RUN_STATUSES = [
  "queued",
  "running",
  "escalated",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

export const PIPELINE_RUN_TRANSITIONS: Record<
  PipelineRunStatus,
  readonly PipelineRunStatus[]
> = {
  queued: ["running", "cancelled"],
  running: ["escalated", "succeeded", "failed", "cancelled"],
  escalated: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionPipelineRun(
  from: PipelineRunStatus,
  to: PipelineRunStatus,
): boolean {
  return PIPELINE_RUN_TRANSITIONS[from].includes(to);
}

export function transitionPipelineRun(
  from: PipelineRunStatus,
  to: PipelineRunStatus,
): PipelineRunStatus | undefined {
  return canTransitionPipelineRun(from, to) ? to : undefined;
}

/** Per-attempt step-row states — append-only rows, no machine (D-64.9). */
export const PIPELINE_STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type PipelineStepStatus = (typeof PIPELINE_STEP_STATUSES)[number];

/**
 * `agent` = one bounded AgentRunner turn. `propose` = the engine-owned
 * deterministic gate handoff (D-64.4) — no LLM, no tools, never an agent
 * holding a write capability.
 */
export const PIPELINE_STEP_KINDS = ["agent", "propose"] as const;
export type PipelineStepKind = (typeof PIPELINE_STEP_KINDS)[number];

// "shadow" (Sprint 65, D-65.2): a dry run with a pairing identity — queued by
// automation alongside the legacy path's live draft so both can be compared.
// Only "live" runs touch the gate; every other mode ends in a simulated proposal.
export const PIPELINE_RUN_MODES = ["live", "dry_run", "shadow"] as const;
export type PipelineRunMode = (typeof PIPELINE_RUN_MODES)[number];

// Step output kinds (D-64.3): a registered vocabulary, not arbitrary JSON
// schemas. Structures stay code-validated; everything else about a step is
// data. Customer-authored schemas arrive only with the eval harness (PRD D5).

export const STEP_OUTPUT_KINDS = [
  "brief",
  "angles",
  "draft",
  "findings",
  "proposal",
] as const;
export type StepOutputKind = (typeof STEP_OUTPUT_KINDS)[number];

/** Research compaction (PRD): a distilled Brief, never a transcript. */
export const briefOutputSchema = z.object({
  summary: z.string().min(1),
  keyFacts: z.array(z.string().min(1)).min(1).max(10),
  sources: z.array(z.string()).max(10).default([]),
  confidence: z.number().int().min(0).max(100).optional(),
});
export type BriefOutput = z.infer<typeof briefOutputSchema>;

export const anglesOutputSchema = z.object({
  angles: z
    .array(
      z.object({
        title: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
  confidence: z.number().int().min(0).max(100).optional(),
});
export type AnglesOutput = z.infer<typeof anglesOutputSchema>;

export const draftOutputSchema = z.object({
  content: z.string().min(1),
  confidence: z.number().int().min(0).max(100).optional(),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

/**
 * Critique findings. Sprint 66 (D-66.3): every finding cites the specific
 * retrieved artifact it rests on — a guardrail line, a prior post, a voice-doc
 * passage, a plan pillar. The score is the engine's revise-loop control
 * signal (D-64.7), not the human-facing product; the cited findings are.
 */
export const findingsOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  findings: z
    .array(
      z.object({
        issue: z.string().min(1),
        citation: z.string().min(1),
      }),
    )
    .max(10)
    .default([]),
  guardrailUncertain: z.boolean().default(false),
  confidence: z.number().int().min(0).max(100).optional(),
});
export type FindingsOutput = z.infer<typeof findingsOutputSchema>;

/** What the propose step recorded — real ids live, nulls when simulated. */
export const proposalOutputSchema = z.object({
  content: z.string().min(1),
  channel: z.enum(CHANNELS),
  taskType: z.enum(TASK_TYPES),
  generationId: z.string().uuid().nullable(),
  draftId: z.string().uuid().nullable(),
  simulated: z.boolean(),
});
export type ProposalOutput = z.infer<typeof proposalOutputSchema>;

const STEP_OUTPUT_SCHEMAS: Record<StepOutputKind, z.ZodType<unknown>> = {
  brief: briefOutputSchema,
  angles: anglesOutputSchema,
  draft: draftOutputSchema,
  findings: findingsOutputSchema,
  proposal: proposalOutputSchema,
};

export function stepOutputSchemaFor(kind: StepOutputKind): z.ZodType<unknown> {
  return STEP_OUTPUT_SCHEMAS[kind];
}

export const pipelineStepSpecSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, "Step keys are short lowercase slugs"),
  title: z.string().min(1).max(80),
  goal: z.string().min(1).max(2000),
  kind: z.enum(PIPELINE_STEP_KINDS),
  /** Tool allowlist — the exact set this step's agent turn may call. */
  tools: z.array(z.enum(AGENT_TOOL_NAMES)).max(8).default([]),
  tier: z.enum(MODEL_TIERS).default("cheap"),
  output: z.enum(STEP_OUTPUT_KINDS),
  /** AgentRunner model-call cap for this step. */
  maxSteps: z.number().int().min(1).max(10).default(4),
  maxTokens: z.number().int().min(1_000).max(32_000).default(16_000),
  /**
   * Engine-owned revise loop (D-64.7): skipped when `scoreFrom`'s latest
   * score ≥ threshold; otherwise this step runs and `scoreFrom` re-runs,
   * up to maxIterations passes. Never control flow inside a prompt.
   */
  loop: z
    .object({
      scoreFrom: z.string().min(1),
      threshold: z.number().int().min(0).max(100),
      maxIterations: z.number().int().min(1).max(3),
    })
    .optional(),
});
export type PipelineStepSpec = z.infer<typeof pipelineStepSpecSchema>;

export const pipelineSpecSchema = z
  .object({
    steps: z.array(pipelineStepSpecSchema).min(2).max(10),
    /** Deterministic escalation rule (D-64.8), checked between steps. */
    escalation: z
      .object({
        minConfidence: z.number().int().min(0).max(100).optional(),
        onGuardrailUncertain: z.boolean().default(true),
      })
      .optional(),
    /** Cumulative token budget across every agent step of one run. */
    budget: z.object({
      maxTokens: z.number().int().min(1_000).max(200_000),
    }),
  })
  .superRefine((spec, ctx) => {
    const keys = new Set<string>();
    for (const [index, step] of spec.steps.entries()) {
      if (keys.has(step.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "key"],
          message: `Duplicate step key "${step.key}"`,
        });
      }
      keys.add(step.key);
    }

    const proposeIndexes = spec.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.kind === "propose");
    if (
      proposeIndexes.length !== 1 ||
      proposeIndexes[0]!.index !== spec.steps.length - 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "A pipeline has exactly one propose step, and it comes last",
      });
    }
    for (const { step, index } of proposeIndexes) {
      if (step.output !== "proposal") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "output"],
          message: "The propose step's output kind is \"proposal\"",
        });
      }
      if (step.tools.length > 0 || step.loop) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index],
          message: "The propose step is engine-owned: no tools, no loop",
        });
      }
    }

    for (const [index, step] of spec.steps.entries()) {
      if (step.kind === "agent" && step.output === "proposal") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "output"],
          message: "Only the propose step produces a proposal",
        });
      }
      if (!step.loop) continue;
      if (step.output !== "draft") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "loop"],
          message: "A revise loop step must produce a draft",
        });
        continue;
      }
      const source = spec.steps.findIndex(
        (candidate) => candidate.key === step.loop!.scoreFrom,
      );
      if (source === -1 || source >= index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "loop", "scoreFrom"],
          message: "loop.scoreFrom must name an earlier step",
        });
      } else if (spec.steps[source]!.output !== "findings") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "loop", "scoreFrom"],
          message: "loop.scoreFrom must name a findings step",
        });
      }
    }
  });
export type PipelineSpec = z.infer<typeof pipelineSpecSchema>;

/**
 * The canonical reference definition (PRD §7 Sprint 64), seeded per
 * workspace as version 1 in `draft` status (D-64.11). Tiers follow Move 8:
 * cheap for research, frontier where judgment is the product.
 */
export const REFERENCE_SIGNAL_SOCIAL_POST_SPEC: PipelineSpec =
  pipelineSpecSchema.parse({
    steps: [
      {
        key: "research",
        title: "Research",
        goal:
          "Research the triggering signal. Gather what the workspace already " +
          "knows: prior posts on this topic, recent publications and their " +
          "metrics, evidence-corpus material, and (only if a URL is given) " +
          "the source page. Distill a Brief with the key facts a writer " +
          "needs — never a transcript.",
        kind: "agent",
        tools: [
          "search_evidence",
          "get_prior_posts_on_topic",
          "safe_fetch_url",
          "list_recent_publications_with_metrics",
        ],
        tier: "cheap",
        output: "brief",
        maxSteps: 6,
        maxTokens: 16_000,
      },
      {
        key: "angle",
        title: "Angle",
        goal:
          "Propose up to three distinct angles for a social post grounded in " +
          "the Brief, the campaign plan, and what similar approved drafts " +
          "did well. Rank them; the first is the one to draft.",
        kind: "agent",
        tools: ["get_campaign_plan", "find_similar_approved_drafts"],
        tier: "frontier",
        output: "angles",
        maxSteps: 3,
        maxTokens: 12_000,
      },
      {
        key: "draft",
        title: "Draft",
        goal:
          "Write the post for the requested channel using the leading angle " +
          "and the Brief. Consult the brain (voice, ICP, now) before " +
          "writing. Study the provided prior examples from approval history: " +
          "imitate what got approved, avoid what got rejected and why. Stay " +
          "strictly inside the Brief's facts.",
        kind: "agent",
        tools: ["get_brain_section"],
        tier: "frontier",
        output: "draft",
        maxSteps: 2,
        maxTokens: 12_000,
      },
      {
        key: "critique",
        title: "Critique",
        goal:
          "Retrieve before you judge — never critique from memory. Pull the " +
          "voice doc's actual examples, the channel guardrail list, the " +
          "campaign plan's pillars, the last ten posts on this channel, and " +
          "the most similar approved drafts and instructive rejections. " +
          "Judge the current draft against what you retrieved. Every finding " +
          "must cite the specific artifact it rests on — the exact guardrail " +
          "line, the specific prior post, the voice-doc passage, the plan " +
          "pillar. Also return a 0-100 score for the revise loop. Set " +
          "guardrailUncertain when a guardrail's applicability is unclear.",
        kind: "agent",
        tools: [
          "find_similar_approved_drafts",
          "find_instructive_rejections",
          "list_channel_guardrails",
          "get_campaign_plan",
          "list_recent_publications_with_metrics",
          "get_brain_section",
        ],
        tier: "frontier",
        output: "findings",
        maxSteps: 6,
        maxTokens: 12_000,
      },
      {
        key: "revise",
        title: "Revise",
        goal:
          "Rewrite the draft to resolve every critique finding while " +
          "keeping the angle and the Brief's facts.",
        kind: "agent",
        tools: ["get_brain_section"],
        tier: "frontier",
        output: "draft",
        maxSteps: 2,
        maxTokens: 12_000,
        loop: { scoreFrom: "critique", threshold: 70, maxIterations: 2 },
      },
      {
        key: "propose",
        title: "Propose",
        goal: "Submit the final draft to the approval gate.",
        kind: "propose",
        output: "proposal",
      },
    ],
    escalation: { minConfidence: 60, onGuardrailUncertain: true },
    budget: { maxTokens: 120_000 },
  });

export const pipelineDefinitionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskKey: z.enum(PIPELINE_TASK_KEYS),
  name: z.string(),
  description: z.string(),
  campaignId: z.string().uuid().nullable(),
  laneId: z.string().uuid().nullable(),
  status: z.enum(PIPELINE_DEFINITION_STATUSES),
  currentVersion: z.number().int().min(1),
  spec: pipelineSpecSchema,
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

export const pipelineDefinitionVersionSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string().uuid(),
  version: z.number().int().min(1),
  spec: pipelineSpecSchema,
  actorLabel: z.string(),
  actorUserId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type PipelineDefinitionVersion = z.infer<
  typeof pipelineDefinitionVersionSchema
>;

export const pipelineDefinitionDetailSchema = pipelineDefinitionSchema.extend({
  versions: z.array(pipelineDefinitionVersionSchema),
});
export type PipelineDefinitionDetail = z.infer<
  typeof pipelineDefinitionDetailSchema
>;

export const listPipelineDefinitionsResponseSchema = z.object({
  definitions: z.array(pipelineDefinitionSchema),
});

export const createPipelineDefinitionInputSchema = z.object({
  taskKey: z.enum(PIPELINE_TASK_KEYS),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  campaignId: z.string().uuid().nullish(),
  laneId: z.string().uuid().nullish(),
  spec: pipelineSpecSchema,
});
export type CreatePipelineDefinitionInput = z.infer<
  typeof createPipelineDefinitionInputSchema
>;

export const updatePipelineSpecInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  spec: pipelineSpecSchema,
});
export type UpdatePipelineSpecInput = z.infer<
  typeof updatePipelineSpecInputSchema
>;

/** One checklist entry per executed step pass (D-64.10). `passes` is earned
 * by validating the structured output against the declared kind. */
export const pipelineChecklistEntrySchema = z.object({
  stepKey: z.string(),
  iteration: z.number().int().min(1),
  output: z.enum(STEP_OUTPUT_KINDS),
  passes: z.boolean(),
  evidence: z.string(),
  agentRunId: z.string().nullable(),
});
export type PipelineChecklistEntry = z.infer<
  typeof pipelineChecklistEntrySchema
>;

export const pipelineRunSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  definitionId: z.string().uuid(),
  definitionVersion: z.number().int().min(1),
  taskKey: z.enum(PIPELINE_TASK_KEYS),
  mode: z.enum(PIPELINE_RUN_MODES),
  dryRunBatchId: z.string().uuid().nullable(),
  signalId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  laneId: z.string().uuid().nullable(),
  personaId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  status: z.enum(PIPELINE_RUN_STATUSES),
  pausedAtStepKey: z.string().nullable(),
  escalationReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  checklist: z.array(pipelineChecklistEntrySchema),
  result: proposalOutputSchema.nullable(),
  generationId: z.string().uuid().nullable(),
  draftId: z.string().uuid().nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costCents: z.number(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const pipelineRunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  stepKey: z.string(),
  iteration: z.number().int().min(1),
  attempt: z.number().int().min(1),
  status: z.enum(PIPELINE_STEP_STATUSES),
  agentRunId: z.string().uuid().nullable(),
  output: z.unknown(),
  passes: z.boolean(),
  failureReason: z.string().nullable(),
  stopReason: z.enum(AGENT_STOP_REASONS).nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costCents: z.number(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type PipelineRunStep = z.infer<typeof pipelineRunStepSchema>;

export const pipelineRunDetailSchema = pipelineRunSchema.extend({
  steps: z.array(pipelineRunStepSchema),
});
export type PipelineRunDetail = z.infer<typeof pipelineRunDetailSchema>;

export const listPipelineRunsResponseSchema = z.object({
  runs: z.array(pipelineRunSchema),
  total: z.number().int(),
});

export const runPipelineInputSchema = z.object({
  signalId: z.string().uuid(),
  channel: z.enum(CHANNELS),
  campaignId: z.string().uuid().nullish(),
  personaId: z.string().uuid().nullish(),
  /** Optional dedupe key (D-64.12) — Sprint 65 automation passes one. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type RunPipelineInput = z.infer<typeof runPipelineInputSchema>;

export const dryRunPipelineInputSchema = z.object({
  /** Explicit signals to replay; otherwise the most recent are used. */
  signalIds: z.array(z.string().uuid()).min(1).max(10).optional(),
  limit: z.number().int().min(1).max(10).default(3),
  channel: z.enum(CHANNELS).default("linkedin"),
});
export type DryRunPipelineInput = z.infer<typeof dryRunPipelineInputSchema>;

export const dryRunPipelineResultSchema = z.object({
  batchId: z.string().uuid(),
  runs: z.array(
    z.object({
      runId: z.string().uuid(),
      signalId: z.string().uuid(),
      status: z.enum(PIPELINE_RUN_STATUSES),
      proposal: proposalOutputSchema.nullable(),
      checklist: z.array(pipelineChecklistEntrySchema),
      costCents: z.number(),
      failureReason: z.string().nullable(),
      escalationReason: z.string().nullable(),
    }),
  ),
});
export type DryRunPipelineResult = z.infer<typeof dryRunPipelineResultSchema>;

export const PIPELINE_RUN_DECISION_ACTIONS = ["resume", "cancel"] as const;
export type PipelineRunDecisionAction =
  (typeof PIPELINE_RUN_DECISION_ACTIONS)[number];

export const pipelineRunDecisionInputSchema = z
  .object({
    action: z.enum(PIPELINE_RUN_DECISION_ACTIONS),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "cancel" && !input.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Cancelling a run requires a reason",
      });
    }
  });
export type PipelineRunDecisionInput = z.infer<
  typeof pipelineRunDecisionInputSchema
>;

// ---------------------------------------------------------------------------
// Structured LLM outputs (Sprint 58)
//
// The response schemas generateStructured validates against — one per service
// that needs structure from the model. Shapes mirror what the prompts already
// asked for pre-58, so migrated call sites persist identical outcomes.
// Tolerance policy: schemas assert shape and type; domain clamps (score 0-100,
// reason length, top-5 matches, RSA field counts) stay in the services —
// an over-long or out-of-range value is trimmed/flagged there, not rejected
// here. brandProfileSchema (Sprint 36.2, above) is the tenth response schema.
// ---------------------------------------------------------------------------

/** One persona×campaign routing candidate in a scoring response. */
export const matchingResponseMatchSchema = z.object({
  personaId: z.string().nullish(),
  campaignId: z.string().nullish(),
  score: z.number(),
  reason: z.string().optional(),
});
export type MatchingResponseMatch = z.infer<typeof matchingResponseMatchSchema>;

/** One scored item in a discovery/signal matching response. */
export const matchingResponseEntrySchema = z.object({
  index: z.number().int(),
  score: z.number(),
  /** Optional top-level fallback reason when `matches` is empty. */
  reason: z.string().optional(),
  matches: z.array(matchingResponseMatchSchema),
});
export type MatchingResponseEntry = z.infer<typeof matchingResponseEntrySchema>;

export const matchingResponseSchema = z.array(matchingResponseEntrySchema);
export type MatchingResponse = z.infer<typeof matchingResponseSchema>;

/**
 * One candidate-campaign judgment in an opportunity matcher response
 * (Sprint 61, design §9.2). Score fields are optional so an irrelevant
 * candidate can omit them; ID validation against the candidate set and the
 * story's occurrences happens in the service — an invented ID makes the
 * routing attempt retryable, never a stored no-match.
 */
export const opportunityMatcherCandidateSchema = z.object({
  campaignId: z.string(),
  relevant: z.boolean(),
  workspaceRelevance: z.number().optional(),
  campaignFit: z.number().optional(),
  confidence: z.number().optional(),
  actionability: z.number().optional(),
  angle: z.string().optional(),
  supportedClaims: z
    .array(
      z.object({
        claim: z.string(),
        occurrenceIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  suggestedPersonaId: z.string().nullish(),
  expiresInDays: z.number().nullish(),
  reason: z.string().optional(),
});
export type OpportunityMatcherCandidate = z.infer<
  typeof opportunityMatcherCandidateSchema
>;

export const opportunityMatcherResponseSchema = z.array(
  opportunityMatcherCandidateSchema,
);
export type OpportunityMatcherResponse = z.infer<
  typeof opportunityMatcherResponseSchema
>;

/**
 * Sufficiency assessment response (Sprint 62, design §8.8). Shape-tolerant
 * per the Sprint 58 convention; hard grounding validation (claim sourceIds ⊆
 * the package's source rows) happens in the service — an invented ID makes
 * the assessment retryable, never a stored judgment. The verdict is derived
 * by the service (`sufficient` requires ≥1 validated claim), never trusted.
 */
export const sufficiencyResponseSchema = z.object({
  sufficient: z.boolean(),
  confidence: z.number().optional(),
  supportedClaims: z
    .array(
      z.object({
        claim: z.string(),
        sourceIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  missingFacts: z.array(z.string()).optional(),
  missingMedia: z.array(z.string()).optional(),
  eligibleFormats: z.array(z.string()).optional(),
  ineligibleFormats: z
    .array(z.object({ format: z.string(), reason: z.string().optional() }))
    .optional(),
  researchActions: z.array(z.string()).optional(),
});
export type SufficiencyResponse = z.infer<typeof sufficiencyResponseSchema>;

/** Inbox reply classification: one label per batched item. */
export const emailReplyClassificationResponseSchema = z.array(
  z.object({
    index: z.number().int(),
    label: z.enum(EMAIL_REPLY_LABELS),
  }),
);
export type EmailReplyClassificationResponse = z.infer<
  typeof emailReplyClassificationResponseSchema
>;

/** Brain-proposed discovery sources — only the keyless trio is proposable. */
export const sourceProposalsResponseSchema = z.array(
  z.object({
    type: z.enum(["google_news", "reddit", "rss"]),
    name: z.string(),
    config: z.object({
      feedUrl: z.string().optional(),
      query: z.string().optional(),
      subreddit: z.string().optional(),
    }),
    reason: z.string().optional(),
  }),
);
export type SourceProposalsResponse = z.infer<typeof sourceProposalsResponseSchema>;

/** One reviewer pass (brand voice / channel fit): score + concrete issues. */
export const reviewCheckResponseSchema = z.object({
  score: z.number(),
  issues: z.array(z.string()),
});
export type ReviewCheckResponse = z.infer<typeof reviewCheckResponseSchema>;

/** Angle-first generation: N distinct one-sentence angles, strongest first. */
export const anglesResponseSchema = z.array(z.string());
export type AnglesResponse = z.infer<typeof anglesResponseSchema>;

/** Meta ad generation: N complete variants. */
export const metaAdVariantsResponseSchema = z.object({
  variants: z.array(
    z.object({
      primaryText: z.string(),
      headline: z.string(),
      description: z.string(),
    }),
  ),
});
export type MetaAdVariantsResponse = z.infer<typeof metaAdVariantsResponseSchema>;

/** Google RSA generation: one asset set (counts validated as violations). */
export const googleRsaResponseSchema = z.object({
  headlines: z.array(z.string()),
  descriptions: z.array(z.string()),
});
export type GoogleRsaResponse = z.infer<typeof googleRsaResponseSchema>;

/** Outline enrichment: one one-line summary per 1-based section index. */
export const outlineSummariesResponseSchema = z.array(
  z.object({
    index: z.number().int(),
    summary: z.string(),
  }),
);
export type OutlineSummariesResponse = z.infer<typeof outlineSummariesResponseSchema>;

/** Brain auto-draft: one doc's markdown body. */
export const brainDocDraftResponseSchema = z.object({
  content: z.string(),
});
export type BrainDocDraftResponse = z.infer<typeof brainDocDraftResponseSchema>;

// ---------------------------------------------------------------------------
// Sprint 65 — first agent-executed pipeline, measured (shadow A/B + rollout)
// ---------------------------------------------------------------------------

/**
 * The founder's side-by-side call on one shadow pair (D-65.7). Shadow proposals
 * never enter the approval gate, so this explicit verdict is the shadow-side
 * approval signal the comparison aggregates.
 */
export const SHADOW_VERDICTS = ["engine", "legacy", "tie"] as const;
export type ShadowVerdict = (typeof SHADOW_VERDICTS)[number];

/**
 * One legacy draft paired with its engine shadow run — the unit of the
 * founder-visible A/B. `draftContent`/`proposalContent` are joined in at read
 * time (the proposal from the run's stored result; null until the run reaches
 * a terminal state).
 */
export const pipelineShadowPairSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  signalId: z.string().uuid().nullable(),
  campaignId: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  draftId: z.string().uuid().nullable(),
  runId: z.string().uuid(),
  draftContent: z.string().nullable(),
  draftState: z.enum(APPROVAL_STATES).nullable(),
  proposalContent: z.string().nullable(),
  runStatus: z.enum(PIPELINE_RUN_STATUSES),
  verdict: z.enum(SHADOW_VERDICTS).nullable(),
  verdictNotes: z.string(),
  verdictAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type PipelineShadowPair = z.infer<typeof pipelineShadowPairSchema>;

export const shadowVerdictInputSchema = z.object({
  verdict: z.enum(SHADOW_VERDICTS),
  notes: z.string().max(2000).default(""),
});
export type ShadowVerdictInput = z.infer<typeof shadowVerdictInputSchema>;

/**
 * Gate outcomes for one path's automation drafts (D-65.8). `approvalRate` and
 * `avgEditDistance` are null until at least one draft has been decided —
 * "no data yet" must be distinguishable from 0.
 */
export const automationPathMetricsSchema = z.object({
  drafts: z.number().int().min(0),
  decided: z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected: z.number().int().min(0),
  /** approved / decided, percent 0–100. */
  approvalRate: z.number().min(0).max(100).nullable(),
  /** Mean normalized Levenshtein between original and final content, 0–100. */
  avgEditDistance: z.number().min(0).max(100).nullable(),
  costCents: z.number().int().min(0),
});
export type AutomationPathMetrics = z.infer<typeof automationPathMetricsSchema>;

export const engineRunHealthSchema = z.object({
  runs: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  escalated: z.number().int().min(0),
});
export type EngineRunHealth = z.infer<typeof engineRunHealthSchema>;

export const shadowSummarySchema = z.object({
  pairs: z.number().int().min(0),
  reviewed: z.number().int().min(0),
  engineWins: z.number().int().min(0),
  legacyWins: z.number().int().min(0),
  ties: z.number().int().min(0),
});
export type ShadowSummary = z.infer<typeof shadowSummarySchema>;

/**
 * The A/B panel's payload. Cost sides are measured differently and readers
 * must say so: engine cost is the exact per-run metered sum; legacy cost is
 * the workspace's signal_draft + review usage for the window, which includes
 * founder-triggered manual drafts (D-65.8).
 */
export const automationComparisonSchema = z.object({
  workspaceId: z.string().uuid(),
  generationPath: z.enum(AUTOMATION_GENERATION_PATHS),
  windowDays: z.number().int().positive(),
  legacy: automationPathMetricsSchema,
  engine: automationPathMetricsSchema.extend({ health: engineRunHealthSchema }),
  shadow: shadowSummarySchema,
});
export type AutomationComparison = z.infer<typeof automationComparisonSchema>;

/**
 * D-65.9: the founder's recorded call on the A/B. Append-only; recording one
 * freezes the comparison snapshot into the record and atomically applies the
 * matching generationPath (adopt_engine → pipeline, keep_legacy → legacy,
 * extend_shadow → shadow). Deleting the legacy path is a later sprint, only
 * after adopt_engine has held up in production.
 */
export const ROLLOUT_DECISION_KINDS = [
  "adopt_engine",
  "keep_legacy",
  "extend_shadow",
] as const;
export type RolloutDecisionKind = (typeof ROLLOUT_DECISION_KINDS)[number];

export const rolloutDecisionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskKey: z.enum(PIPELINE_TASK_KEYS),
  decision: z.enum(ROLLOUT_DECISION_KINDS),
  rationale: z.string(),
  metrics: automationComparisonSchema,
  decidedByUserId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type RolloutDecision = z.infer<typeof rolloutDecisionSchema>;

export const recordRolloutDecisionInputSchema = z.object({
  decision: z.enum(ROLLOUT_DECISION_KINDS),
  rationale: z.string().min(1).max(2000),
});
export type RecordRolloutDecisionInput = z.infer<typeof recordRolloutDecisionInputSchema>;

// ---------------------------------------------------------------------------
// Sprint 67 — Eval & replay harness (PRD §7, direction doc Move 6)
// ---------------------------------------------------------------------------

/**
 * Ground truth for one replayed case: what the founder actually did with the
 * draft this signal produced the first time round. `edited` means approved but
 * not as written — the content changed between generation and approval.
 */
export const EVAL_CASE_OUTCOMES = ["approved", "rejected", "edited"] as const;
export type EvalCaseOutcome = (typeof EVAL_CASE_OUTCOMES)[number];

/** Deterministic checks — no LLM, no network. These are what gate CI (D-67.4). */
export const EVAL_CHECK_KINDS = [
  "length_bounds",
  "banned_claims",
  "placeholder_leak",
  "cta_presence",
  "citation_validity",
] as const;
export type EvalCheckKind = (typeof EVAL_CHECK_KINDS)[number];

export const EVAL_CHECK_STATUSES = ["pass", "fail", "skipped"] as const;
export type EvalCheckStatus = (typeof EVAL_CHECK_STATUSES)[number];

export const EVAL_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/** The harness's own call on a replayed draft, compared against ground truth. */
export const EVAL_VERDICTS = ["pass", "flag"] as const;
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

/** Whether a suite's channel expects a call to action. `any` skips the check. */
export const CTA_EXPECTATIONS = ["any", "required", "forbidden"] as const;
export type CtaExpectation = (typeof CTA_EXPECTATIONS)[number];

/** Below this a "draft" is a stub, whatever the channel. */
export const EVAL_MIN_BODY_CHARS = 40;

/** Judge overall score at or above which the harness's verdict is `pass`. */
export const EVAL_JUDGE_PASS = 70;

/**
 * Upper length bounds per channel. Sourced from SOCIAL_POST_CONSTRAINTS where a
 * publish path exists; `x` is the platform's own limit. A channel with no entry
 * skips the upper bound (the minimum still applies) rather than inventing one.
 */
export const EVAL_MAX_BODY_CHARS: Partial<Record<Channel, number>> = {
  linkedin: SOCIAL_POST_CONSTRAINTS.linkedin.bodyMaxChars,
  instagram: SOCIAL_POST_CONSTRAINTS.instagram.bodyMaxChars,
  x: 280,
};

export const evalCheckResultSchema = z.object({
  kind: z.enum(EVAL_CHECK_KINDS),
  status: z.enum(EVAL_CHECK_STATUSES),
  /** Human-readable: what was checked and, on a failure, what tripped it. */
  detail: z.string(),
});
export type EvalCheckResult = z.infer<typeof evalCheckResultSchema>;

const rubricDimensionSchema = z.object({
  score: z.number().int().min(0).max(5),
  justification: z.string().min(1).max(400),
});

/** The rubric judge's verdict. Reported and trended; never gates CI (D-67.4). */
export const evalRubricSchema = z.object({
  voiceFit: rubricDimensionSchema,
  specificity: rubricDimensionSchema,
  channelFit: rubricDimensionSchema,
  brandSafety: rubricDimensionSchema,
  actionability: rubricDimensionSchema,
  overall: z.number().int().min(0).max(100),
});
export type EvalRubric = z.infer<typeof evalRubricSchema>;

export const evalCaseSchema = z.object({
  id: z.string().uuid(),
  suiteId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  signalId: z.string().uuid().nullable(),
  signalContent: z.string(),
  signalSource: z.string(),
  channel: z.enum(CHANNELS),
  campaignId: z.string().uuid().nullable(),
  personaId: z.string().uuid().nullable(),
  sourceDraftId: z.string().uuid().nullable(),
  /** What the model produced the first time (drafts.originalContent). */
  generatedContent: z.string(),
  /** What the founder actually shipped or last saw (drafts.content). */
  finalContent: z.string(),
  outcome: z.enum(EVAL_CASE_OUTCOMES),
  rejectionReason: z.string().nullable(),
  decidedAt: z.number().int(),
  createdAt: z.number().int(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalSuiteSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  taskKey: z.enum(PIPELINE_TASK_KEYS),
  channel: z.enum(CHANNELS),
  ctaExpectation: z.enum(CTA_EXPECTATIONS),
  caseCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export const buildEvalSuiteInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel: z.enum(CHANNELS).default("linkedin"),
  ctaExpectation: z.enum(CTA_EXPECTATIONS).default("any"),
  limit: z.number().int().min(1).max(50).default(20),
});
export type BuildEvalSuiteInput = z.infer<typeof buildEvalSuiteInputSchema>;

export const evalCaseResultSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  caseId: z.string().uuid(),
  pipelineRunId: z.string().uuid().nullable(),
  producedContent: z.string().nullable(),
  checks: z.array(evalCheckResultSchema),
  judge: evalRubricSchema.nullable(),
  verdict: z.enum(EVAL_VERDICTS).nullable(),
  /** 0–100 normalized distance from what the founder actually shipped. */
  editDistanceToFinal: z.number().nullable(),
  costCents: z.number(),
  durationMs: z.number().int(),
  failureReason: z.string().nullable(),
});
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

/**
 * One run's aggregate. Every rate is null when its denominator is zero — a
 * missing number is never silently rendered as a zero, and a null on either
 * side of a comparison is skipped rather than counted as a regression.
 */
export const evalRunMetricsSchema = z.object({
  cases: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  hardCheckPassRate: z.number().nullable(),
  /** Failure count per check kind; a kind that never failed is simply absent. */
  violations: z.record(z.string(), z.number().int()),
  judged: z.number().int().nonnegative(),
  avgJudgeScore: z.number().nullable(),
  avgEditDistanceToFinal: z.number().nullable(),
  /** Harness verdict matched the founder's outcome. */
  agreementRate: z.number().nullable(),
  /** Of founder-rejected cases, the share the harness also flagged. */
  rejectRecall: z.number().nullable(),
  /** Of founder-approved cases, the share the harness passed. */
  approvePassRate: z.number().nullable(),
  costCents: z.number(),
  avgDurationMs: z.number().int(),
  /** The §1.3 production snapshot, frozen alongside the replay numbers. */
  production: automationComparisonSchema.nullable(),
});
export type EvalRunMetrics = z.infer<typeof evalRunMetricsSchema>;

export const evalRunSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  suiteId: z.string().uuid(),
  definitionId: z.string().uuid().nullable(),
  definitionVersion: z.number().int().nullable(),
  status: z.enum(EVAL_RUN_STATUSES),
  judgeEnabled: z.boolean(),
  metrics: evalRunMetricsSchema,
  /** Non-null makes this run the named baseline for its workspace (D-67.3). */
  baselineLabel: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type EvalRun = z.infer<typeof evalRunSchema>;

export const evalRunDetailSchema = evalRunSchema.extend({
  results: z.array(evalCaseResultSchema),
});
export type EvalRunDetail = z.infer<typeof evalRunDetailSchema>;

export const runEvalSuiteInputSchema = z.object({
  suiteId: z.string().uuid(),
  /** Defaults to the active definition for the suite's task key. */
  definitionId: z.string().uuid().optional(),
  /** Off by default — the judge costs money and never gates CI. */
  judge: z.boolean().default(false),
  /** Labelling at creation is how a baseline gets captured in one call. */
  baselineLabel: z.string().trim().min(1).max(60).optional(),
});
export type RunEvalSuiteInput = z.infer<typeof runEvalSuiteInputSchema>;

export const labelBaselineInputSchema = z.object({
  baselineLabel: z.string().trim().min(1).max(60),
});
export type LabelBaselineInput = z.infer<typeof labelBaselineInputSchema>;

/**
 * How far a metric may move before the gate calls it a regression (D-67.9).
 * `higher` metrics regress by dropping, `lower` metrics regress by rising.
 * Judge-derived metrics are absent here on purpose — CI cannot compute them.
 */
export const EVAL_REGRESSION_THRESHOLDS = {
  hardCheckPassRate: { better: "higher", tolerance: 2 },
  rejectRecall: { better: "higher", tolerance: 5 },
  approvePassRate: { better: "higher", tolerance: 5 },
  agreementRate: { better: "higher", tolerance: 5 },
  avgEditDistanceToFinal: { better: "lower", tolerance: 5 },
} as const satisfies Record<string, { better: "higher" | "lower"; tolerance: number }>;

export type EvalGatedMetric = keyof typeof EVAL_REGRESSION_THRESHOLDS;

export const evalMetricDeltaSchema = z.object({
  metric: z.string(),
  baseline: z.number(),
  current: z.number(),
  delta: z.number(),
  tolerance: z.number(),
});
export type EvalMetricDelta = z.infer<typeof evalMetricDeltaSchema>;

export const evalComparisonSchema = z.object({
  ok: z.boolean(),
  baselineLabel: z.string().nullable(),
  baselineRunId: z.string().uuid().nullable(),
  currentRunId: z.string().uuid(),
  regressions: z.array(evalMetricDeltaSchema),
  improvements: z.array(evalMetricDeltaSchema),
  /** Metrics that could not be compared (null on one side). */
  skipped: z.array(z.string()),
});
export type EvalComparison = z.infer<typeof evalComparisonSchema>;

/**
 * D-67.5: a machine-checkable claim the workspace never wants to publish.
 * Channel guidance is prose an LLM interprets; this list is a hard check and
 * is also handed to the critic through list_channel_guardrails so a finding
 * can cite the exact phrase it tripped on.
 */
export const bannedClaimSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  phrase: z.string(),
  note: z.string(),
  createdAt: z.number().int(),
});
export type BannedClaim = z.infer<typeof bannedClaimSchema>;

export const bannedClaimInputSchema = z.object({
  phrase: z.string().trim().min(2).max(120),
  note: z.string().trim().max(300).default(""),
});
export type BannedClaimInput = z.infer<typeof bannedClaimInputSchema>;

// ---------------------------------------------------------------------------
// Preference memory (Sprint 68, PRD §7 Sprint 68 / direction doc Move 5)
//
// The fast layer under the weekly `now` synthesis: a founder edit becomes a
// captured diff, the diff becomes a learned rule, and the rule is injected as
// a traced resolver section the same afternoon. The slow layer keeps its job —
// promoting stable rules into the brain docs behind the founder-accepts gate.
// ---------------------------------------------------------------------------

/** Where a captured correction came from (D-68.1: edits only). */
export const PREFERENCE_EDIT_SOURCES = ["draft_edit", "editor_turn"] as const;
export type PreferenceEditSource = (typeof PREFERENCE_EDIT_SOURCES)[number];

export const PREFERENCE_POLARITIES = ["do", "avoid"] as const;
export type PreferencePolarity = (typeof PREFERENCE_POLARITIES)[number];

/**
 * `candidate` — extracted below the activation confidence; visible, not
 * injected. `active` — injected. `disabled` — the founder switched it off.
 * `promoted` — folded into a brain doc by an accepted synthesis, so the
 * resolver already reads it. `retired` — neither re-observed nor applied
 * inside the retirement window (D-68.8).
 */
export const PREFERENCE_RULE_STATUSES = [
  "candidate",
  "active",
  "disabled",
  "promoted",
  "retired",
] as const;
export type PreferenceRuleStatus = (typeof PREFERENCE_RULE_STATUSES)[number];

/**
 * Where a rule came from. `answered_question` (Sprint 70) is a rule the founder
 * chose to keep while answering an agent's question — it is not inferred from
 * the prose of the answer (D-70.11); the founder supplies the rule text, and the
 * origin exists so the Preferences page can say where it came from.
 */
export const PREFERENCE_RULE_ORIGINS = ["extracted", "manual", "answered_question"] as const;
export type PreferenceRuleOrigin = (typeof PREFERENCE_RULE_ORIGINS)[number];

/** A rule is one imperative line. Longer than this is a paragraph, not a rule. */
export const PREFERENCE_RULE_MAX_CHARS = 160;
/** Top-N injected per resolve (PRD: "top-N *relevant* rules"). */
export const PREFERENCE_RULE_LIMIT = 5;
/** The section's own budget, enforced inside the resolver before the global ladder. */
export const PREFERENCE_MAX_TOKENS = 300;
/** Below this normalized edit distance a "correction" is whitespace, not taste. */
export const PREFERENCE_MIN_EDIT_DISTANCE = 2;
/** Normalized distance at or below which two rules are the same rule restated. */
export const PREFERENCE_MERGE_DISTANCE = 20;
/** At or above this confidence an extracted rule is `active`; below it, `candidate` (D-68.9). */
export const PREFERENCE_ACTIVATE_CONFIDENCE = 65;
/** Promotion needs a rule the founder's edits re-derived at least this often. */
export const PROMOTE_MIN_OBSERVATIONS = 2;
export const PROMOTE_MIN_CONFIDENCE = 70;
/** Neither observed nor applied within this window ⇒ retired. */
export const RETIRE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const preferenceEditSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  source: z.enum(PREFERENCE_EDIT_SOURCES),
  /** Stable id of the originating row — the decision id, or the revision turn id. */
  sourceId: z.string(),
  draftId: z.string().uuid().nullable(),
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  beforeContent: z.string(),
  afterContent: z.string(),
  /** The founder's own words for the correction; only the editor path has them. */
  instruction: z.string().nullable(),
  /** Normalized Levenshtein, 0–100 (Sprint 65's `edit-distance.ts`). */
  editDistance: z.number(),
  /** Null until an extraction pass has read it. */
  digestedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type PreferenceEdit = z.infer<typeof preferenceEditSchema>;

export const preferenceRuleSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  rule: z.string(),
  polarity: z.enum(PREFERENCE_POLARITIES),
  /** Scope is derived from the edit group, never asked of the model (D-68.4). */
  scopeTaskType: z.enum(TASK_TYPES).nullable(),
  scopeChannel: z.enum(CHANNELS).nullable(),
  status: z.enum(PREFERENCE_RULE_STATUSES),
  origin: z.enum(PREFERENCE_RULE_ORIGINS),
  confidence: z.number().int().min(0).max(100),
  /** How many distinct founder edits produced or restated this rule. */
  observationCount: z.number().int(),
  /** How many real generations it has shaped — never moved by a preview (D-68.6). */
  appliedCount: z.number().int(),
  lastObservedAt: z.number().int().nullable(),
  lastAppliedAt: z.number().int().nullable(),
  promotedAt: z.number().int().nullable(),
  retiredAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PreferenceRule = z.infer<typeof preferenceRuleSchema>;

export const preferenceRuleEvidenceSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  editId: z.string().uuid(),
  excerpt: z.string(),
  createdAt: z.number().int(),
  /** The originating edit, when it still exists — what makes a rule attributable. */
  edit: preferenceEditSchema.nullable(),
});
export type PreferenceRuleEvidence = z.infer<typeof preferenceRuleEvidenceSchema>;

export const preferenceRuleDetailSchema = z.object({
  rule: preferenceRuleSchema,
  evidence: z.array(preferenceRuleEvidenceSchema),
});
export type PreferenceRuleDetail = z.infer<typeof preferenceRuleDetailSchema>;

export const createPreferenceRuleInputSchema = z.object({
  rule: z.string().trim().min(8).max(PREFERENCE_RULE_MAX_CHARS),
  polarity: z.enum(PREFERENCE_POLARITIES).default("avoid"),
  scopeTaskType: z.enum(TASK_TYPES).nullish(),
  scopeChannel: z.enum(CHANNELS).nullish(),
});
export type CreatePreferenceRuleInput = z.infer<typeof createPreferenceRuleInputSchema>;

export const updatePreferenceRuleInputSchema = z.object({
  /** The founder's four levers: activate, switch off, switch back on, retire by hand. */
  status: z.enum(["candidate", "active", "disabled", "retired"]),
});
export type UpdatePreferenceRuleInput = z.infer<typeof updatePreferenceRuleInputSchema>;

/** The extraction step's structured output — one group of same-scope edits in. */
export const extractedPreferenceRuleSchema = z.object({
  rule: z.string().min(8).max(PREFERENCE_RULE_MAX_CHARS),
  polarity: z.enum(PREFERENCE_POLARITIES),
  confidence: z.number().int().min(0).max(100),
  /** Quoted from the diffs — what makes the rule auditable rather than asserted. */
  evidence: z.string().max(300),
});
export type ExtractedPreferenceRule = z.infer<typeof extractedPreferenceRuleSchema>;

export const EXTRACTION_MAX_RULES = 3;

export const preferenceExtractionSchema = z.object({
  rules: z.array(extractedPreferenceRuleSchema).max(EXTRACTION_MAX_RULES),
});
export type PreferenceExtraction = z.infer<typeof preferenceExtractionSchema>;

export const preferenceExtractionResultSchema = z.object({
  /** Scope groups processed this pass. */
  groups: z.number().int(),
  /** Edits digested this pass, including ones that taught nothing. */
  edits: z.number().int(),
  created: z.number().int(),
  merged: z.number().int(),
  retired: z.number().int(),
});
export type PreferenceExtractionResult = z.infer<typeof preferenceExtractionResultSchema>;

// ---------------------------------------------------------------------------
// Answering an agent question (Sprint 70). Declared here rather than beside
// `agentQuestionSchema` because `remember` re-uses the preference vocabulary
// above it.
// ---------------------------------------------------------------------------

/**
 * Answering. `remember` is explicit and complete (D-70.11): the platform never
 * infers a durable rule from the prose of an answer, so if a rule is to be kept
 * the caller says what the rule is. `resume: false` records the answer without
 * restarting the blocked run — for an answer given long after the fact.
 */
export const answerAgentQuestionInputSchema = z
  .object({
    action: z.enum(["answer", "dismiss"]).default("answer"),
    answer: z.string().trim().min(1).max(QUESTION_ANSWER_MAX_CHARS).optional(),
    resume: z.boolean().default(true),
    remember: z
      .object({
        rule: z.string().trim().min(8).max(PREFERENCE_RULE_MAX_CHARS),
        polarity: z.enum(PREFERENCE_POLARITIES).default("do"),
        scopeTaskType: z.enum(TASK_TYPES).nullish(),
        scopeChannel: z.enum(CHANNELS).nullish(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "answer" && !value.answer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "Answering requires an answer.",
      });
    }
    if (value.action === "dismiss" && value.remember) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remember"],
        message: "A dismissed question teaches nothing to remember.",
      });
    }
  });
export type AnswerAgentQuestionInput = z.infer<typeof answerAgentQuestionInputSchema>;

export const answerAgentQuestionResultSchema = z.object({
  question: agentQuestionSchema,
  /** The rule the answer minted, when `remember` was given. */
  rule: preferenceRuleSchema.nullable(),
  /** The blocked run's status after answering — the proof it continued. */
  resumedRun: z
    .object({
      id: z.string().uuid(),
      status: z.enum(PIPELINE_RUN_STATUSES),
    })
    .nullable(),
});
export type AnswerAgentQuestionResult = z.infer<typeof answerAgentQuestionResultSchema>;

// ---------------------------------------------------------------------------
// Sprint 71 — show the work (PRD §8, direction move 7b)
//
// The platform computes a complete reasoning trace on every generation and
// discards it at the UI boundary. This block is the vocabulary for handing it
// back: one `ArtifactTrace` shape assembled server-side for four artifact
// kinds, and the nine context-customization knobs named once so that atlas
// conflict #4 can be settled with data rather than argument.
//
// Read-only by construction. Nothing here describes a write.
// ---------------------------------------------------------------------------

/** The four things a founder can ask "why did it write this?" about. */
export const TRACE_SUBJECT_KINDS = [
  "draft",
  "deliverable",
  "publication",
  "external_action",
] as const;
export type TraceSubjectKind = (typeof TRACE_SUBJECT_KINDS)[number];

export function isTraceSubjectKind(value: string): value is TraceSubjectKind {
  return (TRACE_SUBJECT_KINDS as readonly string[]).includes(value);
}

/** Where the words came from before the resolver ever ran. */
export const TRACE_ORIGIN_KINDS = [
  "signal",
  "story",
  "package",
  "opportunity",
  "inbox_item",
  "manual",
] as const;
export type TraceOriginKind = (typeof TRACE_ORIGIN_KINDS)[number];

/**
 * A knob's relationship to one specific resolve.
 * - `absent` — nothing configured and nothing applied.
 * - `configured` — set in this workspace, but it did not touch this bundle.
 * - `applied` — it demonstrably shaped this bundle.
 *
 * The gap between `configured` and `applied` is the entire point: a knob that
 * is always configured and never applied is the knob to delete.
 */
export const TRACE_KNOB_STATES = ["absent", "configured", "applied"] as const;
export type TraceKnobState = (typeof TRACE_KNOB_STATES)[number];

/**
 * The nine context-customization knobs, in **precedence order** — earlier
 * entries are the base, later entries override them. Atlas conflict #4 is the
 * observation that these were each added for a good reason and have never been
 * looked at together.
 */
export const CONTEXT_KNOB_KEYS = [
  "brain_docs",
  "channel_guidance_builtin",
  "channel_guidance_workspace",
  "scoped_guidance",
  "context_matrix",
  "generation_settings",
  "campaign_overlay",
  "zoom",
  "design_overlays",
] as const;
export type ContextKnobKey = (typeof CONTEXT_KNOB_KEYS)[number];

export interface ContextKnob {
  key: ContextKnobKey;
  label: string;
  /** The question this knob answers, in the founder's words. */
  question: string;
  /** The surface that owns it, relative to the workspace root. */
  surface: string;
}

export const CONTEXT_KNOBS: readonly ContextKnob[] = [
  {
    key: "brain_docs",
    label: "Brain documents",
    question: "What does the company sound like, sell, and care about?",
    surface: "/brain",
  },
  {
    key: "channel_guidance_builtin",
    label: "Built-in channel guidance",
    question: "How should anything on this channel be written?",
    surface: "/guidance",
  },
  {
    key: "channel_guidance_workspace",
    label: "Your channel guidance",
    question: "How should we write on this channel, overriding the built-in?",
    surface: "/guidance",
  },
  {
    key: "scoped_guidance",
    label: "Scoped guidance",
    question: "Does one persona or campaign write differently on this channel?",
    surface: "/guidance",
  },
  {
    key: "context_matrix",
    label: "Context matrix",
    question: "Which brain documents enter which kind of task, and how fully?",
    surface: "/resolver",
  },
  {
    key: "generation_settings",
    label: "Generation settings",
    question: "Should we pick an angle first, and pre-review before you see it?",
    surface: "/automation",
  },
  {
    key: "campaign_overlay",
    label: "Campaign overlay",
    question: "What does this campaign add on top of everything else?",
    surface: "/campaigns",
  },
  {
    key: "zoom",
    label: "Zoom retrieval",
    question: "Which individual brain sections are worth pulling in full?",
    surface: "/resolver",
  },
  {
    key: "design_overlays",
    label: "Design overlays",
    question: "How should the rendered artwork look for this channel?",
    surface: "/design-systems",
  },
] as const;

export function contextKnob(key: ContextKnobKey): ContextKnob {
  return CONTEXT_KNOBS.find((knob) => knob.key === key)!;
}

/** How many recent resolves the knob-usage report replays (D-71.7). */
export const KNOB_USAGE_SAMPLE_LIMIT = 200;

/** Longest excerpt the trace carries per context section / example. */
export const TRACE_EXCERPT_MAX_CHARS = 400;

export const traceOriginSchema = z.object({
  kind: z.enum(TRACE_ORIGIN_KINDS),
  /** Null for `manual`: there is no row to point at. */
  id: z.string().nullable(),
  label: z.string(),
  /** The triggering text itself, clipped — what the agent actually reacted to. */
  detail: z.string().nullable(),
  href: z.string().nullable(),
  at: z.number().int().nullable(),
});
export type TraceOrigin = z.infer<typeof traceOriginSchema>;

export const traceContextSectionSchema = z.object({
  key: z.string(),
  layer: z.string(),
  title: z.string(),
  /** The resolver's own written explanation for in/out. Never paraphrased. */
  reason: z.string(),
  tokens: z.number().int(),
  included: z.boolean(),
  tier: z.number().int().nullable(),
  mode: z.string().nullable(),
  zoomScore: z.number().nullable(),
  zoomRank: z.number().int().nullable(),
  excerpt: z.string(),
  href: z.string().nullable(),
});
export type TraceContextSection = z.infer<typeof traceContextSectionSchema>;

export const tracePlanSchema = z.object({
  campaignId: z.string(),
  campaignName: z.string(),
  objective: z.string(),
  kpi: z.string().nullable(),
  pillars: z.array(z.string()),
  /**
   * The pillar whose wording is closest to the artifact (D-71.4). A match, not
   * a recorded intent — the UI must say so.
   */
  closestPillar: z.string().nullable(),
  href: z.string(),
});
export type TracePlan = z.infer<typeof tracePlanSchema>;

export const traceExampleSchema = z.object({
  kind: z.enum(["approved", "rejected"]),
  label: z.string(),
  excerpt: z.string(),
  /** Why it was rejected, when a reason was ever written down. */
  why: z.string().nullable(),
  href: z.string().nullable(),
});
export type TraceExample = z.infer<typeof traceExampleSchema>;

export const tracePreferenceSchema = z.object({
  /** Null when the rule text no longer matches a live rule (it was retired). */
  ruleId: z.string().nullable(),
  rule: z.string(),
  polarity: z.enum(PREFERENCE_POLARITIES),
  confidence: z.number().int().nullable(),
  href: z.string(),
});
export type TracePreference = z.infer<typeof tracePreferenceSchema>;

export const traceCriticSchema = z.object({
  score: z.number().int().nullable(),
  findings: z.array(z.object({ issue: z.string(), citation: z.string() })),
  /** How many critique passes ran before the draft cleared the threshold. */
  iterations: z.number().int(),
  source: z.enum(["engine", "legacy"]),
  href: z.string().nullable(),
});
export type TraceCritic = z.infer<typeof traceCriticSchema>;

export const traceRevisionSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  status: z.string(),
  at: z.number().int(),
  /** 0-1 normalized edit distance between the turn's input and its result. */
  changedShare: z.number().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
});
export type TraceRevision = z.infer<typeof traceRevisionSchema>;

export const traceCostSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costCents: z.number(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int().nullable(),
  /**
   * True when no metered ledger row exists and the cost was priced from the
   * model plus an estimated token count. The panel must show the difference.
   */
  estimated: z.boolean(),
  href: z.string(),
});
export type TraceCost = z.infer<typeof traceCostSchema>;

export const traceKnobSchema = z.object({
  key: z.enum(CONTEXT_KNOB_KEYS),
  label: z.string(),
  question: z.string(),
  state: z.enum(TRACE_KNOB_STATES),
  detail: z.string(),
  href: z.string(),
});
export type TraceKnob = z.infer<typeof traceKnobSchema>;

export const artifactTraceSchema = z.object({
  subject: z.object({
    kind: z.enum(TRACE_SUBJECT_KINDS),
    id: z.string(),
    title: z.string(),
    state: z.string(),
    href: z.string(),
    createdAt: z.number().int(),
  }),
  origin: traceOriginSchema.nullable(),
  plan: tracePlanSchema.nullable(),
  context: z.array(traceContextSectionSchema),
  /**
   * Why `context` is empty, when it is — a draft that predates trace capture
   * and a budget change that was never generated are different absences, and a
   * blank panel cannot tell them apart (D-71.3).
   */
  contextReason: z.string().nullable(),
  examples: z.array(traceExampleSchema),
  preferences: z.array(tracePreferenceSchema),
  critic: traceCriticSchema.nullable(),
  revisions: z.array(traceRevisionSchema),
  cost: traceCostSchema.nullable(),
  knobs: z.array(traceKnobSchema),
  generatedAt: z.number().int(),
});
export type ArtifactTrace = z.infer<typeof artifactTraceSchema>;

export const knobUsageSchema = z.object({
  key: z.enum(CONTEXT_KNOB_KEYS),
  label: z.string(),
  question: z.string(),
  href: z.string(),
  configured: z.boolean(),
  /** Rows the workspace has set for this knob (0 for always-on knobs). */
  configuredCount: z.number().int(),
  lastConfiguredAt: z.number().int().nullable(),
  /** Sampled resolves this knob demonstrably shaped. */
  appliedResolves: z.number().int(),
  /** 0-1 over `sampledResolves`, not over all history (D-71.7). */
  appliedShare: z.number(),
});
export type KnobUsage = z.infer<typeof knobUsageSchema>;

export const knobUsageReportSchema = z.object({
  knobs: z.array(knobUsageSchema),
  /** The denominator behind every `appliedShare`. Shown, never implied. */
  sampledResolves: z.number().int(),
  sampleLimit: z.number().int(),
  generatedAt: z.number().int(),
});
export type KnobUsageReport = z.infer<typeof knobUsageReportSchema>;
