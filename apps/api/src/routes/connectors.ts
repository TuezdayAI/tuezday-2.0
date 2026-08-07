import type { FastifyInstance, FastifyReply } from "fastify";
import type { AnalyticsSink } from "../analytics/sink";
import { track } from "../analytics/track";
import {
  CONNECTOR_PROVIDERS,
  connectInputSchema,
  createWebhookInputSchema,
  updateConnectionContentProfileInputSchema,
  updateConnectionInputSchema,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { assertWithinLimit, EntitlementError, getUsage } from "../services/entitlements";
import { ConnectorFabricError, type ConnectorFabric } from "../connectors/fabric";
import {
  bindInstagramOAuthIdentity,
  connectProvider,
  disconnectConnection,
  getConnection,
  integrationKeyFor,
  listConnections,
  oauthAppCredentials,
  providerByKey,
  registerOAuthConnection,
  resolveOAuthScopes,
  setConnectionContentProfile,
  testConnection,
  updateConnection,
} from "../services/connections";
import { ProviderCapabilityError } from "../discovery/provider-errors";
import {
  createWebhook,
  deleteWebhook,
  emitEvent,
  getWebhook,
  listEvents,
  listWebhooks,
  setWebhookEnabled,
} from "../services/events";
import { getWorkspace } from "../services/workspaces";

type Fetcher = typeof fetch;

async function workspaceOr404(db: Db, id: string, reply: FastifyReply) {
  const workspace = await getWorkspace(db, id);
  if (!workspace) {
    void reply.status(404).send({ error: "workspace_not_found" });
  }
  return workspace;
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  db: Db,
  fabric: ConnectorFabric,
  fetcher: Fetcher,
  analytics: AnalyticsSink,
): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/connectors", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const [health, connections] = await Promise.all([
      fabric.health(),
      Promise.resolve(listConnections(db, request.params.id)),
    ]);
    // OAuth providers flip to connectable once their app creds land in .env.
    const providers = CONNECTOR_PROVIDERS.map((p) =>
      p.authMode === "oauth" ? { ...p, oauthConfigured: Boolean(oauthAppCredentials(p.key)) } : p,
    );
    return { providers, connections, fabric: health };
  });

  // -------------------------------------------------------------------------
  // OAuth popup flow (Sprint 17): session token out, connection id back in
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string; providerKey: string } }>(
    "/workspaces/:id/connectors/:providerKey/oauth/session",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;

      try {
        await assertWithinLimit(db, request.params.id, "connectors", (await getUsage(db, request.params.id)).connectors);
      } catch (err) {
        if (err instanceof EntitlementError) {
          return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
        }
        throw err;
      }

      const provider = providerByKey(request.params.providerKey);
      if (!provider) return reply.status(404).send({ error: "provider_not_found" });
      if (provider.authMode !== "oauth") {
        return reply.status(400).send({
          error: "not_oauth",
          message: `${provider.label} does not use the OAuth popup flow.`,
        });
      }
      const oauthApp = oauthAppCredentials(provider.key);
      if (!oauthApp) {
        return reply.status(409).send({
          error: "needs_oauth_app",
          message: `${provider.label} needs OAuth app credentials in the root .env first.`,
        });
      }
      const health = await fabric.health();
      if (!health.healthy) {
        return reply.status(503).send({
          error: "fabric_unavailable",
          message: health.detail ?? "The connector service is not reachable.",
        });
      }
      const integrationKey = integrationKeyFor(provider);
      try {
        await fabric.ensureIntegration(integrationKey, provider.nangoProvider, {
          ...oauthApp,
          scopes: resolveOAuthScopes(provider),
        });
        const session = await fabric.createConnectSession(integrationKey, request.params.id);
        // The browser opens the popup itself, so it needs a host it can reach.
        const nangoBaseUrl =
          process.env.NANGO_PUBLIC_URL?.trim() ||
          process.env.NANGO_BASE_URL?.trim() ||
          "http://localhost:3050";
        return { token: session.token, nangoBaseUrl, integrationKey };
      } catch (err) {
        if (err instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "connect_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; providerKey: string }; Body: { connectionId?: string } }>(
    "/workspaces/:id/connectors/:providerKey/oauth/complete",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const provider = providerByKey(request.params.providerKey);
      if (!provider) return reply.status(404).send({ error: "provider_not_found" });
      const nangoConnectionId = request.body?.connectionId?.trim();
      if (!nangoConnectionId) {
        return reply.status(400).send({
          error: "invalid_input",
          message: "The popup result's connectionId is required.",
        });
      }
      const exists = await fabric.connectionExists(nangoConnectionId, integrationKeyFor(provider));
      if (!exists) {
        return reply.status(400).send({
          error: "connection_unknown",
          message: "The connector service does not know that connection — run the popup again.",
        });
      }
      let connection = await registerOAuthConnection(
        db,
        request.params.id,
        provider,
        nangoConnectionId,
      );
      try {
        if (provider.key === "instagram") {
          connection = await bindInstagramOAuthIdentity(
            db,
            fabric,
            connection,
          );
        }
        await testConnection(db, fabric, connection);
      } catch (err) {
        if (err instanceof ProviderCapabilityError) {
          return reply.status(409).send({
            error: err.code,
            message: err.message,
          });
        }
        throw err;
      }

      await track(db, analytics, {
        event: "connector.connected",
        distinctId: request.actor.userId!,
        workspaceId: request.params.id,
        properties: { provider: provider.key },
      });

      return reply.status(201).send(await getConnection(db, request.params.id, connection.id));
    },
  );

  app.post<{ Params: { id: string; providerKey: string } }>(
    "/workspaces/:id/connectors/:providerKey/connect",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;

      try {
        await assertWithinLimit(db, request.params.id, "connectors", (await getUsage(db, request.params.id)).connectors);
      } catch (err) {
        if (err instanceof EntitlementError) {
          return reply.status(402).send({ error: "upgrade_required", key: err.key, limit: err.limit });
        }
        throw err;
      }

      const provider = providerByKey(request.params.providerKey);
      if (!provider) return reply.status(404).send({ error: "provider_not_found" });
      if (provider.authMode === "oauth") {
        return reply.status(409).send({
          error: "needs_oauth_app",
          message: `${provider.label} uses OAuth — it becomes connectable once an OAuth app is configured.`,
        });
      }
      const parsed = connectInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      if (provider.authMode === "api_key" && !parsed.data.apiKey) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `${provider.label} needs an API key.`,
        });
      }
      if (provider.authMode === "basic" && !(parsed.data.username && parsed.data.password)) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `${provider.label} needs a username and password.`,
        });
      }
      if (provider.authMode === "access_token" && !parsed.data.accessToken) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `${provider.label} needs an access token.`,
        });
      }
      if (provider.requiresBaseUrl && !parsed.data.baseUrl) {
        return reply.status(400).send({
          error: "invalid_input",
          message: `${provider.label} needs a baseUrl.`,
        });
      }
      const health = await fabric.health();
      if (!health.healthy) {
        return reply.status(503).send({
          error: "fabric_unavailable",
          message: health.detail ?? "The connector service is not reachable.",
        });
      }
      try {
        const connection = await connectProvider(
          db,
          fabric,
          request.params.id,
          provider,
          parsed.data,
        );

        await track(db, analytics, {
          event: "connector.connected",
          distinctId: request.actor.userId!,
          workspaceId: request.params.id,
          properties: { provider: provider.key },
        });

        return reply.status(201).send(connection);
      } catch (err) {
        if (err instanceof ConnectorFabricError) {
          return reply.status(502).send({ error: "connect_failed", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string; connectionId: string } }>(
    "/workspaces/:id/connections/:connectionId/test",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const connection = await getConnection(db, request.params.id, request.params.connectionId);
      if (!connection) return reply.status(404).send({ error: "connection_not_found" });
      return await testConnection(db, fabric, connection);
    },
  );

  app.patch<{ Params: { id: string; connectionId: string } }>(
    "/workspaces/:id/connections/:connectionId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateConnectionInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = await updateConnection(db, request.params.id, request.params.connectionId, parsed.data);
      if (!updated) return reply.status(404).send({ error: "connection_not_found" });
      return updated;
    },
  );

  app.put<{ Params: { id: string; connectionId: string } }>(
    "/workspaces/:id/connections/:connectionId/content-profile",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const parsed = updateConnectionContentProfileInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_input",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
      }
      const updated = await setConnectionContentProfile(
        db,
        request.params.id,
        request.params.connectionId,
        parsed.data,
      );
      if (!updated) return reply.status(404).send({ error: "connection_not_found" });
      return updated;
    },
  );

  app.delete<{ Params: { id: string; connectionId: string } }>(
    "/workspaces/:id/connections/:connectionId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const connection = await getConnection(db, request.params.id, request.params.connectionId);
      if (!connection) return reply.status(404).send({ error: "connection_not_found" });
      await disconnectConnection(db, fabric, connection);
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Webhooks + events
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>("/workspaces/:id/webhooks", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    const parsed = createWebhookInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    return reply.status(201).send(await createWebhook(db, request.params.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id/webhooks", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return await listWebhooks(db, request.params.id);
  });

  app.patch<{ Params: { id: string; webhookId: string }; Body: { enabled?: boolean } }>(
    "/workspaces/:id/webhooks/:webhookId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const webhook = await getWebhook(db, request.params.id, request.params.webhookId);
      if (!webhook) return reply.status(404).send({ error: "webhook_not_found" });
      if (typeof request.body?.enabled === "boolean") {
        await setWebhookEnabled(db, webhook.id, request.body.enabled);
      }
      return await getWebhook(db, request.params.id, webhook.id);
    },
  );

  app.delete<{ Params: { id: string; webhookId: string } }>(
    "/workspaces/:id/webhooks/:webhookId",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const webhook = await getWebhook(db, request.params.id, request.params.webhookId);
      if (!webhook) return reply.status(404).send({ error: "webhook_not_found" });
      await deleteWebhook(db, webhook.id);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; webhookId: string } }>(
    "/workspaces/:id/webhooks/:webhookId/ping",
    async (request, reply) => {
      if (!await workspaceOr404(db, request.params.id, reply)) return reply;
      const webhook = await getWebhook(db, request.params.id, request.params.webhookId);
      if (!webhook) return reply.status(404).send({ error: "webhook_not_found" });
      await emitEvent(db, fetcher, request.params.id, "webhook.ping", {
        message: "Tuezday webhook test",
        webhookId: webhook.id,
      });
      const [latest] = await listEvents(db, request.params.id, 1);
      return latest;
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/events", async (request, reply) => {
    if (!await workspaceOr404(db, request.params.id, reply)) return reply;
    return await listEvents(db, request.params.id);
  });
}
