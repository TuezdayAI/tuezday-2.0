import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DISCOVERED_ITEM_STATUSES,
  createDiscoverySourceInputSchema,
  updateDiscoverySourceInputSchema,
  type DiscoveredItemStatus,
} from "@tuezday/contracts";
import type { Db } from "../db";
import type { Fetcher } from "../discovery/adapters";
import type { LlmGateway } from "../llm/gateway";
import { GatewayError } from "../llm/gateway";
import {
  ItemNotTriagableError,
  acceptDiscoveredItem,
  createDiscoverySource,
  deleteDiscoverySource,
  getDiscoveredItem,
  listDiscoveredItems,
  listDiscoverySources,
  runDiscovery,
  skipDiscoveredItem,
  suggestDiscoverySources,
  updateDiscoverySource,
} from "../services/discovery";
import { getWorkspace } from "../services/workspaces";

function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  fetcher: Fetcher,
): void {
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/sources",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createDiscoverySourceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      return reply.status(201).send(createDiscoverySource(db, request.params.id, parsed.data));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/sources",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      return listDiscoverySources(db, request.params.id);
    },
  );

  app.patch<{ Params: { id: string; sourceId: string } }>(
    "/workspaces/:id/discovery/sources/:sourceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateDiscoverySourceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = updateDiscoverySource(
        db,
        request.params.id,
        request.params.sourceId,
        parsed.data,
      );
      if (!updated) return reply.status(404).send({ error: "source_not_found" });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/workspaces/:id/discovery/sources/:sourceId",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = deleteDiscoverySource(db, request.params.id, request.params.sourceId);
      if (!deleted) return reply.status(404).send({ error: "source_not_found" });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/discovery/run", async (request, reply) => {
    const workspace = workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    return runDiscovery(db, llm, fetcher, request.params.id, workspace.name);
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/workspaces/:id/discovery/items",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const { status } = request.query;
      if (
        status !== undefined &&
        !(DISCOVERED_ITEM_STATUSES as readonly string[]).includes(status)
      ) {
        return reply.status(400).send({ error: "invalid_status" });
      }
      return listDiscoveredItems(
        db,
        request.params.id,
        status as DiscoveredItemStatus | undefined,
      );
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/discovery/items/:itemId/accept",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const item = getDiscoveredItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "item_not_found" });
      try {
        return acceptDiscoveredItem(db, request.params.id, item);
      } catch (err) {
        if (err instanceof ItemNotTriagableError) {
          return reply.status(409).send({ error: "already_triaged", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/discovery/items/:itemId/skip",
    async (request, reply) => {
      if (!workspaceOr404(db, request.params.id, reply)) return reply;
      const item = getDiscoveredItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "item_not_found" });
      try {
        return skipDiscoveredItem(db, item);
      } catch (err) {
        if (err instanceof ItemNotTriagableError) {
          return reply.status(409).send({ error: "already_triaged", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/suggest",
    async (request, reply) => {
      const workspace = workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      try {
        return await suggestDiscoverySources(db, llm, request.params.id, workspace.name);
      } catch (err) {
        if (err instanceof GatewayError) {
          return reply.status(502).send({ error: "suggestion_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
