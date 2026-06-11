import type { FastifyInstance, FastifyReply } from "fastify";
import { createEvidenceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { EvidenceStoreError, type EvidenceStore } from "../evidence/store";
import {
  addEvidence,
  deleteEvidence,
  getEvidenceDocument,
  listEvidence,
} from "../services/evidence";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerEvidenceRoutes(app: FastifyInstance, db: Db, store: EvidenceStore): void {
  app.post<{ Params: { id: string } }>("/workspaces/:id/evidence", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createEvidenceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const health = await store.health();
    if (!health.healthy) {
      return reply.status(503).send({
        error: "evidence_store_unavailable",
        message: health.detail ?? "The evidence store is not reachable.",
      });
    }
    try {
      const document = await addEvidence(db, store, request.params.id, parsed.data);
      return reply.status(document.status === "failed" ? 502 : 201).send(document);
    } catch (err) {
      if (err instanceof EvidenceStoreError) {
        return reply.status(502).send({ error: "ingestion_failed", message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/evidence", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const [documents, health] = await Promise.all([
      Promise.resolve(listEvidence(db, request.params.id)),
      store.health(),
    ]);
    return { documents, store: health };
  });

  app.delete<{ Params: { id: string; documentId: string } }>(
    "/workspaces/:id/evidence/:documentId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const document = getEvidenceDocument(db, request.params.id, request.params.documentId);
      if (!document) return reply.status(404).send({ error: "evidence_not_found" });
      await deleteEvidence(db, store, document);
      return reply.status(204).send();
    },
  );
}
