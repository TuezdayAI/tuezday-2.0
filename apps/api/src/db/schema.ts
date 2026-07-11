import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Keep this schema Postgres-portable: text ids, integer epoch-ms timestamps,
// no SQLite-only column tricks. The Postgres swap is planned for Sprint 8.

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  analyticsOptOut: integer("analytics_opt_out", { mode: "boolean" }).notNull().default(false),
  // Onboarding wizard (Sprint 36.1): the site the brain will be drafted from,
  // and where the workspace stands in the wizard (null = pre-wizard workspace).
  websiteUrl: text("website_url"),
  onboardingStep: text("onboarding_step"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;

// One extracted brand profile per workspace (Sprint 36.2). Overwritten on
// re-run; editable via PATCH once ready. profileJson holds a BrandProfile.
export const brandProfiles = sqliteTable(
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
    corpusChars: integer("corpus_chars").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("brand_profiles_workspace").on(t.workspaceId)],
);

export type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    // Format: scrypt$<salt-hex>$<hash-hex> — see services/auth.ts.
    passwordHash: text("password_hash"),
    googleSub: text("google_sub"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("users_email").on(t.email), uniqueIndex("users_google_sub").on(t.googleSub)],
);

export type UserRow = typeof users.$inferSelect;

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 of the bearer token; the raw token is only ever returned once.
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [uniqueIndex("sessions_token_hash").on(t.tokenHash)],
);

export type SessionRow = typeof sessions.$inferSelect;

export const workspaceMembers = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("workspace_members_workspace_user").on(t.workspaceId, t.userId)],
);

export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

export const workspaceInvites = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
  },
  (t) => [uniqueIndex("workspace_invites_token").on(t.token)],
);

export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect;

export const brainDocuments = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("brain_documents_workspace_doc_type").on(t.workspaceId, t.docType)],
);

export type BrainDocumentRow = typeof brainDocuments.$inferSelect;

export const brainDocumentVersions = sqliteTable("brain_document_versions", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => brainDocuments.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  // Nullable: versions written before auth existed (Sprint 19).
  actor: text("actor"),
  actorId: text("actor_id"),
  createdAt: integer("created_at").notNull(),
});

export type BrainDocumentVersionRow = typeof brainDocumentVersions.$inferSelect;

// Per-workspace, per-channel guidance overrides (Sprint 21). The built-in
// defaults live in @tuezday/contracts; this table holds overrides only. A
// missing row means "use the default" for that channel. Sprint 44 adds
// optional persona/campaign scope: NULL persona+campaign is the workspace-wide
// override; resolution picks the most specific matching row. SQLite treats
// NULLs as distinct in the unique index, so the service layer upserts
// select-first rather than relying on ON CONFLICT for the unscoped row.
export const guidanceOverrides = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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
export const contextMatrixOverrides = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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

