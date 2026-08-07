import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db";
import { listExecutionResults } from "../services/executions";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerExecutionRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string }; Querystring: { campaign?: string; limit?: string } }>(
    "/workspaces/:id/executions",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const limit = Number(request.query.limit) || undefined;
      return await listExecutionResults(db, request.params.id, {
        campaignId: request.query.campaign || undefined,
        limit,
      });
    },
  );
}
