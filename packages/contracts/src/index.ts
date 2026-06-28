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
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

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

/** Where a channel's resolved guidance came from. */
export const GUIDANCE_SOURCES = ["default", "workspace"] as const;
export type GuidanceSource = (typeof GUIDANCE_SOURCES)[number];

/** A channel's resolved guidance + its source (read model for the editor). */
export const channelGuidanceSchema = z.object({
  channel: z.enum(CHANNELS),
  content: z.string(),
  source: z.enum(GUIDANCE_SOURCES),
  // null when source === "default" (no override row exists).
  updatedAt: z.number().int().nullable(),
});
export type ChannelGuidance = z.infer<typeof channelGuidanceSchema>;

export const updateGuidanceInputSchema = z.object({
  content: z.string().trim().min(1, "Guidance cannot be empty").max(4000),
});
export type UpdateGuidanceInput = z.infer<typeof updateGuidanceInputSchema>;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be 100 characters or fewer"),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

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

export const brainDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  docType: z.enum(BRAIN_DOC_TYPES),
  content: z.string(),
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

export const personaSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  overlay: z.string().max(PERSONA_OVERLAY_MAX_CHARS),
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

export const CAMPAIGN_STATUSES = ["active", "archived"] as const;
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
// Signals (manual market input — source adapters arrive in a later slice)
// ---------------------------------------------------------------------------

export const SIGNAL_SOURCES = [
  "reddit",
  "x",
  "linkedin",
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
  "g2",
  "capterra",
  "intent",
] as const;
export type DiscoverySourceType = (typeof DISCOVERY_SOURCE_TYPES)[number];

export const DISCOVERY_SOURCE_STATUSES = ["active", "needs_api_key", "error"] as const;
export type DiscoverySourceStatus = (typeof DISCOVERY_SOURCE_STATUSES)[number];

export const DISCOVERED_ITEM_STATUSES = ["new", "accepted", "skipped"] as const;
export type DiscoveredItemStatus = (typeof DISCOVERED_ITEM_STATUSES)[number];

export const discoverySourceConfigSchema = z.object({
  feedUrl: z.string().url().optional(),
  query: z.string().trim().max(200).optional(),
  subreddit: z.string().trim().max(100).optional(),
  channelId: z.string().trim().max(100).optional(),
  geo: z.string().trim().max(10).optional(),
  sector: z.string().trim().max(100).optional(),
});
export type DiscoverySourceConfig = z.infer<typeof discoverySourceConfigSchema>;

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
  createdAt: z.number().int(),
});
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

export const createDiscoverySourceInputSchema = z
  .object({
    type: z.enum(DISCOVERY_SOURCE_TYPES),
    name: z.string().trim().min(1).max(200).optional(),
    config: discoverySourceConfigSchema.default({}),
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
    if ((input.type === "x" || input.type === "linkedin") && !input.config.query?.trim()) {
      ctx.addIssue({ code: "custom", message: `An ${input.type} source needs a query` });
    }
  });
export type CreateDiscoverySourceInput = z.infer<typeof createDiscoverySourceInputSchema>;

