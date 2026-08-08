// Native evidence store — replaces R2R behind the EvidenceStore seam.
// Lexical search via Postgres full-text (tsvector/GIN), vector search via
// pgvector (HNSW, cosine), fused with reciprocal-rank fusion. No external
// service: health is always green.
//
// Sprint 74 moved this off SQLite. The two legs were FTS5 and sqlite-vec
// virtual tables reached through the raw driver handle; they are now ordinary
// indexes on evidence_chunks (see schema.ts), so this file no longer reaches
// past drizzle and there is no extension to load at runtime.
//
// Score contract: search() returns a 0–1 similarity per chunk —
// rankEvidenceChunks (services/evidence.ts) floors at 0.2 and blends
// similarity/recency/source, so the scale here is load-bearing. Vector-backed
// results report raw cosine similarity clamped to [0, 1] (the same semantics
// R2R reported, so the downstream floor keeps meaning); lexical-only results
// are min–max scaled into [0.35, 0.9] (a lexical hit on a curated corpus is
// meaningful, but never a claimed-perfect match). KNN returns the k nearest no
// matter how far, so near-zero-similarity noise is dropped here rather than
// handed downstream.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { GatewayError, type LlmGateway } from "../llm/gateway";
import { chunkText } from "./chunk";
import type { Db } from "../db";
import { evidenceChunks, EVIDENCE_EMBEDDING_DIMENSIONS } from "../db/schema";
import {
  type AddDocumentInput,
  type EvidenceStore,
  type EvidenceStoreHealth,
  type StoreSearchResult,
} from "./store";

export { EVIDENCE_EMBEDDING_DIMENSIONS };

const CANDIDATES_PER_LEG = 24;
const RRF_K = 60;
const FTS_ONLY_SCORE_MIN = 0.35;
const FTS_ONLY_SCORE_MAX = 0.9;
/** Vector hits below this similarity are KNN noise, not evidence. */
const MIN_VECTOR_SCORE = 0.05;
/** Postgres text-search configuration; must match the index expression. */
const TS_CONFIG = "english";

interface ChunkHit {
  id: string;
  text: string;
  documentId: string;
  /** 0-based rank within its retrieval leg. */
  rank: number;
  /** Cosine similarity in [-1, 1]; undefined for lexical-only hits. */
  cosine?: number;
  /**
   * Lexical relevance, carried in SQLite's bm25() sign convention (more
   * negative = better) so the fusion maths below is unchanged from Sprint 47.
   * Postgres ts_rank_cd is higher-is-better, so it is negated on the way in.
   */
  bm25?: number;
}

/** pgvector's text input format. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Reduce a prose query to bare terms OR-joined — user queries are sentences,
 * not tsquery syntax, and raw punctuation/AND/parens throw syntax errors.
 * (`websearch_to_tsquery` would AND the terms, which is far too strict for
 * recall here; the previous FTS5 behaviour was an OR.)
 */
function tsQueryFrom(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return null;
  return [...new Set(terms)].join(" | ");
}

export class DbEvidenceStore implements EvidenceStore {
  constructor(
    private readonly db: Db,
    private readonly gateway?: LlmGateway,
  ) {}

