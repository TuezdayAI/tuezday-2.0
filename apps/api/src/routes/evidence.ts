import type { FastifyInstance, FastifyReply } from "fastify";
import { createEvidenceInputSchema, type EvidenceCandidateStatus } from "@tuezday/contracts";
import type { Db } from "../db";
import { EvidenceStoreError, type EvidenceStore } from "../evidence/store";
import {
  acceptCandidate,
  addEvidence,
  deleteEvidence,
  dismissCandidate,
  getCandidate,
  getEvidenceDocument,
  listCandidates,
  listEvidence,
  sweepEvidenceCandidates,
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

  // --- Ingest candidate queue (Sprint 30) ---------------------------------

  app.get<{ Params: { id: string }; Querystring: { status?: EvidenceCandidateStatus } }>(
    "/workspaces/:id/evidence/candidates",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return {
        candidates: listCandidates(db, request.params.id, request.query.status ?? "pending"),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/evidence/candidates/sweep",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return sweepEvidenceCandidates(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string; candidateId: string } }>(
    "/workspaces/:id/evidence/candidates/:candidateId/accept",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const candidate = getCandidate(db, request.params.id, request.params.candidateId);
      if (!candidate) return reply.status(404).send({ error: "candidate_not_found" });
      if (candidate.status !== "pending") {
        return reply.status(409).send({ error: "already_decided" });
      }
      const health = await store.health();
      if (!health.healthy) {
        return reply.status(503).send({
          error: "evidence_store_unavailable",
          message: health.detail ?? "The evidence store is not reachable.",
        });
      }
      try {
        const document = await acceptCandidate(db, store, request.params.id, candidate);
        return reply.status(document.status === "failed" ? 502 : 201).send(document);
      } catch (err) {
        if (err instanceof EvidenceStoreError) {
          return reply.status(502).send({ error: "ingestion_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; candidateId: string } }>(
    "/workspaces/:id/evidence/candidates/:candidateId/dismiss",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const candidate = getCandidate(db, request.params.id, request.params.candidateId);
      if (!candidate) return reply.status(404).send({ error: "candidate_not_found" });
      if (candidate.status !== "pending") {
        return reply.status(409).send({ error: "already_decided" });
      }
      dismissCandidate(db, candidate);
      return reply.status(204).send();
    },
  );
}
