import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  DISCOVERED_ITEM_STATUSES,
  createDiscoverySourceInputSchema,
  createTrackedSocialAccountInputSchema,
  resolveTrackedSocialAccountInputSchema,
  updateDiscoverySourceInputSchema,
  updateTrackedSocialAccountInputSchema,
  type DiscoveredItemStatus,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import type { IntentProvider } from "../discovery/intent";
import type { TrustedFetcher } from "../http";
import type { LlmGateway } from "../llm/gateway";
import { GatewayError } from "../llm/gateway";
import { StructuredOutputError } from "../llm/structured";
import {
  SafeFetchError,
  serializeSafeFetchError,
  type SafeFetchService,
} from "../safe-fetch";
import {
  DiscoverySourceConnectionError,
  DiscoverySourceReservedError,
  ItemNotTriagableError,
  MatchingNotReadyError,
  acceptDiscoveredItem,
  createDiscoverySource,
  deleteDiscoverySource,
  getDiscoveredItem,
  getDiscoverySource,
  listDiscoveredItems,
  listDiscoverySources,
  listItemDuplicates,
  skipDiscoveredItem,
  suggestDiscoverySources,
  updateDiscoverySource,
  validateDiscoverySourceTransition,
} from "../services/discovery";
import {
  runDiscoveryScheduler,
  type DiscoveryOperatorEvent,
} from "../services/discovery-scheduler";
import type { DiscoveryOperatorPolicy } from "../runtime/operator-policy";
import { emitEvent } from "../services/events";
import {
  DiscoveryReferenceNotFoundError,
  DuplicateTrackedAccountError,
  InvalidTrackedHandleError,
  createTrackedSocialAccount,
  deleteTrackedSocialAccount,
  listTrackedSocialAccounts,
  updateTrackedSocialAccount,
} from "../services/tracked-social-accounts";
import { getWorkspace } from "../services/workspaces";
import { ProviderCapabilityError } from "../discovery/provider-errors";
import {
  TrackedAccountConnectionError,
  TrackedAccountNotFoundError,
  resolveTrackedSocialAccount,
} from "../services/tracked-account-resolver";

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  db: Db,
  llm: LlmGateway,
  safeFetch: SafeFetchService,
  trustedFetcher: TrustedFetcher,
  intent: IntentProvider,
  connectors: ConnectorFabric,
  scheduler: {
    policy: DiscoveryOperatorPolicy;
    instanceId: string;
    shutdownSignal: AbortSignal;
    log: (event: DiscoveryOperatorEvent) => void;
  },
): void {
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/sources",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createDiscoverySourceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        if (
          (parsed.data.type === "rss" || parsed.data.type === "podcast") &&
          parsed.data.config.feedUrl
        ) {
          safeFetch.validateUrl(parsed.data.config.feedUrl);
        }
        return await reply
          .status(201)
          .send(await createDiscoverySource(db, request.params.id, parsed.data));
      } catch (err) {
        if (err instanceof SafeFetchError) {
          return reply.status(400).send(serializeSafeFetchError(err));
        }
        if (err instanceof DiscoverySourceConnectionError) {
          return reply.status(400).send({ error: err.code, message: err.message });
        }
        if (err instanceof DiscoverySourceReservedError) {
          return reply.status(409).send({
            error: err.code,
            message: err.message,
          });
        }
        if (err instanceof DiscoveryReferenceNotFoundError) {
          return reply.status(404).send({ error: "related_object_not_found" });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/sources",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await listDiscoverySources(db, request.params.id);
    },
  );

  app.patch<{ Params: { id: string; sourceId: string } }>(
    "/workspaces/:id/discovery/sources/:sourceId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateDiscoverySourceInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        const existing = await getDiscoverySource(
          db,
          request.params.id,
          request.params.sourceId,
        );
        if (!existing) {
          return reply.status(404).send({ error: "source_not_found" });
        }
        const transition = validateDiscoverySourceTransition(
          existing,
          parsed.data,
        );
        if (
          transition.config.feedUrl &&
          (transition.type === "rss" || transition.type === "podcast")
        ) {
          safeFetch.validateUrl(transition.config.feedUrl);
        }
        const updated = await updateDiscoverySource(
          db,
          request.params.id,
          request.params.sourceId,
          parsed.data,
        );
        if (!updated) return reply.status(404).send({ error: "source_not_found" });
        return updated;
      } catch (err) {
        if (err instanceof ZodError) {
          return reply.status(400).send({
            error: "invalid_input",
            message: err.issues.map((issue) => issue.message).join("; "),
          });
        }
        if (err instanceof SafeFetchError) {
          return reply.status(400).send(serializeSafeFetchError(err));
        }
        if (err instanceof DiscoverySourceConnectionError) {
          return reply.status(400).send({ error: err.code, message: err.message });
        }
        if (err instanceof DiscoverySourceReservedError) {
          return reply.status(409).send({
            error: err.code,
            message: err.message,
          });
        }
        if (err instanceof DiscoveryReferenceNotFoundError) {
          return reply.status(404).send({ error: "related_object_not_found" });
        }
        throw err;
      }
    },
  );

  // Tracked social accounts (Sprint 46): competitor/source accounts that
  // connected discovery sources reference instead of re-typing handles.
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/tracked-accounts",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = createTrackedSocialAccountInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        return await reply
          .status(201)
          .send(await createTrackedSocialAccount(db, request.params.id, parsed.data));
      } catch (err) {
        if (err instanceof DuplicateTrackedAccountError) {
          return reply.status(409).send({ error: "duplicate_account", message: err.message });
        }
        if (err instanceof InvalidTrackedHandleError) {
          return reply.status(400).send({ error: "invalid_input", message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/discovery/tracked-accounts",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      return await listTrackedSocialAccounts(db, request.params.id);
    },
  );

  app.patch<{ Params: { id: string; accountId: string } }>(
    "/workspaces/:id/discovery/tracked-accounts/:accountId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateTrackedSocialAccountInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      try {
        const updated = await updateTrackedSocialAccount(
          db,
          request.params.id,
          request.params.accountId,
          parsed.data,
        );
        if (!updated) return reply.status(404).send({ error: "account_not_found" });
        return updated;
      } catch (err) {
        if (err instanceof DuplicateTrackedAccountError) {
          return reply.status(409).send({ error: "duplicate_account", message: err.message });
        }
        if (err instanceof InvalidTrackedHandleError) {
          return reply.status(400).send({ error: "invalid_input", message: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; accountId: string } }>(
    "/workspaces/:id/discovery/tracked-accounts/:accountId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = await deleteTrackedSocialAccount(db, request.params.id, request.params.accountId);
      if (!deleted) return reply.status(404).send({ error: "account_not_found" });
      return reply.status(204).send();
    },
  );

  app.post<{
    Params: { id: string; accountId: string };
  }>(
    "/workspaces/:id/discovery/tracked-accounts/:accountId/resolve",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed =
        resolveTrackedSocialAccountInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues
            .map((issue) => issue.message)
            .join("; "),
        });
      }
      try {
        return await resolveTrackedSocialAccount(
          { db, fabric: connectors },
          {
            workspaceId: request.params.id,
            accountId: request.params.accountId,
            connectionId: parsed.data.connectionId,
            force: true,
          },
        );
      } catch (err) {
        if (err instanceof TrackedAccountNotFoundError) {
          return reply
            .status(404)
            .send({ error: "account_not_found" });
        }
        if (err instanceof TrackedAccountConnectionError) {
          return reply.status(404).send({
            error: err.code,
            message: err.message,
          });
        }
        if (err instanceof ProviderCapabilityError) {
          return reply.status(409).send({
            error: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/workspaces/:id/discovery/sources/:sourceId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const deleted = await deleteDiscoverySource(db, request.params.id, request.params.sourceId);
      if (!deleted) return reply.status(404).send({ error: "source_not_found" });
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/discovery/run", async (request, reply) => {
    const workspace = await workspaceOr404(db, request.params.id, reply);
    if (!workspace) return reply;
    return await runDiscoveryScheduler(
      {
        db,
        llm,
        safeFetch,
        intentProvider: intent,
        fabric: connectors,
        ...scheduler,
      },
      { workspaceId: request.params.id },
    );
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/workspaces/:id/discovery/items",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const { status } = request.query;
      if (
        status !== undefined &&
        !(DISCOVERED_ITEM_STATUSES as readonly string[]).includes(status)
      ) {
        return reply.status(400).send({ error: "invalid_status" });
      }
      return await listDiscoveredItems(
        db,
        request.params.id,
        status as DiscoveredItemStatus | undefined,
      );
    },
  );

  // The "seen via N sources" expansion for a canonical item (Sprint 45).
  app.get<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/discovery/items/:itemId/duplicates",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const item = await getDiscoveredItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "item_not_found" });
      return await listItemDuplicates(db, request.params.id, request.params.itemId);
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/discovery/items/:itemId/accept",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const item = await getDiscoveredItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "item_not_found" });
      try {
        const result = await acceptDiscoveredItem(db, request.params.id, item.id);
        await emitEvent(db, trustedFetcher, request.params.id, "discovery.item.accepted", {
          itemId: result.item.id,
          signalId: result.signal.id,
          title: result.item.title,
          url: result.item.url,
          score: result.item.score,
        });
        return result;
      } catch (err) {
        if (err instanceof MatchingNotReadyError) {
          return reply.status(409).send({
            error: "matching_not_ready",
            message: "Scoring has not completed for this item yet.",
          });
        }
        if (err instanceof ItemNotTriagableError) {
          return reply.status(409).send({ error: "already_triaged", message: err.message });
        }
        if (err instanceof DiscoveryReferenceNotFoundError) {
          return reply.status(404).send({ error: "related_object_not_found" });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/discovery/items/:itemId/skip",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const item = await getDiscoveredItem(db, request.params.id, request.params.itemId);
      if (!item) return reply.status(404).send({ error: "item_not_found" });
      try {
        return await skipDiscoveredItem(db, request.params.id, item);
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
      const workspace = await workspaceOr404(db, request.params.id, reply);
      if (!workspace) return reply;
      try {
        return await suggestDiscoverySources(db, llm, request.params.id, workspace.name);
      } catch (err) {
        // Provider down and post-repair malformed output are both 502s — the
        // latter used to be a silent empty list (Sprint 58).
        if (err instanceof GatewayError || err instanceof StructuredOutputError) {
          return reply.status(502).send({ error: "suggestion_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
