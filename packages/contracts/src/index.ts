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
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Channels a task can target. */
export const CHANNELS = ["linkedin", "x", "email", "ads", "web", "pr"] as const;
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
// Evidence corpus (RAG behind the Brain Gateway boundary)
// ---------------------------------------------------------------------------

export const EVIDENCE_STATUSES = ["processing", "ready", "failed"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_MAX_CHARS = 200_000;

export const evidenceDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  r2rDocumentId: z.string().nullable(),
  title: z.string().min(1).max(200),
  chars: z.number().int(),
  status: z.enum(EVIDENCE_STATUSES),
  error: z.string().nullable(),
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
  createdAt: z.number().int(),
});
export type Lead = z.infer<typeof leadSchema>;

export const createLeadInputSchema = z.object({
  name: z.string().trim().min(1, "Lead name is required").max(200),
  email: z.string().trim().email("A valid email is required"),
  company: z.string().trim().max(200).default(""),
  role: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(2000).default(""),
});
export type CreateLeadInput = z.infer<typeof createLeadInputSchema>;

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
  status: z.enum(CONNECTION_STATUSES),
  lastCheckedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
});
export type Connection = z.infer<typeof connectionSchema>;

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
}

export const SOCIAL_POST_CONSTRAINTS = {
  // https://www.reddit.com — self (text) posts.
  reddit: { targetLabel: "Subreddit", titleMaxChars: 300, bodyMaxChars: 40_000 },
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
// API error shape
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
