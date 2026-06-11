/**
 * The connector fabric boundary. Nango implements this over REST; tests use
 * fakes. Credentials never pass beyond this boundary into Tuezday's DB.
 */

export interface FabricHealth {
  healthy: boolean;
  detail?: string;
}

export type ImportCredentials =
  | { type: "API_KEY"; apiKey: string }
  | { type: "BASIC"; username: string; password: string }
  | { type: "NONE" };

export interface ProxyResult {
  status: number;
  bodySnippet: string;
}

export interface ProxyJsonResult {
  status: number;
  /** Parsed response body; undefined when the upstream reply is not JSON. */
  json: unknown;
}

export class ConnectorFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorFabricError";
  }
}

export interface ConnectorFabric {
  health(): Promise<FabricHealth>;
  /** Create the integration (provider config) if it does not exist yet. */
  ensureIntegration(uniqueKey: string, provider: string): Promise<void>;
  importConnection(
    providerConfigKey: string,
    connectionId: string,
    credentials: ImportCredentials,
    connectionConfig?: Record<string, string>,
  ): Promise<void>;
  connectionExists(connectionId: string, providerConfigKey: string): Promise<boolean>;
  deleteConnection(connectionId: string, providerConfigKey: string): Promise<void>;
  proxyGet(
    path: string,
    connectionId: string,
    providerConfigKey: string,
    baseUrlOverride?: string,
  ): Promise<ProxyResult>;
  /** Full-body JSON proxy for provider API calls (CRM reads/writes). */
  proxyJson(
    method: "GET" | "POST",
    path: string,
    connectionId: string,
    providerConfigKey: string,
    opts?: { body?: unknown; baseUrlOverride?: string },
  ): Promise<ProxyJsonResult>;
}
