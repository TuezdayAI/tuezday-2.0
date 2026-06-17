import type { FastifyInstance, FastifyReply } from "fastify";
import { updateGuidanceInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import {
  asChannel,
  listChannelGuidance,
  resetChannelGuidance,
  setChannelGuidance,
} from "../services/guidance";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerGuidanceRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/guidance", async (request, reply) => {
    if (!workspaceOr404(db, request.params.id, reply)) return reply;
    return listChannelGuidance(db, request.params.id);
  });

  app.put<{ Params: { id: string; channel: string } }>(
    "/workspaces/:id/guidance/:channel",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const channel = asChannel(request.params.channel);
      if (!channel) return reply.status(400).send({ error: "invalid_channel" });
      const parsed = updateGuidanceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return setChannelGuidance(db, request.params.id, channel, parsed.data.content);
    },
  );

  app.delete<{ Params: { id: string; channel: string } }>(
    "/workspaces/:id/guidance/:channel",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const channel = asChannel(request.params.channel);
      if (!channel) return reply.status(400).send({ error: "invalid_channel" });
      return resetChannelGuidance(db, request.params.id, channel);
    },
  );
}
