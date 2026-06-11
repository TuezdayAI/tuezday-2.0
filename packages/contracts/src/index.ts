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
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Channels a task can target. */
export const CHANNELS = ["linkedin", "x", "email", "ads", "web"] as const;
export type Channel = (typeof CHANNELS)[number];

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
});
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

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
  prompt: z.string(),
  output: z.string(),
  model: z.string(),
  provider: z.string(),
  durationMs: z.number().int(),
  rating: z.enum(OUTPUT_RATINGS).nullable(),
  ratedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Generation = z.infer<typeof generationSchema>;

/** Generate takes the same inputs as resolve. */
export const generateRequestSchema = resolveRequestSchema;
export type GenerateRequest = ResolveRequest;

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
});
export type UpsertCampaignInput = z.infer<typeof upsertCampaignInputSchema>;

// ---------------------------------------------------------------------------
// Signals (manual market input — source adapters arrive in a later slice)
// ---------------------------------------------------------------------------

export const SIGNAL_SOURCES = ["reddit", "x", "linkedin", "rss", "news", "other"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_MAX_CHARS = 10_000;

export const signalSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  content: z.string().min(1).max(SIGNAL_MAX_CHARS),
  source: z.enum(SIGNAL_SOURCES),
  sourceUrl: z.string().nullable(),
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
});
export type CreateSignalInput = z.infer<typeof createSignalInputSchema>;

/** Drafting a response to a signal: the task type is implied (signal_response). */
export const draftSignalRequestSchema = z.object({
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  tokenBudget: z.number().int().min(500).max(200_000).optional(),
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
export const DISCOVERY_SOURCE_TYPES = ["rss", "google_news", "reddit", "x", "linkedin"] as const;
export type DiscoverySourceType = (typeof DISCOVERY_SOURCE_TYPES)[number];

export const DISCOVERY_SOURCE_STATUSES = ["active", "needs_api_key", "error"] as const;
export type DiscoverySourceStatus = (typeof DISCOVERY_SOURCE_STATUSES)[number];

export const DISCOVERED_ITEM_STATUSES = ["new", "accepted", "skipped"] as const;
export type DiscoveredItemStatus = (typeof DISCOVERED_ITEM_STATUSES)[number];

export const discoverySourceConfigSchema = z.object({
  feedUrl: z.string().url().optional(),
  query: z.string().trim().max(200).optional(),
  subreddit: z.string().trim().max(100).optional(),
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
  scoreReason: z.string().nullable(),
  status: z.enum(DISCOVERED_ITEM_STATUSES),
  signalId: z.string().uuid().nullable(),
  createdAt: z.number().int(),
});
export type DiscoveredItem = z.infer<typeof discoveredItemSchema>;

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
  taskType: z.enum(TASK_TYPES),
  channel: z.enum(CHANNELS),
  personaId: z.string().uuid().nullable(),
  originalContent: z.string(),
  content: z.string(),
  state: z.enum(APPROVAL_STATES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
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
// API error shape
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
