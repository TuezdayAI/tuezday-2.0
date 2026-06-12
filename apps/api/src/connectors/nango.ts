import {
  ConnectorFabricError,
  type ConnectorFabric,
  type FabricHealth,
  type ImportCredentials,
  type IntegrationOAuthCredentials,
  type ProxyJsonResult,
  type ProxyResult,
} from "./fabric";

type Fetcher = typeof fetch;

/** Nango REST implementation. Self-hosted via infra/nango/compose.yaml. */
export class NangoFabric implements ConnectorFabric {
  private readonly baseUrl: string;
  private readonly secretKey: string | undefined;

  constructor(
    baseUrl?: string,
    secretKey?: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    const fromEnv = process.env.NANGO_BASE_URL?.trim();
    this.baseUrl = (baseUrl ?? (fromEnv || "http://localhost:3050")).replace(/\/$/, "");
    this.secretKey = secretKey ?? process.env.NANGO_SECRET_KEY;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.secretKey}`, ...extra };
  }

  async health(): Promise<FabricHealth> {
    if (!this.secretKey) {
      return { healthy: false, detail: "NANGO_SECRET_KEY is not set in the root .env." };
    }
    try {
      const res = await this.fetcher(`${this.baseUrl}/integrations`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 401) {
        return { healthy: false, detail: "Nango rejected the secret key (401)." };
      }
      if (!res.ok) return { healthy: false, detail: `Nango returned ${res.status}.` };
      return { healthy: true };
    } catch {
      return {
        healthy: false,
        detail: `Nango is not reachable at ${this.baseUrl}. Start it with "npm run nango:up".`,
      };
    }
  }

  async ensureIntegration(
    uniqueKey: string,
    provider: string,
    oauth?: IntegrationOAuthCredentials,
  ): Promise<void> {
    const credentials = oauth
      ? {
          credentials: {
            type: "OAUTH2",
            client_id: oauth.clientId,
            client_secret: oauth.clientSecret,
            scopes: oauth.scopes,
          },
        }
      : {};

    const existing = await this.fetcher(`${this.baseUrl}/integrations/${uniqueKey}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (existing.ok) {
      // Keep the OAuth app creds current (the founder may rotate them in
      // .env). Best-effort: older Nango builds without PATCH still work.
      if (oauth) {
        await this.fetcher(`${this.baseUrl}/integrations/${uniqueKey}`, {
          method: "PATCH",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify(credentials),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      return;
    }

    const res = await this.fetcher(`${this.baseUrl}/integrations`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ unique_key: uniqueKey, provider, ...credentials }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Tolerate races where the integration appeared between the two calls.
      if (/exist/i.test(body)) return;
      throw new ConnectorFabricError(
        `Nango could not create integration "${uniqueKey}" (${res.status}): ${body.slice(0, 200)}`,
      );
    }
  }

  async createConnectSession(integrationKey: string, endUserId: string): Promise<{ token: string }> {
    const res = await this.fetcher(`${this.baseUrl}/connect/sessions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        end_user: { id: endUserId },
        allowed_integrations: [integrationKey],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ConnectorFabricError(
        `Nango could not create a connect session (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    let token: string | undefined;
    try {
      token = (JSON.parse(text) as { data?: { token?: string } }).data?.token;
    } catch {
      token = undefined;
    }
    if (!token) {
      throw new ConnectorFabricError("Nango's connect session response had no token.");
    }
    return { token };
  }

  async importConnection(
    providerConfigKey: string,
    connectionId: string,
    credentials: ImportCredentials,
    connectionConfig?: Record<string, string>,
  ): Promise<void> {
    // OAuth2 token imports: Nango's import endpoint reads snake_case
    // access_token while proxy templates interpolate ${accessToken} — send
    // both casings (extra keys are harmless on import).
    const wireCredentials =
      credentials.type === "OAUTH2"
        ? { type: "OAUTH2", access_token: credentials.accessToken, accessToken: credentials.accessToken }
        : credentials;
    const res = await this.fetcher(`${this.baseUrl}/connections`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        provider_config_key: providerConfigKey,
        connection_id: connectionId,
        credentials: wireCredentials,
        ...(connectionConfig ? { connection_config: connectionConfig } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConnectorFabricError(
        `Nango could not import the connection (${res.status}): ${body.slice(0, 200)}`,
      );
    }
  }

  async connectionExists(connectionId: string, providerConfigKey: string): Promise<boolean> {
    const res = await this.fetcher(
      `${this.baseUrl}/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerConfigKey)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    return res.ok;
  }

  async deleteConnection(connectionId: string, providerConfigKey: string): Promise<void> {
    const res = await this.fetcher(
      `${this.baseUrl}/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerConfigKey)}`,
      { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok && res.status !== 404) {
      throw new ConnectorFabricError(`Nango could not delete the connection (${res.status}).`);
    }
  }

  async proxyGet(
    path: string,
    connectionId: string,
    providerConfigKey: string,
    baseUrlOverride?: string,
  ): Promise<ProxyResult> {
    const res = await this.fetcher(`${this.baseUrl}/proxy${path}`, {
      headers: this.headers({
        "Connection-Id": connectionId,
        "Provider-Config-Key": providerConfigKey,
        ...(baseUrlOverride ? { "Base-Url-Override": baseUrlOverride } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, bodySnippet: body.slice(0, 300) };
  }

  async proxyJson(
    method: "GET" | "POST",
    path: string,
    connectionId: string,
    providerConfigKey: string,
    opts: {
      body?: unknown;
      form?: Record<string, string>;
      headers?: Record<string, string>;
      baseUrlOverride?: string;
    } = {},
  ): Promise<ProxyJsonResult> {
    const wireBody =
      opts.form !== undefined
        ? new URLSearchParams(opts.form).toString()
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined;
    const contentType =
      opts.form !== undefined
        ? "application/x-www-form-urlencoded"
        : opts.body !== undefined
          ? "application/json"
          : undefined;
    const res = await this.fetcher(`${this.baseUrl}/proxy${path}`, {
      method,
      headers: this.headers({
        "Connection-Id": connectionId,
        "Provider-Config-Key": providerConfigKey,
        ...(opts.baseUrlOverride ? { "Base-Url-Override": opts.baseUrlOverride } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...(opts.headers ?? {}),
      }),
      ...(wireBody !== undefined ? { body: wireBody } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }
}
