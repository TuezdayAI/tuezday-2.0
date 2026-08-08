import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

// Postgres (Sprint 74). The portability rule this schema was written under —
// text ids, epoch-ms integer timestamps, no dialect-only column tricks — is
// what made the swap from SQLite mechanical.
//
// Two conventions worth knowing before you add a column:
//   * Timestamps are epoch milliseconds in `bigint({ mode: "number" })`, never
//     `timestamp`. Postgres `integer` is int4 (max ~2.1e9) and epoch-ms is
//     ~1.7e12, so `integer` silently overflows — every integer column here is
//     bigint for that reason, and `mode: "number"` keeps the TypeScript type a
//     plain `number`.
//   * A handful of tables carry a `seq bigserial` purely as an insertion-order
//     tie-breaker for same-millisecond rows. It replaces SQLite's implicit
//     `rowid`, which Postgres has no equivalent of.

/** Embedding width of the evidence store's vectors (Gemini text-embedding). */
export const EVIDENCE_EMBEDDING_DIMENSIONS = 768;

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  analyticsOptOut: boolean("analytics_opt_out").notNull().default(false),
  // Onboarding wizard (Sprint 36.1): the site the brain will be drafted from,
  // and where the workspace stands in the wizard (null = pre-wizard workspace).
  websiteUrl: text("website_url"),
  onboardingStep: text("onboarding_step"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;

// One extracted brand profile per workspace (Sprint 36.2). Overwritten on
// re-run; editable via PATCH once ready. profileJson holds a BrandProfile.
export const brandProfiles = pgTable(
  "brand_profiles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull().default("scraping"),
    profileJson: text("profile_json"),
    error: text("error"),
    corpusChars: bigint("corpus_chars", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("brand_profiles_workspace").on(t.workspaceId)],
);

export type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    // Format: scrypt$<salt-hex>$<hash-hex> — see services/auth.ts.
    passwordHash: text("password_hash"),
    googleSub: text("google_sub"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("users_email").on(t.email), uniqueIndex("users_google_sub").on(t.googleSub)],
);

export type UserRow = typeof users.$inferSelect;

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 of the bearer token; the raw token is only ever returned once.
    tokenHash: text("token_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("sessions_token_hash").on(t.tokenHash)],
);

export type SessionRow = typeof sessions.$inferSelect;

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workspace_members_workspace_user").on(t.workspaceId, t.userId)],
);

export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    token: text("token").notNull(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    acceptedAt: bigint("accepted_at", { mode: "number" }),
  },
  (t) => [uniqueIndex("workspace_invites_token").on(t.token)],
);

export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect;

