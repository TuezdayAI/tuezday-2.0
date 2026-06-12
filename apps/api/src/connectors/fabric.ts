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
  /** A pasted OAuth access token (e.g. a Meta system-user token). */
  | { type: "OAUTH2"; accessToken: string }
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

/** OAuth app credentials provisioned on the integration (never stored here). */
export interface IntegrationOAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Comma-separated scope list. */
  scopes: string;
}

export interface ConnectorFabric {
  health(): Promise<FabricHealth>;
  /**
   * Create the integration (provider config) if it does not exist yet. With
   * `oauth` given, a new integration carries the OAuth app credentials and an
   * existing one gets them refreshed (best-effort).
   */
  ensureIntegration(
    uniqueKey: string,
    provider: string,
    oauth?: IntegrationOAuthCredentials,
  ): Promise<void>;
  /**
   * Mint a connect-session token for the browser OAuth popup. The popup
   * reports back the connection id Nango generated.
   */
  createConnectSession(integrationKey: string, endUserId: string): Promise<{ token: string }>;
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
  /**
   * Full-body proxy for provider API calls. `body` is sent as JSON; `form`
   * is sent url-encoded (Reddit's submit endpoint is form-only). `headers`
   * adds provider requirements like Reddit's descriptive User-Agent.
   */
  proxyJson(
    method: "GET" | "POST",
    path: string,
    connectionId: string,
    providerConfigKey: string,
    opts?: {
      body?: unknown;
      form?: Record<string, string>;
      headers?: Record<string, string>;
      baseUrlOverride?: string;
    },
  ): Promise<ProxyJsonResult>;
}