export const personas = sqliteTable("personas", {
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type PersonaRow = typeof personas.$inferSelect;

export const generations = sqliteTable("generations", {
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
  durationMs: integer("duration_ms").notNull(),
  rating: text("rating"),
  ratedAt: integer("rated_at"),
  // Sprint 22 dual-LLM pre-review of `output`, as JSON (GenerationReview).
  // Null when review is disabled or never ran.
  reviewJson: text("review_json"),
  createdAt: integer("created_at").notNull(),
});

export type GenerationRow = typeof generations.$inferSelect;

export const drafts = sqliteTable("drafts", {
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
  // Sprint 22 pre-review (GenerationReview JSON), copied from the source
  // generation at submit or refreshed by the Re-run review action. Null when
  // never reviewed.
  reviewJson: text("review_json"),
  // Sprint 41: rendered visuals (LaunchMedia[] JSON) — what a reviewer sees,
  // while content holds what they read. Null for text-only drafts.
  mediaJson: text("media_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type DraftRow = typeof drafts.$inferSelect;

export const approvalDecisions = sqliteTable("approval_decisions", {
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
  actor: text("actor").notNull(),
  // Nullable: decisions logged before auth existed, or by the system actor.
  actorId: text("actor_id"),
  createdAt: integer("created_at").notNull(),
});

export type ApprovalDecisionRow = typeof approvalDecisions.$inferSelect;

export const signals = sqliteTable("signals", {
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
  createdAt: integer("created_at").notNull(),
});

export type SignalRow = typeof signals.$inferSelect;

export const discoverySources = sqliteTable("discovery_sources", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull(),
  lastError: text("last_error"),
  lastFetchedAt: integer("last_fetched_at"),
  // Connected sourcing (Sprint 46): the workspace connection this source reads
  // through; null for keyless sources. No declared FK to `connections`:
  // drizzle-kit's SQLite ALTER TABLE ADD action gap (deferred #26) — cleared
  // at the service level when a connection is deleted.
  connectionId: text("connection_id"),
  // Best-effort provider pagination state keyed by mode.
  cursorJson: text("cursor_json").notNull().default("{}"),
  // Rate-limit back-pressure: the source is not enqueued until this passes.
  backoffUntil: integer("backoff_until"),
  lastAttemptedAt: integer("last_attempted_at"),
  createdAt: integer("created_at").notNull(),
});

export type DiscoverySourceRow = typeof discoverySources.$inferSelect;

// Discovery job ledger (Sprint 46): one row per source fetch attempt. Bounded
// batches per `/discovery/run` give retries, per-source progress, and prevent
// one slow provider from serializing the whole workspace — no external queue.
export const discoveryJobs = sqliteTable(
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
    attempt: integer("attempt").notNull().default(0),
    lockedAt: integer("locked_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    fetchedCount: integer("fetched_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("discovery_jobs_workspace_status").on(t.workspaceId, t.status, t.createdAt),
    index("discovery_jobs_source_status").on(t.sourceId, t.status),
  ],
);

export type DiscoveryJobRow = typeof discoveryJobs.$inferSelect;

// Tracked social accounts (Sprint 46): first-class competitor/source accounts.
// Discovery sources reference them via config.trackedAccountId(s) — no FK from
// the JSON config, so deleting one simply drops it from future fetches.
export const trackedSocialAccounts = sqliteTable(
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
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastResolvedAt: integer("last_resolved_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("tracked_social_account_unique").on(t.workspaceId, t.platform, t.handle)],
);

export type TrackedSocialAccountRow = typeof trackedSocialAccounts.$inferSelect;

export const discoveredItems = sqliteTable(
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
    publishedAt: integer("published_at"),
    score: integer("score"),
    suggestedPersonaId: text("suggested_persona_id"),
    suggestedCampaignId: text("suggested_campaign_id"),
    scoreReason: text("score_reason"),
    status: text("status").notNull().default("new"),
    signalId: text("signal_id"),
    // Sprint 45: re-score watermark — when the item was last LLM-judged. Null
    // for never-scored items.
    scoredAt: integer("scored_at"),
    // Sprint 45 cross-source dedup: sha256 of the normalized URL (null when the
    // item has no URL) and of the normalized title + summary prefix.
    urlHash: text("url_hash"),
    contentHash: text("content_hash").notNull().default(""),
    // Self-reference to the canonical item when status = "duplicate". No
    // declared FK: drizzle-kit's SQLite ALTER TABLE ADD cascade gap (deferred
    // #26) — enforced at the service level instead.
    duplicateOfId: text("duplicate_of_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("discovered_items_source_external").on(t.sourceId, t.externalId),
    index("discovered_items_workspace_url_hash").on(t.workspaceId, t.urlHash),
    index("discovered_items_workspace_content_hash").on(t.workspaceId, t.contentHash),
  ],
);

export type DiscoveredItemRow = typeof discoveredItems.$inferSelect;

export const campaigns = sqliteTable("campaigns", {
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
  autoDailyCap: integer("auto_daily_cap"),
  // Service-validated pointer to the active immutable plan revision. Kept as
  // a plain id to avoid a circular SQLite table-recreate migration.
  currentPlanRevisionId: text("current_plan_revision_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type CampaignRow = typeof campaigns.$inferSelect;

// Immutable campaign intent snapshots. Activating a new row supersedes the
// old one; historical generations keep the exact revision they used.
export const campaignPlanRevisions = sqliteTable(
  "campaign_plan_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: text("status").notNull().default("draft"),
    objective: text("objective").notNull().default(""),
    kpi: text("kpi").notNull().default(""),
    startAt: integer("start_at"),
    endAt: integer("end_at"),
    audienceIdsJson: text("audience_ids_json").notNull().default("[]"),
    pillarsJson: text("pillars_json").notNull().default("[]"),
    offersJson: text("offers_json").notNull().default("[]"),
    ctasJson: text("ctas_json").notNull().default("[]"),
    guidance: text("guidance").notNull().default(""),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    activatedAt: integer("activated_at"),
  },
  (t) => [
    uniqueIndex("campaign_plan_revision_number").on(t.campaignId, t.revision),
    index("campaign_plan_workspace_campaign").on(t.workspaceId, t.campaignId),
  ],
);

export type CampaignPlanRevisionRow = typeof campaignPlanRevisions.$inferSelect;

// Stable production thread. Its revision-scoped configuration lives below so
// historical attribution survives campaign plan edits.
export const campaignLanes = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("campaign_lane_key").on(t.campaignId, t.key),
    index("campaign_lane_workspace_campaign").on(t.workspaceId, t.campaignId),
  ],
);

export type CampaignLaneRow = typeof campaignLanes.$inferSelect;

export const campaignLaneRevisions = sqliteTable(
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
    plannedQuantity: integer("planned_quantity").notNull().default(0),
    scheduleJson: text("schedule_json"),
    reactivePeriod: text("reactive_period"),
    reactiveCap: integer("reactive_cap"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("campaign_lane_plan_revision").on(t.laneId, t.planRevisionId),
    index("campaign_lane_revision_plan").on(t.planRevisionId),
  ],
);

export type CampaignLaneRevisionRow = typeof campaignLaneRevisions.$inferSelect;

// Sprint 45 multi-candidate scoring: one row per candidate persona×campaign
// pairing a discovered item scored above zero relevance for. Replaced
// (delete-then-insert) each time the item is scored.
export const discoveredItemMatches = sqliteTable(
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
    score: integer("score").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("discovered_item_matches_item").on(t.itemId)],
);

export type DiscoveredItemMatchRow = typeof discoveredItemMatches.$inferSelect;

// Sprint 45: same shape for signals — copied from discovered_item_matches on
// accept, written directly for manually-created signals. runAutomation routes
// a signal to a campaign only via a row here at/above the match threshold.
export const signalMatches = sqliteTable(
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
    score: integer("score").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("signal_matches_signal").on(t.signalId),
    index("signal_matches_signal_campaign").on(t.signalId, t.campaignId),
  ],
);

export type SignalMatchRow = typeof signalMatches.$inferSelect;

export const evidenceDocuments = sqliteTable("evidence_documents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  r2rDocumentId: text("r2r_document_id"),
  title: text("title").notNull(),
  chars: integer("chars").notNull(),
  status: text("status").notNull().default("processing"),
  error: text("error"),
  // Provenance (Sprint 30): manual paste vs accepted ingest candidate.
  kind: text("kind").notNull().default("manual"),
  sourceRef: text("source_ref"),
  sourceCreatedAt: integer("source_created_at"),
  createdAt: integer("created_at").notNull(),
});

export type EvidenceDocumentRow = typeof evidenceDocuments.$inferSelect;

// One R2R collection per workspace (Sprint 30) — replaces document-id-filter
// scoping with real per-workspace isolation inside the store.
export const evidenceCollections = sqliteTable("evidence_collections", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  r2rCollectionId: text("r2r_collection_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type EvidenceCollectionRow = typeof evidenceCollections.$inferSelect;

// Founder-gated ingest queue (Sprint 30): the worker proposes signals +
// published posts; the founder accepts them into the corpus. Unique on
// (workspace, kind, sourceRef) so a source is proposed at most once.
export const evidenceCandidates = sqliteTable(
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
    sourceCreatedAt: integer("source_created_at").notNull(),
    status: text("status").notNull().default("pending"),
    evidenceDocumentId: text("evidence_document_id"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => [uniqueIndex("evidence_candidates_source").on(t.workspaceId, t.kind, t.sourceRef)],
);

export type EvidenceCandidateRow = typeof evidenceCandidates.$inferSelect;

export const engagementMetrics = sqliteTable("engagement_metrics", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: text("draft_id"),
  channel: text("channel").notNull(),
  description: text("description").notNull().default(""),
  impressions: integer("impressions"),
  engagements: integer("engagements"),
  clicks: integer("clicks"),
  notes: text("notes").notNull().default(""),
  recordedAt: integer("recorded_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type EngagementMetricRow = typeof engagementMetrics.$inferSelect;

export const nowSyntheses = sqliteTable("now_syntheses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  proposal: text("proposal").notNull(),
  rationale: text("rationale").notNull(),
  basedOnJson: text("based_on_json").notNull(),
  status: text("status").notNull().default("proposed"),
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
});

export type NowSynthesisRow = typeof nowSyntheses.$inferSelect;

export const leads = sqliteTable("leads", {
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
  createdAt: integer("created_at").notNull(),
});

export type LeadRow = typeof leads.$inferSelect;

// PR & media outreach (Sprint 16) — the founder's media list, not a media DB.
export const mediaContacts = sqliteTable("media_contacts", {
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
  createdAt: integer("created_at").notNull(),
});

export type MediaContactRow = typeof mediaContacts.$inferSelect;

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  providerKey: text("provider_key").notNull(),
  nangoConnectionId: text("nango_connection_id").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  displayName: text("display_name").notNull().default(""),
  externalAccountId: text("external_account_id"),
  externalAccountName: text("external_account_name"),
  externalAccountHandle: text("external_account_handle"),
  externalAccountUrl: text("external_account_url"),
  status: text("status").notNull().default("connected"),
  lastCheckedAt: integer("last_checked_at"),
  lastError: text("last_error"),
  // Sprint 44: per-account content profile ({ topics: string[], guidance }),
  // injected into the context bundle when a draft resolves to this connection.
  contentProfileJson: text("content_profile_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type ConnectionRow = typeof connections.$inferSelect;

export const personaSocialAccounts = sqliteTable(
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
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    defaultTarget: text("default_target").notNull().default("feed"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("persona_social_accounts_unique").on(table.personaId, table.connectionId, table.channel),
  ],
);

export type PersonaSocialAccountRow = typeof personaSocialAccounts.$inferSelect;

// Synced mirror of CRM contacts — the CRM stays the system of record.
export const crmContacts = sqliteTable(
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
    discardedAt: integer("discarded_at"),
    lastSyncedAt: integer("last_synced_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("crm_contacts_connection_external").on(table.connectionId, table.externalId)],
);

export type CrmContactRow = typeof crmContacts.$inferSelect;

// Per-connection CRM sync filter (Sprint 23). Stored separately so the generic
// connection config stays provider-agnostic; cascades with its connection.
export const crmSyncSettings = sqliteTable("crm_sync_settings", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  filterJson: text("filter_json").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});

export type CrmSyncSettingsRow = typeof crmSyncSettings.$inferSelect;

// Ads reporting (Sprint 14). Tuezday owns this metric model regardless of
// source; connectionId null marks the workspace's CSV-only account.
export const adAccounts = sqliteTable(
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
    lastSyncedAt: integer("last_synced_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("ad_accounts_workspace_external").on(t.workspaceId, t.externalId)],
);

export type AdAccountRow = typeof adAccounts.$inferSelect;

export const adCampaigns = sqliteTable(
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
    lastSyncedAt: integer("last_synced_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("ad_campaigns_account_external").on(t.adAccountId, t.externalId)],
);

export type AdCampaignRow = typeof adCampaigns.$inferSelect;

export const adCampaignMetrics = sqliteTable(
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
    spendCents: integer("spend_cents").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("ad_campaign_metrics_campaign_date").on(t.adCampaignId, t.date)],
);

export type AdCampaignMetricRow = typeof adCampaignMetrics.$inferSelect;

// Social publishing receipts (Sprint 17) — one row per publish attempt (now
// or scheduled); the post lives on the platform, Tuezday keeps status + URL.
export const publications = sqliteTable("publications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  draftId: text("draft_id")
    .notNull()
    .references(() => drafts.id, { onDelete: "cascade" }),
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
  scheduledFor: integer("scheduled_for").notNull(),
  publishedAt: integer("published_at"),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type PublicationRow = typeof publications.$inferSelect;

// Recurring posting cadence (Sprint 27). Defines repeating slots (days-of-week
// + time-of-day in an IANA timezone) bound to a campaign/channel/account;
// approved matching drafts auto-fill the next open slots as scheduled
// publications, which the Sprint 17 worker fires on time.
export const postingCadences = sqliteTable("posting_cadences", {
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type PostingCadenceRow = typeof postingCadences.$inferSelect;

// Native ads execution (Sprint 20) — a launch is a draft ad campaign that
// must clear the approval gate before any API call that can spend money.
export const adLaunches = sqliteTable("ad_launches", {
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
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  pageId: text("page_id").notNull(),
  linkUrl: text("link_url").notNull(),
  // Integer cents in the account currency, like all ad money columns.
  dailyBudgetCents: integer("daily_budget_cents").notNull(),
  startAt: integer("start_at"),
  endAt: integer("end_at"),
  countriesJson: text("countries_json").notNull(),
  ageMin: integer("age_min").notNull(),
  ageMax: integer("age_max").notNull(),
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
  launchedAt: integer("launched_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type AdLaunchRow = typeof adLaunches.$inferSelect;

// The spend decision log — who moved a launch through the gate, and who
// pulled the launch trigger. Structurally identical to approval_decisions.
export const adLaunchDecisions = sqliteTable("ad_launch_decisions", {
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
  createdAt: integer("created_at").notNull(),
});

export type AdLaunchDecisionRow = typeof adLaunchDecisions.$inferSelect;

// Per-workspace spend guardrails; reads fall back to defaults when unset.
export const adSettings = sqliteTable("ad_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  dailyCapCents: integer("daily_cap_cents").notNull().default(5000),
  killSwitch: integer("kill_switch").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export type AdSettingsRow = typeof adSettings.$inferSelect;

// Per-workspace generation-quality settings (Sprint 22); reads fall back to
// defaults when unset, same pattern as ad_settings. Booleans stored as 0/1.
export const generationSettings = sqliteTable("generation_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  reviewEnabled: integer("review_enabled").notNull().default(1),
  angleEnabled: integer("angle_enabled").notNull().default(0),
  angleCount: integer("angle_count").notNull().default(3),
  flagThreshold: integer("flag_threshold").notNull().default(70),
  updatedAt: integer("updated_at").notNull(),
});

export type GenerationSettingsRow = typeof generationSettings.$inferSelect;

// Social automation guardrails (Sprint 28) — one row per workspace, like
// ad_settings. killSwitch is the hard stop for scheduled_auto posting; the caps
// bound auto-posts per UTC day (per connection and per campaign).
export const socialAutomationSettings = sqliteTable("social_automation_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  killSwitch: integer("kill_switch").notNull().default(0),
  perConnectionDailyCap: integer("per_connection_daily_cap").notNull().default(10),
  perCampaignDailyCap: integer("per_campaign_daily_cap").notNull().default(5),
  // Sprint 29: master switch for auto-posting engagement replies (off by default).
  autoReplyEnabled: integer("auto_reply_enabled").notNull().default(0),
  // Sprint 45: minimum signal-match score (0-100) for runAutomation to route a
  // signal to a campaign.
  matchThreshold: integer("match_threshold").notNull().default(50),
  updatedAt: integer("updated_at").notNull(),
});

export type SocialAutomationSettingsRow = typeof socialAutomationSettings.$inferSelect;

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type EventRow = typeof events.$inferSelect;

export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  eventTypesJson: text("event_types_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id")
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

// Lead lists & segments (Sprint 24). An audience is a static hand-picked list
// or a dynamic segment whose members are computed live from rulesJson.
export const audiences = sqliteTable("audiences", {
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type AudienceRow = typeof audiences.$inferSelect;

// Static-list membership, polymorphic over leads and crm_contacts. memberId has
// no FK (it points at one of two tables); the service validates on add and
// filters dangling rows on read.
export const audienceMembers = sqliteTable(
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
    addedAt: integer("added_at").notNull(),
  },
  (t) => [uniqueIndex("audience_members_unique").on(t.audienceId, t.memberType, t.memberId)],
);

export type AudienceMemberRow = typeof audienceMembers.$inferSelect;

// A campaign's structured audience(s); many-to-many. The free-text
// campaigns.audience field stays as the human description.
export const campaignAudiences = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("campaign_audiences_unique").on(t.campaignId, t.audienceId)],
);

export type CampaignAudienceRow = typeof campaignAudiences.$inferSelect;

// Targeted campaign launch (Sprint 26). A launch targets an audience and
// produces per-recipient personalized first-touches (email, X DM) plus
// per-platform broadcast posts (LinkedIn, Instagram), each gated as a draft.
export const launches = sqliteTable("launches", {
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
  stopOnReply: integer("stop_on_reply").notNull().default(1),
  xConnectionId: text("x_connection_id").references(() => connections.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type LaunchRow = typeof launches.$inferSelect;

// One row per personalized recipient message, or one per platform broadcast.
// Recipient identity is a snapshot (polymorphic memberId, no FK). The draft
// carries the gated content; this row carries the dispatch outcome.
export const launchMessages = sqliteTable("launch_messages", {
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
  status: text("status").notNull().default("pending"),
  skipReason: text("skip_reason"),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  publicationId: text("publication_id").references(() => publications.id, { onDelete: "set null" }),
  sentAt: integer("sent_at"),
  lastError: text("last_error"),
  // Sequence wiring (Sprint 30). Step-1 / S26 first-touch rows default to step 1.
  stepNumber: integer("step_number").notNull().default(1),
  sequenceRecipientId: text("sequence_recipient_id").references(() => sequenceRecipients.id, {
    onDelete: "set null",
  }),
  // The connection an X DM was dispatched on (for the per-connection daily cap).
  connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type LaunchMessageRow = typeof launchMessages.$inferSelect;

// Unified engagement inbox (Sprint 29). One row per inbound comment on our
// published posts or reply to our outbound DMs, polled per connection. The
// reply (if any) is a normal gated draft linked via replyDraftId.
export const inboxItems = sqliteTable(
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
    postedReplyExternalId: text("posted_reply_external_id"),
    postedReplyUrl: text("posted_reply_url"),
    externalCreatedAt: integer("external_created_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("inbox_items_connection_external").on(table.connectionId, table.externalId)],
);

export type InboxItemRow = typeof inboxItems.$inferSelect;

// Platform-pulled engagement snapshots on a published post (Sprint 29). One row
// per (publication, window); separate from the learning-loop engagement_metrics.
export const publicationMetrics = sqliteTable(
  "publication_metrics",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    // A MetricWindow: "24h" | "7d".
    window: text("window").notNull(),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    capturedAt: integer("captured_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("publication_metrics_pub_window").on(table.publicationId, table.window)],
);

export type PublicationMetricRow = typeof publicationMetrics.$inferSelect;

// Multi-step outbound sequences (Sprint 30). A launch's follow-up chain template:
// an ordered list of steps per personalized channel (email / x). Step 1 is the
// first-touch; steps 2..N are follow-ups with a delay + optional founder angle.
export const sequenceSteps = sqliteTable(
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
    stepNumber: integer("step_number").notNull(),
    // Founder angle for this step; "" = the model writes a natural follow-up.
    instruction: text("instruction").notNull().default(""),
    // Delay (hours) after the previous step's actual send for that recipient.
    delayHours: integer("delay_hours").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("sequence_steps_launch_channel_step").on(table.launchId, table.channel, table.stepNumber)],
);

export type SequenceStepRow = typeof sequenceSteps.$inferSelect;

// Per-recipient enrollment + progression through one channel's chain. The
// engine's source of truth for "who is where, and when the next step fires".
export const sequenceRecipients = sqliteTable(
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
    currentStep: integer("current_step").notNull().default(0),
    // A SequenceRecipientStatus.
    status: text("status").notNull().default("active"),
    nextDueAt: integer("next_due_at"),
    lastSentAt: integer("last_sent_at"),
    stoppedReason: text("stopped_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("free"),                 // PlanId
  status: text("status").notNull().default("active"),           // active|past_due|canceled
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: integer("current_period_end"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("subscriptions_workspace").on(t.workspaceId)]);

export type SubscriptionRow = typeof subscriptions.$inferSelect;

// Per-workspace notification channel config (Sprint 39). Each row represents a
// Telegram chat or email address the founder configured for approval notifications.
export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // "telegram" | "email"
  target: text("target").notNull(),      // telegram chat id | email address
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

// Signed, one-time-use approval action tokens (Sprint 39). A button tap or
// email link carries a raw token; we store the sha256 and burn it on first use.
export const approvalActionTokens = sqliteTable(
  "approval_action_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),     // sha256 of the raw token
    workspaceId: text("workspace_id").notNull(),
    draftId: text("draft_id").notNull(),
    action: text("action").notNull(),            // "approve" | "reject"
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("approval_action_tokens_hash").on(t.tokenHash)],
);

export type ApprovalActionTokenRow = typeof approvalActionTokens.$inferSelect;

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),         // sha256 of the raw key
  scopesJson: text("scopes_json").notNull(),   // JSON string[] of API_SCOPES
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("api_keys_hash").on(t.keyHash)]);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

// Design systems (Sprint 41 Part 2) — the Brain UI's additional "Design" tab.
// Deliberately NOT part of brain_documents / BRAIN_DOC_TYPES: only the design
// pipeline reads these, via resolveDesignSystem(), never packages/brain.
// Multiple named systems per workspace are supported at the schema level;
// v1 seeds exactly one org-level default (isDefault = 1) and the UI surfaces
// only that one. Uniqueness is (workspaceId, name), NOT workspaceId; the
// one-default-per-workspace invariant lives in the service.
export const designSystems = sqliteTable(
  "design_systems",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default"),
    isDefault: integer("is_default").notNull().default(0),
    content: text("content").notNull(), // DESIGN.md-shaped markdown
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("design_systems_workspace_name").on(t.workspaceId, t.name)],
);

export type DesignSystemRow = typeof designSystems.$inferSelect;

// Channel/persona/campaign overlays — clones guidance_overrides' shape and
// most-specific-wins precedence (Sprint 44), scoped to a design system. The
// winning overlay is appended to the base content as an addendum. Same SQLite
// NULLs-are-distinct caveat as guidance_overrides: the service upserts
// select-first instead of relying on ON CONFLICT.
export const designOverlays = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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
export const designTemplates = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
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
