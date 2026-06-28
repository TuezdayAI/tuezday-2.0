import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_PROVIDERS } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { ConnectorFabricError, type ConnectorFabric } from "../src/connectors/fabric";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

// The three social providers this sprint adds, with the env vars that make
// each connectable and the scopes provisioned now for Sprint 26.
const SOCIAL = [
  {
    key: "linkedin",
    label: "LinkedIn",
    nangoProvider: "linkedin",
    idEnv: "LINKEDIN_CLIENT_ID",
    secretEnv: "LINKEDIN_CLIENT_SECRET",
    scopes: "openid,profile,email,w_member_social",
  },
  {
    key: "twitter",
    label: "X (Twitter)",
    nangoProvider: "twitter-v2",
    idEnv: "TWITTER_CLIENT_ID",
    secretEnv: "TWITTER_CLIENT_SECRET",
    scopes: "tweet.read,tweet.write,users.read,dm.read,dm.write,offline.access",
  },
  {
    key: "instagram",
    label: "Instagram",
    nangoProvider: "facebook",
    idEnv: "INSTAGRAM_CLIENT_ID",
    secretEnv: "INSTAGRAM_CLIENT_SECRET",
    scopes:
      "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management",
  },
] as const;

// ---------------------------------------------------------------------------
// Contracts: the registry shape (no app needed)
// ---------------------------------------------------------------------------

describe("social provider registry", () => {
  it("registers linkedin, twitter and instagram as verified-ready oauth social providers", () => {
    for (const expected of SOCIAL) {
      const provider = CONNECTOR_PROVIDERS.find((p) => p.key === expected.key);
      expect(provider, `${expected.key} missing from CONNECTOR_PROVIDERS`).toBeDefined();
      expect(provider!.authMode).toBe("oauth");
      expect(provider!.categories).toEqual(["social"]);
      expect(provider!.nangoProvider).toBe(expected.nangoProvider);
      // A verifiable identity endpoint so a connection can be health-checked.
      expect(provider!.baseUrl).toMatch(/^https:\/\//);
      expect(provider!.testPath).toMatch(/^\//);
      // Scopes are provisioned now (used in Sprint 26) — non-empty and
      // well-formed: comma-separated tokens, no stray whitespace.
      expect(provider!.oauthScopes).toBe(expected.scopes);
      const tokens = provider!.oauthScopes!.split(",");
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token).not.toBe("");
        expect(token).toBe(token.trim());
        expect(token).not.toMatch(/\s/);
      }
    }
  });

  it("labels twitter as X while keeping the nango-matching key", () => {
    const twitter = CONNECTOR_PROVIDERS.find((p) => p.key === "twitter")!;
    expect(twitter.label).toBe("X (Twitter)");
    expect(twitter.nangoProvider).toBe("twitter-v2");
  });

  it("keeps reddit registered but parked (no removal)", () => {
    const reddit = CONNECTOR_PROVIDERS.find((p) => p.key === "reddit");
    expect(reddit).toBeDefined();
    expect(reddit!.authMode).toBe("oauth");
  });
});

// ---------------------------------------------------------------------------
// Fake fabric: records OAuth provisioning + knows which connections exist
// ---------------------------------------------------------------------------

interface FabricState {
  healthy: boolean;
  integrations: Set<string>;
  integrationOAuth: Map<string, { clientId: string; clientSecret: string; scopes: string }>;
  sessions: Array<{ integrationKey: string; endUserId: string }>;
  connections: Map<string, { providerConfigKey: string }>;
  proxyStatus: number;
}

function fabricState(): FabricState {
  return {
    healthy: true,
    integrations: new Set(),
    integrationOAuth: new Map(),
    sessions: [],
    connections: new Map(),
    proxyStatus: 200,
  };
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return state.healthy ? { healthy: true } : { healthy: false, detail: "nango is down" };
    },
    async ensureIntegration(uniqueKey, _provider, oauth) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      state.integrations.add(uniqueKey);
      if (oauth) state.integrationOAuth.set(uniqueKey, oauth);
    },
    async createConnectSession(integrationKey, endUserId) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      state.sessions.push({ integrationKey, endUserId });
      return { token: `session-token-${state.sessions.length}` };
    },
    async importConnection(providerConfigKey, connectionId) {
      state.connections.set(connectionId, { providerConfigKey });
    },
    async connectionExists(connectionId) {
      return state.connections.has(connectionId);
    },
    async deleteConnection(connectionId) {
      state.connections.delete(connectionId);
    },
    async proxyGet() {
      return { status: state.proxyStatus, bodySnippet: '{"sub":"member-123"}' };
    },
    async proxyJson() {
      return { status: state.proxyStatus, json: { ok: true } };
    },
  };
}

