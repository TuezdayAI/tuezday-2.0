import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import { getNextActionView } from "../services/next-action";
import { getWorkspace } from "../services/workspaces";

/**
 * The next-action endpoint (spec §5.1): one server-computed answer that the
 * guide dot, smart landing, and Home checklist all consume.
 */
export function registerNextActionRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/next-action", async (request, reply) => {
    if (!getWorkspace(db, request.params.id)) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return getNextActionView(db, request.params.id);
  });
}
