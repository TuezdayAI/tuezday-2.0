import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  BRAIN_DOC_TYPES,
  type BrainDocType,
  type BrainDocVersion,
  type BrainDocument,
} from "@tuezday/contracts";
import {
  renderBrainMarkdown,
  scoreBrain,
  type BrainContents,
  type BrainScore,
} from "@tuezday/brain";
import type { Db } from "../db";
import { brainDocumentVersions, brainDocuments } from "../db/schema";

const CANONICAL_ORDER = new Map(BRAIN_DOC_TYPES.map((t, i) => [t, i]));

function rowToDoc(row: typeof brainDocuments.$inferSelect): BrainDocument {
  return { ...row, docType: row.docType as BrainDocType };
}

/**
 * Idempotently create any missing brain docs for a workspace. Called on
 * workspace creation and again on read so workspaces that predate this
 * sprint pick up their docs lazily.
 */
export function ensureBrainDocs(db: Db, workspaceId: string): void {
  const existing = db
    .select({ docType: brainDocuments.docType })
    .from(brainDocuments)
    .where(eq(brainDocuments.workspaceId, workspaceId))
    .all();
  const have = new Set(existing.map((r) => r.docType));
  const now = Date.now();
  for (const docType of BRAIN_DOC_TYPES) {
    if (!have.has(docType)) {
      db.insert(brainDocuments)
        .values({ id: randomUUID(), workspaceId, docType, content: "", createdAt: now, updatedAt: now })
        .run();
    }
  }
}

export interface BrainView {
  docs: BrainDocument[];
  completeness: BrainScore;
}

export function getBrain(db: Db, workspaceId: string): BrainView {
  ensureBrainDocs(db, workspaceId);
  const docs = db
    .select()
    .from(brainDocuments)
    .where(eq(brainDocuments.workspaceId, workspaceId))
    .all()
    .map(rowToDoc)
    .sort((a, b) => CANONICAL_ORDER.get(a.docType)! - CANONICAL_ORDER.get(b.docType)!);

  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  return { docs, completeness: scoreBrain(contents) };
}

export function updateBrainDoc(
  db: Db,
  workspaceId: string,
  docType: BrainDocType,
  content: string,
): BrainDocument {
  ensureBrainDocs(db, workspaceId);
  const doc = db
    .select()
    .from(brainDocuments)
    .where(and(eq(brainDocuments.workspaceId, workspaceId), eq(brainDocuments.docType, docType)))
    .get()!;

  const now = Date.now();
  db.update(brainDocuments)
    .set({ content, updatedAt: now })
    .where(eq(brainDocuments.id, doc.id))
    .run();

  const latest = db
    .select({ version: brainDocumentVersions.version })
    .from(brainDocumentVersions)
    .where(eq(brainDocumentVersions.documentId, doc.id))
    .orderBy(desc(brainDocumentVersions.version))
    .get();
  db.insert(brainDocumentVersions)
    .values({
      id: randomUUID(),
      documentId: doc.id,
      version: (latest?.version ?? 0) + 1,
      content,
      createdAt: now,
    })
    .run();

  return rowToDoc({ ...doc, content, updatedAt: now });
}

export function listDocVersions(
  db: Db,
  workspaceId: string,
  docType: BrainDocType,
): BrainDocVersion[] {
  ensureBrainDocs(db, workspaceId);
  const doc = db
    .select({ id: brainDocuments.id })
    .from(brainDocuments)
    .where(and(eq(brainDocuments.workspaceId, workspaceId), eq(brainDocuments.docType, docType)))
    .get()!;

  return db
    .select()
    .from(brainDocumentVersions)
    .where(eq(brainDocumentVersions.documentId, doc.id))
    .orderBy(desc(brainDocumentVersions.version))
    .all();
}

export function exportBrainMarkdown(db: Db, workspaceId: string, workspaceName: string): string {
  const { docs } = getBrain(db, workspaceId);
  const contents = Object.fromEntries(docs.map((d) => [d.docType, d.content])) as BrainContents;
  return renderBrainMarkdown(workspaceName, contents);
}
