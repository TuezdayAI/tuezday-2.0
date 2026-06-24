import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Keep this schema Postgres-portable: text ids, integer epoch-ms timestamps,
// no SQLite-only column tricks. The Postgres swap is planned for Sprint 8.

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    // Format: scrypt$<salt-hex>$<hash-hex> — see services/auth.ts.
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("users_email").on(t.email)],
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
// missing row means "use the default" for that channel.
export const guidanceOverrides = sqliteTable(
  "guidance_overrides",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("guidance_overrides_workspace_channel").on(t.workspaceId, t.channel)],
);

export type GuidanceOverrideRow = typeof guidanceOverrides.$inferSelect;

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  overlay: text("overlay").notNull().default(""),
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
  createdAt: integer("created_at").notNull(),
});

export type DiscoverySourceRow = typeof discoverySources.$inferSelect;

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
    scoreReason: text("score_reason"),
    status: text("status").notNull().default("new"),
    signalId: text("signal_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("discovered_items_source_external").on(t.sourceId, t.externalId)],
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
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type CampaignRow = typeof campaigns.$inferSelect;

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
  createdAt: integer("created_at").notNull(),
});

export type EvidenceDocumentRow = typeof evidenceDocuments.$inferSelect;

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
  status: text("status").notNull().default("connected"),
  lastCheckedAt: integer("last_checked_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
});

export type ConnectionRow = typeof connections.$inferSelect;

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
    lastSyncedAt: integer("last_synced_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("crm_contacts_connection_external").on(table.connectionId, table.externalId)],
);

export type CrmContactRow = typeof crmContacts.$inferSelect;

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
