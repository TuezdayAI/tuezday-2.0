import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db";
import { listWorkspacePriorities } from "../services/priorities";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) void reply.status(404).send({ error: "workspace_not_found" });
  return workspace;
}

const prioritiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerPriorityRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/workspaces/:id/priorities",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = prioritiesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
      return listWorkspacePriorities(db, request.params.id, parsed.data.limit);
    },
  );
}