export const updateDiscoverySourceInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  config: discoverySourceConfigSchema.optional(),
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
  createdAt: z.number().int(),
});
export type DiscoveredItem = z.infer<typeof discoveredItemSchema>;

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
  actor: z.string(),
  // Nullable: decisions logged before auth existed (Sprint 19), or by the worker.
  actorId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const editDraftInputSchema = z.object({
  content: z
    .string()
    .min(1, "Draft content cannot be empty")
    .max(BRAIN_DOC_MAX_CHARS, `Draft must be ${BRAIN_DOC_MAX_CHARS} characters or fewer`),
});
export type EditDraftInput = z.infer<typeof editDraftInputSchema>;

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
    key: "reddit",
    label: "Reddit",
    nangoProvider: "reddit",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://oauth.reddit.com",
    testPath: "/api/v1/me",
    oauthScopes: "identity,submit",
  },
  {
    // Sprint 25 social trio. OAuth popup like Reddit; creds come from
    // LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in the root .env. testPath
    // hits /v2/userinfo (OpenID) so a connection verifies the member identity.
    // w_member_social is provisioned now so Sprint 26 can broadcast posts
    // (LinkedIn's API forbids cold per-person DMs) without a reconnect.
    key: "linkedin",
    label: "LinkedIn",
    nangoProvider: "linkedin",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://api.linkedin.com",
    testPath: "/v2/userinfo",
    oauthScopes: "openid,profile,email,w_member_social",
  },
  {
    // Key stays "twitter" to match Nango's twitter-v2 template family; the UI
    // shows the "X (Twitter)" label. tweet.* + dm.* are provisioned now so
    // Sprint 26 can post AND send per-recipient DMs; offline.access keeps the
    // token refreshable. Scopes are stored comma-separated like every other
    // provider — Nango's twitter-v2 template emits the space separator X wants.
    key: "twitter",
    label: "X (Twitter)",
    nangoProvider: "twitter-v2",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://api.twitter.com",
    testPath: "/2/users/me",
    oauthScopes: "tweet.read,tweet.write,users.read,dm.read,dm.write,offline.access",
  },
  {
    // Instagram content publishing runs through the Facebook Graph API and
    // needs an Instagram Business/Creator account linked to a Facebook Page,
    // plus a Facebook app with instagram_content_publish approved. Creds are
    // the Facebook app's INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET.
    // testPath hits /me to verify identity; Sprint 26 does the broadcast post.
    key: "instagram",
    label: "Instagram",
    nangoProvider: "facebook",
    authMode: "oauth",
    categories: ["social"],
    baseUrl: "https://graph.facebook.com",
    testPath: "/v23.0/me",
    oauthScopes:
      "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management",
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

export const connectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  providerKey: z.string(),
  nangoConnectionId: z.string(),
  config: z.object({
    baseUrl: z.string().optional(),
    testPath: z.string().optional(),
  }),
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
export const CALENDAR_ENTRY_STATUSES = ["open", "scheduled", "published", "failed"] as const;
export type CalendarEntryStatus = (typeof CALENDAR_ENTRY_STATUSES)[number];

export const calendarEntrySchema = z.object({
  kind: z.enum(["slot", "publication"]),
  at: z.number().int(),
  cadenceId: z.string().uuid().nullable(),
  cadenceName: z.string().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  providerKey: z.string().nullable(),
  status: z.enum(CALENDAR_ENTRY_STATUSES),
  title: z.string(),
  draftId: z.string().uuid().nullable(),
  publicationId: z.string().uuid().nullable(),
  url: z.string().nullable(),
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
 * Launch approval statuses. `launched` is terminal in the approval machine —
 * runtime platform state (active/paused/disapproved) lives in platformStatus.
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

/** Decision-log actions: the machine moves plus the launch trigger itself. */
export const AD_LAUNCH_DECISION_ACTIONS = [...AD_LAUNCH_ACTIONS, "launch"] as const;
export type AdLaunchDecisionAction = (typeof AD_LAUNCH_DECISION_ACTIONS)[number];

/**
 * The launch state machine — spend is gated on `approved`. `revise` pulls a
 * launch back to draft from anywhere short of launched.
 */
const AD_LAUNCH_TRANSITIONS: Record<
  AdLaunchAction,
  Partial<Record<AdLaunchStatus, AdLaunchStatus>>
> = {
  submit: { draft: "pending_review" },
  approve: { pending_review: "approved" },
  reject: { pending_review: "rejected" },
  revise: { pending_review: "draft", rejected: "draft", approved: "draft" },
};

export function adLaunchTransitionTo(
  from: AdLaunchStatus,
  action: AdLaunchAction,
): AdLaunchStatus | undefined {
  return AD_LAUNCH_TRANSITIONS[action][from];
}

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
  // The Sprint 14 ad_campaigns mirror row created on launch.
  adCampaignId: z.string().uuid().nullable(),
  // Raw platform effective_status, stamped by the sync job and pause/resume.
  platformStatus: z.string().nullable(),
  launchedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
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
  dailyBudgetCents: z
    .number()
    .int()
    .min(100, "Daily budget must be at least 100 cents")
    .max(100_000_000),
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
  updatedAt: z.number().int(),
});
export type SocialAutomationSettings = z.infer<typeof socialAutomationSettingsSchema>;

export const updateSocialAutomationSettingsInputSchema = z.object({
  killSwitch: z.boolean().optional(),
  perConnectionDailyCap: z.number().int().positive().max(1000).optional(),
  perCampaignDailyCap: z.number().int().positive().max(1000).optional(),
  autoReplyEnabled: z.boolean().optional(),
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

/** A comment on one of our posts, or a reply to one of our outbound DMs. */
export const INBOX_ITEM_KINDS = ["comment", "dm"] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

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
});
export type InboxItemWithContext = z.infer<typeof inboxItemWithContextSchema>;

/** Only `read`/`dismissed` are hand-settable; `replied` is system-set on a posted reply. */
export const updateInboxItemStatusInputSchema = z.object({
  status: z.enum(["read", "dismissed"]),
});
export type UpdateInboxItemStatusInput = z.infer<typeof updateInboxItemStatusInputSchema>;

/** Engagement snapshot windows after publish. */
export const METRIC_WINDOWS = ["24h", "7d"] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

export const publicationMetricSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  publicationId: z.string().uuid(),
  window: z.enum(METRIC_WINDOWS),
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

export const LAUNCH_MEDIA_TYPES = ["image", "video"] as const;
export type LaunchMediaType = (typeof LAUNCH_MEDIA_TYPES)[number];

export const launchMediaSchema = z.object({
  url: z.string().trim().url("A valid media URL is required"),
  type: z.enum(LAUNCH_MEDIA_TYPES),
});
export type LaunchMedia = z.infer<typeof launchMediaSchema>;

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
// Onboarding (Sprint 38)
// ---------------------------------------------------------------------------

export const BRAIN_DOC_TEMPLATES = [
  {
    id: "b2b-saas-founder",
    label: "B2B SaaS founder",
    docs: { soul: "...", icp: "...", voice: "...", history: "", now: "" },
  },
  {
    id: "agency",
    label: "Agency",
    docs: { soul: "...", icp: "...", voice: "...", history: "", now: "" },
  },
  {
    id: "dev-tool",
    label: "Dev-tool",
    docs: { soul: "...", icp: "...", voice: "...", history: "", now: "" },
  },
] as const;

export const onboardingStepSchema = z.object({
  key: z.enum(["workspace", "brain", "connect", "generate", "approve"]),
  label: z.string(),
  done: z.boolean(),
  cta: z.string(),
});
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

// ---------------------------------------------------------------------------
// Pricing plans & feature gating (Sprint 37)
// ---------------------------------------------------------------------------

export const PLAN_IDS = ["free", "pro", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Entitlements {
  seats: number;          // -1 = unlimited
  connectors: number;
  monthlyGenerations: number;
  adSpendCapCents: number;
}

export const PLANS: Record<PlanId, { label: string; priceEnv: string | null; entitlements: Entitlements }> = {
  free:  { label: "Free",  priceEnv: null,                entitlements: { seats: 1,  connectors: 1,  monthlyGenerations: 50,   adSpendCapCents: 0 } },
  pro:   { label: "Pro",   priceEnv: "STRIPE_PRICE_PRO",  entitlements: { seats: 5,  connectors: 10, monthlyGenerations: 1000, adSpendCapCents: 500_00 } },
  scale: { label: "Scale", priceEnv: "STRIPE_PRICE_SCALE",entitlements: { seats: -1, connectors: -1, monthlyGenerations: -1,   adSpendCapCents: -1 } },
};

export const entitlementUsageSchema = z.object({
  seats: z.number().int(),
  connectors: z.number().int(),
  monthlyGenerations: z.number().int(),
});
export type EntitlementUsage = z.infer<typeof entitlementUsageSchema>;

export const checkoutInputSchema = z.object({
  plan: z.enum(["pro", "scale"]),
});
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

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
});
export type WorkspaceCapabilities = z.infer<typeof workspaceCapabilitiesSchema>;

