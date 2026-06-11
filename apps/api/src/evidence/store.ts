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
  metadata: Record<string, string>;
}

export interface StoreSearchResult {
  text: string;
  score: number;
  documentId: string;
}

export interface EvidenceStore {
  health(): Promise<EvidenceStoreHealth>;
  /** Returns the store's document id. */
  addDocument(input: AddDocumentInput): Promise<string>;
  deleteDocument(documentId: string): Promise<void>;
  /** Search restricted to the given store document ids (workspace scoping). */
  search(query: string, documentIds: string[], limit: number): Promise<StoreSearchResult[]>;
}

export class EvidenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}
