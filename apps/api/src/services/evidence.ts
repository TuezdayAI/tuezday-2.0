import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  Channel,
  CreateEvidenceInput,
  EvidenceDocument,
  EvidenceStatus,
  TaskType,
} from "@tuezday/contracts";
import type { EvidenceChunk, ResolveEvidence } from "@tuezday/brain";
import type { Db } from "../db";
import { evidenceDocuments, type EvidenceDocumentRow } from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { getBrain } from "./brain";

function rowToDocument(row: EvidenceDocumentRow): EvidenceDocument {
  return { ...row, status: row.status as EvidenceStatus };
}

export function listEvidence(db: Db, workspaceId: string): EvidenceDocument[] {
  return db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.workspaceId, workspaceId))
    .orderBy(desc(evidenceDocuments.createdAt))
    .all()
    .map(rowToDocument);
}

export function getEvidenceDocument(
  db: Db,
  workspaceId: string,
  documentId: string,
): EvidenceDocument | undefined {
  const row = db
    .select()
    .from(evidenceDocuments)
    .where(and(eq(evidenceDocuments.workspaceId, workspaceId), eq(evidenceDocuments.id, documentId)))
    .get();
  return row ? rowToDocument(row) : undefined;
}

export async function addEvidence(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
  input: CreateEvidenceInput,
): Promise<EvidenceDocument> {
  const row: EvidenceDocumentRow = {
    id: randomUUID(),
    workspaceId,
    r2rDocumentId: null,
    title: input.title,
    chars: input.content.length,
    status: "processing",
    error: null,
    createdAt: Date.now(),
  };
  db.insert(evidenceDocuments).values(row).run();

  try {
    const r2rDocumentId = await store.addDocument({
      title: input.title,
      content: input.content,
      metadata: { workspace_id: workspaceId },
    });
    db.update(evidenceDocuments)
      .set({ r2rDocumentId, status: "ready" })
      .where(eq(evidenceDocuments.id, row.id))
      .run();
    return { ...rowToDocument(row), r2rDocumentId, status: "ready" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(evidenceDocuments)
      .set({ status: "failed", error: message.slice(0, 500) })
      .where(eq(evidenceDocuments.id, row.id))
      .run();
    return { ...rowToDocument(row), status: "failed", error: message.slice(0, 500) };
  }
}

export async function deleteEvidence(
  db: Db,
  store: EvidenceStore,
  document: EvidenceDocument,
): Promise<void> {
  if (document.r2rDocumentId) {
    try {
      await store.deleteDocument(document.r2rDocumentId);
    } catch {
      // The store row is the source of truth for the UI; an unreachable
      // store must not block cleanup. Orphans in R2R are harmless because
      // searches filter by our known document ids.
    }
  }
  db.delete(evidenceDocuments).where(eq(evidenceDocuments.id, document.id)).run();
}

// ---------------------------------------------------------------------------
// Retrieval policy (Tuezday-owned)
// ---------------------------------------------------------------------------

const RETRIEVAL_LIMIT = 5;
const SCORE_FLOOR = 0.35;
const QUERY_EXCERPT_CHARS = 300;

export interface RetrievalContext {
  taskType: TaskType;
  channel: Channel;
  signalContent?: string;
  campaignObjective?: string;
}

/**
 * Compose the retrieval query from the most specific context available:
 * the signal being responded to beats the campaign objective beats the
 * workspace's `now`/soul docs. Deterministic and shown in the trace.
 */
export function composeRetrievalQuery(
  db: Db,
  workspaceId: string,
  context: RetrievalContext,
): string {
  const parts: string[] = [];
  if (context.signalContent?.trim()) {
    parts.push(context.signalContent.trim().slice(0, QUERY_EXCERPT_CHARS));
  } else if (context.campaignObjective?.trim()) {
    parts.push(context.campaignObjective.trim().slice(0, QUERY_EXCERPT_CHARS));
  } else {
    const { docs } = getBrain(db, workspaceId);
    const now = docs.find((d) => d.docType === "now")?.content.trim();
    const soul = docs.find((d) => d.docType === "soul")?.content.trim();
    if (now) parts.push(now.slice(0, QUERY_EXCERPT_CHARS));
    else if (soul) parts.push(soul.slice(0, QUERY_EXCERPT_CHARS));
  }
  parts.push(`${context.taskType.replace(/_/g, " ")} for ${context.channel}`);
  return parts.join(" — ");
}

export interface EvidenceResolution {
  evidence?: ResolveEvidence;
  exclusionReason?: string;
}

/**
 * Run the retrieval policy for a task. Never throws: evidence assists
 * resolution, it must not break it.
 */
export async function retrieveEvidence(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
  context: RetrievalContext,
  useEvidence: boolean,
): Promise<EvidenceResolution> {
  if (!useEvidence) {
    return { exclusionReason: "evidence was turned off for this task." };
  }

  const ready = listEvidence(db, workspaceId).filter(
    (d) => d.status === "ready" && d.r2rDocumentId,
  );
  if (ready.length === 0) {
    return { exclusionReason: "no evidence documents uploaded yet." };
  }

  const health = await store.health();
  if (!health.healthy) {
    return { exclusionReason: health.detail ?? "evidence store is not reachable." };
  }

  const query = composeRetrievalQuery(db, workspaceId, context);
  const titleByR2rId = new Map(ready.map((d) => [d.r2rDocumentId!, d.title]));

  try {
    const results = await store.search(
      query,
      ready.map((d) => d.r2rDocumentId!),
      RETRIEVAL_LIMIT,
    );
    const chunks: EvidenceChunk[] = results
      .filter((r) => r.score >= SCORE_FLOOR)
      .map((r) => ({
        text: r.text,
        score: r.score,
        documentId: r.documentId,
        title: titleByR2rId.get(r.documentId) ?? "Evidence",
      }));
    if (chunks.length === 0) {
      return { exclusionReason: `no evidence matched the query "${query}".` };
    }
    return { evidence: { query, chunks } };
  } catch (err) {
    return {
      exclusionReason: `evidence retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