export const brainDocuments = pgTable(
  "brain_documents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    content: text("content").notNull().default(""),
    // Sprint 43: DocOutline JSON (headings + one-line summaries), regenerated
    // on every save. Null for empty docs and docs saved before outlines
    // existed (derived on the fly at resolve time).
    outlineJson: text("outline_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("brain_documents_workspace_doc_type").on(t.workspaceId, t.docType)],
);

export type BrainDocumentRow = typeof brainDocuments.$inferSelect;

export const brainDocumentVersions = pgTable("brain_document_versions", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => brainDocuments.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull(),
  content: text("content").notNull(),
  // Nullable: versions written before auth existed (Sprint 19).
  actor: text("actor"),
  actorId: text("actor_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type BrainDocumentVersionRow = typeof brainDocumentVersions.$inferSelect;

// Per-workspace, per-channel guidance overrides (Sprint 21). The built-in
// defaults live in @tuezday/contracts; this table holds overrides only. A
// missing row means "use the default" for that channel. Sprint 44 adds
// optional persona/campaign scope: NULL persona+campaign is the workspace-wide
// override; resolution picks the most specific matching row. SQLite treats
// NULLs as distinct in the unique index, so the service layer upserts
// select-first rather than relying on ON CONFLICT for the unscoped row.
export const guidanceOverrides = pgTable(
  "guidance_overrides",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("guidance_overrides_workspace_channel_scope").on(
      t.workspaceId,
      t.channel,
      t.personaId,
      t.campaignId,
    ),
  ],
);

export type GuidanceOverrideRow = typeof guidanceOverrides.$inferSelect;

// Per-workspace task-matrix overrides (Sprint 43). The shipped defaults live
// in @tuezday/contracts (DEFAULT_TASK_DOC_MATRIX); this table holds overrides
// only. A missing row means "use the default" for that taskType × docType.
export const contextMatrixOverrides = pgTable(
  "context_matrix_overrides",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskType: text("task_type").notNull(),
    docType: text("doc_type").notNull(),
    mode: text("mode").notNull(),
    // Optional founder-written why; falls back to the default cell's reason.
    reason: text("reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("context_matrix_overrides_workspace_task_doc").on(
      t.workspaceId,
      t.taskType,
      t.docType,
    ),
  ],
);

export type ContextMatrixOverrideRow = typeof contextMatrixOverrides.$inferSelect;

export const personas = pgTable("personas", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  overlay: text("overlay").notNull().default(""),
  // Sprint 44 structured drafting fields. topicsJson is a JSON string array.
  topicsJson: text("topics_json").notNull().default("[]"),
  tone: text("tone").notNull().default(""),
  styleRules: text("style_rules").notNull().default(""),
  avoid: text("avoid").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type PersonaRow = typeof personas.$inferSelect;

export const generations = pgTable("generations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  taskType: text("task_type").notNull(),
  channel: text("channel").notNull(),
  personaId: text("persona_id"),
  campaignId: text("campaign_id"),
  leadId: text("lead_id"),
  mediaContactId: text("media_contact_id"),
  prompt: text("prompt").notNull(),
  sectionsJson: text("sections_json").notNull(),
  output: text("output").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
  rating: text("rating"),
  ratedAt: bigint("rated_at", { mode: "number" }),
  // Sprint 22 dual-LLM pre-review of `output`, as JSON (GenerationReview).
  // Null when review is disabled or never ran.
  reviewJson: text("review_json"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type GenerationRow = typeof generations.$inferSelect;

export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceGenerationId: text("source_generation_id"),
    sourceSignalId: text("source_signal_id"),
    campaignId: text("campaign_id"),
    leadId: text("lead_id"),
    mediaContactId: text("media_contact_id"),
    taskType: text("task_type").notNull(),
    channel: text("channel").notNull(),
    personaId: text("persona_id"),
    originalContent: text("original_content").notNull(),
    content: text("content").notNull(),
    state: text("state").notNull(),
    // Internal-only deterministic identity for automatic signal fan-out.
    // Manual submissions intentionally leave this null.
    automationKey: text("automation_key"),
    // Sprint 22 pre-review (GenerationReview JSON), copied from the source
    // generation at submit or refreshed by the Re-run review action. Null when
    // never reviewed.
    reviewJson: text("review_json"),
    // Sprint 41: rendered visuals (LaunchMedia[] JSON) — what a reviewer sees,
    // while content holds what they read. Null for text-only drafts.
    mediaJson: text("media_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("drafts_automation_key")
      .on(t.automationKey)
      .where(sql`${t.automationKey} IS NOT NULL`),
  ],
);

export type DraftRow = typeof drafts.$inferSelect;

export const approvalDecisions = pgTable("approval_decisions", {
  /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
  seq: bigserial("seq", { mode: "number" }),
  id: text("id").primaryKey(),
  draftId: text("draft_id")
    .notNull()
    .references(() => drafts.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  contentSnapshot: text("content_snapshot"),
  // Sprint 52: sha256 of exactly what was approved (draft id + content + media).
  // Written ONLY for `approve` decisions made by a human actor — a null here is
  // what stops a system/auto-approval from collapsing the publish gate.
  contentFingerprint: text("content_fingerprint"),
  actor: text("actor").notNull(),
  // Nullable: decisions logged before auth existed, or by the system actor.
  actorId: text("actor_id"),
  // Sprint 66: the human's stated rationale, captured optionally at the gate.
  // Today only rejections offer the input; null wherever it wasn't given.
  reason: text("reason"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type ApprovalDecisionRow = typeof approvalDecisions.$inferSelect;

// UI revamp conversational editor: one persisted natural-language revision
// turn per request. The draft remains the approval object and owns the state
// transition; these rows preserve conversation, provider metadata, and trace.
export const draftRevisionTurns = pgTable(
  "draft_revision_turns",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    instruction: text("instruction").notNull(),
    sourceContent: text("source_content").notNull(),
    resultContent: text("result_content"),
    sectionsJson: text("sections_json").notNull().default("[]"),
    status: text("status").notNull(),
    error: text("error"),
    model: text("model"),
    provider: text("provider"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("draft_revision_turn_request").on(t.draftId, t.requestId),
    index("draft_revision_turn_draft").on(t.draftId, t.createdAt),
  ],
);

export type DraftRevisionTurnRow = typeof draftRevisionTurns.$inferSelect;

export const signals = pgTable("signals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  // Auto-mapping (Sprint 31): carried from a discovered item on accept so the
  // Content draft can pre-fill persona + campaign. Null for manual signals.
  suggestedPersonaId: text("suggested_persona_id"),
  suggestedCampaignId: text("suggested_campaign_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type SignalRow = typeof signals.$inferSelect;

export const taskLeases = pgTable("task_leases", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  heartbeatAt: bigint("heartbeat_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type TaskLeaseRow = typeof taskLeases.$inferSelect;

// Durable application job queue (Sprint 73). The generic rows own admission,
// leases, retries and observability; domain ledgers remain the source of truth
// for the work itself.
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    // Equal to idempotencyKey while queued/running and cleared at terminal
    // state. A normal nullable unique index is portable to PostgreSQL.
    activeKey: text("active_key"),
    priority: bigint("priority", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("queued"),
    availableAt: bigint("available_at", { mode: "number" }).notNull(),
    attempt: bigint("attempt", { mode: "number" }).notNull().default(0),
    maxAttempts: bigint("max_attempts", { mode: "number" }).notNull().default(5),
    leaseOwner: text("lease_owner"),
    leaseVersion: bigint("lease_version", { mode: "number" }).notNull().default(0),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    lastError: text("last_error"),
    resultJson: text("result_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("background_jobs_active_key_unique").on(t.activeKey),
    index("background_jobs_status_available").on(
      t.status,
      t.availableAt,
      t.priority,
      t.createdAt,
    ),
    index("background_jobs_workspace_status").on(
      t.workspaceId,
      t.status,
      t.availableAt,
    ),
    index("background_jobs_lease_expiry").on(t.status, t.leaseExpiresAt),
  ],
);

export type BackgroundJobRow = typeof backgroundJobs.$inferSelect;

export const backgroundSchedules = pgTable(
  "background_schedules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    intervalMs: bigint("interval_ms", { mode: "number" }).notNull(),
    nextRunAt: bigint("next_run_at", { mode: "number" }).notNull(),
    lastEnqueuedAt: bigint("last_enqueued_at", { mode: "number" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("background_schedules_workspace_kind_unique").on(
      t.workspaceId,
      t.kind,
    ),
    index("background_schedules_due").on(t.enabled, t.nextRunAt),
  ],
);

export type BackgroundScheduleRow = typeof backgroundSchedules.$inferSelect;

export const backgroundWorkspaceDispatch = pgTable(
  "background_workspace_dispatch",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastDispatchedAt: bigint("last_dispatched_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
);

export type BackgroundWorkspaceDispatchRow =
  typeof backgroundWorkspaceDispatch.$inferSelect;

export const discoverySources = pgTable("discovery_sources", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull(),
  lastError: text("last_error"),
  lastFetchedAt: bigint("last_fetched_at", { mode: "number" }),
  // Connected sourcing (Sprint 46): the workspace connection this source reads
  // through; null for keyless sources. No declared FK to `connections`:
  // drizzle-kit's SQLite ALTER TABLE ADD action gap (deferred #26) — cleared
  // at the service level when a connection is deleted.
  connectionId: text("connection_id"),
  // Best-effort provider pagination state keyed by mode.
  cursorJson: text("cursor_json").notNull().default("{}"),
  // Rate-limit back-pressure: the source is not enqueued until this passes.
  backoffUntil: bigint("backoff_until", { mode: "number" }),
  lastAttemptedAt: bigint("last_attempted_at", { mode: "number" }),
  executionVersion: bigint("execution_version", { mode: "number" }).notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type DiscoverySourceRow = typeof discoverySources.$inferSelect;

// Discovery job ledger (Sprint 46): one row per source fetch attempt. Bounded
// batches per `/discovery/run` give retries, per-source progress, and prevent
// one slow provider from serializing the whole workspace — no external queue.
export const discoveryJobs = pgTable(
  "discovery_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => discoverySources.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // queued | running | succeeded | failed | skipped
    attempt: bigint("attempt", { mode: "number" }).notNull().default(0),
    lockedAt: bigint("locked_at", { mode: "number" }),
    sourceExecutionVersion: bigint("source_execution_version", { mode: "number" }).notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseVersion: bigint("lease_version", { mode: "number" }).notNull().default(0),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    fetchedCount: bigint("fetched_count", { mode: "number" }).notNull().default(0),
    newCount: bigint("new_count", { mode: "number" }).notNull().default(0),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("discovery_jobs_workspace_status").on(t.workspaceId, t.status, t.createdAt),
    index("discovery_jobs_source_status").on(t.sourceId, t.status),
    uniqueIndex("discovery_jobs_one_active_source")
      .on(t.sourceId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export type DiscoveryJobRow = typeof discoveryJobs.$inferSelect;

// Tracked social accounts (Sprint 46): first-class competitor/source accounts.
// Discovery sources reference them via config.trackedAccountId(s) — no FK from
// the JSON config, so services resolve the complete enabled set strictly on
// source create, update, and fetch.
export const trackedSocialAccounts = pgTable(
  "tracked_social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // "x" | "linkedin" | "instagram" | "reddit"
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    // Provider-side id (e.g. a LinkedIn author URN) once resolved.
    externalId: text("external_id"),
    url: text("url"),
    notes: text("notes").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    lastResolvedAt: bigint("last_resolved_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("tracked_social_account_unique").on(t.workspaceId, t.platform, t.handle)],
);

export type TrackedSocialAccountRow = typeof trackedSocialAccounts.$inferSelect;

export const discoveredItems = pgTable(
  "discovered_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => discoverySources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    summary: text("summary").notNull().default(""),
    publishedAt: bigint("published_at", { mode: "number" }),
    score: bigint("score", { mode: "number" }),
    suggestedPersonaId: text("suggested_persona_id"),
    suggestedCampaignId: text("suggested_campaign_id"),
    scoreReason: text("score_reason"),
    status: text("status").notNull().default("new"),
    signalId: text("signal_id"),
    // When the item was last LLM-judged. Null for never-scored items; queue
    // eligibility is controlled by matchingState rather than this timestamp.
    scoredAt: bigint("scored_at", { mode: "number" }),
    matchingState: text("matching_state").notNull().default("pending"),
    matchingVersion: bigint("matching_version", { mode: "number" }).notNull().default(0),
    matchingInputFingerprint: text("matching_input_fingerprint"),
    matchingLeaseOwner: text("matching_lease_owner"),
    matchingLeaseExpiresAt: bigint("matching_lease_expires_at", { mode: "number" }),
    matchingHeartbeatAt: bigint("matching_heartbeat_at", { mode: "number" }),
    matchingError: text("matching_error"),
    // Sprint 45 cross-source dedup: sha256 of the normalized URL (null when the
    // item has no URL) and of the normalized title + summary prefix.
    urlHash: text("url_hash"),
    contentHash: text("content_hash").notNull().default(""),
    // Self-reference to the canonical item when status = "duplicate". No
    // declared FK: drizzle-kit's SQLite ALTER TABLE ADD cascade gap (deferred
    // #26) — enforced at the service level instead.
    duplicateOfId: text("duplicate_of_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("discovered_items_source_external").on(t.sourceId, t.externalId),
    index("discovered_items_workspace_url_hash").on(t.workspaceId, t.urlHash),
    index("discovered_items_workspace_content_hash").on(t.workspaceId, t.contentHash),
    index("discovered_items_matching_queue").on(
      t.matchingState,
      t.matchingLeaseExpiresAt,
      t.createdAt,
    ),
  ],
);

export type DiscoveredItemRow = typeof discoveredItems.$inferSelect;

// ---------------------------------------------------------------------------
// Canonical stories & source occurrences (Sprint 60, design §8.1–8.4).
// Shadow intelligence layer beside discovered-items triage: immutable
// occurrences resolve by exact identity keys into canonical stories with
// reversible membership and versioned enrichment.
// ---------------------------------------------------------------------------

export const discoverySourceOccurrences = pgTable(
  "discovery_source_occurrences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Deliberately no FK: occurrences are the immutable historical record and
    // must survive source deletion; the type/name snapshot below stays valid.
    sourceId: text("source_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceName: text("source_name").notNull(),
    // discovery_jobs row of the fetch attempt (no FK — jobs cascade with their
    // source). Null for rows synthesized by the backfill.
    fetchRunId: text("fetch_run_id"),
    providerExternalId: text("provider_external_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    // Adapters don't emit authors yet; the column exists so future adapters
    // need no migration.
    author: text("author"),
    providerPublishedAt: bigint("provider_published_at", { mode: "number" }),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    // hashUrl / hashContent from services/discovery.ts — same normalizers as
    // discovered_items so the shadow layer and Sprint 45 dedupe agree.
    normalizedUrlKey: text("normalized_url_key"),
    contentFingerprint: text("content_fingerprint").notNull(),
    // Bounded provider snapshot. Never holds fields needed for joins,
    // filtering, or uniqueness (TAP-19 invariant).
    rawMetadataJson: text("raw_metadata_json").notNull().default("{}"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("discovery_source_occurrences_source_external").on(
      t.sourceId,
      t.providerExternalId,
    ),
    index("discovery_source_occurrences_workspace_observed").on(
      t.workspaceId,
      t.observedAt,
    ),
  ],
);

export type DiscoverySourceOccurrenceRow =
  typeof discoverySourceOccurrences.$inferSelect;

export const canonicalExternalStories = pgTable(
  "canonical_external_stories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    // Founding occurrence's URL/title/fingerprint — stable; later variants
    // live in enrichment payloads, not here.
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    firstObservedAt: bigint("first_observed_at", { mode: "number" }).notNull(),
    lastObservedAt: bigint("last_observed_at", { mode: "number" }).notNull(),
    currentEnrichmentVersion: bigint("current_enrichment_version", { mode: "number" })
      .notNull()
      .default(0),
    // Set when this story was archived by a manual merge (self-reference; no
    // FK to keep the initial CREATE simple and the pointer historical).
    mergedIntoStoryId: text("merged_into_story_id"),
    archivedAt: bigint("archived_at", { mode: "number" }),
    // Sprint 61 opportunity-routing queue — mirrors the discovered_items
    // matching-state machinery (lease + fingerprint fence).
    routingState: text("routing_state").notNull().default("pending"),
    routingFingerprint: text("routing_fingerprint"),
    routingLeaseExpiresAt: bigint("routing_lease_expires_at", { mode: "number" }),
    routingAttempts: bigint("routing_attempts", { mode: "number" }).notNull().default(0),
    routedAt: bigint("routed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("canonical_stories_workspace_status").on(
      t.workspaceId,
      t.status,
      t.lastObservedAt,
    ),
    index("canonical_stories_routing_queue").on(
      t.workspaceId,
      t.routingState,
      t.routingLeaseExpiresAt,
    ),
  ],
);

export type CanonicalExternalStoryRow =
  typeof canonicalExternalStories.$inferSelect;

// Exact identity child table (design §8.2): several keys may identify one
// story; a key belongs to exactly one story per workspace.
export const canonicalStoryKeys = pgTable(
  "canonical_story_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storyId: text("story_id")
      .notNull()
      .references(() => canonicalExternalStories.id, { onDelete: "cascade" }),
    keyKind: text("key_kind").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("canonical_story_keys_identity").on(
      t.workspaceId,
      t.keyKind,
      t.keyHash,
    ),
    index("canonical_story_keys_story").on(t.storyId),
  ],
);

export type CanonicalStoryKeyRow = typeof canonicalStoryKeys.$inferSelect;

// Reversible membership (design §8.3). Rows are never deleted: a merge or
// split closes the active row (detachedAt) and writes a new one.
export const storyOccurrences = pgTable(
  "story_occurrences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storyId: text("story_id")
      .notNull()
      .references(() => canonicalExternalStories.id, { onDelete: "cascade" }),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => discoverySourceOccurrences.id, { onDelete: "cascade" }),
    relationshipKind: text("relationship_kind").notNull(),
    confidence: bigint("confidence", { mode: "number" }).notNull(),
    matcherVersion: bigint("matcher_version", { mode: "number" }).notNull().default(1),
    attachedAt: bigint("attached_at", { mode: "number" }).notNull(),
    // Null = the system resolver; set for manual merge/split attaches.
    attachedByUserId: text("attached_by_user_id"),
    attachReason: text("attach_reason"),
    detachedAt: bigint("detached_at", { mode: "number" }),
    detachedByUserId: text("detached_by_user_id"),
    detachReason: text("detach_reason"),
  },
  (t) => [
    // Exactly one active membership per occurrence.
    uniqueIndex("story_occurrences_one_active")
      .on(t.occurrenceId)
      .where(sql`${t.detachedAt} IS NULL`),
    index("story_occurrences_story").on(t.storyId, t.detachedAt),
  ],
);

export type StoryOccurrenceRow = typeof storyOccurrences.$inferSelect;

// Immutable, versioned enrichment output (design §8.4). storyFingerprint
// covers the active membership's content, so unchanged membership re-runs
// are no-ops and membership changes append rather than overwrite.
export const storyEnrichments = pgTable(
  "story_enrichments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storyId: text("story_id")
      .notNull()
      .references(() => canonicalExternalStories.id, { onDelete: "cascade" }),
    storyFingerprint: text("story_fingerprint").notNull(),
    enricherVersion: bigint("enricher_version", { mode: "number" }).notNull(),
    // Distinct sources among active members — a real column because quality
    // gates filter on it; the JSON payload is display/snapshot data only.
    corroborationCount: bigint("corroboration_count", { mode: "number" }).notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("story_enrichments_identity").on(
      t.storyId,
      t.storyFingerprint,
      t.enricherVersion,
    ),
  ],
);

export type StoryEnrichmentRow = typeof storyEnrichments.$inferSelect;

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  objective: text("objective").notNull().default(""),
  kpi: text("kpi").notNull().default(""),
  timeframe: text("timeframe").notNull().default(""),
  audience: text("audience").notNull().default(""),
  pillarsJson: text("pillars_json").notNull().default("[]"),
  channelsJson: text("channels_json").notNull().default("[]"),
  personaIdsJson: text("persona_ids_json").notNull().default("[]"),
  overlay: text("overlay").notNull().default(""),
  // Control-plane identity. Existing campaigns migrate as user-created,
  // initiative campaigns; always-on system campaigns opt into other values.
  origin: text("origin").notNull().default("user"),
  purpose: text("purpose").notNull().default("initiative"),
  status: text("status").notNull().default("active"),
  // Social automation mode (Sprint 28): manual | human_in_the_loop | scheduled_auto.
  automationMode: text("automation_mode").notNull().default("manual"),
  // Per-campaign override of the daily auto-post cap; null = workspace default.
  autoDailyCap: bigint("auto_daily_cap", { mode: "number" }),
  // Sprint 61 routing policy (design §9.4). Lives here, not on the immutable
  // plan revision, so the founder can tune autonomy without a new revision.
  routingBand: text("routing_band").notNull().default("review"),
  routingMinFit: bigint("routing_min_fit", { mode: "number" }).notNull().default(70),
  routingMinConfidence: bigint("routing_min_confidence", { mode: "number" }).notNull().default(60),
  // 0 = not enforced until source classes exist (D-61.4).
  routingMinTrust: bigint("routing_min_trust", { mode: "number" }).notNull().default(0),
  // Exclusion keywords — policy config consumed by the compiler/stage-1
  // service code, never joined or SQL-filtered.
  routingExclusionsJson: text("routing_exclusions_json").notNull().default("[]"),
  // Service-validated pointer to the active immutable plan revision. Kept as
  // a plain id to avoid a circular SQLite table-recreate migration.
  currentPlanRevisionId: text("current_plan_revision_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type CampaignRow = typeof campaigns.$inferSelect;

// Immutable campaign intent snapshots. Activating a new row supersedes the
// old one; historical generations keep the exact revision they used.
export const campaignPlanRevisions = pgTable(
  "campaign_plan_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    status: text("status").notNull().default("draft"),
    objective: text("objective").notNull().default(""),
    kpi: text("kpi").notNull().default(""),
    timeframe: text("timeframe").notNull().default(""),
    startAt: bigint("start_at", { mode: "number" }),
    endAt: bigint("end_at", { mode: "number" }),
    audienceIdsJson: text("audience_ids_json").notNull().default("[]"),
    pillarsJson: text("pillars_json").notNull().default("[]"),
    offersJson: text("offers_json").notNull().default("[]"),
    ctasJson: text("ctas_json").notNull().default("[]"),
    guidance: text("guidance").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    activatedAt: bigint("activated_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("campaign_plan_revision_number").on(t.campaignId, t.revision),
    index("campaign_plan_workspace_campaign").on(t.workspaceId, t.campaignId),
  ],
);

export type CampaignPlanRevisionRow = typeof campaignPlanRevisions.$inferSelect;

// Stable production thread. Its revision-scoped configuration lives below so
// historical attribution survives campaign plan edits.
export const campaignLanes = pgTable(
  "campaign_lanes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("campaign_lane_key").on(t.campaignId, t.key),
    index("campaign_lane_workspace_campaign").on(t.workspaceId, t.campaignId),
  ],
);

export type CampaignLaneRow = typeof campaignLanes.$inferSelect;

export const campaignLaneRevisions = pgTable(
  "campaign_lane_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    laneId: text("lane_id")
      .notNull()
      .references(() => campaignLanes.id, { onDelete: "cascade" }),
    planRevisionId: text("plan_revision_id")
      .notNull()
      .references(() => campaignPlanRevisions.id, { onDelete: "cascade" }),
    key: text("key").notNull().default(""),
    name: text("name").notNull().default(""),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "restrict" }),
    audienceId: text("audience_id").references(() => audiences.id, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    format: text("format").notNull(),
    publishingConnectionId: text("publishing_connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    providerTarget: text("provider_target").notNull().default(""),
    deliveryMode: text("delivery_mode").notNull(),
    plannedQuantity: bigint("planned_quantity", { mode: "number" }).notNull().default(0),
    scheduleJson: text("schedule_json"),
    reactivePeriod: text("reactive_period"),
    reactiveCap: bigint("reactive_cap", { mode: "number" }),
    status: text("status").notNull().default("active"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("campaign_lane_plan_revision").on(t.laneId, t.planRevisionId),
    index("campaign_lane_revision_plan").on(t.planRevisionId),
  ],
);

export type CampaignLaneRevisionRow = typeof campaignLaneRevisions.$inferSelect;

// Sprint 61 (design §8.5): compiled, versioned candidate-retrieval/matching
// context for one active plan revision. Derived data — the plan revision and
// lane revisions remain the authority. Append-only: unchanged inputs produce
// the same fingerprint and no new row.
export const campaignRoutingProfiles = pgTable(
  "campaign_routing_profiles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    planRevisionId: text("plan_revision_id")
      .notNull()
      .references(() => campaignPlanRevisions.id, { onDelete: "cascade" }),
    profileVersion: bigint("profile_version", { mode: "number" }).notNull(),
    profileFingerprint: text("profile_fingerprint").notNull(),
    // Policy snapshots at compile time — real columns because dispositions
    // are decided against the profile version the matcher actually used.
    routingBand: text("routing_band").notNull(),
    minFit: bigint("min_fit", { mode: "number" }).notNull(),
    minConfidence: bigint("min_confidence", { mode: "number" }).notNull(),
    minTrust: bigint("min_trust", { mode: "number" }).notNull(),
    compilerVersion: bigint("compiler_version", { mode: "number" }).notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("campaign_routing_profiles_identity").on(
      t.campaignId,
      t.planRevisionId,
      t.profileFingerprint,
    ),
    uniqueIndex("campaign_routing_profiles_version").on(
      t.campaignId,
      t.profileVersion,
    ),
    index("campaign_routing_profiles_workspace").on(t.workspaceId, t.campaignId),
  ],
);

export type CampaignRoutingProfileRow =
  typeof campaignRoutingProfiles.$inferSelect;

// Sprint 61 (design §8.6): independent story×campaign×angle matcher
// decisions. Judgment fields are immutable once written; only lifecycle
// status moves, through the contracts transition machine, with audit events.
export const campaignOpportunities = pgTable(
  "campaign_opportunities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalStoryId: text("canonical_story_id").references(
      () => canonicalExternalStories.id,
      { onDelete: "cascade" },
    ),
    // Producer deferred (D-61.2): schema-level XOR ships once.
    manualSignalId: text("manual_signal_id").references(() => signals.id, {
      onDelete: "cascade",
    }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    planRevisionId: text("plan_revision_id")
      .notNull()
      .references(() => campaignPlanRevisions.id, { onDelete: "cascade" }),
    routingProfileId: text("routing_profile_id")
      .notNull()
      .references(() => campaignRoutingProfiles.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    angle: text("angle").notNull(),
    angleHash: text("angle_hash").notNull(),
    // Separate score dimensions are real columns (design §9.3): a composite
    // sort may project over them, never replace them.
    workspaceRelevance: bigint("workspace_relevance", { mode: "number" }).notNull(),
    campaignFit: bigint("campaign_fit", { mode: "number" }).notNull(),
    confidence: bigint("confidence", { mode: "number" }).notNull(),
    actionability: bigint("actionability", { mode: "number" }).notNull(),
    sourceTrust: bigint("source_trust", { mode: "number" }).notNull(),
    // Recommendation snapshot; no FK — the lane revision stays the execution
    // authority and persona deletion must not cascade into decisions.
    suggestedPersonaId: text("suggested_persona_id"),
    supportedClaimsJson: text("supported_claims_json").notNull().default("[]"),
    reason: text("reason").notNull(),
    matcherVersion: bigint("matcher_version", { mode: "number" }).notNull(),
    policyJson: text("policy_json").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    decisionReason: text("decision_reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    check(
      "campaign_opportunities_trigger_xor",
      sql`(${t.canonicalStoryId} IS NULL) <> (${t.manualSignalId} IS NULL)`,
    ),
    uniqueIndex("campaign_opportunities_story_identity")
      .on(t.canonicalStoryId, t.campaignId, t.planRevisionId, t.angleHash, t.matcherVersion)
      .where(sql`${t.canonicalStoryId} IS NOT NULL`),
    uniqueIndex("campaign_opportunities_signal_identity")
      .on(t.manualSignalId, t.campaignId, t.planRevisionId, t.angleHash, t.matcherVersion)
      .where(sql`${t.manualSignalId} IS NOT NULL`),
    index("campaign_opportunities_workspace_status").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    index("campaign_opportunities_story").on(t.canonicalStoryId),
    index("campaign_opportunities_campaign_status").on(t.campaignId, t.status),
  ],
);

export type CampaignOpportunityRow = typeof campaignOpportunities.$inferSelect;

// Append-only lifecycle audit (design §11.4, §12.1): one row per status
// change, including creation (fromStatus null). actorUserId null = system.
export const campaignOpportunityEvents = pgTable(
  "campaign_opportunity_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => campaignOpportunities.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("campaign_opportunity_events_opportunity").on(
      t.opportunityId,
      t.createdAt,
    ),
  ],
);

export type CampaignOpportunityEventRow =
  typeof campaignOpportunityEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Content packages (Sprint 62, design §8.7–§8.8). The narrative unit between
// a qualified opportunity and Sprint 63's deliverables, pinned to exactly one
// campaign and plan revision. Grounding invariant: every generated claim is
// supported by package sources, or the package remains research_needed.
// ---------------------------------------------------------------------------

export const contentPackages = pgTable(
  "content_packages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    planRevisionId: text("plan_revision_id")
      .notNull()
      .references(() => campaignPlanRevisions.id, { onDelete: "cascade" }),
    // set null, not cascade: packages are output provenance and must survive
    // opportunity/story deletion (design §1.3). Snapshots live on sources.
    opportunityId: text("opportunity_id").references(
      () => campaignOpportunities.id,
      { onDelete: "set null" },
    ),
    canonicalStoryId: text("canonical_story_id").references(
      () => canonicalExternalStories.id,
      { onDelete: "set null" },
    ),
    angle: text("angle").notNull(),
    angleHash: text("angle_hash").notNull(),
    // Deterministic angle-overlap novelty at creation (D-62.3), 0–100.
    novelty: bigint("novelty", { mode: "number" }).notNull(),
    status: text("status").notNull().default("assessing"),
    // Sufficiency queue state — infrastructure, never a judgment (§8.11).
    assessmentState: text("assessment_state").notNull().default("pending"),
    assessmentAttempts: bigint("assessment_attempts", { mode: "number" }).notNull().default(0),
    assessmentLeaseExpiresAt: bigint("assessment_lease_expires_at", { mode: "number" }),
    assessedAt: bigint("assessed_at", { mode: "number" }),
    // Sprint 63 (D-63.4): §9.5 fan-out attempted. Null = due once ready.
    fannedOutAt: bigint("fanned_out_at", { mode: "number" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // One package per consumed opportunity (D-62.2).
    uniqueIndex("content_packages_opportunity")
      .on(t.opportunityId)
      .where(sql`${t.opportunityId} IS NOT NULL`),
    index("content_packages_workspace_status").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    index("content_packages_campaign_status").on(t.campaignId, t.status),
    // Novelty + per-lane repetition lookups.
    index("content_packages_campaign_angle").on(t.campaignId, t.angleHash),
    index("content_packages_assessment_queue").on(
      t.workspaceId,
      t.assessmentState,
      t.assessmentLeaseExpiresAt,
    ),
  ],
);

export type ContentPackageRow = typeof contentPackages.$inferSelect;

// Typed source snapshots (design §8.7, PACKAGE_SOURCE_ROLES activated).
// Nullable refs go set-null on deletion; the snapshot columns survive.
export const packageSources = pgTable(
  "package_sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    canonicalStoryId: text("canonical_story_id").references(
      () => canonicalExternalStories.id,
      { onDelete: "set null" },
    ),
    occurrenceId: text("occurrence_id").references(
      () => discoverySourceOccurrences.id,
      { onDelete: "set null" },
    ),
    signalId: text("signal_id").references(() => signals.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default(""),
    url: text("url"),
    excerpt: text("excerpt").notNull().default(""),
    // Full capture (provider, corroboration, captured-at) — snapshot only.
    snapshotJson: text("snapshot_json").notNull().default("{}"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("package_sources_package").on(t.packageId)],
);

export type PackageSourceRow = typeof packageSources.$inferSelect;

// Versioned, append-only sufficiency judgments (design §8.8). The verdict is
// service-derived: sufficient requires ≥1 validated supported claim.
export const sufficiencyAssessments = pgTable(
  "sufficiency_assessments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    assessmentVersion: bigint("assessment_version", { mode: "number" }).notNull(),
    verdict: text("verdict").notNull(),
    confidence: bigint("confidence", { mode: "number" }).notNull(),
    supportedClaimsJson: text("supported_claims_json").notNull().default("[]"),
    missingFactsJson: text("missing_facts_json").notNull().default("[]"),
    missingMediaJson: text("missing_media_json").notNull().default("[]"),
    eligibleFormatsJson: text("eligible_formats_json").notNull().default("[]"),
    ineligibleFormatsJson: text("ineligible_formats_json")
      .notNull()
      .default("[]"),
    researchActionsJson: text("research_actions_json").notNull().default("[]"),
    assessorVersion: bigint("assessor_version", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("sufficiency_assessments_version").on(
      t.packageId,
      t.assessmentVersion,
    ),
    index("sufficiency_assessments_package").on(t.packageId, t.createdAt),
  ],
);

export type SufficiencyAssessmentRow =
  typeof sufficiencyAssessments.$inferSelect;

// Deterministic per-lane-revision allow/block evaluations (design §8.8) —
// every reason recorded. Unique per (package, assessment, lane revision) so
// re-evaluation is idempotent.
export const laneEligibilityDecisions = pgTable(
  "lane_eligibility_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    assessmentId: text("assessment_id")
      .notNull()
      .references(() => sufficiencyAssessments.id, { onDelete: "cascade" }),
    laneId: text("lane_id")
      .notNull()
      .references(() => campaignLanes.id, { onDelete: "cascade" }),
    laneRevisionId: text("lane_revision_id")
      .notNull()
      .references(() => campaignLaneRevisions.id, { onDelete: "cascade" }),
    eligible: boolean("eligible").notNull(),
    checksJson: text("checks_json").notNull(),
    evaluatorVersion: bigint("evaluator_version", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("lane_eligibility_identity").on(
      t.packageId,
      t.assessmentId,
      t.laneRevisionId,
    ),
    index("lane_eligibility_package").on(t.packageId, t.createdAt),
  ],
);

export type LaneEligibilityDecisionRow =
  typeof laneEligibilityDecisions.$inferSelect;

// Append-only package lifecycle audit (design §12.1: package
// created/research-needed/blocked). actorUserId null = system.
export const contentPackageEvents = pgTable(
  "content_package_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => contentPackages.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("content_package_events_package").on(t.packageId, t.createdAt),
  ],
);

export type ContentPackageEventRow = typeof contentPackageEvents.$inferSelect;

// Sprint 63 (design §8.10): one campaign commitment for one lane and time.
// Planned deliverables are materialized slots waiting for a package; reactive
// ones are born at fan-out with a package attached. Lifecycle is the contracts
// DELIVERABLE_PRODUCTION_STATUSES machine; the generation queue columns are
// infrastructure, never content (§8.11 separation).
export const deliverables = pgTable(
  "deliverables",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    planRevisionId: text("plan_revision_id")
      .notNull()
      .references(() => campaignPlanRevisions.id, { onDelete: "cascade" }),
    laneId: text("lane_id")
      .notNull()
      .references(() => campaignLanes.id, { onDelete: "cascade" }),
    laneRevisionId: text("lane_revision_id")
      .notNull()
      .references(() => campaignLaneRevisions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Immutable slot identity for planned deliverables (§8.10); null for
    // reactive. Reschedules would move a future scheduled_for, never this.
    originalScheduledFor: bigint("original_scheduled_for", { mode: "number" }),
    // set null: the deliverable and its angle snapshot survive package
    // deletion (design §1.3 provenance survival).
    packageId: text("package_id").references(() => contentPackages.id, {
      onDelete: "set null",
    }),
    angle: text("angle").notNull().default(""),
    angleHash: text("angle_hash").notNull().default(""),
    status: text("status").notNull().default("planned"),
    generationState: text("generation_state").notNull().default("pending"),
    generationAttempts: bigint("generation_attempts", { mode: "number" }).notNull().default(0),
    generationLeaseExpiresAt: bigint("generation_lease_expires_at", { mode: "number" }),
    generatedAt: bigint("generated_at", { mode: "number" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // §8.10 planned uniqueness: one commitment per lane revision and slot.
    uniqueIndex("deliverables_planned_slot")
      .on(t.laneRevisionId, t.originalScheduledFor)
      .where(sql`${t.originalScheduledFor} IS NOT NULL`),
    // §8.10 reactive uniqueness: one reactive commitment per package + lane
    // revision.
    uniqueIndex("deliverables_reactive_package")
      .on(t.packageId, t.laneRevisionId)
      .where(sql`${t.kind} = 'reactive' AND ${t.packageId} IS NOT NULL`),
    index("deliverables_workspace_status").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    index("deliverables_lane_revision").on(t.laneRevisionId, t.status),
    index("deliverables_package").on(t.packageId),
    index("deliverables_campaign_status").on(t.campaignId, t.status),
    index("deliverables_generation_queue").on(
      t.workspaceId,
      t.generationState,
      t.generationLeaseExpiresAt,
    ),
  ],
);

export type DeliverableRow = typeof deliverables.$inferSelect;

// Sprint 63 (design §8.10): the replay/audit record behind one variant — the
// entire resolved context (sections with trace, prompt, token accounting)
// plus identity and grounding inputs. Append-only; never updated.
export const contextSnapshots = pgTable(
  "context_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliverableId: text("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    packageId: text("package_id").references(() => contentPackages.id, {
      onDelete: "set null",
    }),
    resolvedContextJson: text("resolved_context_json").notNull(),
    inputsJson: text("inputs_json").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("context_snapshots_deliverable").on(t.deliverableId, t.createdAt)],
);

export type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;

// Sprint 63 (design §8.10): one candidate execution. Regeneration appends the
// next version and never overwrites lineage; only status/selectedAt change,
// and only through the contracts variant machine.
export const variants = pgTable(
  "variants",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliverableId: text("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    variantVersion: bigint("variant_version", { mode: "number" }).notNull(),
    contextSnapshotId: text("context_snapshot_id")
      .notNull()
      .references(() => contextSnapshots.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("candidate"),
    content: text("content").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    selectedAt: bigint("selected_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("variants_version").on(t.deliverableId, t.variantVersion),
    index("variants_deliverable_status").on(t.deliverableId, t.status),
  ],
);

export type VariantRow = typeof variants.$inferSelect;

// Append-only deliverable lifecycle audit (§12.1). actorUserId null = system.
export const deliverableEvents = pgTable(
  "deliverable_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliverableId: text("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    reason: text("reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("deliverable_events_deliverable").on(t.deliverableId, t.createdAt)],
);

export type DeliverableEventRow = typeof deliverableEvents.$inferSelect;

// Sprint 45 multi-candidate scoring: one row per candidate persona×campaign
// pairing a discovered item scored above zero relevance for. Replaced
// (delete-then-insert) each time the item is scored.
export const discoveredItemMatches = pgTable(
  "discovered_item_matches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => discoveredItems.id, { onDelete: "cascade" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    score: bigint("score", { mode: "number" }).notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("discovered_item_matches_item").on(t.itemId)],
);

export type DiscoveredItemMatchRow = typeof discoveredItemMatches.$inferSelect;

// Sprint 45: same shape for signals — copied from discovered_item_matches on
// accept, written directly for manually-created signals. runAutomation routes
// a signal to a campaign only via a row here at/above the match threshold.
export const signalMatches = pgTable(
  "signal_matches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    signalId: text("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    score: bigint("score", { mode: "number" }).notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("signal_matches_signal").on(t.signalId),
    index("signal_matches_signal_campaign").on(t.signalId, t.campaignId),
  ],
);

export type SignalMatchRow = typeof signalMatches.$inferSelect;

export const evidenceDocuments = pgTable("evidence_documents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  r2rDocumentId: text("r2r_document_id"),
  title: text("title").notNull(),
  chars: bigint("chars", { mode: "number" }).notNull(),
  status: text("status").notNull().default("processing"),
  error: text("error"),
  // Provenance (Sprint 30): manual paste vs accepted ingest candidate.
  kind: text("kind").notNull().default("manual"),
  sourceRef: text("source_ref"),
  sourceCreatedAt: bigint("source_created_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type EvidenceDocumentRow = typeof evidenceDocuments.$inferSelect;

// One R2R collection per workspace (Sprint 30) — replaces document-id-filter
// scoping with real per-workspace isolation inside the store.
export const evidenceCollections = pgTable("evidence_collections", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  r2rCollectionId: text("r2r_collection_id").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type EvidenceCollectionRow = typeof evidenceCollections.$inferSelect;

// Founder-gated ingest queue (Sprint 30): the worker proposes signals +
// published posts; the founder accepts them into the corpus. Unique on
// (workspace, kind, sourceRef) so a source is proposed at most once.
export const evidenceCandidates = pgTable(
  "evidence_candidates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceCreatedAt: bigint("source_created_at", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    evidenceDocumentId: text("evidence_document_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    decidedAt: bigint("decided_at", { mode: "number" }),
  },
  (t) => [uniqueIndex("evidence_candidates_source").on(t.workspaceId, t.kind, t.sourceRef)],
);

export type EvidenceCandidateRow = typeof evidenceCandidates.$inferSelect;

// Native evidence store (Sprint 47): chunk text + embeddings live in our own
// DB. The FTS5/vec0 index tables over these rows are runtime artifacts owned
// by DbEvidenceStore (virtual tables can't be modeled here), rebuildable via
// reindex(). embedding is Float32Array bytes (becomes pgvector at the
// Postgres swap); null when embeddings were unavailable at ingest.
export const evidenceChunks = pgTable(
  "evidence_chunks",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").notNull(),
    documentId: text("document_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EVIDENCE_EMBEDDING_DIMENSIONS }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("evidence_chunks_collection").on(t.collectionId),
    index("evidence_chunks_document").on(t.documentId),
    // The two retrieval legs the evidence store fuses (Sprint 74 replaced
    // SQLite's FTS5 and sqlite-vec virtual tables with these).
    //
    // Lexical: a GIN index over the same to_tsvector() expression the query
    // uses — the expressions must match exactly or Postgres ignores the index.
    index("evidence_chunks_fts")
      .using("gin", sql`to_tsvector('english', ${t.text})`),
    // Vector: HNSW under cosine distance, which is what `<=>` computes.
    index("evidence_chunks_embedding")
      .using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type EvidenceChunkRow = typeof evidenceChunks.$inferSelect;

export const engagementMetrics = pgTable("engagement_metrics", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: text("draft_id"),
  channel: text("channel").notNull(),
  description: text("description").notNull().default(""),
  impressions: bigint("impressions", { mode: "number" }),
  engagements: bigint("engagements", { mode: "number" }),
  clicks: bigint("clicks", { mode: "number" }),
  notes: text("notes").notNull().default(""),
  recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type EngagementMetricRow = typeof engagementMetrics.$inferSelect;

export const nowSyntheses = pgTable("now_syntheses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  proposal: text("proposal").notNull(),
  rationale: text("rationale").notNull(),
  basedOnJson: text("based_on_json").notNull(),
  status: text("status").notNull().default("proposed"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  decidedAt: bigint("decided_at", { mode: "number" }),
});

export type NowSynthesisRow = typeof nowSyntheses.$inferSelect;

export const leads = pgTable("leads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull().default(""),
  role: text("role").notNull().default(""),
  notes: text("notes").notNull().default(""),
  // X (Twitter) handle without the leading "@" — for per-recipient X DMs (Sprint 26).
  xHandle: text("x_handle").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type LeadRow = typeof leads.$inferSelect;

// PR & media outreach (Sprint 16) — the founder's media list, not a media DB.
export const mediaContacts = pgTable("media_contacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  type: text("type").notNull().default("journalist"),
  outlet: text("outlet").notNull().default(""),
  beat: text("beat").notNull().default(""),
  coverageNotes: text("coverage_notes").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type MediaContactRow = typeof mediaContacts.$inferSelect;

export const connections = pgTable("connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  providerKey: text("provider_key").notNull(),
  nangoConnectionId: text("nango_connection_id").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  displayName: text("display_name").notNull().default(""),
  // Sprint 75: account-local day boundary for social budgets.
  timezone: text("timezone").notNull().default("UTC"),
  externalAccountId: text("external_account_id"),
  externalAccountName: text("external_account_name"),
  externalAccountHandle: text("external_account_handle"),
  externalAccountUrl: text("external_account_url"),
  status: text("status").notNull().default("connected"),
  lastCheckedAt: bigint("last_checked_at", { mode: "number" }),
  lastError: text("last_error"),
  // Sprint 44: per-account content profile ({ topics: string[], guidance }),
  // injected into the context bundle when a draft resolves to this connection.
  contentProfileJson: text("content_profile_json").notNull().default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type ConnectionRow = typeof connections.$inferSelect;

export const personaSocialAccounts = pgTable(
  "persona_social_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    channel: text("channel").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    defaultTarget: text("default_target").notNull().default("feed"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("persona_social_accounts_unique").on(table.personaId, table.connectionId, table.channel),
  ],
);

export type PersonaSocialAccountRow = typeof personaSocialAccounts.$inferSelect;

// Synced mirror of CRM contacts — the CRM stays the system of record.
export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    company: text("company").notNull().default(""),
    role: text("role").notNull().default(""),
    leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
    // Tombstone for local discard (Sprint 23): set = hidden + skipped by sync.
    discardedAt: bigint("discarded_at", { mode: "number" }),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("crm_contacts_connection_external").on(table.connectionId, table.externalId)],
);

export type CrmContactRow = typeof crmContacts.$inferSelect;

// Per-connection CRM sync filter (Sprint 23). Stored separately so the generic
// connection config stays provider-agnostic; cascades with its connection.
export const crmSyncSettings = pgTable("crm_sync_settings", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  filterJson: text("filter_json").notNull().default("{}"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type CrmSyncSettingsRow = typeof crmSyncSettings.$inferSelect;

// Ads reporting (Sprint 14). Tuezday owns this metric model regardless of
// source; connectionId null marks the workspace's CSV-only account.
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull().default("USD"),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("ad_accounts_workspace_external").on(t.workspaceId, t.externalId)],
);

export type AdAccountRow = typeof adAccounts.$inferSelect;

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    adAccountId: text("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    // The link that puts paid numbers on a Tuezday campaign's page.
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("ad_campaigns_account_external").on(t.adAccountId, t.externalId)],
);

export type AdCampaignRow = typeof adCampaigns.$inferSelect;

export const adCampaignMetrics = pgTable(
  "ad_campaign_metrics",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    adCampaignId: text("ad_campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    // YYYY-MM-DD as the platform reports it — portable and sortable as text.
    date: text("date").notNull(),
    // Integer cents in the account currency — no floats in the DB.
    spendCents: bigint("spend_cents", { mode: "number" }).notNull().default(0),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    conversions: bigint("conversions", { mode: "number" }).notNull().default(0),
    source: text("source").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("ad_campaign_metrics_campaign_date").on(t.adCampaignId, t.date)],
);

export type AdCampaignMetricRow = typeof adCampaignMetrics.$inferSelect;

// Sprint 55: the unified metric fact table — one row per observed number.
// Vocabularies (keys, windows, subject types, sources) live in
// @tuezday/contracts. The grain's unique index is what makes re-recording
// idempotent: the ads sync restates a rolling window every few hours, so the
// same (subject, key, window, period) must update in place, never duplicate.
// `window` semantics differ deliberately (point / cumulative 24h-7d / 1d
// periodic) — readers classify via metricWindowKind before aggregating.
export const metrics = pgTable(
  "metrics",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    metricKey: text("metric_key").notNull(),
    // Integer only; money is cents in the account currency — no floats in the DB.
    value: bigint("value", { mode: "number" }).notNull(),
    window: text("window").notNull(),
    // Inclusive start of the period this value covers. For a publication's
    // cumulative window this is its publishedAt; for a 1d bucket, the day;
    // for a point reading, the reading's own instant.
    periodStart: bigint("period_start", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    // When we learned the value — genuinely distinct from periodStart.
    capturedAt: bigint("captured_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("metrics_grain").on(
      t.workspaceId,
      t.subjectType,
      t.subjectId,
      t.metricKey,
      t.window,
      t.periodStart,
    ),
    index("metrics_workspace_subject").on(t.workspaceId, t.subjectType, t.subjectId),
  ],
);

export type MetricRow = typeof metrics.$inferSelect;

// Workspace and scoped governance rules for every external side effect. The
// vocabulary and precedence live in @tuezday/contracts; these rows preserve
// the founder's explicit policy choices and their provenance.
export const externalActionPolicyRules = pgTable(
  "external_action_policy_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    actionKind: text("action_kind").notNull(),
    rule: text("rule").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("external_action_policy_scope_kind").on(
      t.workspaceId,
      t.scope,
      t.scopeId,
      t.actionKind,
    ),
    index("external_action_policy_workspace_scope").on(t.workspaceId, t.scope, t.scopeId),
  ],
);

export type ExternalActionPolicyRuleRow = typeof externalActionPolicyRules.$inferSelect;

// Durable authorization envelope. It separates permission to take an external
// action from approval of the content that action may carry.
export const externalActions = pgTable(
  "external_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    laneRevisionId: text("lane_revision_id").references(() => campaignLaneRevisions.id, {
      onDelete: "set null",
    }),
    payloadJson: text("payload_json").notNull(),
    subjectSnapshotJson: text("subject_snapshot_json").notNull(),
    requestedFor: bigint("requested_for", { mode: "number" }),
    idempotencyKey: text("idempotency_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    policySnapshotJson: text("policy_snapshot_json").notNull(),
    blockerCode: text("blocker_code"),
    blockerDetail: text("blocker_detail"),
    blockerRetryable: boolean("blocker_retryable"),
    // Plain ids avoid a SQLite self-reference table rebuild while preserving
    // immutable supersession lineage.
    supersedesActionId: text("supersedes_action_id"),
    supersededByActionId: text("superseded_by_action_id"),
    executionKind: text("execution_kind"),
    executionId: text("execution_id"),
    executionReceiptJson: text("execution_receipt_json"),
    proposedByUserId: text("proposed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    proposedByLabel: text("proposed_by_label").notNull(),
    // Sprint 69: who proposed it, as a typed fact rather than a label
    // convention — the authorization queue has to be able to say "an agent
    // asked for this" without parsing `proposed_by_label`. Not part of the
    // fingerprint (D-69.3): the gate is origin-blind on purpose.
    origin: text("origin").notNull().default("human"),
    originRunId: text("origin_run_id"),
    // Sprint 78 (D-78.8): which agent surface asked. Derivable from the run,
    // but the queue would need a join per row and runs are prunable while
    // actions are not. Null unless origin is `agent`.
    originSurface: text("origin_surface"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    authorizedAt: bigint("authorized_at", { mode: "number" }),
    dispatchedAt: bigint("dispatched_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("external_actions_workspace_idempotency").on(t.workspaceId, t.idempotencyKey),
    index("external_actions_workspace_status").on(t.workspaceId, t.status),
    index("external_actions_workspace_subject").on(t.workspaceId, t.subjectKind, t.subjectId),
    index("external_actions_campaign").on(t.campaignId),
  ],
);

export type ExternalActionRow = typeof externalActions.$inferSelect;

// Durable, idempotent preview header for a bounded batch authorization. The
// exact selection stays frozen while status/timestamps advance on confirm.
export const externalActionBatches = pgTable(
  "external_action_batches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    selectionJson: text("selection_json").notNull(),
    status: text("status").notNull(),
    continuationCount: bigint("continuation_count", { mode: "number" }).notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByLabel: text("created_by_label").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    confirmedAt: bigint("confirmed_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("external_action_batches_workspace_request").on(
      t.workspaceId,
      t.requestId,
    ),
    index("external_action_batches_workspace_status").on(t.workspaceId, t.status),
  ],
);

export type ExternalActionBatchRow = typeof externalActionBatches.$inferSelect;

// One immutable action snapshot plus its mutable authorization outcome. Batch
// deletion removes the snapshot; direct action deletion is restricted so the
// authorization audit can never point at a vanished action.
export const externalActionBatchItems = pgTable(
  "external_action_batch_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => externalActionBatches.id, { onDelete: "cascade" }),
    actionId: text("action_id")
      .notNull()
      .references(() => externalActions.id, { onDelete: "restrict" }),
    snapshotJson: text("snapshot_json").notNull(),
    status: text("status").notNull(),
    submissionJson: text("submission_json"),
    error: text("error"),
    processedAt: bigint("processed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("external_action_batch_items_batch_action").on(t.batchId, t.actionId),
    index("external_action_batch_items_workspace_batch").on(t.workspaceId, t.batchId),
  ],
);

export type ExternalActionBatchItemRow = typeof externalActionBatchItems.$inferSelect;

// Append-only founder/operator decisions. Deleting an authorization envelope
// removes its now-unreachable audit rows, while ordinary state changes retain
// every decision forever.
export const externalActionDecisions = pgTable(
  "external_action_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actionId: text("action_id")
      .notNull()
      .references(() => externalActions.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull(),
    // Sprint 52 follow-up: was this decision made by a person? Never inferred
    // from `actorUserId` — the delegated approve links are humans with no user
    // id, and the worker is a non-human with none either. A cadence reads this
    // to tell a founder's withdrawal (final for that draft) from a system stop
    // such as the automation kill switch (reversible). Existing rows default to
    // true because every decision written before this column existed came from
    // the human-only authorize/deny/cancel routes, and because "a human said
    // no" is the safe reading of an ambiguous refusal.
    actorHuman: boolean("actor_human").notNull().default(true),
    subjectFingerprint: text("subject_fingerprint").notNull(),
    policySnapshotJson: text("policy_snapshot_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("external_action_decisions_action").on(t.actionId, t.createdAt),
    index("external_action_decisions_workspace").on(t.workspaceId, t.createdAt),
  ],
);

export type ExternalActionDecisionRow = typeof externalActionDecisions.$inferSelect;

// One verified sender identity and its workspace-owned safety settings. The
// platform provider credential stays in the environment; only public domain
// identifiers and DNS challenge projections are persisted here.
export const workspaceEmailSenders = pgTable("workspace_email_senders", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  fromLocalPart: text("from_local_part").notNull(),
  fromName: text("from_name").notNull(),
  fromAddress: text("from_address").notNull(),
  replyTo: text("reply_to"),
  status: text("status").notNull().default("not_configured"),
  provider: text("provider").notNull().default("resend"),
  providerDomainId: text("provider_domain_id"),
  dnsRecordsJson: text("dns_records_json").notNull().default("[]"),
  // Existing and newly configured workspaces start safely disabled.
  killSwitch: boolean("kill_switch").notNull().default(true),
  dailyCap: bigint("daily_cap", { mode: "number" }).notNull().default(100),
  lastCheckedAt: bigint("last_checked_at", { mode: "number" }),
  lastError: text("last_error"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type WorkspaceEmailSenderRow = typeof workspaceEmailSenders.$inferSelect;

// Explicit technical send permission for one normalized recipient. Unknown is
// a blocking state and remains distinct from a durable suppression.
export const emailRecipientPermissions = pgTable(
  "email_recipient_permissions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    status: text("status").notNull().default("unknown"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("email_recipient_permissions_workspace_email").on(
      t.workspaceId,
      t.normalizedEmail,
    ),
    index("email_recipient_permissions_workspace_status").on(t.workspaceId, t.status),
  ],
);

export type EmailRecipientPermissionRow = typeof emailRecipientPermissions.$inferSelect;

// Deliverability and founder suppressions are durable guardrails. A recipient
// can have only one active suppression per workspace, regardless of source.
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    reason: text("reason").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("email_suppressions_workspace_email").on(t.workspaceId, t.normalizedEmail),
    index("email_suppressions_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;

// Durable message snapshot created before the provider call. Mutable columns
// record delivery progress; recipient, sender, subject, and body remain the
// exact action-authorized payload for audit and retry recovery.
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    externalActionId: text("external_action_id")
      .notNull()
      .references(() => externalActions.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    originId: text("origin_id").notNull(),
    normalizedRecipient: text("normalized_recipient").notNull(),
    senderAddress: text("sender_address").notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html"),
    idempotencyKey: text("idempotency_key").notNull(),
    provider: text("provider").notNull().default("resend"),
    providerMessageId: text("provider_message_id"),
    // Gmail thread id (Sprint 47) — the inbound-reply matching key. Null on
    // Resend deliveries, which have no reply loop.
    providerThreadId: text("provider_thread_id"),
    // Which connected mailbox sent this (Sprint 47). Null = the Resend path.
    mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    acceptedAt: bigint("accepted_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
    lastError: text("last_error"),
    // Open/click tracking counters (Sprint 50). Opens are a soft signal (MPP
    // inflation); the detail log lives in outreach_tracking_events.
    openedAt: bigint("opened_at", { mode: "number" }),
    openCount: bigint("open_count", { mode: "number" }).notNull().default(0),
    firstClickAt: bigint("first_click_at", { mode: "number" }),
    clickCount: bigint("click_count", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("email_deliveries_workspace_idempotency").on(
      t.workspaceId,
      t.idempotencyKey,
    ),
    uniqueIndex("email_deliveries_provider_message").on(t.provider, t.providerMessageId),
    index("email_deliveries_workspace_status_accepted").on(
      t.workspaceId,
      t.status,
      t.acceptedAt,
    ),
    index("email_deliveries_workspace_origin").on(t.workspaceId, t.origin, t.originId),
  ],
);

export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;

const MAX_EMAIL_DELIVERY_EVENT_PAYLOAD_CHARS = 1_000_000;

// Append-only verified provider events. The raw bounded JSON supports audit
// and replay without persisting webhook secrets or mutable projections.
export const emailDeliveryEvents = pgTable(
  "email_delivery_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => emailDeliveries.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("resend"),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("email_delivery_events_provider_event").on(t.provider, t.providerEventId),
    index("email_delivery_events_delivery_created").on(t.deliveryId, t.createdAt),
    check(
      "email_delivery_events_payload_bounded",
      sql`length(${t.payloadJson}) <= ${sql.raw(
        String(MAX_EMAIL_DELIVERY_EVENT_PAYLOAD_CHARS),
      )}`,
    ),
  ],
);

export type EmailDeliveryEventRow = typeof emailDeliveryEvents.$inferSelect;

// A connected outreach mailbox (Sprint 47): the send identity AND the reply
// source. Rides a `gmail` connector row (tokens live in Nango, never here).
// Modeled as a pool per workspace from day one; distinct from
// workspaceEmailSenders (the Resend DNS-domain transactional identity).
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("gmail"),
    // Filled from the provider profile at connect time, never hand-typed.
    address: text("address").notNull(),
    displayName: text("display_name").notNull().default(""),
    replyTo: text("reply_to"),
    signature: text("signature").notNull().default(""),
    // Founder decision: customizable, default 50 (MAILBOX_DEFAULT_DAILY_CAP).
    dailyCap: bigint("daily_cap", { mode: "number" }).notNull().default(50),
    // MailboxSendingWindow JSON; stored now, enforced by the Sprint 48 scheduler.
    sendingWindowJson: text("sending_window_json").notNull().default("{}"),
    defaultPersonaId: text("default_persona_id").references(() => personas.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("connected"),
    // Inbound poll cursor anchor for the mailbox-inbox tick.
    lastPolledAt: bigint("last_polled_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_address").on(t.workspaceId, t.address),
    index("mailboxes_workspace_status").on(t.workspaceId, t.status),
  ],
);

export type MailboxRow = typeof mailboxes.$inferSelect;

// ---------------------------------------------------------------------------
// Outreach sequences (Sprint 48) — a first-class, always-on email sequence.
// Parallel to (and independent of) the S30 launch-bound sequence_* tables,
// which stay frozen. Email-only; sends from a mailbox pool (S47).
// ---------------------------------------------------------------------------

export const outreachSequences = pgTable("outreach_sequences", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  campaignId: text("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  goal: text("goal").notNull().default(""),
  personaId: text("persona_id")
    .notNull()
    .references(() => personas.id, { onDelete: "cascade" }),
  audienceId: text("audience_id")
    .notNull()
    .references(() => audiences.id, { onDelete: "cascade" }),
  automationMode: text("automation_mode").notNull().default("manual"),
  status: text("status").notNull().default("draft"),
  dailyEnrollmentCap: bigint("daily_enrollment_cap", { mode: "number" }).notNull().default(50),
  stopOnReply: bigint("stop_on_reply", { mode: "number" }).notNull().default(1),
  // Open/click tracking (Sprint 50) — off by default (deliverability-first).
  trackOpens: bigint("track_opens", { mode: "number" }).notNull().default(0),
  trackClicks: bigint("track_clicks", { mode: "number" }).notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type OutreachSequenceRow = typeof outreachSequences.$inferSelect;

// The mailbox pool a sequence rotates across (M:N). "Pool, start with one."
export const outreachSequenceMailboxes = pgTable(
  "outreach_sequence_mailboxes",
  {
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => outreachSequences.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.sequenceId, t.mailboxId] }),
    index("outreach_sequence_mailboxes_mailbox").on(t.mailboxId),
  ],
);

export type OutreachSequenceMailboxRow = typeof outreachSequenceMailboxes.$inferSelect;

export const outreachSequenceSteps = pgTable(
  "outreach_sequence_steps",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => outreachSequences.id, { onDelete: "cascade" }),
    stepNumber: bigint("step_number", { mode: "number" }).notNull(),
    // Blank = the brain writes a natural follow-up; filled = steer that step.
    instruction: text("instruction").notNull().default(""),
    // Delay from the previous step's actual send; step 1 treated as 0.
    delayHours: bigint("delay_hours", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("outreach_steps_sequence_number").on(t.sequenceId, t.stepNumber)],
);

export type OutreachSequenceStepRow = typeof outreachSequenceSteps.$inferSelect;

// One row per (sequence × recipient). The partial unique index on active rows
// enforces "one active outreach sequence per person, workspace-wide".
export const outreachEnrollments = pgTable(
  "outreach_enrollments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => outreachSequences.id, { onDelete: "cascade" }),
    recipientType: text("recipient_type").notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientEmail: text("recipient_email").notNull().default(""),
    // The mailbox pinned to this recipient at enroll (thread continuity).
    mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    // Gmail thread of the last send — follow-ups thread into it.
    lastThreadId: text("last_thread_id"),
    currentStep: bigint("current_step", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"),
    nextDueAt: bigint("next_due_at", { mode: "number" }),
    lastSentAt: bigint("last_sent_at", { mode: "number" }),
    stoppedReason: text("stopped_reason"),
    // Reply-check cursor (Sprint 49): the lookup uses max(lastSentAt, this) so an
    // out-of-office pause is idempotent and the chain resumes cleanly.
    lastReplyHandledAt: bigint("last_reply_handled_at", { mode: "number" }),
    // Manual funnel outcome (Sprint 50): none / meeting / won / lost.
    outcome: text("outcome").notNull().default("none"),
    enrolledAt: bigint("enrolled_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("outreach_enrollments_sequence_recipient").on(
      t.sequenceId,
      t.recipientType,
      t.recipientId,
    ),
    // The global "one active sequence per person" lock (decision 07).
    uniqueIndex("outreach_enrollments_active_person")
      .on(t.workspaceId, t.recipientType, t.recipientId)
      .where(sql`status = 'active'`),
    index("outreach_enrollments_due").on(t.status, t.nextDueAt),
  ],
);

export type OutreachEnrollmentRow = typeof outreachEnrollments.$inferSelect;

// One row per (enrollment × step) — the dispatch record (mirrors launchMessages).
export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enrollmentId: text("enrollment_id")
      .notNull()
      .references(() => outreachEnrollments.id, { onDelete: "cascade" }),
    stepNumber: bigint("step_number", { mode: "number" }).notNull(),
    draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    externalActionId: text("external_action_id").references(() => externalActions.id, {
      onDelete: "set null",
    }),
    // Gmail thread returned by the send — feeds the next step's threading.
    providerThreadId: text("provider_thread_id"),
    status: text("status").notNull().default("pending"),
    sentAt: bigint("sent_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("outreach_messages_enrollment_step").on(t.enrollmentId, t.stepNumber)],
);

export type OutreachMessageRow = typeof outreachMessages.$inferSelect;

// Open/click engagement events on a sent outreach email (Sprint 50). Append-
// only detail behind the denormalized counters on email_deliveries. Privacy-
// first: no IP/user-agent.
export const outreachTrackingEvents = pgTable(
  "outreach_tracking_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    emailDeliveryId: text("email_delivery_id").references(() => emailDeliveries.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    targetUrl: text("target_url"),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("outreach_tracking_events_delivery").on(t.emailDeliveryId)],
);

export type OutreachTrackingEventRow = typeof outreachTrackingEvents.$inferSelect;

// A workspace's CAN-SPAM postal mailing address (Sprint 49), required before an
// outreach sequence can activate and appended to every send's footer. Its own
// table because a Gmail-only workspace has no workspaceEmailSenders row.
export const workspaceCompliance = pgTable("workspace_compliance", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  postalAddress: text("postal_address").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type WorkspaceComplianceRow = typeof workspaceCompliance.$inferSelect;

// Chat (Sprint 42, rebuilt Sprint 76): a workspace+user GTM conversation.
// Messages are the transcript (user/assistant/tool/compaction); citations_json
// holds the ChatCitation[] provenance for an assistant turn.
//
// Sprint 76 adds the thread's SCOPE BINDING — campaign / persona / channel —
// which selects the context bundle the conversation resolves against, exactly
// as a generation request would, plus lifetime token and cost counters. Those
// counters are the per-thread cap's authority; llm_usage_events remains the
// workspace budget's authority, and the two are written from the same turn.
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    // Sprint 76: standing intent, derived once from the opening message and
    // thereafter user-editable. The model never rewrites it (D-76.12) — a
    // model-updated goal would silently re-aim the system prefix.
    goal: text("goal").notNull().default(""),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    channel: text("channel"),
    totalInputTokens: bigint("total_input_tokens", { mode: "number" }).notNull().default(0),
    totalOutputTokens: bigint("total_output_tokens", { mode: "number" }).notNull().default(0),
    totalCostCents: doublePrecision("total_cost_cents").notNull().default(0),
    /** Newest message folded into the latest compaction, if any. */
    compactedThroughMessageId: text("compacted_through_message_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("chat_sessions_workspace_user").on(t.workspaceId, t.userId)],
);

export type ChatSessionRow = typeof chatSessions.$inferSelect;

export const chatMessages = pgTable(
  "chat_messages",
  {
    /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolName: text("tool_name"),
    citationsJson: text("citations_json").notNull().default("[]"),
    // Sprint 77: the typed result cards this turn rendered. Persisted rather
    // than recomputed — the tool results they were derived from live in
    // `agent_run_steps` and are subject to retention, and a transcript whose
    // cards vanished on a sweep would change shape over time.
    cardsJson: text("cards_json").notNull().default("[]"),
    // Sprint 42 P2 → dormant since Sprint 76 (chat is read-only until 78, which
    // repopulates both). Kept rather than dropped: a SQLite column drop is a
    // table rebuild, and 78 wants them back (D-76.7).
    proposalJson: text("proposal_json"),
    producedRef: text("produced_ref"),
    // Sprint 76: every assistant turn is an agent_run, so the Agent Inspector
    // works for chat with no new tracing code. No FK — an agent_runs row can be
    // pruned by retention without orphaning the transcript that referenced it.
    agentRunId: text("agent_run_id"),
    // Sprint 79: set on the acknowledgement message a detach writes, so
    // reopening the thread later still finds the task and can re-attach its
    // live panel. No FK, for the same retention reason as agent_run_id.
    agentTaskId: text("agent_task_id"),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    stopReason: text("stop_reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("chat_messages_session_created").on(t.sessionId, t.createdAt)],
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;

// Confirm-before-propose (Sprint 78). One row per propose-tool call made inside
// a chat turn. The row IS the pause: the tool records intent here and returns,
// the run finishes, and nothing reaches the Sprint 69 gate until a human
// confirms (D-78.1). Kept beside the transcript rather than on it because a
// proposal's status changes long after its message was written.
export const chatProposals = pgTable(
  "chat_proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Nullable since Sprint 79: a background task with no originating thread
    // still proposes, and its card renders in the task panel instead.
    sessionId: text("session_id").references(() => chatSessions.id, {
      onDelete: "cascade",
    }),
    /** Sprint 79. No FK — a proposal outlives the task that made it, exactly
     * as it already outlives the draft it proposed. */
    agentTaskId: text("agent_task_id"),
    // Set once the turn's assistant message exists; the proposal is recorded
    // mid-run, before there is a message to hang it under.
    messageId: text("message_id"),
    // No FK, for the same retention reason as chat_messages.agent_run_id.
    agentRunId: text("agent_run_id"),
    tool: text("tool").notNull(), // PROPOSE_TOOL_NAMES
    /** The validated tool arguments, replayed verbatim on confirmation. */
    argsJson: text("args_json").notNull(),
    /** The rendered ChatProposalIntent the founder confirms. */
    intentJson: text("intent_json").notNull(),
    status: text("status").notNull(), // CHAT_PROPOSAL_STATUSES
    // Sprint 78 (D-78.6): the arguments derive only from untrusted content.
    quarantined: boolean("quarantined").notNull().default(false),
    quarantineReason: text("quarantine_reason"),
    producedRef: text("produced_ref"),
    producedStatus: text("produced_status"),
    error: text("error"),
    errorMessage: text("error_message"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("chat_proposals_session_created").on(t.sessionId, t.createdAt),
    // The per-day cap's read path.
    index("chat_proposals_workspace_created").on(t.workspaceId, t.createdAt),
    index("chat_proposals_task_created").on(t.agentTaskId, t.createdAt),
  ],
);

export type ChatProposalRow = typeof chatProposals.$inferSelect;

// Pinned context (Sprint 77). The `@` mention's durable form: the founder names
// an entity, a removable chip appears, and the next turn's system prefix says
// so out loud. Campaign and persona pins also write through to the session's
// scope columns (D-77.5) so the resolver and the chips cannot disagree.
export const chatPins = pgTable(
  "chat_pins",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // CHAT_PIN_KINDS
    /** The entity id — or the URL itself for a `url` pin. No FK: the kinds
     * span five tables plus a bare string, and a pin to a deleted record
     * should render as a stale chip the founder can remove, not block the
     * delete. */
    refId: text("ref_id").notNull(),
    label: text("label").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("chat_pins_session").on(t.sessionId, t.createdAt),
    // One pin per entity per thread — pinning twice is a no-op, not a second chip.
    uniqueIndex("chat_pins_session_kind_ref").on(t.sessionId, t.kind, t.refId),
  ],
);

export type ChatPinRow = typeof chatPins.$inferSelect;

// Social publishing receipts (Sprint 17) — one row per publish attempt (now
// or scheduled); the post lives on the platform, Tuezday keeps status + URL.
export const publications = pgTable(
  "publications",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    externalActionId: text("external_action_id").references(() => externalActions.id, {
      onDelete: "set null",
    }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    target: text("target").notNull(),
    title: text("title").notNull(),
    // Attached media for platforms that need it (Instagram). JSON array of
    // { url, type } or null. Posted alongside the draft body/caption.
    mediaJson: text("media_json"),
    // The posting cadence that auto-slotted this receipt (Sprint 27); null for a
    // manual one-off publish. Set null when the cadence is deleted.
    cadenceId: text("cadence_id").references(() => postingCadences.id, { onDelete: "set null" }),
    status: text("status").notNull().default("scheduled"),
    // The requested publish time; "post now" stamps the request time.
    scheduledFor: bigint("scheduled_for", { mode: "number" }).notNull(),
    publishedAt: bigint("published_at", { mode: "number" }),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    lastError: text("last_error"),
    // Durable asynchronous-provider state (Sprint 75). The operation id is a
    // container/job handle, never the final public media id.
    providerOperationId: text("provider_operation_id"),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
    processingStartedAt: bigint("processing_started_at", { mode: "number" }),
    processingAttempts: bigint("processing_attempts", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("publications_external_action").on(t.externalActionId)],
);

export type PublicationRow = typeof publications.$inferSelect;

// Recurring posting cadence (Sprint 27). Defines repeating slots (days-of-week
// + time-of-day in an IANA timezone) bound to a campaign/channel/account;
// approved matching drafts auto-fill the next open slots as scheduled
// publications, which the Sprint 17 worker fires on time.
export const postingCadences = pgTable("posting_cadences", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Matching + context. Null (e.g. after a campaign delete) leaves the cadence
  // unable to match, so it effectively pauses.
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
  channel: text("channel").notNull(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  target: text("target").notNull(),
  // JSON number[] of 0..6 (Sun=0); HH:MM interpreted in `timezone`.
  daysOfWeekJson: text("days_of_week_json").notNull(),
  timeOfDay: text("time_of_day").notNull(),
  timezone: text("timezone").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type PostingCadenceRow = typeof postingCadences.$inferSelect;

// Native ads execution (Sprint 20) — a launch is a draft ad campaign that
// must clear the approval gate before any API call that can spend money.
export const adLaunches = pgTable("ad_launches", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  adAccountId: text("ad_account_id")
    .notNull()
    .references(() => adAccounts.id, { onDelete: "cascade" }),
  // The Tuezday campaign reporting links to — copied from the creative draft.
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  creativeDraftId: text("creative_draft_id")
    .notNull()
    .references(() => drafts.id, { onDelete: "cascade" }),
  externalActionId: text("external_action_id").references(() => externalActions.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  pageId: text("page_id").notNull(),
  linkUrl: text("link_url").notNull(),
  // Integer cents in the account currency, like all ad money columns.
  dailyBudgetCents: bigint("daily_budget_cents", { mode: "number" }).notNull(),
  startAt: bigint("start_at", { mode: "number" }),
  endAt: bigint("end_at", { mode: "number" }),
  countriesJson: text("countries_json").notNull(),
  ageMin: bigint("age_min", { mode: "number" }).notNull(),
  ageMax: bigint("age_max", { mode: "number" }).notNull(),
  status: text("status").notNull().default("draft"),
  // External ids are persisted per step so a failed launch resumes, not dupes.
  externalCampaignId: text("external_campaign_id"),
  externalAdSetId: text("external_ad_set_id"),
  externalCreativeId: text("external_creative_id"),
  externalAdId: text("external_ad_id"),
  // Meta adimages hash (Sprint 41 Part 5): persisted after uploadAdImage so a
  // resumed launch never re-uploads; consumed by createAdCreative.
  metaImageHash: text("meta_image_hash"),
  // The Sprint 14 reporting mirror row created on a successful launch.
  adCampaignId: text("ad_campaign_id").references(() => adCampaigns.id, { onDelete: "set null" }),
  platformStatus: text("platform_status"),
  launchedAt: bigint("launched_at", { mode: "number" }),
  lastError: text("last_error"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [
  index("ad_launches_external_action").on(t.externalActionId),
],
);

export type AdLaunchRow = typeof adLaunches.$inferSelect;

// The spend decision log — who moved a launch through the gate, and who
// pulled the launch trigger. Structurally identical to approval_decisions.
export const adLaunchDecisions = pgTable("ad_launch_decisions", {
  id: text("id").primaryKey(),
  launchId: text("launch_id")
    .notNull()
    .references(() => adLaunches.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  actorId: text("actor_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type AdLaunchDecisionRow = typeof adLaunchDecisions.$inferSelect;

// Per-workspace spend guardrails; reads fall back to defaults when unset.
export const adSettings = pgTable("ad_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  dailyCapCents: bigint("daily_cap_cents", { mode: "number" }).notNull().default(5000),
  killSwitch: bigint("kill_switch", { mode: "number" }).notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type AdSettingsRow = typeof adSettings.$inferSelect;

// Per-workspace generation-quality settings (Sprint 22); reads fall back to
// defaults when unset, same pattern as ad_settings. Booleans stored as 0/1.
export const generationSettings = pgTable("generation_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  reviewEnabled: bigint("review_enabled", { mode: "number" }).notNull().default(1),
  angleEnabled: bigint("angle_enabled", { mode: "number" }).notNull().default(0),
  angleCount: bigint("angle_count", { mode: "number" }).notNull().default(3),
  flagThreshold: bigint("flag_threshold", { mode: "number" }).notNull().default(70),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type GenerationSettingsRow = typeof generationSettings.$inferSelect;

// Social automation guardrails (Sprint 28) — one row per workspace, like
// ad_settings. killSwitch is the hard stop for scheduled_auto posting; caps
// use each destination account's local day, with replies budgeted separately.
export const socialAutomationSettings = pgTable("social_automation_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  killSwitch: bigint("kill_switch", { mode: "number" }).notNull().default(0),
  perConnectionDailyCap: bigint("per_connection_daily_cap", { mode: "number" }).notNull().default(10),
  perConnectionReplyDailyCap: bigint("per_connection_reply_daily_cap", { mode: "number" }).notNull().default(10),
  perCampaignDailyCap: bigint("per_campaign_daily_cap", { mode: "number" }).notNull().default(5),
  // Sprint 29: master switch for auto-posting engagement replies (off by default).
  autoReplyEnabled: bigint("auto_reply_enabled", { mode: "number" }).notNull().default(0),
  // Sprint 45: minimum signal-match score (0-100) for runAutomation to route a
  // signal to a campaign.
  matchThreshold: bigint("match_threshold", { mode: "number" }).notNull().default(50),
  // Sprint 65 (D-65.1): AUTOMATION_GENERATION_PATHS — which path automation
  // uses for signal → social post. Default legacy: merging changes nothing.
  generationPath: text("generation_path").notNull().default("legacy"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type SocialAutomationSettingsRow = typeof socialAutomationSettings.$inferSelect;

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type EventRow = typeof events.$inferSelect;

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  eventTypesJson: text("event_types_json").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  httpStatus: bigint("http_status", { mode: "number" }),
  error: text("error"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

// Lead lists & segments (Sprint 24). An audience is a static hand-picked list
// or a dynamic segment whose members are computed live from rulesJson.
export const audiences = pgTable("audiences", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  kind: text("kind").notNull(),
  // The AND/OR rule tree (SegmentRuleGroup JSON) for dynamic segments; null for
  // static lists.
  rulesJson: text("rules_json"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type AudienceRow = typeof audiences.$inferSelect;

// Static-list membership, polymorphic over leads and crm_contacts. memberId has
// no FK (it points at one of two tables); the service validates on add and
// filters dangling rows on read.
export const audienceMembers = pgTable(
  "audience_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    audienceId: text("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    memberType: text("member_type").notNull(),
    memberId: text("member_id").notNull(),
    addedAt: bigint("added_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("audience_members_unique").on(t.audienceId, t.memberType, t.memberId)],
);

export type AudienceMemberRow = typeof audienceMembers.$inferSelect;

// A campaign's structured audience(s); many-to-many. The free-text
// campaigns.audience field stays as the human description.
export const campaignAudiences = pgTable(
  "campaign_audiences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    audienceId: text("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("campaign_audiences_unique").on(t.campaignId, t.audienceId)],
);

export type CampaignAudienceRow = typeof campaignAudiences.$inferSelect;

// Targeted campaign launch (Sprint 26). A launch targets an audience and
// produces per-recipient personalized first-touches (email, X DM) plus
// per-platform broadcast posts (LinkedIn, Instagram), each gated as a draft.
export const launches = pgTable("launches", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Recipients are snapshotted onto launch_messages at generate time, so a
  // later audience/campaign/persona delete never breaks the launch record.
  audienceId: text("audience_id").references(() => audiences.id, { onDelete: "set null" }),
  campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
  channelsJson: text("channels_json").notNull(),
  status: text("status").notNull().default("draft"),
  // Sequence config (Sprint 30). Ignored unless the launch has sequence_steps.
  automationMode: text("automation_mode").notNull().default("manual"),
  stopOnReply: bigint("stop_on_reply", { mode: "number" }).notNull().default(1),
  xConnectionId: text("x_connection_id").references(() => connections.id, { onDelete: "set null" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type LaunchRow = typeof launches.$inferSelect;

// One row per personalized recipient message, or one per platform broadcast.
// Recipient identity is a snapshot (polymorphic memberId, no FK). The draft
// carries the gated content; this row carries the dispatch outcome.
export const launchMessages = pgTable("launch_messages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  launchId: text("launch_id")
    .notNull()
    .references(() => launches.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  kind: text("kind").notNull(),
  recipientType: text("recipient_type"),
  recipientId: text("recipient_id"),
  recipientName: text("recipient_name").notNull().default(""),
  recipientEmail: text("recipient_email").notNull().default(""),
  recipientHandle: text("recipient_handle"),
  draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
  externalActionId: text("external_action_id").references(() => externalActions.id, {
    onDelete: "set null",
  }),
  status: text("status").notNull().default("pending"),
  skipReason: text("skip_reason"),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  publicationId: text("publication_id").references(() => publications.id, { onDelete: "set null" }),
  sentAt: bigint("sent_at", { mode: "number" }),
  lastError: text("last_error"),
  // Sequence wiring (Sprint 30). Step-1 / S26 first-touch rows default to step 1.
  stepNumber: bigint("step_number", { mode: "number" }).notNull().default(1),
  sequenceRecipientId: text("sequence_recipient_id").references(() => sequenceRecipients.id, {
    onDelete: "set null",
  }),
  // The connection an X DM was dispatched on (for the per-connection daily cap).
  connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [
  index("launch_messages_external_action").on(t.externalActionId),
],
);

export type LaunchMessageRow = typeof launchMessages.$inferSelect;

// Unified engagement inbox (Sprint 29). One row per inbound comment on our
// published posts or reply to our outbound DMs, polled per connection. The
// reply (if any) is a normal gated draft linked via replyDraftId.
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    // An InboxItemKind: comment (on our post) | dm (reply to our outbound DM).
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    // Platform id of the inbound item — idempotency key per connection.
    externalId: text("external_id").notNull(),
    // Platform id of the thing it replies to (our post/comment/DM).
    parentExternalId: text("parent_external_id"),
    publicationId: text("publication_id").references(() => publications.id, { onDelete: "set null" }),
    launchMessageId: text("launch_message_id").references(() => launchMessages.id, { onDelete: "set null" }),
    authorHandle: text("author_handle").notNull().default(""),
    authorName: text("author_name").notNull().default(""),
    content: text("content").notNull(),
    url: text("url"),
    status: text("status").notNull().default("unread"),
    // The gated reply draft, once generated.
    replyDraftId: text("reply_draft_id").references(() => drafts.id, { onDelete: "set null" }),
    externalActionId: text("external_action_id").references(() => externalActions.id, {
      onDelete: "set null",
    }),
    postedReplyExternalId: text("posted_reply_external_id"),
    postedReplyUrl: text("posted_reply_url"),
    // The sent outreach email this replies to (kind "email" — Sprint 47); the
    // email analog of publicationId (comment) / launchMessageId (dm).
    emailDeliveryId: text("email_delivery_id").references(() => emailDeliveries.id, {
      onDelete: "set null",
    }),
    // EmailReplyLabel from the best-effort LLM classifier; null = unclassified.
    replyLabel: text("reply_label"),
    replyLabeledAt: bigint("reply_labeled_at", { mode: "number" }),
    externalCreatedAt: bigint("external_created_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("inbox_items_connection_external").on(table.connectionId, table.externalId),
    index("inbox_items_external_action").on(table.externalActionId),
  ],
);

export type InboxItemRow = typeof inboxItems.$inferSelect;

// Platform-pulled engagement snapshots on a published post (Sprint 29). One row
// per (publication, window); separate from the learning-loop engagement_metrics.
export const publicationMetrics = pgTable(
  "publication_metrics",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    // A PublicationMetricWindow: "24h" | "7d".
    window: text("window").notNull(),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    shares: bigint("shares", { mode: "number" }),
    impressions: bigint("impressions", { mode: "number" }),
    clicks: bigint("clicks", { mode: "number" }),
    capturedAt: bigint("captured_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("publication_metrics_pub_window").on(table.publicationId, table.window)],
);

export type PublicationMetricRow = typeof publicationMetrics.$inferSelect;

// Multi-step outbound sequences (Sprint 30). A launch's follow-up chain template:
// an ordered list of steps per personalized channel (email / x). Step 1 is the
// first-touch; steps 2..N are follow-ups with a delay + optional founder angle.
export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id, { onDelete: "cascade" }),
    // A SequenceChannel: "email" | "x".
    channel: text("channel").notNull(),
    // 1-based, per channel.
    stepNumber: bigint("step_number", { mode: "number" }).notNull(),
    // Founder angle for this step; "" = the model writes a natural follow-up.
    instruction: text("instruction").notNull().default(""),
    // Delay (hours) after the previous step's actual send for that recipient.
    delayHours: bigint("delay_hours", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("sequence_steps_launch_channel_step").on(table.launchId, table.channel, table.stepNumber)],
);

export type SequenceStepRow = typeof sequenceSteps.$inferSelect;

// Per-recipient enrollment + progression through one channel's chain. The
// engine's source of truth for "who is where, and when the next step fires".
export const sequenceRecipients = pgTable(
  "sequence_recipients",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    launchId: text("launch_id")
      .notNull()
      .references(() => launches.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    recipientType: text("recipient_type").notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientName: text("recipient_name").notNull().default(""),
    recipientEmail: text("recipient_email").notNull().default(""),
    recipientHandle: text("recipient_handle"),
    // Highest step started for this recipient; 0 = enrolled, not yet generated.
    currentStep: bigint("current_step", { mode: "number" }).notNull().default(0),
    // A SequenceRecipientStatus.
    status: text("status").notNull().default("active"),
    nextDueAt: bigint("next_due_at", { mode: "number" }),
    lastSentAt: bigint("last_sent_at", { mode: "number" }),
    stoppedReason: text("stopped_reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("sequence_recipients_unique").on(
      table.launchId,
      table.channel,
      table.recipientType,
      table.recipientId,
    ),
  ],
);

export type SequenceRecipientRow = typeof sequenceRecipients.$inferSelect;

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("free"),                 // PlanId
  status: text("status").notNull().default("active"),           // active|past_due|canceled
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: bigint("current_period_end", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("subscriptions_workspace").on(t.workspaceId)]);

export type SubscriptionRow = typeof subscriptions.$inferSelect;

// Per-workspace notification channel config (Sprint 39). Each row represents a
// Telegram chat or email address the founder configured for approval notifications.
export const notificationChannels = pgTable("notification_channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // "telegram" | "email"
  target: text("target").notNull(),      // telegram chat id | email address
  enabled: boolean("enabled").notNull().default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

// Signed, one-time-use approval action tokens (Sprint 39). A button tap or
// email link carries a raw token; we store the sha256 and burn it on first use.
export const approvalActionTokens = pgTable(
  "approval_action_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),     // sha256 of the raw token
    workspaceId: text("workspace_id").notNull(),
    draftId: text("draft_id").notNull(),
    action: text("action").notNull(),            // "approve" | "reject"
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    usedAt: bigint("used_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("approval_action_tokens_hash").on(t.tokenHash)],
);

export type ApprovalActionTokenRow = typeof approvalActionTokens.$inferSelect;

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),         // sha256 of the raw key
  scopesJson: text("scopes_json").notNull(),   // JSON string[] of API_SCOPES
  lastUsedAt: bigint("last_used_at", { mode: "number" }),
  revokedAt: bigint("revoked_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("api_keys_hash").on(t.keyHash)]);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

// Design systems (Sprint 41 Part 2) — the Brain UI's additional "Design" tab.
// Deliberately NOT part of brain_documents / BRAIN_DOC_TYPES: only the design
// pipeline reads these, via resolveDesignSystem(), never packages/brain.
// Multiple named systems per workspace are supported at the schema level;
// v1 seeds exactly one org-level default (isDefault = 1) and the UI surfaces
// only that one. Uniqueness is (workspaceId, name), NOT workspaceId; the
// one-default-per-workspace invariant lives in the service.
export const designSystems = pgTable(
  "design_systems",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default"),
    isDefault: bigint("is_default", { mode: "number" }).notNull().default(0),
    content: text("content").notNull(), // DESIGN.md-shaped markdown
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("design_systems_workspace_name").on(t.workspaceId, t.name)],
);

export type DesignSystemRow = typeof designSystems.$inferSelect;

// Channel/persona/campaign overlays — clones guidance_overrides' shape and
// most-specific-wins precedence (Sprint 44), scoped to a design system. The
// winning overlay is appended to the base content as an addendum. Same SQLite
// NULLs-are-distinct caveat as guidance_overrides: the service upserts
// select-first instead of relying on ON CONFLICT.
export const designOverlays = pgTable(
  "design_overlays",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    designSystemId: text("design_system_id")
      .notNull()
      .references(() => designSystems.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    content: text("content").notNull(), // partial DESIGN.md override/addendum
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("design_overlays_system_channel_scope").on(
      t.designSystemId,
      t.channel,
      t.personaId,
      t.campaignId,
    ),
  ],
);

export type DesignOverlayRow = typeof designOverlays.$inferSelect;

// Cached, agent-authored HTML/CSS slide templates (Sprint 41 Part 3) —
// authored ONCE per (workspace, design system, skill, fingerprint, shape) via
// Open Design, then reused forever by the deterministic renderer. A design
// edit changes the fingerprint so stale templates simply never match again —
// rows are immutable, which also makes approved creatives reproducible.
export const designTemplates = pgTable(
  "design_templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    designSystemId: text("design_system_id")
      .notNull()
      .references(() => designSystems.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(), // e.g. "social-carousel"
    designSystemFingerprint: text("design_system_fingerprint").notNull(), // sha256 of *resolved* design markdown
    slideShape: text("slide_shape").notNull(), // SLIDE_ARCHETYPES member or ad shape, e.g. "hook", "ad-1080x1080"
    html: text("html").notNull(),
    css: text("css").notNull(),
    placeholders: text("placeholders_json").notNull(), // string[] of {{token}} names
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("design_templates_lookup").on(
      t.workspaceId,
      t.designSystemId,
      t.skillId,
      t.designSystemFingerprint,
      t.slideShape,
    ),
  ],
);

export type DesignTemplateRow = typeof designTemplates.$inferSelect;

// Agent runtime traces (Sprint 56) — every AgentRunner loop is persisted in
// full: the run row holds the input (system + initial messages) and totals;
// steps hold everything appended in order (model calls with per-step usage,
// tool dispatches with arguments and results). The transcript reconstructs
// without duplication, and the Sprint 57 Agent Inspector renders straight
// from these rows.
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    task: text("task").notNull(), // short label, e.g. "proof" / "pipeline:research"
    createdBy: text("created_by").notNull(), // actor attribution label
    // Sprint 79: set on a delegated worker's run. Self-referencing and
    // nullable; no cascade, because a swept parent must not take its children's
    // traces with it — the child's distilled report is what the parent kept.
    parentRunId: text("parent_run_id"),
    status: text("status").notNull(), // AGENT_RUN_STATUSES
    stopReason: text("stop_reason"), // AGENT_STOP_REASONS, set iff done
    error: text("error"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    system: text("system").notNull(),
    inputMessages: text("input_messages_json").notNull(), // AgentMessage[]
    outputJson: text("output_json"), // final structured/text output when complete
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    stepCount: bigint("step_count", { mode: "number" }).notNull().default(0),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
  },
  (t) => [
    index("agent_runs_workspace_started").on(t.workspaceId, t.startedAt),
    index("agent_runs_parent").on(t.parentRunId),
  ],
);

export type AgentRunRow = typeof agentRuns.$inferSelect;

export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepIndex: bigint("step_index", { mode: "number" }).notNull(),
    kind: text("kind").notNull(), // AGENT_STEP_KINDS
    messageJson: text("message_json"), // model_call: the assistant AgentMessage
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    toolArgsJson: text("tool_args_json"),
    toolResultJson: text("tool_result_json"),
    toolError: text("tool_error"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("agent_run_steps_run_index").on(t.runId, t.stepIndex)],
);

export type AgentRunStepRow = typeof agentRunSteps.$inferSelect;

// LLM usage ledger (Sprint 59) — one row per successful model call, written by
// the meteredLlm gateway proxy (and flat design-daemon events). This is the
// single budget authority: workspace spend, /billing spend-by-pipeline and the
// cache-hit-rate metric are all sums over this table. agent_runs keeps its own
// per-run totals for the Inspector; the runner's calls land here through the
// metered gateway, never via duplicate writes.
export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pipeline: text("pipeline").notNull(), // LLM_PIPELINES
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    agentRunId: text("agent_run_id"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("llm_usage_events_workspace_created").on(t.workspaceId, t.createdAt),
    index("llm_usage_events_workspace_pipeline").on(t.workspaceId, t.pipeline, t.createdAt),
  ],
);

export type LlmUsageEventRow = typeof llmUsageEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Pipeline definitions as data + execution engine (Sprint 64, Move 3)
// ---------------------------------------------------------------------------

// The current spec of one versioned pipeline. Scoped workspace → campaign →
// lane (most specific active definition wins, D-64.2); at most one active
// definition per exact scope, enforced in the activation transaction.
export const pipelineDefinitions = pgTable(
  "pipeline_definitions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(), // PIPELINE_TASK_KEYS
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    campaignId: text("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    laneId: text("lane_id").references(() => campaignLanes.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("draft"), // PIPELINE_DEFINITION_STATUSES
    currentVersion: bigint("current_version", { mode: "number" }).notNull().default(1),
    specJson: text("spec_json").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("pipeline_definitions_workspace_task").on(
      t.workspaceId,
      t.taskKey,
      t.status,
    ),
  ],
);

export type PipelineDefinitionRow = typeof pipelineDefinitions.$inferSelect;

// Append-only spec history (D-64.1) — strict unique per version, tighter
// than the brain-doc pattern, matching the Sprint 63 variants convention.
export const pipelineDefinitionVersions = pgTable(
  "pipeline_definition_versions",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => pipelineDefinitions.id, { onDelete: "cascade" }),
    version: bigint("version", { mode: "number" }).notNull(),
    specJson: text("spec_json").notNull(),
    actorLabel: text("actor_label").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("pipeline_definition_versions_version").on(
      t.definitionId,
      t.version,
    ),
  ],
);

export type PipelineDefinitionVersionRow =
  typeof pipelineDefinitionVersions.$inferSelect;

// One engine execution against a frozen definition version. The engine is
// deterministic between steps: status moves only through the contracts
// pipeline-run machine, and the lease fence keeps one run from executing
// twice concurrently (D-64.6).
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    definitionId: text("definition_id")
      .notNull()
      .references(() => pipelineDefinitions.id, { onDelete: "cascade" }),
    definitionVersion: bigint("definition_version", { mode: "number" }).notNull(),
    taskKey: text("task_key").notNull(),
    mode: text("mode").notNull().default("live"), // PIPELINE_RUN_MODES
    dryRunBatchId: text("dry_run_batch_id"),
    signalId: text("signal_id").references(() => signals.id, {
      onDelete: "set null",
    }),
    campaignId: text("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    laneId: text("lane_id").references(() => campaignLanes.id, {
      onDelete: "set null",
    }),
    personaId: text("persona_id").references(() => personas.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("queued"), // PIPELINE_RUN_STATUSES
    pausedAtStepKey: text("paused_at_step_key"),
    escalationReason: text("escalation_reason"),
    failureReason: text("failure_reason"),
    checklistJson: text("checklist_json").notNull().default("[]"),
    resultJson: text("result_json"),
    generationId: text("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    draftId: text("draft_id").references(() => drafts.id, {
      onDelete: "set null",
    }),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
  },
  (t) => [
    // D-64.12: dedupe only when the caller supplied a key.
    uniqueIndex("pipeline_runs_idempotency")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("pipeline_runs_workspace_status").on(
      t.workspaceId,
      t.status,
      t.createdAt,
    ),
    index("pipeline_runs_definition").on(t.definitionId, t.createdAt),
    index("pipeline_runs_batch").on(t.dryRunBatchId),
  ],
);

export type PipelineRunRow = typeof pipelineRuns.$inferSelect;

// Append-only step attempts (D-64.9): iteration counts revise-loop passes,
// attempt counts retries of one pass. `passes` is earned by validating the
// structured output against the declared kind (D-64.10).
export const pipelineRunSteps = pgTable(
  "pipeline_run_steps",
  {
    /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    iteration: bigint("iteration", { mode: "number" }).notNull().default(1),
    attempt: bigint("attempt", { mode: "number" }).notNull().default(1),
    status: text("status").notNull().default("pending"), // PIPELINE_STEP_STATUSES
    agentRunId: text("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    outputJson: text("output_json"),
    passes: bigint("passes", { mode: "number" }).notNull().default(0),
    failureReason: text("failure_reason"),
    stopReason: text("stop_reason"), // AGENT_STOP_REASONS
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("pipeline_run_steps_attempt").on(
      t.runId,
      t.stepKey,
      t.iteration,
      t.attempt,
    ),
    index("pipeline_run_steps_run").on(t.runId, t.createdAt),
  ],
);

export type PipelineRunStepRow = typeof pipelineRunSteps.$inferSelect;

// ---------------------------------------------------------------------------
// Sprint 65 — shadow A/B pairs + rollout decisions
// ---------------------------------------------------------------------------

// One legacy automation draft paired with its engine shadow run (D-65.7).
// pair_key is the shadow run's idempotency key (shadow:v1:ws:signal:campaign:
// channel) so a pair, like a run, exists at most once per work item.
export const pipelineShadowPairs = pgTable(
  "pipeline_shadow_pairs",
  {
    /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pairKey: text("pair_key").notNull(),
    signalId: text("signal_id").references(() => signals.id, {
      onDelete: "set null",
    }),
    campaignId: text("campaign_id").references(() => campaigns.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    draftId: text("draft_id").references(() => drafts.id, {
      onDelete: "set null",
    }),
    runId: text("run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "cascade" }),
    verdict: text("verdict"), // SHADOW_VERDICTS, null until reviewed
    verdictNotes: text("verdict_notes").notNull().default(""),
    verdictByUserId: text("verdict_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    verdictAt: bigint("verdict_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("pipeline_shadow_pairs_key").on(t.pairKey),
    index("pipeline_shadow_pairs_workspace").on(t.workspaceId, t.createdAt),
  ],
);

export type PipelineShadowPairRow = typeof pipelineShadowPairs.$inferSelect;

// Append-only founder calls on the A/B (D-65.9). metrics_json freezes the
// comparison snapshot the decision was made on; recording one also applies
// the matching generation_path on social_automation_settings.
export const pipelineRolloutDecisions = pgTable(
  "pipeline_rollout_decisions",
  {
    /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    decision: text("decision").notNull(), // ROLLOUT_DECISION_KINDS
    rationale: text("rationale").notNull(),
    metricsJson: text("metrics_json").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("pipeline_rollout_decisions_workspace").on(t.workspaceId, t.createdAt)],
);

export type PipelineRolloutDecisionRow = typeof pipelineRolloutDecisions.$inferSelect;

// ---------------------------------------------------------------------------
// Sprint 67 — Eval & replay harness
// ---------------------------------------------------------------------------

// D-67.5: machine-checkable claims the workspace will not publish. Channel
// guidance is prose an LLM interprets; this list is a hard check, and it is
// handed to the critic so a finding can cite the exact phrase it tripped on.
export const workspaceBannedClaims = pgTable(
  "workspace_banned_claims",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    phrase: text("phrase").notNull(),
    note: text("note").notNull().default(""),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workspace_banned_claims_phrase").on(t.workspaceId, t.phrase)],
);

export type WorkspaceBannedClaimRow = typeof workspaceBannedClaims.$inferSelect;

// D-67.2: a suite is frozen at build time so a trend line means something.
export const evalSuites = pgTable(
  "eval_suites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    taskKey: text("task_key").notNull(), // PIPELINE_TASK_KEYS
    channel: text("channel").notNull(),
    ctaExpectation: text("cta_expectation").notNull().default("any"), // CTA_EXPECTATIONS
    caseCount: bigint("case_count", { mode: "number" }).notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("eval_suites_workspace").on(t.workspaceId, t.createdAt)],
);

export type EvalSuiteRow = typeof evalSuites.$inferSelect;

// One historical tuple, snapshotted. The source FKs are set-null on purpose:
// deleting the draft a case was built from must not rewrite eval history.
export const evalCases = pgTable(
  "eval_cases",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id")
      .notNull()
      .references(() => evalSuites.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    signalId: text("signal_id").references(() => signals.id, { onDelete: "set null" }),
    signalContent: text("signal_content").notNull(),
    signalSource: text("signal_source").notNull(),
    channel: text("channel").notNull(),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    personaId: text("persona_id").references(() => personas.id, { onDelete: "set null" }),
    sourceDraftId: text("source_draft_id").references(() => drafts.id, { onDelete: "set null" }),
    generatedContent: text("generated_content").notNull(),
    finalContent: text("final_content").notNull(),
    outcome: text("outcome").notNull(), // EVAL_CASE_OUTCOMES
    rejectionReason: text("rejection_reason"),
    decidedAt: bigint("decided_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("eval_cases_suite").on(t.suiteId, t.createdAt)],
);

export type EvalCaseRow = typeof evalCases.$inferSelect;

// D-67.3: a baseline is a labelled run, not a second table. The partial unique
// index is what makes a label point at exactly one run per workspace.
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    suiteId: text("suite_id")
      .notNull()
      .references(() => evalSuites.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").references(() => pipelineDefinitions.id, {
      onDelete: "set null",
    }),
    definitionVersion: bigint("definition_version", { mode: "number" }),
    status: text("status").notNull().default("running"), // EVAL_RUN_STATUSES
    judgeEnabled: boolean("judge_enabled").notNull().default(false),
    metricsJson: text("metrics_json").notNull(),
    baselineLabel: text("baseline_label"),
    failureReason: text("failure_reason"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("eval_runs_baseline_label")
      .on(t.workspaceId, t.baselineLabel)
      .where(sql`${t.baselineLabel} IS NOT NULL`),
    index("eval_runs_workspace").on(t.workspaceId, t.createdAt),
  ],
);

export type EvalRunRow = typeof evalRuns.$inferSelect;

export const evalCaseResults = pgTable(
  "eval_case_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseId: text("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    pipelineRunId: text("pipeline_run_id").references(() => pipelineRuns.id, {
      onDelete: "set null",
    }),
    producedContent: text("produced_content"),
    checksJson: text("checks_json").notNull().default("[]"),
    judgeJson: text("judge_json"),
    verdict: text("verdict"), // EVAL_VERDICTS
    editDistanceToFinal: doublePrecision("edit_distance_to_final"),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull().default(0),
    failureReason: text("failure_reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("eval_case_results_run").on(t.runId, t.createdAt)],
);

export type EvalCaseResultRow = typeof evalCaseResults.$inferSelect;

// ---------------------------------------------------------------------------
// Preference memory (Sprint 68) — the fast learning layer.
//
// A human correction is captured verbatim and deterministically (no LLM in the
// request path, D-68.3); an extraction pass turns groups of same-scope edits
// into learned rules; the rules are injected as a traced resolver section and
// promoted into the brain docs only through the existing founder-accepts gate.
// ---------------------------------------------------------------------------

export const preferenceEdits = pgTable(
  "preference_edits",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // PREFERENCE_EDIT_SOURCES
    /** Decision id or revision-turn id — the unique key that makes capture idempotent. */
    sourceId: text("source_id").notNull(),
    // Set null, not cascade: deleting a draft removes the link, never the
    // correction it taught us (the Sprint 67 freeze rule).
    draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    taskType: text("task_type").notNull(),
    channel: text("channel").notNull(),
    beforeContent: text("before_content").notNull(),
    afterContent: text("after_content").notNull(),
    instruction: text("instruction"),
    editDistance: doublePrecision("edit_distance").notNull().default(0),
    digestedAt: bigint("digested_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("preference_edit_source").on(t.workspaceId, t.source, t.sourceId),
    index("preference_edit_undigested").on(t.workspaceId, t.digestedAt, t.createdAt),
  ],
);

export type PreferenceEditRow = typeof preferenceEdits.$inferSelect;

export const preferenceRules = pgTable(
  "preference_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    polarity: text("polarity").notNull(), // PREFERENCE_POLARITIES
    scopeTaskType: text("scope_task_type"),
    scopeChannel: text("scope_channel"),
    status: text("status").notNull(), // PREFERENCE_RULE_STATUSES
    origin: text("origin").notNull(), // PREFERENCE_RULE_ORIGINS
    confidence: bigint("confidence", { mode: "number" }).notNull().default(0),
    observationCount: bigint("observation_count", { mode: "number" }).notNull().default(0),
    appliedCount: bigint("applied_count", { mode: "number" }).notNull().default(0),
    lastObservedAt: bigint("last_observed_at", { mode: "number" }),
    lastAppliedAt: bigint("last_applied_at", { mode: "number" }),
    promotedAt: bigint("promoted_at", { mode: "number" }),
    retiredAt: bigint("retired_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("preference_rule_workspace").on(t.workspaceId, t.status, t.confidence)],
);

export type PreferenceRuleRow = typeof preferenceRules.$inferSelect;

export const preferenceRuleEvidence = pgTable(
  "preference_rule_evidence",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => preferenceRules.id, { onDelete: "cascade" }),
    editId: text("edit_id")
      .notNull()
      .references(() => preferenceEdits.id, { onDelete: "cascade" }),
    excerpt: text("excerpt").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("preference_rule_evidence_pair").on(t.ruleId, t.editId)],
);

export type PreferenceRuleEvidenceRow = typeof preferenceRuleEvidence.$inferSelect;

// ---------------------------------------------------------------------------
// Agent proposals (Sprint 69, PRD §8 / direction Move 7)
//
// One row per successful propose-tool call. `external_actions.origin` already
// says who proposed a given action; this says what a given *run* proposed, and
// it is the only place drafts (which are not external actions) and actions can
// be counted together — which is what the per-workspace daily cap needs.
//
// Both target links are `set null`: deleting the draft an agent wrote must not
// erase the fact that it wrote one.
// ---------------------------------------------------------------------------

export const agentProposals = pgTable(
  "agent_proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id").notNull(),
    tool: text("tool").notNull(),
    targetKind: text("target_kind").notNull(),
    draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    externalActionId: text("external_action_id").references(() => externalActions.id, {
      onDelete: "set null",
    }),
    // Sprint 77: what `propose_campaign` created. Set null on delete, like the
    // other two — the record of the proposal outlives the thing proposed.
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    rationale: text("rationale").notNull(),
    // Sprint 78: the conversation a founder confirmed this in. No FK — a
    // deleted thread must not take the record of what it proposed with it.
    chatSessionId: text("chat_session_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("agent_proposals_workspace_created").on(t.workspaceId, t.createdAt),
    index("agent_proposals_run").on(t.agentRunId),
  ],
);

export type AgentProposalRow = typeof agentProposals.$inferSelect;

/**
 * Sprint 70: the ask lane. One row per question an agent stopped to ask.
 *
 * `pipeline_run_id` is what makes suspend/resume work: the run itself is
 * suspended by `pipeline_runs.status = 'escalated'` (Sprint 64), and this row
 * is the only thing that knows *why* and can carry the answer back. Null on a
 * one-shot agent run, which has no resume point.
 */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentRunId: text("agent_run_id").notNull(),
    pipelineRunId: text("pipeline_run_id").references(() => pipelineRuns.id, {
      onDelete: "set null",
    }),
    stepKey: text("step_key"),
    /** Sprint 79: the background task this question suspended. The second
     * resume point beside `pipeline_run_id` — answering either re-queues the
     * work that stopped. No FK, so a swept task never blocks the question. */
    agentTaskId: text("agent_task_id"),
    type: text("type").notNull(),
    question: text("question").notNull(),
    why: text("why").notNull(),
    optionsJson: text("options_json"),
    /** sha256(type + normalized question) — the re-ask check (D-70.3). */
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("open"),
    answer: text("answer"),
    answeredByUserId: text("answered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    answeredByLabel: text("answered_by_label"),
    answeredAt: bigint("answered_at", { mode: "number" }),
    ruleId: text("rule_id").references(() => preferenceRules.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("agent_questions_workspace_status").on(t.workspaceId, t.status, t.createdAt),
    index("agent_questions_pipeline_run").on(t.pipelineRunId),
    index("agent_questions_run").on(t.agentRunId),
    index("agent_questions_task").on(t.agentTaskId),
  ],
);

export type AgentQuestionRow = typeof agentQuestions.$inferSelect;

// ---------------------------------------------------------------------------
// Background agents (Sprint 79, PRD §10 Move 9c)
//
// An `agent_run` is a TRACE: no queue, no cancel, no resume, no owner, and
// subject to retention. A detached unit of work needs an identity that
// outlives any single run — a task that asks a question and resumes is two
// runs, and a task that is steered is still one thing the founder is watching
// (D-79.1). Hence this table, with `agent_run_id` pointing at the CURRENT run.
// ---------------------------------------------------------------------------

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The thread it was detached from. Null for an API-created task: it still
     * runs, it just has nowhere to post its answer back to. */
    sessionId: text("session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    request: text("request").notNull(),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("queued"), // AGENT_TASK_STATUSES
    /** No FK, for the same retention reason as chat_messages.agent_run_id. */
    agentRunId: text("agent_run_id"),
    jobId: text("job_id"),
    /** The working transcript carried across a suspend/resume (D-79.10):
     * AgentMessage[], bounded, oldest tool results dropped first. */
    transcriptJson: text("transcript_json"),
    outputText: text("output_text"),
    stopReason: text("stop_reason"), // AGENT_STOP_REASONS
    error: text("error"),
    stepCount: bigint("step_count", { mode: "number" }).notNull().default(0),
    subagentCount: bigint("subagent_count", { mode: "number" }).notNull().default(0),
    steerCount: bigint("steer_count", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    /** Set by the cancel route; read by the executor at each step boundary. */
    cancelRequestedAt: bigint("cancel_requested_at", { mode: "number" }),
    /** Cleared from the inbox once a human has looked at the result. */
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("agent_tasks_workspace_created").on(t.workspaceId, t.createdAt),
    // The concurrency-cap read path and the inbox projection's read path.
    index("agent_tasks_workspace_status").on(t.workspaceId, t.status, t.createdAt),
    index("agent_tasks_session_created").on(t.sessionId, t.createdAt),
  ],
);

export type AgentTaskRow = typeof agentTasks.$inferSelect;

/**
 * Steering (D-79.7). A message arriving mid-generation cannot be applied to
 * that generation, so the executor drains unconsumed rows at each step
 * boundary and records which step consumed them. The row is the durable
 * queue between a founder typing and a run noticing.
 */
export const agentTaskMessages = pgTable(
  "agent_task_messages",
  {
    /** Insertion order; breaks same-millisecond ties (replaces SQLite rowid). */
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("steer"),
    content: text("content").notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
    consumedAtStep: bigint("consumed_at_step", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("agent_task_messages_task_created").on(t.taskId, t.createdAt)],
);

export type AgentTaskMessageRow = typeof agentTaskMessages.$inferSelect;
