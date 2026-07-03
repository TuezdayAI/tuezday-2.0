import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  CONNECTOR_PROVIDERS,
  connectionContentProfileSchema,
  type ConnectInput,
  type Connection,
  type ConnectionContentProfile,
  type ConnectionStatus,
  type ConnectorProvider,
  type UpdateConnectionInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { connections, type ConnectionRow } from "../db/schema";
import type { ConnectorFabric, ImportCredentials } from "../connectors/fabric";

export function providerByKey(key: string): ConnectorProvider | undefined {
  return CONNECTOR_PROVIDERS.find((p) => p.key === key);
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerKey: row.providerKey,
    nangoConnectionId: row.nangoConnectionId,
    config: JSON.parse(row.configJson) as Connection["config"],
    displayName: row.displayName || row.providerKey,
    externalAccountId: row.externalAccountId,
    externalAccountName: row.externalAccountName,
    externalAccountHandle: row.externalAccountHandle,
    externalAccountUrl: row.externalAccountUrl,
    status: row.status as ConnectionStatus,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
    contentProfile: connectionContentProfileSchema.parse(JSON.parse(row.contentProfileJson)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

export function listConnections(db: Db, workspaceId: string): Connection[] {
  return db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId))
    .orderBy(desc(connections.createdAt))
    .all()
    .map(rowToConnection);
}

export function getConnection(
  db: Db,
  workspaceId: string,
  connectionId: string,
): Connection | undefined {
  const row = db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .get();
  return row ? rowToConnection(row) : undefined;
}

export function updateConnection(
  db: Db,
  workspaceId: string,
  connectionId: string,
  input: UpdateConnectionInput,
): Connection | undefined {
  const existing = getConnection(db, workspaceId, connectionId);
  if (!existing) return undefined;
  db.update(connections)
    .set({ displayName: input.displayName, updatedAt: Date.now() })
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .run();
  return getConnection(db, workspaceId, connectionId);
}

/** Save the per-account content profile (Sprint 44) — what this account posts about. */
export function setConnectionContentProfile(
  db: Db,
  workspaceId: string,
  connectionId: string,
  profile: ConnectionContentProfile,
): Connection | undefined {
  const existing = getConnection(db, workspaceId, connectionId);
  if (!existing) return undefined;
  db.update(connections)
    .set({ contentProfileJson: JSON.stringify(profile), updatedAt: Date.now() })
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .run();
  return getConnection(db, workspaceId, connectionId);
}

export function integrationKeyFor(provider: ConnectorProvider): string {
  return `tuezday-${provider.key}`;
}

// Per-provider OAuth app credentials live in the root .env only — they are
// provisioned into Nango at connect time and never stored in Tuezday's DB.
const OAUTH_ENV: Record<string, { id: string; secret: string }> = {
  reddit: { id: "REDDIT_CLIENT_ID", secret: "REDDIT_CLIENT_SECRET" },
  // Sprint 25 social trio. Each becomes connectable only when both vars are
  // set in the root .env; until then it stays needs_oauth_app, like Reddit.
  linkedin: { id: "LINKEDIN_CLIENT_ID", secret: "LINKEDIN_CLIENT_SECRET" },
  twitter: { id: "TWITTER_CLIENT_ID", secret: "TWITTER_CLIENT_SECRET" },
  instagram: { id: "INSTAGRAM_CLIENT_ID", secret: "INSTAGRAM_CLIENT_SECRET" }, // Facebook app id/secret
};

export function oauthAppCredentials(
  providerKey: string,
): { clientId: string; clientSecret: string } | undefined {
  const envKeys = OAUTH_ENV[providerKey];
  if (!envKeys) return undefined;
  const clientId = process.env[envKeys.id]?.trim();
  const clientSecret = process.env[envKeys.secret]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/**
 * Register a connection the OAuth popup created. Nango generated the
 * connection id; Tuezday stores one row per distinct Nango connection id.
 */
export function registerOAuthConnection(
  db: Db,
  workspaceId: string,
  provider: ConnectorProvider,
  nangoConnectionId: string,
): Connection {
  const existing = db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.nangoConnectionId, nangoConnectionId),
      ),
    )
    .get();
  const now = Date.now();

  if (existing) {
    db.update(connections)
      .set({
        nangoConnectionId,
        status: "connected",
        lastError: null,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, existing.id)))
      .run();
    return getConnection(db, workspaceId, existing.id)!;
  }

  const row: ConnectionRow = {
    id: randomUUID(),
    workspaceId,
    providerKey: provider.key,
    nangoConnectionId,
    configJson: "{}",
    displayName: provider.label,
    externalAccountId: null,
    externalAccountName: null,
    externalAccountHandle: null,
    externalAccountUrl: null,
    status: "connected",
    lastCheckedAt: now,
    lastError: null,
    contentProfileJson: "{}",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(connections).values(row).run();
  return rowToConnection(row);
}

