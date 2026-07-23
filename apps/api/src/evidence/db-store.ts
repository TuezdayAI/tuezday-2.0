// Native evidence store (Sprint 47) — replaces R2R behind the EvidenceStore
// seam. Lexical search via SQLite FTS5, vector search via sqlite-vec, fused
// with reciprocal-rank fusion. No external service: health is always green.
//
// Score contract: search() returns a 0–1 similarity per chunk —
// rankEvidenceChunks (services/evidence.ts) floors at 0.2 and blends
// similarity/recency/source, so the scale here is load-bearing. Vector-backed
// results report raw cosine similarity clamped to [0, 1] (the same semantics
// R2R reported, so the downstream floor keeps meaning); FTS-only results are
// min–max scaled into [0.35, 0.9] (a lexical hit on a curated corpus is
// meaningful, but never a claimed-perfect match). KNN returns the k nearest
// no matter how far, so near-zero-similarity noise is dropped here rather
// than handed downstream.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { chunkText } from "./chunk";
import type { Db } from "../db";
import {
  type AddDocumentInput,
  type EvidenceStore,
  type EvidenceStoreHealth,
  type StoreSearchResult,
} from "./store";

export const EVIDENCE_EMBEDDING_DIMENSIONS = 768;

const CANDIDATES_PER_LEG = 24;
const RRF_K = 60;
const FTS_ONLY_SCORE_MIN = 0.35;
const FTS_ONLY_SCORE_MAX = 0.9;
/** Vector hits below this similarity are KNN noise, not evidence. */
const MIN_VECTOR_SCORE = 0.05;

interface ChunkHit {
  rowid: number;
  text: string;
  documentId: string;
  /** 0-based rank within its retrieval leg. */
  rank: number;
  /** Cosine similarity in [-1, 1]; undefined for FTS-only hits. */
  cosine?: number;
  /** Raw BM25 score (more negative = better in SQLite); undefined for vector hits. */
  bm25?: number;
}

function toBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/** Reduce a prose query to bare FTS5 terms OR-joined — user queries are
 * sentences, not FTS syntax, and raw quotes/AND/parens throw syntax errors. */
