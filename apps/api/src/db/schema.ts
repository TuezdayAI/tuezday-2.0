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
  createdAt: integer("created_at").notNull(),
});

export type BrainDocumentVersionRow = typeof brainDocumentVersions.$inferSelect;

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
