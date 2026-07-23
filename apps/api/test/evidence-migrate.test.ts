import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import {
  evidenceCandidates,
  evidenceCollections,
  evidenceChunks,
  evidenceDocuments,
} from "../src/db/schema";
import { DbEvidenceStore } from "../src/evidence/db-store";
import { migrateEvidence } from "../src/evidence/migrate";
import { createTestDb } from "./helpers";

const WS = "11111111-1111-4111-8111-111111111111";

function seedWorkspace(db: Db): void {
  (db as unknown as { $client: import("better-sqlite3").Database }).$client
    .prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'W', 1, 1)`)
    .run(WS);
  db.insert(evidenceCollections)
    .values({ workspaceId: WS, r2rCollectionId: "r2r-col-1", createdAt: 1 })
    .run();
}

function seedDoc(
  db: Db,
  over: Partial<typeof evidenceDocuments.$inferInsert> = {},
): string {
  const id = randomUUID();
  db.insert(evidenceDocuments)
    .values({
      id,
      workspaceId: WS,
      r2rDocumentId: over.r2rDocumentId ?? `r2r-${id.slice(0, 8)}`,
      title: over.title ?? "Doc",
      chars: 100,
      status: over.status ?? "ready",
      error: null,
      kind: over.kind ?? "manual",
      sourceRef: null,
      sourceCreatedAt: null,
      createdAt: 1,
      ...over,
    })
    .run();
  return id;
}

/** Fake R2R chunk endpoint: GET /v3/documents/:id/chunks */
function fakeR2rFetcher(chunksByDoc: Record<string, string[]>): typeof fetch {
  return vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    const match = /\/v3\/documents\/([^/]+)\/chunks/.exec(String(url));
    const chunks = match ? chunksByDoc[match[1]!] : undefined;
    if (!chunks) return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({ results: chunks.map((text, i) => ({ text, metadata: { chunk_order: i } })) }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe("migrateEvidence", () => {
  let db: Db;
  let store: DbEvidenceStore;

  beforeEach(() => {
    db = createTestDb();
    store = new DbEvidenceStore(db);
    seedWorkspace(db);
  });

  it("re-ingests candidate-backed documents from local content without touching R2R", async () => {
    const docId = seedDoc(db, { kind: "signal" });
    db.insert(evidenceCandidates)
      .values({
        id: randomUUID(),
        workspaceId: WS,
        kind: "signal",
        sourceRef: "sig-1",
        title: "Signal",
        content: "Local candidate content about churn.",
        sourceCreatedAt: 1,
        status: "accepted",
        evidenceDocumentId: docId,
        createdAt: 1,
      })
      .run();
    const fetcher = fakeR2rFetcher({});

    const summary = await migrateEvidence(db, store, fetcher, "http://r2r.local");

    expect(summary.migrated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    const doc = db.select().from(evidenceDocuments).all()[0]!;
    const chunks = db.select().from(evidenceChunks).all();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.documentId).toBe(doc.r2rDocumentId);
    // Collection remapped to a native id and chunks scoped to it.
    const col = db.select().from(evidenceCollections).all()[0]!;
    expect(col.r2rCollectionId).not.toBe("r2r-col-1");
    expect(chunks[0]!.collectionId).toBe(col.r2rCollectionId);
  });

  it("pulls manual documents' chunks from R2R and re-ingests them", async () => {
    seedDoc(db, { r2rDocumentId: "r2r-manual-1", title: "Manual" });
    const fetcher = fakeR2rFetcher({
      "r2r-manual-1": ["First chunk about pricing.", "Second chunk about plans."],
    });

    const summary = await migrateEvidence(db, store, fetcher, "http://r2r.local");

    expect(summary.migrated).toBe(1);
    const results = await store.search(
      "pricing plans",
      db.select().from(evidenceCollections).all()[0]!.r2rCollectionId,
      5,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.text).join(" ")).toContain("pricing");
  });

  it("marks documents failed when R2R has no content for them", async () => {
    seedDoc(db, { r2rDocumentId: "r2r-gone" });
    const summary = await migrateEvidence(db, store, fakeR2rFetcher({}), "http://r2r.local");

    expect(summary.migrated).toBe(0);
    expect(summary.failed).toBe(1);
    const doc = db.select().from(evidenceDocuments).all()[0]!;
    expect(doc.status).toBe("failed");
    expect(doc.error).toBeTruthy();
  });

  it("skips already-migrated documents on a second run", async () => {
    seedDoc(db, { r2rDocumentId: "r2r-manual-1" });
    const fetcher = fakeR2rFetcher({ "r2r-manual-1": ["Chunk one."] });

    await migrateEvidence(db, store, fetcher, "http://r2r.local");
    const second = await migrateEvidence(db, store, fetcher, "http://r2r.local");

    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(db.select().from(evidenceChunks).all()).toHaveLength(1);
  });

  it("ignores documents that never made it into the store", async () => {
    seedDoc(db, { status: "failed", r2rDocumentId: null });
    const summary = await migrateEvidence(db, store, fakeR2rFetcher({}), "http://r2r.local");
    expect(summary.migrated + summary.failed + summary.skipped).toBe(0);
  });
});
