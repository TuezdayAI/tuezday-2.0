import type { FastifyInstance, FastifyReply } from "fastify";
import { updateGenerationSettingsInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  getGenerationSettings,
  updateGenerationSettings,
} from "../services/generation-settings";
import { getWorkspace } from "../services/workspaces";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerGenerationSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/generation-settings",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await getGenerationSettings(db, request.params.id);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/workspaces/:id/generation-settings",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateGenerationSettingsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return await updateGenerationSettings(db, request.params.id, parsed.data);
    },
  );
}
