import { createAuthorizationBatchInputSchema } from "@tuezday/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import type { ExternalActionRuntime } from "../services/external-action-coordinator";
import {
  AuthorizationBatchNotFoundError,
  createAuthorizationBatchPreview,
  getAuthorizationBatchDetail,
  runAuthorizationBatch,
} from "../services/external-action-batches";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

export function registerExternalActionBatchRoutes(
  app: FastifyInstance,
  db: Db,
  runtime: ExternalActionRuntime,
): void {
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/external-action-batches",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createAuthorizationBatchInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
      const detail = createAuthorizationBatchPreview(
        db,
        request.params.id,
        parsed.data,
        actorOf(request),
      );
      return reply.status(201).send(detail);
    },
  );

  app.get<{ Params: { id: string; batchId: string } }>(
    "/workspaces/:id/external-action-batches/:batchId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return (
        getAuthorizationBatchDetail(db, request.params.id, request.params.batchId) ??
        reply.status(404).send({ error: "not_found" })
      );
    },
  );

  app.post<{ Params: { id: string; batchId: string } }>(
    "/workspaces/:id/external-action-batches/:batchId/authorize",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        return await runAuthorizationBatch(
          db,
          runtime,
          request.params.id,
          request.params.batchId,
          actorOf(request),
        );
      } catch (error) {
        if (error instanceof AuthorizationBatchNotFoundError) {
          return reply.status(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );
}
