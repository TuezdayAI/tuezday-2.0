import type { FastifyInstance } from "fastify";
import { createWorkspaceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  listWorkspacesForUser,
} from "../services/workspaces";

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  app.post("/workspaces", async (request, reply) => {
    const parsed = createWorkspaceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const workspace = createWorkspace(db, parsed.data, request.actor.userId);
    return reply.status(201).send(workspace);
  });

  app.get("/workspaces", async (request) =>
    // The worker's system actor polls every workspace; users see their own.
    request.actor.system ? listWorkspaces(db) : listWorkspacesForUser(db, request.actor.userId!),
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) {
      return reply.status(404).send({ error: "workspace_not_found" });
    }
    return workspace;
  });
}
