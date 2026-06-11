import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  CONNECTOR_PROVIDERS,
  type ConnectInput,
  type Connection,
  type ConnectionStatus,
  type ConnectorProvider,
} from "@tuezday/contracts";
import type { Db } from "../db";
import { connections, type ConnectionRow } from "../db/schema";
import type { ConnectorFabric, ImportCredentials } from "../connectors/fabric";

export function providerByKey(key: string): ConnectorProvider | undefined {
  return CONNECTOR_PROVIDERS.find((p) => p.key === key);
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    ...row,
    config: JSON.parse(row.configJson) as Connection["config"],
    status: row.status as ConnectionStatus,
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

function integrationKeyFor(provider: ConnectorProvider): string {
  return `tuezday-${provider.key}`;
}

/**
 * Connect a provider: ensure the integration exists in Nango, import the
 * credentials there (they never touch our DB), and store only the state row.
 * Reconnecting a disconnected provider revives the same row.
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
      : input.apiKey
        ? { type: "API_KEY", apiKey: input.apiKey }
        : { type: "BASIC", username: input.username!, password: input.password! };

  const existing = db
    .select()
    .from(connections)
    .where(
      and(eq(connections.workspaceId, workspaceId), eq(connections.providerKey, provider.key)),
    )
    .get();

  const nangoConnectionId = `ws-${workspaceId}-${provider.key}`;
  await fabric.importConnection(integrationKey, nangoConnectionId, credentials);

  const config = JSON.stringify({
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.testPath ? { testPath: input.testPath } : {}),
  });
  const now = Date.now();

  if (existing) {
    db.update(connections)
      .set({ nangoConnectionId, configJson: config, status: "connected", lastError: null, lastCheckedAt: now })
      .where(eq(connections.id, existing.id))
      .run();
    return getConnection(db, workspaceId, existing.id)!;
  }

  const row: ConnectionRow = {
    id: randomUUID(),
    workspaceId,
    providerKey: provider.key,
    nangoConnectionId,
    configJson: config,
    status: "connected",
    lastCheckedAt: now,
    lastError: null,
    createdAt: now,
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
