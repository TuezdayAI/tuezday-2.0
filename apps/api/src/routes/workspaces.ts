import type { FastifyInstance } from "fastify";
import { createWorkspaceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { createWorkspace, getWorkspace, listWorkspaces } from "../services/workspaces";

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  app.post("/workspaces", async (request, reply) => {
    const parsed = createWorkspaceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const workspace = createWorkspace(db, parsed.data);
    return reply.status(201).send(workspace);
  });

  app.get("/workspaces", async () => listWorkspaces(db));

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return workspace;
  });
}
