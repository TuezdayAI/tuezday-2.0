import { z } from "zod";
import type { Db } from "../../db/index";
import type { EvidenceStore } from "../../evidence/store";
import { ensureWorkspaceCollection, listEvidence } from "../../services/evidence";
import type { AgentTool } from "../runner";

const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

const DEFAULT_LIMIT = 5;

/**
 * The Sprint 56 proof tool: workspace-scoped search over the native evidence
 * store. Same scoping discipline as retrieveEvidence — the workspace's own
 * collection, ready documents only, orphaned chunks hidden. The full read-tool
 * set (and the registry these plug into) is Sprint 57.
 */
export function searchEvidenceTool(
  db: Db,
  store: EvidenceStore,
  workspaceId: string,
): AgentTool {
  return {
    definition: {
      name: "search_evidence",
      description:
        "Search the workspace's evidence corpus (uploaded documents, saved research) for passages relevant to a query. Returns the best-matching excerpts with their source document titles.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in plain language." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max excerpts to return (default 5).",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args: unknown) => {
      const { query, limit } = inputSchema.parse(args);
      const ready = listEvidence(db, workspaceId).filter(
        (doc) => doc.status === "ready" && doc.r2rDocumentId,
      );
      if (ready.length === 0) {
        return { results: [], note: "This workspace has no evidence documents yet." };
      }
      const docByStoreId = new Map(ready.map((doc) => [doc.r2rDocumentId!, doc]));
      const collectionId = await ensureWorkspaceCollection(db, store, workspaceId);
      const hits = await store.search(query, collectionId, limit ?? DEFAULT_LIMIT);
      const results = hits.flatMap((hit) => {
        const doc = docByStoreId.get(hit.documentId);
        if (!doc) return [];
        return [{ title: doc.title, kind: doc.kind, text: hit.text, score: hit.score }];
      });
      return { results };
    },
  };
}
