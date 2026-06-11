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
  ): Promise<void>;
  connectionExists(connectionId: string, providerConfigKey: string): Promise<boolean>;
  deleteConnection(connectionId: string, providerConfigKey: string): Promise<void>;
  proxyGet(
    path: string,
    connectionId: string,
    providerConfigKey: string,
    baseUrlOverride?: string,
  ): Promise<ProxyResult>;
}
