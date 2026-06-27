// The Brain Gateway's evidence boundary. Tuezday owns this interface, the
// retrieval policy, and the citations UI; the implementation behind it
// (R2R today) owns parsing, chunking, embedding, and similarity search.

export interface EvidenceStoreHealth {
  healthy: boolean;
  detail?: string;
}

export interface AddDocumentInput {
  title: string;
  content: string;
  /** The R2R collection (one per workspace) the document is ingested into. */
  collectionId: string;
  metadata: Record<string, string>;
}

export interface StoreSearchResult {
  text: string;
  score: number;
  documentId: string;
}

export interface EvidenceStore {
  health(): Promise<EvidenceStoreHealth>;
  /**
   * Create a collection in the store and return its id. Tuezday owns the
   * workspace→collection mapping (and thus idempotency); the store only owns
   * the R2R side of the operation.
   */
  createCollection(name: string): Promise<string>;
  /** Ingest a document into a collection. Returns the store's document id. */
  addDocument(input: AddDocumentInput): Promise<string>;
  /** Attach an already-ingested document to a collection (used by backfill). */
  attachDocument(collectionId: string, documentId: string): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;
  /** Search restricted to a single collection (workspace scoping). */
  search(query: string, collectionId: string, limit: number): Promise<StoreSearchResult[]>;
}

export class EvidenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}