// ---------------------------------------------------------------------------
// The generic OAuth routes, exercised through the three new providers
// ---------------------------------------------------------------------------

describe("connect social API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FabricState;

  function stubSocialEnv() {
    for (const s of SOCIAL) {
      vi.stubEnv(s.idEnv, "cid");
      vi.stubEnv(s.secretEnv, "csecret");
    }
  }

  beforeEach(async () => {
    state = fabricState();
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: fakeLlm,
      connectors: fakeFabric(state),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Social" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  function providers() {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
      .then((r) => r.json().providers as Array<Record<string, unknown>>);
  }

  /** Simulate the popup: Nango creates the connection, then we complete. */
  async function connect(providerKey: string): Promise<{ id: string; status: string }> {
    const session = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/session`,
    });
    expect(session.statusCode, `session for ${providerKey}: ${session.body}`).toBe(200);
    const nangoConnectionId = `nango-${providerKey}-${Math.random().toString(36).slice(2)}`;
    state.connections.set(nangoConnectionId, { providerConfigKey: `tuezday-${providerKey}` });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode, `complete for ${providerKey}: ${complete.body}`).toBe(201);
    return complete.json();
  }

  describe("registry listing", () => {
    it("shows the three as needs-oauth-app until creds exist, parked reddit too", async () => {
      const list = await providers();
      for (const s of SOCIAL) {
        const p = list.find((x) => x.key === s.key)!;
        expect(p, `${s.key} not listed`).toBeDefined();
        expect(p.oauthConfigured).toBe(false);
        expect(p.label).toBe(s.label);
      }
      // Reddit's app key hasn't been issued — it stays parked, not removed.
      expect(list.find((x) => x.key === "reddit")!.oauthConfigured).toBe(false);
    });

    it("flips oauthConfigured to true once each app's env creds are set", async () => {
      stubSocialEnv();
      const list = await providers();
      for (const s of SOCIAL) {
        expect(list.find((x) => x.key === s.key)!.oauthConfigured).toBe(true);
      }
    });
  });

  describe("oauth/session", () => {
    it("refuses with 409 needs_oauth_app when the app env is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/session`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("needs_oauth_app");
    });

    it("provisions each integration with its own scopes and returns a session token", async () => {
      stubSocialEnv();
      for (const s of SOCIAL) {
        const res = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/connectors/${s.key}/oauth/session`,
        });
        expect(res.statusCode, `${s.key}: ${res.body}`).toBe(200);
        const body = res.json();
        expect(body.token).toMatch(/^session-token-/);
        expect(body.integrationKey).toBe(`tuezday-${s.key}`);
        expect(typeof body.nangoBaseUrl).toBe("string");
        expect(state.integrationOAuth.get(`tuezday-${s.key}`)).toEqual({
          clientId: "cid",
          clientSecret: "csecret",
          scopes: s.scopes,
        });
        expect(state.sessions.at(-1)).toEqual({
          integrationKey: `tuezday-${s.key}`,
          endUserId: workspaceId,
        });
      }
    });
  });

  describe("oauth/complete", () => {
    it("registers a connected, identity-verified connection for each platform", async () => {
      stubSocialEnv();
      for (const s of SOCIAL) {
        const connection = await connect(s.key);
        expect(connection).toMatchObject({ providerKey: s.key, status: "connected" });
        // testConnection ran the identity proxy and kept it connected.
        const listed = await app
          .inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
          .then((r) => r.json().connections as Array<Record<string, unknown>>);
        const row = listed.find((c) => c.providerKey === s.key)!;
        expect(row.status).toBe("connected");
        expect(row.lastCheckedAt).toBeTruthy();
      }
    });

    it("keeps multiple OAuth accounts for the same social provider", async () => {
      stubSocialEnv();

      const firstSession = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/session`,
      });
      expect(firstSession.statusCode).toBe(200);

      state.connections.set("nango-linkedin-a", { providerConfigKey: "tuezday-linkedin" });
      const first = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
        payload: { connectionId: "nango-linkedin-a" },
      });
      expect(first.statusCode).toBe(201);

      state.connections.set("nango-linkedin-b", { providerConfigKey: "tuezday-linkedin" });
      const second = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
        payload: { connectionId: "nango-linkedin-b" },
      });
      expect(second.statusCode).toBe(201);

      const view = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const linkedInConnections = view
        .json()
        .connections.filter((c: { providerKey: string }) => c.providerKey === "linkedin");
      expect(linkedInConnections).toHaveLength(2);
    });

    it("treats the same OAuth Nango connection id as idempotent", async () => {
      stubSocialEnv();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/session`,
      });
      state.connections.set("nango-linkedin-repeat", { providerConfigKey: "tuezday-linkedin" });

      const first = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
        payload: { connectionId: "nango-linkedin-repeat" },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
        payload: { connectionId: "nango-linkedin-repeat" },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);

      const view = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const linkedInConnections = view
        .json()
        .connections.filter((c: { providerKey: string }) => c.providerKey === "linkedin");
      expect(linkedInConnections).toHaveLength(1);
    });

    it("updates an OAuth connection display name", async () => {
      stubSocialEnv();
      const connection = await connect("linkedin");

      const patched = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/connections/${connection.id}`,
        payload: { displayName: "  Founder LinkedIn  " },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().displayName).toBe("Founder LinkedIn");

      const view = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const linkedIn = view
        .json()
        .connections.find((c: { id: string }) => c.id === connection.id);
      expect(linkedIn.displayName).toBe("Founder LinkedIn");

      const invalid = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/connections/${connection.id}`,
        payload: { displayName: "  " },
      });
      expect(invalid.statusCode).toBe(400);

      const otherWorkspaceId = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
      ).json().id;
      const crossWorkspace = await app.inject({
        method: "PATCH",
        url: `/workspaces/${otherWorkspaceId}/connections/${connection.id}`,
        payload: { displayName: "Wrong workspace" },
      });
      expect(crossWorkspace.statusCode).toBe(404);
    });

    it("refuses completion for a connection Nango does not know", async () => {
      stubSocialEnv();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/session`,
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/linkedin/oauth/complete`,
        payload: { connectionId: "nango-unknown" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("connection_unknown");
    });
  });

  describe("health + disconnect", () => {
    it("flips connected/error from the proxied identity status", async () => {
      stubSocialEnv();
      const connection = await connect("twitter");
      const ok = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connections/${connection.id}/test`,
      });
      expect(ok.json().ok).toBe(true);

      state.proxyStatus = 401;
      const bad = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connections/${connection.id}/test`,
      });
      expect(bad.json().ok).toBe(false);
      const row = (
        await app
          .inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
          .then((r) => r.json())
      ).connections.find((c: { providerKey: string }) => c.providerKey === "twitter");
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("401");
    });

    it("disconnects to 204 then reconnects as a new row", async () => {
      stubSocialEnv();
      const first = await connect("instagram");
      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/connections/${first.id}`,
      });
      expect(del.statusCode).toBe(204);
      const afterDelete = (
        await app
          .inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
          .then((r) => r.json())
      ).connections.find((c: { providerKey: string }) => c.providerKey === "instagram");
      expect(afterDelete.status).toBe("disconnected");

      const second = await connect("instagram");
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("connected");
      const afterReconnect = (
        await app
          .inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
          .then((r) => r.json())
      ).connections.filter((c: { providerKey: string }) => c.providerKey === "instagram");
      expect(afterReconnect).toHaveLength(2);
    });
  });

  describe("negative", () => {
    it("404s an unknown provider", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/tiktok/oauth/session`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("provider_not_found");
    });

    it("400 not_oauth when a non-oauth provider is pushed through the oauth route", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/smartlead/oauth/session`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("not_oauth");
    });
  });
});
