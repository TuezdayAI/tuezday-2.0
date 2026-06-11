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
    return documentId;
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

  async search(query: string, documentIds: string[], limit: number): Promise<StoreSearchResult[]> {
    if (documentIds.length === 0) return [];
    const res = await this.fetcher(`${this.baseUrl}/v3/retrieval/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_settings: {
          limit,
          filters: { document_id: { $in: documentIds } },
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
