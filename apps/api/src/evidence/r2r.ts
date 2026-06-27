import {
  EvidenceStoreError,
  type AddDocumentInput,
  type EvidenceStore,
  type EvidenceStoreHealth,
  type StoreSearchResult,
} from "./store";

type Fetcher = typeof fetch;

interface R2RChunkResult {
  text?: string;
  score?: number;
  document_id?: string;
  documentId?: string;
}

/**
 * R2R REST implementation of the evidence store (v3 API).
 * Self-hosted via infra/r2r/compose.yaml; base url from R2R_BASE_URL.
 */
export class R2REvidenceStore implements EvidenceStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl?: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    const fromEnv = process.env.R2R_BASE_URL?.trim();
    this.baseUrl = (baseUrl ?? (fromEnv || "http://localhost:7272")).replace(/\/$/, "");
  }

  async health(): Promise<EvidenceStoreHealth> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/v3/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { healthy: false, detail: `R2R health returned ${res.status}` };
      return { healthy: true };
    } catch {
      return {
        healthy: false,
        detail: `R2R is not reachable at ${this.baseUrl}. Start it with "npm run r2r:up".`,
      };
    }
  }

  async addDocument(input: AddDocumentInput): Promise<string> {
    const form = new FormData();
    form.append("raw_text", input.content);
    form.append("metadata", JSON.stringify({ title: input.title, ...input.metadata }));
    form.append("ingestion_mode", "fast");

    const res = await this.fetcher(`${this.baseUrl}/v3/documents`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: { document_id?: string; documentId?: string };
      message?: string;
      detail?: { message?: string } | string;
    };
    if (!res.ok) {
      const detail =
        typeof body.detail === "string" ? body.detail : (body.detail?.message ?? body.message);
      throw new EvidenceStoreError(`R2R ingestion failed (${res.status}): ${detail ?? "unknown"}`);
    }
    const documentId = body.results?.document_id ?? body.results?.documentId;
    if (!documentId) throw new EvidenceStoreError("R2R did not return a document id.");
    await this.attachDocument(input.collectionId, documentId);
    return documentId;
  }

  /**
   * Create an R2R collection and return its id. Idempotency (one collection
   * per workspace) is owned by Tuezday via the evidence_collections table, so
   * this performs a plain create.
   */
  async createCollection(name: string): Promise<string> {
    const res = await this.fetcher(`${this.baseUrl}/v3/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: `Tuezday evidence corpus (${name})` }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: { id?: string; collection_id?: string; collectionId?: string };
    };
    if (!res.ok) throw new EvidenceStoreError(`R2R collection create failed (${res.status}).`);
    const id = body.results?.id ?? body.results?.collection_id ?? body.results?.collectionId;
    if (!id) throw new EvidenceStoreError("R2R did not return a collection id.");
    return id;
  }

  /**
   * Attach a document to a collection. A duplicate attach (the document is
   * already a member) is treated as success so backfills and re-runs are
   * idempotent.
   */
  async attachDocument(collectionId: string, documentId: string): Promise<void> {
    const res = await this.fetcher(
      `${this.baseUrl}/v3/collections/${collectionId}/documents/${documentId}`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok && res.status !== 409) {
      throw new EvidenceStoreError(`R2R collection attach failed (${res.status}).`);
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    const res = await this.fetcher(`${this.baseUrl}/v3/documents/${documentId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 404) {
      throw new EvidenceStoreError(`R2R delete failed (${res.status}).`);
    }
  }

  async search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]> {
    const res = await this.fetcher(`${this.baseUrl}/v3/retrieval/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_settings: {
          limit,
          filters: { collection_ids: { $overlap: [collectionId] } },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      results?: {
        chunk_search_results?: R2RChunkResult[];
        chunkSearchResults?: R2RChunkResult[];
      };
    };
    if (!res.ok) throw new EvidenceStoreError(`R2R search failed (${res.status}).`);
    const chunks = body.results?.chunk_search_results ?? body.results?.chunkSearchResults ?? [];
    return chunks
      .map((c) => ({
        text: c.text ?? "",
        score: typeof c.score === "number" ? c.score : 0,
        documentId: c.document_id ?? c.documentId ?? "",
      }))
      .filter((c) => c.text && c.documentId);
  }
}
