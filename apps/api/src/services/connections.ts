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
import { operatorFlagEnabled } from "../connectors/provider-config";
import { ProviderCapabilityError } from "../discovery/provider-errors";

export function providerByKey(key: string): ConnectorProvider | undefined {
  return CONNECTOR_PROVIDERS.find((p) => p.key === key);
}

/**
 * The OAuth scopes to request for a provider at connect time. Usually just the
 * provider's static scopes, but LinkedIn's member-post READ scope
 * (r_member_social) needs Community Management approval and, being
 * all-or-nothing, blocks the entire grant when the app lacks it — so it is
 * added back only when the operator sets LINKEDIN_COMMUNITY_APPROVED, once
 * their LinkedIn app is approved.
 */
export function resolveOAuthScopes(
  provider: ConnectorProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = provider.oauthScopes ?? "";
  if (
    provider.key !== "linkedin" ||
    !operatorFlagEnabled(env.LINKEDIN_COMMUNITY_APPROVED)
  ) {
    return base;
  }
  return [
    ...base.split(",").filter(Boolean),
    "r_member_social",
    "r_organization_social",
  ].join(",");
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
    timezone: row.timezone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

export async function listConnections(db: Db, workspaceId: string): Promise<Connection[]> {
  return (await db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId))
    .orderBy(desc(connections.createdAt))
    .all())
    .map(rowToConnection);
}

export async function getConnection(
  db: Db,
  workspaceId: string,
  connectionId: string,
): Promise<Connection | undefined> {
  const row = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .get();
  return row ? rowToConnection(row) : undefined;
}

export async function updateConnection(
  db: Db,
  workspaceId: string,
  connectionId: string,
  input: UpdateConnectionInput,
): Promise<Connection | undefined> {
  const existing = await getConnection(db, workspaceId, connectionId);
  if (!existing) return undefined;
  await db.update(connections)
    .set({
      displayName: input.displayName,
      timezone: input.timezone,
      updatedAt: Date.now(),
    })
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .run();
  return await getConnection(db, workspaceId, connectionId);
}

/** Save the per-account content profile (Sprint 44) — what this account posts about. */
export async function setConnectionContentProfile(
  db: Db,
  workspaceId: string,
  connectionId: string,
  profile: ConnectionContentProfile,
): Promise<Connection | undefined> {
  const existing = await getConnection(db, workspaceId, connectionId);
  if (!existing) return undefined;
  await db.update(connections)
    .set({ contentProfileJson: JSON.stringify(profile), updatedAt: Date.now() })
    .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
    .run();
  return await getConnection(db, workspaceId, connectionId);
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
  instagram: { id: "INSTAGRAM_CLIENT_ID", secret: "INSTAGRAM_CLIENT_SECRET" },
  // Sprint 47 outreach mailbox: a GCP OAuth app with the Gmail scopes.
  gmail: { id: "GMAIL_CLIENT_ID", secret: "GMAIL_CLIENT_SECRET" },
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
export async function registerOAuthConnection(
  db: Db,
  workspaceId: string,
  provider: ConnectorProvider,
  nangoConnectionId: string,
): Promise<Connection> {
  const existing = await db
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
    await db.update(connections)
      .set({
        nangoConnectionId,
        status: "connected",
        lastError: null,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, existing.id)))
      .run();
    return (await getConnection(db, workspaceId, existing.id))!;
  }

  const row: ConnectionRow = {
    id: randomUUID(),
    workspaceId,
    providerKey: provider.key,
    nangoConnectionId,
    configJson: "{}",
    displayName: provider.label,
    timezone: "UTC",
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
  await db.insert(connections).values(row).run();
  return rowToConnection(row);
}

interface InstagramIdentity {
  id?: string;
  user_id?: string;
  username?: string;
  name?: string;
}

/** Bind the one professional account returned by direct Instagram Login. */
export async function bindInstagramOAuthIdentity(
  db: Db,
  fabric: ConnectorFabric,
  connection: Connection,
): Promise<Connection> {
  const provider = providerByKey("instagram")!;
  const response = await fabric.proxyJson(
    "GET",
    "/me?fields=id,user_id,username,name,account_type",
    connection.nangoConnectionId,
    integrationKeyFor(provider),
    { baseUrlOverride: "https://graph.instagram.com" },
  );
  const identity = (response.json ?? {}) as InstagramIdentity;
  const accountId = identity.user_id?.trim() || identity.id?.trim();
  const username = identity.username?.trim().replace(/^@+/, "");
  if (
    response.status < 200 ||
    response.status >= 300 ||
    !accountId ||
    !username
  ) {
    const now = Date.now();
    await db.update(connections)
      .set({
        status: "error",
        lastError: "reconnect_required",
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(connections.workspaceId, connection.workspaceId),
          eq(connections.id, connection.id),
        ),
      )
      .run();
    throw new ProviderCapabilityError(
      "reconnect_required",
      "Instagram Login did not return a professional account identity.",
    );
  }

  const now = Date.now();
  await db.update(connections)
    .set({
      configJson: JSON.stringify({
        ...connection.config,
        authArchitecture: "instagram_login",
      }),
      displayName: identity.name?.trim() || `@${username}`,
      externalAccountId: accountId,
      externalAccountName: identity.name?.trim() || username,
      externalAccountHandle: username.toLowerCase(),
      externalAccountUrl: `https://www.instagram.com/${username}/`,
      status: "connected",
      lastCheckedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(connections.workspaceId, connection.workspaceId),
        eq(connections.id, connection.id),
      ),
    )
    .run();
  return (await getConnection(db, connection.workspaceId, connection.id))!;
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
    timezone: "UTC",
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
  await db.insert(connections).values(row).run();
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

  await db.update(connections)
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
  await db.update(connections)
    .set({ status: "disconnected", lastCheckedAt: Date.now() })
    .where(eq(connections.id, connection.id))
    .run();
}
