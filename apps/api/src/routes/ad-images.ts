import type { FastifyInstance, FastifyReply } from "fastify";
import { actorOf } from "../auth/guard";
import type { Db } from "../db";
import { DesignProviderError, type DesignProvider } from "../design/provider";
import { StorageError, type AssetStorage } from "../design/storage";
import type { RenderInput } from "../design/render";
import { AdImageSourceError, generateAdImage } from "../services/ad-images";
import { EntitlementError } from "../services/entitlements";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerAdImageRoutes(
  app: FastifyInstance,
  db: Db,
  design: DesignProvider,
  assetStorage: AssetStorage,
  render: (input: RenderInput) => Promise<Uint8Array>,
): void {
  app.post<{ Params: { id: string; draftId: string } }>(
    "/workspaces/:id/ad-creatives/:draftId/image",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      try {
        const draft = await generateAdImage(
          { db, design, assetStorage, render },
          {
            workspaceId: request.params.id,
            draftId: request.params.draftId,
            actor: actorOf(request),
          },
        );
        return reply.status(201).send(draft);
      } catch (err) {
        if (err instanceof EntitlementError) {
          return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
        }
        if (err instanceof AdImageSourceError) {
          if (err.message === "draft_not_found") {
            return reply.status(404).send({ error: "draft_not_found" });
          }
          return reply.status(409).send({ error: "source_not_eligible", message: err.message });
        }
        if (err instanceof DesignProviderError) {
          return reply
            .status(503)
            .send({ error: "design_unavailable", message: "The design service is unavailable — try again in a moment. Text flows are unaffected." });
        }
        if (err instanceof StorageError) {
          return reply.status(502).send({ error: "asset_storage_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