export type NavRequirement = "ads" | "insights" | "crm" | "connections";

export interface NavChild {
  label: string;
  path: string;
  summary?: string;
  tone?: "belief" | "voice" | "history" | "icp" | "system" | "signal";
  requires?: NavRequirement;
}

export interface NavItem {
  label: string;
  path: string;
  summary?: string;
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
  },
  {
    label: "Brain",
    path: "/brain",
    summary: "Company context, evidence, and inspection",
    tone: "system",
    children: [
      { label: "Brain docs", path: "/brain", summary: "The editable GTM memory", tone: "system" },
      { label: "Evidence library", path: "/evidence", summary: "Proof and source material", tone: "history" },
      { label: "Context inspector", path: "/resolver", summary: "See what Tuezday will use", tone: "icp" },
    ],
  },
  {
    label: "Campaigns",
    path: "/campaigns",
    summary: "Plans, calendar, automation, ads, and reporting",
    tone: "voice",
    children: [
      { label: "Campaign home", path: "/campaigns", summary: "Goals and GTM pushes", tone: "voice" },
      { label: "Calendar", path: "/calendar", summary: "Scheduled posts and work", tone: "history" },
      { label: "Cadence", path: "/cadence", summary: "Publishing rhythm", tone: "history" },
      { label: "Automation", path: "/automation", summary: "Human-in-the-loop rules", tone: "signal" },
      { label: "Ads", path: "/ads", summary: "Paid channel performance", tone: "belief", requires: "ads" },
      { label: "Launch ads", path: "/ad-launches", summary: "Spend-controlled ad launches", tone: "belief", requires: "ads" },
      { label: "Insights", path: "/insights", summary: "What worked and why", tone: "icp", requires: "insights" },
    ],
  },
  {
    label: "Discover",
    path: "/discovery",
    summary: "Market signals worth acting on",
    tone: "signal",
  },
  {
    label: "Create",
    path: "/content",
    summary: "Draft content, ads, and channel assets",
    tone: "belief",
    children: [
      { label: "Content", path: "/content", summary: "Posts and signal responses", tone: "belief" },
      { label: "Playground", path: "/sandbox", summary: "Generate from the Brain", tone: "system" },
      { label: "Ad creatives", path: "/ad-creatives", summary: "Platform-ready variants", tone: "voice" },
    ],
  },
  {
    label: "Review",
    path: "/approvals",
    summary: "Approve, edit, reply, and teach the Brain",
    tone: "icp",
    children: [
      { label: "Approval queue", path: "/approvals", summary: "Nothing ships without review", tone: "icp" },
      { label: "Inbox", path: "/inbox", summary: "Replies and engagement", tone: "signal" },
      { label: "Learning", path: "/learning", summary: "Brain updates from decisions", tone: "history" },
    ],
  },
  {
    label: "Audience",
    path: "/outbound",
    summary: "Leads, lists, launches, CRM, and PR contacts",
    tone: "icp",
    children: [
      { label: "Outbound", path: "/outbound", summary: "Lead-driven drafts", tone: "icp" },
      { label: "Lists & segments", path: "/lists", summary: "Reusable audiences", tone: "icp" },
      { label: "Launches", path: "/launches", summary: "Targeted campaign sends", tone: "voice" },
      { label: "CRM", path: "/crm", summary: "Contacts and account context", tone: "icp" },
      { label: "PR & media", path: "/pr", summary: "Media contacts and pitches", tone: "belief" },
    ],
  },
  {
    label: "Settings",
    path: "/connectors",
    summary: "Integrations, team, billing, and account control",
    tone: "system",
    children: [
      { label: "Integrations", path: "/connectors", summary: "Connect the stack", tone: "system" },
      { label: "Team", path: "/team", summary: "Members and invites", tone: "icp" },
      { label: "Billing", path: "/billing", summary: "Plan and usage", tone: "history" },
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
