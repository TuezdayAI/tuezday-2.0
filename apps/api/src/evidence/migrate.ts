// One-time R2R → native-store migration (Sprint 47). Runs while R2R is still
// up; after it, evidence_collections and evidence_documents point at native
// ids and the R2R stack can be deleted. Idempotent: documents whose store id
// already has chunks are skipped, so a crashed run just resumes.

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import {
  evidenceCandidates,
  evidenceCollections,
  evidenceChunks,
  evidenceDocuments,
} from "../db/schema";
import type { DbEvidenceStore } from "./db-store";

export interface MigrationSummary {
  migrated: number;
  skipped: number;
  failed: number;
  failures: { title: string; error: string }[];
}

interface R2RChunksResponse {
  results?: { text?: string; metadata?: { chunk_order?: number } }[];
}

/** Fetch a document's chunk texts from R2R and join them back into content.
 * The only R2R endpoint the migration needs — inlined so r2r.ts can die. */
async function fetchR2rContent(
  fetcher: typeof fetch,
  baseUrl: string,
  r2rDocumentId: string,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetcher(`${baseUrl.replace(/\/$/, "")}/v3/documents/${r2rDocumentId}/chunks`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as R2RChunksResponse;
  const chunks = (body.results ?? [])
    .filter((c) => c.text?.trim())
    .sort((a, b) => (a.metadata?.chunk_order ?? 0) - (b.metadata?.chunk_order ?? 0));
  if (chunks.length === 0) return null;
  return chunks.map((c) => c.text!.trim()).join("\n\n");
}

export async function migrateEvidence(
  db: Db,
  store: DbEvidenceStore,
  fetcher: typeof fetch,
  r2rBaseUrl: string,
): Promise<MigrationSummary> {
  const summary: MigrationSummary = { migrated: 0, skipped: 0, failed: 0, failures: [] };
  const nativeCollections = new Map<string, string>();

  /** Swap a workspace's collection mapping to a native id (once). */
  const nativeCollectionFor = async (workspaceId: string): Promise<string> => {
    const cached = nativeCollections.get(workspaceId);
    if (cached) return cached;
    const existing = db
      .select()
      .from(evidenceCollections)
      .where(eq(evidenceCollections.workspaceId, workspaceId))
      .get();
    // A native collection id is one our own chunks already use.
    if (existing) {
      const inUse = db
        .select()
        .from(evidenceChunks)
        .where(eq(evidenceChunks.collectionId, existing.r2rCollectionId))
        .get();
      if (inUse) {
        nativeCollections.set(workspaceId, existing.r2rCollectionId);
        return existing.r2rCollectionId;
      }
    }
    const nativeId = await store.createCollection(workspaceId);
    if (existing) {
      db.update(evidenceCollections)
        .set({ r2rCollectionId: nativeId })
        .where(eq(evidenceCollections.workspaceId, workspaceId))
        .run();
    } else {
      db.insert(evidenceCollections)
        .values({ workspaceId, r2rCollectionId: nativeId, createdAt: Date.now() })
        .run();
    }
    nativeCollections.set(workspaceId, nativeId);
    return nativeId;
  };

  const docs = db.select().from(evidenceDocuments).all();
  for (const doc of docs) {
    if (doc.status !== "ready" || !doc.r2rDocumentId) continue;

    const alreadyMigrated = db
      .select()
      .from(evidenceChunks)
      .where(eq(evidenceChunks.documentId, doc.r2rDocumentId))
      .get();
    if (alreadyMigrated) {
      summary.skipped++;
      continue;
    }

    const candidate = db
      .select()
      .from(evidenceCandidates)
      .where(eq(evidenceCandidates.evidenceDocumentId, doc.id))
      .get();
    const content =
      candidate?.content ?? (await fetchR2rContent(fetcher, r2rBaseUrl, doc.r2rDocumentId));

    if (!content) {
      summary.failed++;
      summary.failures.push({
        title: doc.title,
        error: "content unavailable (candidate missing and R2R had no chunks)",
      });
      db.update(evidenceDocuments)
        .set({
          status: "failed",
          error:
            "Migration could not recover this document's content from R2R — re-add it from the Evidence page.",
        })
        .where(eq(evidenceDocuments.id, doc.id))
        .run();
      continue;
    }

    const collectionId = await nativeCollectionFor(doc.workspaceId);
    const nativeDocId = await store.addDocument({
      title: doc.title,
      content,
      collectionId,
      metadata: { workspace_id: doc.workspaceId, kind: doc.kind, migrated_from: doc.r2rDocumentId },
    });
    db.update(evidenceDocuments)
      .set({ r2rDocumentId: nativeDocId })
      .where(eq(evidenceDocuments.id, doc.id))
      .run();
    summary.migrated++;
  }

  return summary;
}

/** CLI entry: `npm run evidence:migrate [-- <db-file>]`. */
export async function runMigrationCli(): Promise<void> {
  const [{ createDb }, { DbEvidenceStore }, { GeminiGateway }] = await Promise.all([
    import("../db/index"),
    import("./db-store"),
    import("../llm/gemini"),
  ]);
  const file = process.argv[2] ?? new URL("../../tuezday.db", import.meta.url).pathname;
  const baseUrl = process.env.R2R_BASE_URL?.trim() || "http://localhost:7272";
  const db = createDb(file);
  const store = new DbEvidenceStore(db, new GeminiGateway());
  const summary = await migrateEvidence(db, store, fetch, baseUrl);
  console.log(
    `Migrated ${summary.migrated} · skipped ${summary.skipped} (already native) · failed ${summary.failed}`,
  );
  for (const f of summary.failures) console.log(`  FAILED  ${f.title}: ${f.error}`);
  if (summary.failed > 0) process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) void runMigrationCli();
