import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db";
import { listExecutionResults } from "../services/executions";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerExecutionRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string }; Querystring: { campaign?: string; limit?: string } }>(
    "/workspaces/:id/executions",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const limit = Number(request.query.limit) || undefined;
      return listExecutionResults(db, request.params.id, {
        campaignId: request.query.campaign || undefined,
        limit,
      });
    },
  );
}
