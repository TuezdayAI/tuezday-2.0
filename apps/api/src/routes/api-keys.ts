import type { TuezdayApp } from "../app";
import type { Db } from "../db";
import type { FastifyReply } from "fastify";
import { getWorkspace } from "../services/workspaces";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-keys";
import { createApiKeyInputSchema } from "@tuezday/contracts";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    reply.status(404).send({ error: "workspace_not_found" });
    return null;
  }
  return workspace;
}

export function registerApiKeyRoutes(app: TuezdayApp, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/api-keys", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return await listApiKeys(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/api-keys", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createApiKeyInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_input" });
    }
    const result = await createApiKey(db, request.params.id, parsed.data);
    return reply.status(201).send(result);
  });

  app.delete<{ Params: { id: string; keyId: string } }>(
    "/workspaces/:id/api-keys/:keyId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      await revokeApiKey(db, request.params.id, request.params.keyId);
      return reply.status(204).send();
    },
  );
}
