import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  Channel,
  CreateEvidenceInput,
  EvidenceCandidate,
  EvidenceCandidateKind,
  EvidenceCandidateStatus,
  EvidenceDocument,
  EvidenceKind,
  EvidenceStatus,
  TaskType,
} from "@tuezday/contracts";
import type { EvidenceChunk, ResolveEvidence } from "@tuezday/brain";
import type { Db } from "../db";
import {
  drafts,
  evidenceCandidates,
  evidenceCollections,
  evidenceDocuments,
  publications,
  signals,
  type EvidenceCandidateRow,
  type EvidenceDocumentRow,
} from "../db/schema";
import type { EvidenceStore } from "../evidence/store";
import { getBrain } from "./brain";

function rowToDocument(row: EvidenceDocumentRow): EvidenceDocument {
  return { ...row, status: row.status as EvidenceStatus, kind: row.kind as EvidenceKind };
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

export interface EvidenceProvenance {
  kind: EvidenceKind;
  sourceRef: string | null;
  sourceCreatedAt: number | null;
}

/**
 * Resolve the workspace's R2R collection id, creating it on first use.
 * Tuezday owns the workspace→collection mapping (evidence_collections); the
 * store only owns the R2R side. Reads hit the DB first, so this is cheap on
 * the hot path and only calls R2R once per workspace.
 */
export async function ensureWorkspaceCollection(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
): Promise<string> {
  const existing = db
    .select()
    .from(evidenceCollections)
    .where(eq(evidenceCollections.workspaceId, workspaceId))
    .get();
  if (existing) return existing.r2rCollectionId;

  const r2rCollectionId = await store.createCollection(workspaceId);
  db.insert(evidenceCollections)
    .values({ workspaceId, r2rCollectionId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  // Re-read in case a concurrent request won the insert race.
  const row = db
    .select()
    .from(evidenceCollections)
    .where(eq(evidenceCollections.workspaceId, workspaceId))
    .get();
  return row?.r2rCollectionId ?? r2rCollectionId;
}

export async function addEvidence(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
  input: CreateEvidenceInput,
  provenance?: EvidenceProvenance,
): Promise<EvidenceDocument> {
  const row: EvidenceDocumentRow = {
    id: randomUUID(),
    workspaceId,
    r2rDocumentId: null,
    title: input.title,
    chars: input.content.length,
    status: "processing",
    error: null,
    kind: provenance?.kind ?? "manual",
    sourceRef: provenance?.sourceRef ?? null,
    sourceCreatedAt: provenance?.sourceCreatedAt ?? null,
    createdAt: Date.now(),
  };
  db.insert(evidenceDocuments).values(row).run();

  try {
    const collectionId = await ensureWorkspaceCollection(db, store, workspaceId);
    const r2rDocumentId = await store.addDocument({
      title: input.title,
      content: input.content,
      collectionId,
      metadata: { workspace_id: workspaceId, kind: row.kind },
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
      // retrieval only surfaces chunks from documents we still track.
    }
  }
  db.delete(evidenceDocuments).where(eq(evidenceDocuments.id, document.id)).run();
}

// ---------------------------------------------------------------------------
// Retrieval policy (Tuezday-owned)
// ---------------------------------------------------------------------------

const QUERY_EXCERPT_CHARS = 300;

/**
 * Tuezday-owned retrieval policy (Sprint 30): over-fetch from the store, then
 * re-rank by similarity + recency + source weight and dedupe. Kept here with
 * the other retrieval constants; a later slice can make these per-workspace
 * editable (cf. Sprint 21 channel guidance).
 */
export const RETRIEVAL = {
  overFetch: 15,
  keepMax: 8,
  perDocCap: 2,
  scoreFloor: 0.35,
  halfLifeDays: 90,
  weights: { similarity: 0.6, recency: 0.25, source: 0.15 },
  sourceWeight: { manual: 1, published: 0.8, signal: 0.6 } as Record<EvidenceKind, number>,
  jaccardDupThreshold: 0.9,
} as const;

export interface ScoredCandidate {
  text: string;
  title: string;
  documentId: string;
  kind: EvidenceKind;
  /** R2R similarity (0–1). */
  score: number;
  /** Original source time (ms epoch) used for recency weighting. */
  sourceCreatedAt: number;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Re-rank scored candidates by blended similarity + recency + source weight,
 * then dedupe (per-document cap + near-duplicate text) and keep the top N,
 * best first. Pure and deterministic given `now` — unit-tested directly.
 */
export function rankEvidenceChunks(candidates: ScoredCandidate[], now: number): EvidenceChunk[] {
  const scored = candidates
    .filter((c) => c.score >= RETRIEVAL.scoreFloor)
    .map((c) => {
      const ageDays = Math.max(0, (now - c.sourceCreatedAt) / 86_400_000);
      const recencyScore = Math.pow(0.5, ageDays / RETRIEVAL.halfLifeDays);
      const sourceWeight = RETRIEVAL.sourceWeight[c.kind];
      const finalScore =
        RETRIEVAL.weights.similarity * c.score +
        RETRIEVAL.weights.recency * recencyScore +
        RETRIEVAL.weights.source * sourceWeight;
      return {
        text: c.text,
        title: c.title,
        documentId: c.documentId,
        kind: c.kind,
        score: c.score,
        recencyScore,
        sourceWeight,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const kept: EvidenceChunk[] = [];
  const perDoc = new Map<string, number>();
  for (const chunk of scored) {
    if (kept.length >= RETRIEVAL.keepMax) break;
    if ((perDoc.get(chunk.documentId) ?? 0) >= RETRIEVAL.perDocCap) continue;
    const isDuplicate = kept.some(
      (k) => jaccard(tokenSet(k.text), tokenSet(chunk.text)) >= RETRIEVAL.jaccardDupThreshold,
    );
    if (isDuplicate) continue;
    kept.push(chunk);
    perDoc.set(chunk.documentId, (perDoc.get(chunk.documentId) ?? 0) + 1);
  }
  return kept;
}

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
  const docByR2rId = new Map(ready.map((d) => [d.r2rDocumentId!, d]));

  try {
    const collectionId = await ensureWorkspaceCollection(db, store, workspaceId);
    const results = await store.search(query, collectionId, RETRIEVAL.overFetch);
    // Only surface chunks from documents we still track as ready: keeps
    // workspace scoping honest and hides orphans from a failed delete.
    const candidates: ScoredCandidate[] = results.flatMap((r) => {
      const doc = docByR2rId.get(r.documentId);
      if (!doc) return [];
      return [
        {
          text: r.text,
          title: doc.title,
          documentId: r.documentId,
          kind: doc.kind,
          score: r.score,
          sourceCreatedAt: doc.sourceCreatedAt ?? doc.createdAt,
        },
      ];
    });
    const chunks = rankEvidenceChunks(candidates, Date.now());
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

// ---------------------------------------------------------------------------
// Ingest candidate queue (Sprint 30)
// ---------------------------------------------------------------------------

function rowToCandidate(row: EvidenceCandidateRow): EvidenceCandidate {
  return {
    ...row,
    kind: row.kind as EvidenceCandidateKind,
    status: row.status as EvidenceCandidateStatus,
  };
}

export function listCandidates(
  db: Db,
  workspaceId: string,
  status: EvidenceCandidateStatus = "pending",
): EvidenceCandidate[] {
  return db
    .select()
    .from(evidenceCandidates)
    .where(
      and(eq(evidenceCandidates.workspaceId, workspaceId), eq(evidenceCandidates.status, status)),
    )
    .orderBy(desc(evidenceCandidates.createdAt))
    .all()
    .map(rowToCandidate);
}

export function getCandidate(
  db: Db,
  workspaceId: string,
  candidateId: string,
): EvidenceCandidate | undefined {
  const row = db
    .select()
    .from(evidenceCandidates)
    .where(
      and(eq(evidenceCandidates.workspaceId, workspaceId), eq(evidenceCandidates.id, candidateId)),
    )
    .get();
  return row ? rowToCandidate(row) : undefined;
}

export interface SweepResult {
  signal: { proposed: number };
  published: { proposed: number };
}

/**
 * Propose every signal and every successfully published post as an ingest
 * candidate, skipping any source already proposed (in any status, so a
 * decided source is never resurrected). Pure DB work — ingestion into the
 * corpus only happens when the founder accepts a candidate.
 */
export function sweepEvidenceCandidates(db: Db, workspaceId: string): SweepResult {
  const seen = new Set(
    db
      .select({ kind: evidenceCandidates.kind, sourceRef: evidenceCandidates.sourceRef })
      .from(evidenceCandidates)
      .where(eq(evidenceCandidates.workspaceId, workspaceId))
      .all()
      .map((r) => `${r.kind}:${r.sourceRef}`),
  );
  const now = Date.now();
  let signalProposed = 0;
  let publishedProposed = 0;

  for (const s of db.select().from(signals).where(eq(signals.workspaceId, workspaceId)).all()) {
    if (seen.has(`signal:${s.id}`)) continue;
    const date = new Date(s.createdAt).toISOString().slice(0, 10);
    db.insert(evidenceCandidates)
      .values({
        id: randomUUID(),
        workspaceId,
        kind: "signal",
        sourceRef: s.id,
        title: `Signal — ${s.source} — ${date}`,
        content: s.content,
        sourceCreatedAt: s.createdAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    signalProposed++;
  }

  const publishedRows = db
    .select({
      id: publications.id,
      title: publications.title,
      publishedAt: publications.publishedAt,
      scheduledFor: publications.scheduledFor,
      content: drafts.content,
    })
    .from(publications)
    .innerJoin(drafts, eq(publications.draftId, drafts.id))
    .where(and(eq(publications.workspaceId, workspaceId), eq(publications.status, "published")))
    .all();
  for (const p of publishedRows) {
    if (seen.has(`published:${p.id}`)) continue;
    db.insert(evidenceCandidates)
      .values({
        id: randomUUID(),
        workspaceId,
        kind: "published",
        sourceRef: p.id,
        title: p.title,
        content: p.content,
        sourceCreatedAt: p.publishedAt ?? p.scheduledFor,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    publishedProposed++;
  }

  return { signal: { proposed: signalProposed }, published: { proposed: publishedProposed } };
}

/**
 * Accept a candidate into the corpus: ingest its text with provenance, then —
 * only if ingestion succeeded — mark the candidate accepted and link the
 * created document. A failed ingestion leaves the candidate pending to retry.
 */
export async function acceptCandidate(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
  candidate: EvidenceCandidate,
): Promise<EvidenceDocument> {
  const document = await addEvidence(
    db,
    store,
    workspaceId,
    { title: candidate.title.slice(0, 200), content: candidate.content },
    {
      kind: candidate.kind,
      sourceRef: candidate.sourceRef,
      sourceCreatedAt: candidate.sourceCreatedAt,
    },
  );
  if (document.status === "ready") {
    db.update(evidenceCandidates)
      .set({ status: "accepted", evidenceDocumentId: document.id, decidedAt: Date.now() })
      .where(eq(evidenceCandidates.id, candidate.id))
      .run();
  }
  return document;
}

export function dismissCandidate(db: Db, candidate: EvidenceCandidate): void {
  db.update(evidenceCandidates)
    .set({ status: "dismissed", decidedAt: Date.now() })
    .where(eq(evidenceCandidates.id, candidate.id))
    .run();
}

/**
 * Ensure every workspace with ingested evidence has its R2R collection and
 * that all ready documents are attached to it. Idempotent and best-effort: a
 * failure for one workspace (e.g. R2R down) is logged and skipped so boot is
 * never blocked. Runs on API startup; safe to re-run.
 */
export async function backfillCollections(db: Db, store: EvidenceStore): Promise<void> {
  const ready = db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.status, "ready"))
    .all()
    .filter((d) => d.r2rDocumentId);

  const byWorkspace = new Map<string, EvidenceDocumentRow[]>();
  for (const d of ready) {
    const list = byWorkspace.get(d.workspaceId) ?? [];
    list.push(d);
    byWorkspace.set(d.workspaceId, list);
  }

  for (const [workspaceId, docs] of byWorkspace) {
    try {
      const collectionId = await ensureWorkspaceCollection(db, store, workspaceId);
      for (const d of docs) {
        await store.attachDocument(collectionId, d.r2rDocumentId!);
      }
    } catch (err) {
      console.error(
        `[evidence] collection backfill failed for workspace ${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