/**
 * Connect a provider: ensure the integration exists in Nango, import the
 * credentials there (they never touch our DB), and store only the state row.
 * Reconnecting a disconnected provider creates a new row; reconnecting a
 * specific prior row belongs to a future scoped flow.
 */
export async function connectProvider(
  db: Db,
  fabric: ConnectorFabric,
  workspaceId: string,
  provider: ConnectorProvider,
  input: ConnectInput,
): Promise<Connection> {
  const integrationKey = integrationKeyFor(provider);
  await fabric.ensureIntegration(integrationKey, provider.nangoProvider);

  const credentials: ImportCredentials =
    provider.authMode === "none"
      ? { type: "NONE" }
      : provider.authMode === "access_token"
        ? { type: "OAUTH2", accessToken: input.accessToken! }
        : input.apiKey
          ? { type: "API_KEY", apiKey: input.apiKey }
          : { type: "BASIC", username: input.username!, password: input.password! };

  const nangoConnectionId = `ws-${workspaceId}-${provider.key}-${randomUUID()}`;
  // Some Nango templates resolve their API host from a connection_config
  // value (freshsales' bundleAlias) — derive it from the founder's base URL.
  const connectionConfig =
    provider.baseUrlConfigKey && input.baseUrl
      ? { [provider.baseUrlConfigKey]: input.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") }
      : undefined;
  await fabric.importConnection(integrationKey, nangoConnectionId, credentials, connectionConfig);

  const config = JSON.stringify({
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.testPath ? { testPath: input.testPath } : {}),
  });
  const now = Date.now();

  const row: ConnectionRow = {
    id: randomUUID(),
    workspaceId,
    providerKey: provider.key,
    nangoConnectionId,
    configJson: config,
    displayName: provider.label,
    externalAccountId: null,
    externalAccountName: null,
    externalAccountHandle: null,
    externalAccountUrl: null,
    status: "connected",
    lastCheckedAt: now,
    lastError: null,
    contentProfileJson: "{}",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(connections).values(row).run();
  return rowToConnection(row);
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
  httpStatus?: number;
}

export async function testConnection(
  db: Db,
  fabric: ConnectorFabric,
  connection: Connection,
): Promise<ConnectionTestResult> {
  const provider = providerByKey(connection.providerKey);
  const integrationKey = provider ? integrationKeyFor(provider) : `tuezday-${connection.providerKey}`;
  let result: ConnectionTestResult;

  try {
    const exists = await fabric.connectionExists(connection.nangoConnectionId, integrationKey);
    if (!exists) {
      result = { ok: false, detail: "Connection no longer exists in the connector service." };
    } else {
      const baseUrl = connection.config.baseUrl ?? provider?.baseUrl;
      const testPath = connection.config.testPath ?? provider?.testPath;
      if (baseUrl && testPath) {
        const proxy = await fabric.proxyGet(
          testPath,
          connection.nangoConnectionId,
          integrationKey,
          baseUrl,
        );
        result =
          proxy.status >= 200 && proxy.status < 300
            ? { ok: true, detail: `Test request returned ${proxy.status}.`, httpStatus: proxy.status }
            : {
                ok: false,
                detail: `Test request returned ${proxy.status}: ${proxy.bodySnippet.slice(0, 120)}`,
                httpStatus: proxy.status,
              };
      } else {
        result = { ok: true, detail: "Credentials are stored; no test endpoint configured." };
      }
    }
  } catch (err) {
    result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  db.update(connections)
    .set({
      status: result.ok ? "connected" : "error",
      lastError: result.ok ? null : result.detail.slice(0, 500),
      lastCheckedAt: Date.now(),
    })
    .where(eq(connections.id, connection.id))
    .run();
  return result;
}

export async function disconnectConnection(
  db: Db,
  fabric: ConnectorFabric,
  connection: Connection,
): Promise<void> {
  const provider = providerByKey(connection.providerKey);
  const integrationKey = provider ? integrationKeyFor(provider) : `tuezday-${connection.providerKey}`;
  try {
    await fabric.deleteConnection(connection.nangoConnectionId, integrationKey);
  } catch {
    // The state row is ours; an unreachable fabric must not block disconnect.
  }
  db.update(connections)
    .set({ status: "disconnected", lastCheckedAt: Date.now() })
    .where(eq(connections.id, connection.id))
    .run();
}