  /**
   * Re-embed any chunks missing vectors (backfill after key-less ingests).
   * The indexes maintain themselves, so unlike the SQLite implementation there
   * is nothing to drop and rebuild.
   */
  async reindex(): Promise<void> {
    const missing = await this.db
      .select({ id: evidenceChunks.id, text: evidenceChunks.text })
      .from(evidenceChunks)
      .where(sql`${evidenceChunks.embedding} IS NULL`);
    if (missing.length === 0 || !this.gateway?.embed) return;

    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      try {
        const { embeddings } = await this.gateway.embed({ texts: batch.map((r) => r.text) });
        for (const [j, row] of batch.entries()) {
          await this.db
            .update(evidenceChunks)
            .set({ embedding: embeddings[j]! })
            .where(eq(evidenceChunks.id, row.id));
        }
      } catch {
        break; // embeddings stay null; a later reindex picks them up
      }
    }
  }

  async health(): Promise<EvidenceStoreHealth> {
    return { healthy: true };
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

    let vectors: (number[] | null)[] = chunks.map(() => null);
    if (this.gateway?.embed) {
      try {
        const { embeddings } = await this.gateway.embed({ texts: indexTexts });
        vectors = embeddings;
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        // Ingestion never fails because embeddings are down; reindex() backfills.
      }
    }

    const now = Date.now();
    await this.db.insert(evidenceChunks).values(
      chunks.map((_text, seq) => ({
        id: randomUUID(),
        collectionId: input.collectionId,
        documentId,
        seq,
        text: indexTexts[seq]!,
        embedding: vectors[seq],
        createdAt: now,
      })),
    );

    return documentId;
  }

  async attachDocument(_collectionId: string, _documentId: string): Promise<void> {
    // Documents are born in their collection; kept for seam compatibility
    // (backfill calls this for legacy flows).
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.db.delete(evidenceChunks).where(eq(evidenceChunks.documentId, documentId));
  }

  async search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]> {
    const ftsHits = await this.searchFts(query, collectionId);
    const vecHits = await this.searchVec(query, collectionId);

    // RRF orders; the reported score is a 0–1 similarity (see module header).
    const fused = new Map<string, ChunkHit & { rrf: number }>();
    for (const leg of [ftsHits, vecHits]) {
      for (const hit of leg) {
        const existing = fused.get(hit.id);
        const rrf = 1 / (RRF_K + hit.rank + 1);
        if (existing) {
          existing.rrf += rrf;
          existing.cosine = existing.cosine ?? hit.cosine;
          existing.bm25 = existing.bm25 ?? hit.bm25;
        } else {
          fused.set(hit.id, { ...hit, rrf });
        }
      }
    }

    const ordered = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
    if (ordered.length === 0) return [];

    // Lexical scale: min–max over this result set's lexical scores (carried in
    // bm25's negative-is-better convention).
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

  private async searchFts(query: string, collectionId: string): Promise<ChunkHit[]> {
    const match = tsQueryFrom(query);
    if (!match) return [];
    // to_tsvector(...) here must be character-identical to the expression the
    // GIN index in schema.ts is built on, or the index is not used.
    const result = await this.db.execute<{
      id: string;
      text: string;
      documentId: string;
      rank: number;
    }>(sql`
      SELECT c.id AS id,
             c.text AS text,
             c.document_id AS "documentId",
             ts_rank_cd(to_tsvector('english', c.text), to_tsquery(${TS_CONFIG}, ${match})) AS rank
      FROM evidence_chunks c
      WHERE to_tsvector('english', c.text) @@ to_tsquery(${TS_CONFIG}, ${match})
        AND c.collection_id = ${collectionId}
      ORDER BY rank DESC
      LIMIT ${CANDIDATES_PER_LEG}
    `);
    return result.rows.map((r, rank) => ({
      id: r.id,
      text: r.text,
      documentId: r.documentId,
      rank,
      // Negated into bm25's convention so the fusion maths is unchanged.
      bm25: -Number(r.rank),
    }));
  }

  private async searchVec(query: string, collectionId: string): Promise<ChunkHit[]> {
    if (!this.gateway?.embed) return [];
    let queryVector: number[];
    try {
      const { embeddings } = await this.gateway.embed({ texts: [query] });
      queryVector = embeddings[0]!;
    } catch (err) {
      if (err instanceof GatewayError) return []; // lexical-only this call
      throw err;
    }
    // A zero vector has no direction — cosine against it is meaningless.
    if (queryVector.every((v) => v === 0)) return [];

    const literal = toVectorLiteral(queryVector);
    const result = await this.db.execute<{
      id: string;
      text: string;
      documentId: string;
      distance: number;
    }>(sql`
      SELECT c.id AS id,
             c.text AS text,
             c.document_id AS "documentId",
             c.embedding <=> ${literal}::vector AS distance
      FROM evidence_chunks c
      WHERE c.collection_id = ${collectionId}
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${literal}::vector
      LIMIT ${CANDIDATES_PER_LEG}
    `);

    // pgvector cosine distance = 1 - cosine similarity.
    return result.rows.map((r, rank) => ({
      id: r.id,
      text: r.text,
      documentId: r.documentId,
      rank,
      cosine: 1 - Number(r.distance),
    }));
  }
}
