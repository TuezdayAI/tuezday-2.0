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