function ftsQueryFrom(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return null;
  return [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
}

export class DbEvidenceStore implements EvidenceStore {
  private readonly sqlite: Database.Database;
  private vecAvailable = false;

  constructor(
    db: Db,
    private readonly gateway?: LlmGateway,
  ) {
    // drizzle's better-sqlite3 driver exposes the raw handle at runtime; the
    // installed type surface doesn't declare it yet.
    this.sqlite = (db as unknown as { $client: Database.Database }).$client;
    this.ensureIndexes();
  }

  /** Create the runtime index artifacts (virtual tables drizzle can't model)
   * and load sqlite-vec. Idempotent; called from the constructor. */
  private ensureIndexes(): void {
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_chunks_fts USING fts5(
        text, content='evidence_chunks', content_rowid='rowid'
      );
    `);
    try {
      // Lazy load keeps a broken native extension from taking the whole API
      // down — the store degrades to FTS-only. createRequire because the app
      // is ESM and sqlite-vec ships CJS.
      const req = createRequire(import.meta.url);
      const sqliteVec = req("sqlite-vec") as { load(db: Database.Database): void };
      sqliteVec.load(this.sqlite);
      this.sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vec USING vec0(
          chunk_rowid integer primary key,
          collection_id text partition key,
          embedding float[${EVIDENCE_EMBEDDING_DIMENSIONS}] distance_metric=cosine
        );
      `);
      this.vecAvailable = true;
    } catch (err) {
      this.vecAvailable = false;
      console.warn(
        `[evidence] sqlite-vec unavailable (${err instanceof Error ? err.message : String(err)}); running FTS-only.`,
      );
    }
  }

  /** Drop and rebuild both index artifacts from evidence_chunks, embedding
   * any chunks that are missing vectors (backfill after key-less ingests). */
  async reindex(): Promise<void> {
    this.sqlite.exec(`DELETE FROM evidence_chunks_fts;`);
    if (this.vecAvailable) this.sqlite.exec(`DELETE FROM evidence_vec;`);
    const rows = this.sqlite
      .prepare(`SELECT rowid, id, collection_id, text, embedding FROM evidence_chunks ORDER BY rowid`)
      .all() as { rowid: number; id: string; collection_id: string; text: string; embedding: Buffer | null }[];

    const missing = rows.filter((r) => !r.embedding);
    if (missing.length > 0 && this.gateway?.embed) {
      for (let i = 0; i < missing.length; i += 100) {
        const batch = missing.slice(i, i + 100);
        try {
          const { embeddings } = await this.gateway.embed({ texts: batch.map((r) => r.text) });
          const update = this.sqlite.prepare(`UPDATE evidence_chunks SET embedding = ? WHERE id = ?`);
          batch.forEach((r, j) => {
            r.embedding = toBuffer(embeddings[j]!);
            update.run(r.embedding, r.id);
          });
        } catch {
          break; // embeddings stay null; FTS still rebuilds below
        }
      }
    }

    const insertFts = this.sqlite.prepare(
      `INSERT INTO evidence_chunks_fts (rowid, text) VALUES (?, ?)`,
    );
    const insertVec = this.vecAvailable
      ? this.sqlite.prepare(
          `INSERT INTO evidence_vec (chunk_rowid, collection_id, embedding) VALUES (?, ?, ?)`,
        )
      : null;
    for (const r of rows) {
      insertFts.run(r.rowid, r.text);
      if (insertVec && r.embedding) insertVec.run(BigInt(r.rowid), r.collection_id, r.embedding);
    }
  }

  async health(): Promise<EvidenceStoreHealth> {
    return this.vecAvailable
      ? { healthy: true }
      : { healthy: true, detail: "vector index unavailable — running FTS-only" };
  }

  async createCollection(_name: string): Promise<string> {
    // The workspace → collection mapping lives in evidence_collections
    // (Tuezday-owned); the store only needs an opaque id to scope chunks by.
    return randomUUID();
  }

  async addDocument(input: AddDocumentInput): Promise<string> {
    const documentId = randomUUID();
    const chunks = chunkText(input.content);
    // Titles carry retrieval signal (R2R kept them in metadata); prepend to
    // the first chunk's indexed text.
    const indexTexts = chunks.map((c, i) => (i === 0 ? `${input.title}\n${c}` : c));

    let vectors: (Buffer | null)[] = chunks.map(() => null);
    if (this.gateway?.embed) {
      try {
        const { embeddings } = await this.gateway.embed({ texts: indexTexts });
        vectors = embeddings.map(toBuffer);
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        // Ingestion never fails because embeddings are down; reindex() backfills.
      }
    }

    const insertChunk = this.sqlite.prepare(`
      INSERT INTO evidence_chunks (id, collection_id, document_id, seq, text, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rowid
    `);
    const insertFts = this.sqlite.prepare(
      `INSERT INTO evidence_chunks_fts (rowid, text) VALUES (?, ?)`,
    );
    const insertVec = this.vecAvailable
      ? this.sqlite.prepare(
          `INSERT INTO evidence_vec (chunk_rowid, collection_id, embedding) VALUES (?, ?, ?)`,
        )
      : null;

    this.sqlite.transaction(() => {
      chunks.forEach((text, seq) => {
        const { rowid } = insertChunk.get(
          randomUUID(),
          input.collectionId,
          documentId,
          seq,
          indexTexts[seq]!,
          vectors[seq],
          Date.now(),
        ) as { rowid: number };
        insertFts.run(rowid, indexTexts[seq]!);
        if (insertVec && vectors[seq]) insertVec.run(BigInt(rowid), input.collectionId, vectors[seq]);
      });
    })();

    return documentId;
  }

  async attachDocument(_collectionId: string, _documentId: string): Promise<void> {
    // Documents are born in their collection; kept for seam compatibility
    // (backfill calls this for legacy flows).
  }

  async deleteDocument(documentId: string): Promise<void> {
    const rows = this.sqlite
      .prepare(`SELECT rowid, text FROM evidence_chunks WHERE document_id = ?`)
      .all(documentId) as { rowid: number; text: string }[];

    const deleteFts = this.sqlite.prepare(
      `INSERT INTO evidence_chunks_fts (evidence_chunks_fts, rowid, text) VALUES ('delete', ?, ?)`,
    );
    const deleteVec = this.vecAvailable
      ? this.sqlite.prepare(`DELETE FROM evidence_vec WHERE chunk_rowid = ?`)
      : null;
    const deleteChunks = this.sqlite.prepare(`DELETE FROM evidence_chunks WHERE document_id = ?`);

    this.sqlite.transaction(() => {
      for (const r of rows) {
        deleteFts.run(r.rowid, r.text);
        deleteVec?.run(BigInt(r.rowid));
      }
      deleteChunks.run(documentId);
    })();
  }

  async search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]> {
    const ftsHits = this.searchFts(query, collectionId);
    const vecHits = await this.searchVec(query, collectionId);

    // RRF orders; the reported score is a 0–1 similarity (see module header).
    const fused = new Map<number, ChunkHit & { rrf: number }>();
    for (const leg of [ftsHits, vecHits]) {
      for (const hit of leg) {
        const existing = fused.get(hit.rowid);
        const rrf = 1 / (RRF_K + hit.rank + 1);
        if (existing) {
          existing.rrf += rrf;
          existing.cosine = existing.cosine ?? hit.cosine;
          existing.bm25 = existing.bm25 ?? hit.bm25;
        } else {
          fused.set(hit.rowid, { ...hit, rrf });
        }
      }
    }

    const ordered = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
    if (ordered.length === 0) return [];

    // Lexical scale: min–max over this result set's BM25 scores (SQLite bm25()
    // is negative; more negative = better).
    const bm25Scores = ordered.filter((h) => h.bm25 !== undefined).map((h) => -h.bm25!);
    const bmMin = Math.min(...bm25Scores);
    const bmMax = Math.max(...bm25Scores);

    // A chunk can carry two independent relevance signals; report the
    // stronger one. Cosine is the primary; the scaled lexical score keeps a
    // strong exact-vocabulary match from being undersold by a weak embedding.
    return ordered
      .map((h) => {
        let score = 0;
        if (h.cosine !== undefined) {
          score = Math.min(1, Math.max(0, h.cosine));
        }
        if (h.bm25 !== undefined) {
          const spread = bmMax - bmMin;
          const scaled = spread > 0 ? (-h.bm25 - bmMin) / spread : 1;
          score = Math.max(
            score,
            FTS_ONLY_SCORE_MIN + scaled * (FTS_ONLY_SCORE_MAX - FTS_ONLY_SCORE_MIN),
          );
        }
        return { text: h.text, score, documentId: h.documentId };
      })
      .filter((r) => r.score >= MIN_VECTOR_SCORE);
  }

  private searchFts(query: string, collectionId: string): ChunkHit[] {
    const match = ftsQueryFrom(query);
    if (!match) return [];
    const rows = this.sqlite
      .prepare(
        `SELECT c.rowid AS rowid, c.text AS text, c.document_id AS documentId,
                bm25(evidence_chunks_fts) AS bm25
         FROM evidence_chunks_fts f
         JOIN evidence_chunks c ON c.rowid = f.rowid
         WHERE evidence_chunks_fts MATCH ? AND c.collection_id = ?
         ORDER BY bm25(evidence_chunks_fts)
         LIMIT ?`,
      )
      .all(match, collectionId, CANDIDATES_PER_LEG) as {
      rowid: number;
      text: string;
      documentId: string;
      bm25: number;
    }[];
    return rows.map((r, rank) => ({ ...r, rank }));
  }

  private async searchVec(query: string, collectionId: string): Promise<ChunkHit[]> {
    if (!this.vecAvailable || !this.gateway?.embed) return [];
    let queryVector: number[];
    try {
      const { embeddings } = await this.gateway.embed({ texts: [query] });
      queryVector = embeddings[0]!;
    } catch (err) {
      if (err instanceof GatewayError) return []; // FTS-only this call
      throw err;
    }
    // A zero vector has no direction — cosine against it is meaningless.
    if (queryVector.every((v) => v === 0)) return [];

    const rows = this.sqlite
      .prepare(
        `SELECT v.chunk_rowid AS rowid, v.distance AS distance,
                c.text AS text, c.document_id AS documentId
         FROM evidence_vec v
         JOIN evidence_chunks c ON c.rowid = v.chunk_rowid
         WHERE v.embedding MATCH ? AND v.collection_id = ? AND v.k = ?`,
      )
      .all(toBuffer(queryVector), collectionId, CANDIDATES_PER_LEG) as {
      rowid: number;
      distance: number;
      text: string;
      documentId: string;
    }[];

    // vec0 cosine distance = 1 - cosine similarity.
    return rows.map((r, rank) => ({
      rowid: r.rowid,
      text: r.text,
      documentId: r.documentId,
      rank,
      cosine: 1 - r.distance,
    }));
  }
}
