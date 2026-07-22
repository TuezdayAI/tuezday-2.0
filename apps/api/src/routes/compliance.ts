import type { FastifyInstance, FastifyReply } from "fastify";
import { updateComplianceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { getCompliance, updateCompliance } from "../services/compliance";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply): boolean {
  if (getWorkspace(db, id)) return true;
  void reply.status(404).send({ error: "workspace_not_found" });
  return false;
}

export function registerComplianceRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/compliance", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return getCompliance(db, request.params.id);
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/compliance", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = updateComplianceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    return updateCompliance(db, request.params.id, parsed.data);
  });
}
