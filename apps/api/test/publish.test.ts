import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicationSchema, validateSocialPost } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import {
  ConnectorFabricError,
  type ConnectorFabric,
  type ProxyJsonResult,
} from "../src/connectors/fabric";
import { RedditAdapter } from "../src/connectors/social/reddit";
import { NangoFabric } from "../src/connectors/nango";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated post text.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

// ---------------------------------------------------------------------------
// Fake fabric with an in-memory Reddit behind the proxy
// ---------------------------------------------------------------------------

interface RedditPost {
  sr: string;
  title: string;
  text: string;
  kind: string;
  api_type: string;
}

interface RedditState {
  posts: RedditPost[];
  nextId: number;
  /** When set, the proxy returns this HTTP status with an error body. */
  failStatus: number | null;
  /** When set, /api/submit returns 200 with these in-band errors. */
  inBandErrors: string[][] | null;
}

interface FabricState {
  healthy: boolean;
  integrations: Set<string>;
  /** OAuth credentials recorded per integration key by ensureIntegration. */
  integrationOAuth: Map<string, { clientId: string; clientSecret: string; scopes: string }>;
  sessions: Array<{ integrationKey: string; endUserId: string }>;
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  proxyStatus: number;
  reddit: RedditState;
}

function redditState(): RedditState {
  return { posts: [], nextId: 1, failStatus: null, inBandErrors: null };
}

function fabricState(): FabricState {
  return {
    healthy: true,
    integrations: new Set(),
    integrationOAuth: new Map(),
    sessions: [],
    connections: new Map(),
    proxyStatus: 200,
    reddit: redditState(),
  };
}

function handleReddit(
  state: RedditState,
  method: string,
  path: string,
  form: Record<string, string> | undefined,
): ProxyJsonResult {
  if (state.failStatus) return { status: state.failStatus, json: { message: "boom" } };

  if (method === "POST" && path.startsWith("/api/submit")) {
    if (state.inBandErrors) {
      return { status: 200, json: { json: { errors: state.inBandErrors, data: {} } } };
    }
    const post: RedditPost = {
      sr: form?.sr ?? "",
      title: form?.title ?? "",
      text: form?.text ?? "",
      kind: form?.kind ?? "",
      api_type: form?.api_type ?? "",
    };
    const id = state.nextId++;
    state.posts.push(post);
    return {
      status: 200,
      json: {
        json: {
          errors: [],
          data: {
            name: `t3_post${id}`,
            url: `https://www.reddit.com/r/${post.sr}/comments/post${id}/x/`,
          },
        },
      },
    };
  }
  if (method === "GET" && path.startsWith("/api/v1/me")) {
    return { status: 200, json: { name: "tuezday_founder" } };
  }
  return { status: 404, json: { message: "no such endpoint" } };
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
    async importConnection(providerConfigKey, connectionId, credentials) {
      state.connections.set(connectionId, { providerConfigKey, credentials });
    },
    async connectionExists(connectionId) {
      return state.connections.has(connectionId);
    },
    async deleteConnection(connectionId) {
      state.connections.delete(connectionId);
    },
    async proxyGet() {
      return { status: state.proxyStatus, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, opts) {
      return handleReddit(state.reddit, method, path, opts?.form);
    },
  };
}

// ---------------------------------------------------------------------------
// Contracts: per-platform constraint validation
// ---------------------------------------------------------------------------

describe("validateSocialPost", () => {
  it("accepts a valid reddit post", () => {
    const result = validateSocialPost("reddit", { target: "test", title: "Hello", body: "World" });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects a missing target and title", () => {
    const result = validateSocialPost("reddit", { target: "  ", title: "", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.field).sort()).toEqual(["target", "title"]);
  });

  it("enforces reddit length limits (title 300, body 40000)", () => {
    const atLimit = validateSocialPost("reddit", {
      target: "test",
      title: "t".repeat(300),
      body: "b".repeat(40_000),
    });
    expect(atLimit.ok).toBe(true);

    const over = validateSocialPost("reddit", {
      target: "test",
      title: "t".repeat(301),
      body: "b".repeat(40_001),
    });
    expect(over.ok).toBe(false);
    expect(over.violations.map((v) => v.field).sort()).toEqual(["body", "title"]);
  });

  it("rejects unknown platforms", () => {
    const result = validateSocialPost("myspace", { target: "x", title: "y", body: "z" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NangoFabric request shapes for the Sprint 17 additions
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetcher(
  recorded: RecordedRequest[],
  respond: (req: RecordedRequest) => Response,
): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    };
    recorded.push(req);
    return respond(req);
  }) as typeof fetch;
}

describe("NangoFabric (Sprint 17 additions)", () => {
  const oauth = { clientId: "cid", clientSecret: "csecret", scopes: "identity,submit" };

  it("creates a missing integration with OAuth credentials", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, (req) =>
        req.method === "GET" ? new Response("{}", { status: 404 }) : new Response("{}", { status: 200 }),
      ),
    );
    await fabric.ensureIntegration("tuezday-reddit", "reddit", oauth);
    const create = recorded.find((r) => r.method === "POST")!;
    expect(create.url).toBe("http://nango.test/integrations");
    expect(JSON.parse(create.body)).toEqual({
      unique_key: "tuezday-reddit",
      provider: "reddit",
      credentials: {
        type: "OAUTH2",
        client_id: "cid",
        client_secret: "csecret",
        scopes: "identity,submit",
      },
    });
  });

  it("refreshes credentials with PATCH when the integration exists, tolerating failure", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, (req) =>
        req.method === "PATCH" ? new Response("nope", { status: 400 }) : new Response("{}", { status: 200 }),
      ),
    );
    await expect(fabric.ensureIntegration("tuezday-reddit", "reddit", oauth)).resolves.toBeUndefined();
    const patch = recorded.find((r) => r.method === "PATCH")!;
    expect(patch.url).toBe("http://nango.test/integrations/tuezday-reddit");
    expect(JSON.parse(patch.body).credentials.client_id).toBe("cid");
  });

  it("creates a connect session and returns the token", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(
        recorded,
        () => new Response(JSON.stringify({ data: { token: "tok-123" } }), { status: 201 }),
      ),
    );
    const session = await fabric.createConnectSession("tuezday-reddit", "ws-42");
    expect(session.token).toBe("tok-123");
    const req = recorded[0]!;
    expect(req.url).toBe("http://nango.test/connect/sessions");
    expect(JSON.parse(req.body)).toEqual({
      end_user: { id: "ws-42" },
      allowed_integrations: ["tuezday-reddit"],
    });
  });

  it("proxies form bodies url-encoded with custom headers", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response('{"ok":true}', { status: 200 })),
    );
    const result = await fabric.proxyJson("POST", "/api/submit", "conn-1", "tuezday-reddit", {
      form: { sr: "test", title: "Hello & welcome" },
      headers: { "User-Agent": "web:tuezday:v0.1" },
      baseUrlOverride: "https://oauth.reddit.com",
    });
    expect(result.status).toBe(200);
    const req = recorded[0]!;
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(req.headers["User-Agent"]).toBe("web:tuezday:v0.1");
    expect(req.headers["Base-Url-Override"]).toBe("https://oauth.reddit.com");
    expect(req.body).toBe(new URLSearchParams({ sr: "test", title: "Hello & welcome" }).toString());
  });
});

// ---------------------------------------------------------------------------
// RedditAdapter
// ---------------------------------------------------------------------------

interface RecordedProxyCall {
  method: string;
  path: string;
  opts?: { form?: Record<string, string>; headers?: Record<string, string>; baseUrlOverride?: string };
}

function adapterFor(state: RedditState, calls: RecordedProxyCall[] = []): RedditAdapter {
  const fabric = {
    async proxyJson(
      method: "GET" | "POST",
      path: string,
      _c: string,
      _k: string,
      opts?: RecordedProxyCall["opts"],
    ) {
      calls.push({ method, path, opts });
      return handleReddit(state, method, path, opts?.form);
    },
  } as unknown as ConnectorFabric;
  return new RedditAdapter(fabric, {
    nangoConnectionId: "nango-conn-1",
    integrationKey: "tuezday-reddit",
  });
}

describe("RedditAdapter", () => {
  it("submits a self post with the right form shape and headers", async () => {
    const state = redditState();
    const calls: RecordedProxyCall[] = [];
    const result = await adapterFor(state, calls).publishPost({
      target: "r/test",
      title: "Hello",
      body: "World",
    });
    expect(result.externalId).toBe("t3_post1");
    expect(result.url).toBe("https://www.reddit.com/r/test/comments/post1/x/");
    expect(state.posts).toEqual([
      { sr: "test", title: "Hello", text: "World", kind: "self", api_type: "json" },
    ]);
    const call = calls[0]!;
    expect(call.opts?.baseUrlOverride).toBe("https://oauth.reddit.com");
    expect(call.opts?.headers?.["User-Agent"]).toContain("tuezday");
    expect(call.opts?.form?.resubmit).toBe("true");
  });

  it("raises ConnectorFabricError on in-band reddit errors", async () => {
    const state = redditState();
    state.inBandErrors = [["SUBREDDIT_NOEXIST", "that community does not exist", "sr"]];
    await expect(
      adapterFor(state).publishPost({ target: "nope", title: "T", body: "B" }),
    ).rejects.toThrow(/SUBREDDIT_NOEXIST/);
  });

  it("raises ConnectorFabricError on non-2xx responses", async () => {
    const state = redditState();
    state.failStatus = 403;
    await expect(
      adapterFor(state).publishPost({ target: "test", title: "T", body: "B" }),
    ).rejects.toThrow(ConnectorFabricError);
  });
});

// ---------------------------------------------------------------------------
// OAuth connect flow + publish API (routes + services over the fake fabric)
// ---------------------------------------------------------------------------

interface ReceivedHook {
  url: string;
  body: string;
  eventType: string | null;
}

function webhookFetcher(received: ReceivedHook[]): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    received.push({
      url: String(url),
      body: String(init?.body ?? ""),
      eventType: headers["X-Tuezday-Event"] ?? null,
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

describe("social publishing API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FabricState;
  let received: ReceivedHook[];

  beforeEach(async () => {
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "csecret");
    state = fabricState();
    received = [];
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: fakeLlm,
      connectors: fakeFabric(state),
      fetcher: webhookFetcher(received),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Publisher" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await app.close();
  });

  /** Simulate the popup: Nango creates the connection, then we complete. */
  async function connectReddit(nangoConnectionId = `nango-${Math.random().toString(36).slice(2)}`): Promise<{ id: string }> {
    const session = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
    });
    expect(session.statusCode).toBe(200);
    state.connections.set(nangoConnectionId, {
      providerConfigKey: "tuezday-reddit",
      credentials: { type: "OAUTH2" },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json();
  }

  async function createPersona(name = "CEO") {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function assignSocialAccount(
    personaId: string,
    connectionId: string,
    channel = "reddit",
    isPrimary = true,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${personaId}/social-accounts`,
      payload: { connectionId, channel, isPrimary },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function approvedDraft(opts: { personaId?: string; channel?: string } = {}): Promise<string> {
    const generationId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: {
          taskType: "linkedin_post",
          channel: opts.channel ?? "linkedin",
          personaId: opts.personaId,
        },
      })
    ).json().id;
    const draftId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
      })
    ).json().id;
    const approve = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
    });
    expect(approve.statusCode).toBe(200);
    return draftId;
  }

  async function publish(draftId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/publish`,
      payload,
    });
  }

  function listPublications() {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
      .then((r) => r.json());
  }

  describe("OAuth connect flow", () => {
    it("reports oauthConfigured on the registry listing", async () => {
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const providers = res.json().providers as Array<Record<string, unknown>>;
      const reddit = providers.find((p) => p.key === "reddit")!;
      expect(reddit.oauthConfigured).toBe(true);
      expect(reddit.categories).toEqual(["social"]);
    });

    it("refuses a session for a non-oauth provider", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/freshsales/oauth/session`,
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a session when the OAuth app env is missing", async () => {
      vi.stubEnv("REDDIT_CLIENT_ID", "");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("needs_oauth_app");
    });

    it("provisions the integration with OAuth creds and returns a session token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toMatch(/^session-token-/);
      expect(body.integrationKey).toBe("tuezday-reddit");
      expect(typeof body.nangoBaseUrl).toBe("string");
      expect(state.integrationOAuth.get("tuezday-reddit")).toEqual({
        clientId: "cid",
        clientSecret: "csecret",
        // `read` (Sprint 46) + `history` (Sprint 36.7: read the user's own posts
        // for the onboarding brain draft).
        scopes: "identity,submit,read,history",
      });
      expect(state.sessions[0]).toEqual({ integrationKey: "tuezday-reddit", endUserId: workspaceId });
    });

    it("completes a connection the popup created", async () => {
      const connection = await connectReddit();
      expect(connection).toMatchObject({ providerKey: "reddit", status: "connected" });
    });

    it("refuses completion for a connection Nango does not know", async () => {
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/reddit/oauth/complete`,
        payload: { connectionId: "nango-unknown" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("reconnects as a new row after disconnect", async () => {
      const first = await connectReddit();
      await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/connections/${first.id}`,
      });
      const second = await connectReddit();
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ status: "connected" });
      const view = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const redditRows = view
        .json()
        .connections.filter((c: { providerKey: string }) => c.providerKey === "reddit");
      expect(redditRows).toHaveLength(2);
    });
  });

  describe("publish now", () => {
    it("posts an approved draft to reddit and records the receipt", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const res = await publish(draftId, {
        connectionId: connection.id,
        target: "test",
        title: "Generated post",
      });
      expect(res.statusCode).toBe(201);
      const publication = res.json();
      expect(publicationSchema.safeParse(publication).success).toBe(true);
      expect(publication).toMatchObject({
        draftId,
        providerKey: "reddit",
        target: "test",
        title: "Generated post",
        status: "published",
        externalId: "t3_post1",
      });
      expect(publication.externalUrl).toContain("reddit.com/r/test");
      expect(publication.publishedAt).toBeGreaterThan(0);
      expect(state.reddit.posts[0]).toMatchObject({
        sr: "test",
        title: "Generated post",
        text: "Generated post text.",
      });
    });

    it("emits post.published to subscribed webhooks", async () => {
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/webhooks`,
        payload: { url: "https://hooks.example/x", eventTypes: ["post.published"] },
      });
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      const hook = received.find((h) => h.eventType === "post.published");
      expect(hook).toBeDefined();
      const payload = JSON.parse(hook!.body);
      expect(payload.payload).toMatchObject({ draftId, providerKey: "reddit", target: "test" });
      expect(payload.payload.url).toContain("reddit.com");
    });

    it("refuses drafts that are not approved", async () => {
      const connection = await connectReddit();
      const generationId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json().id;
      const draftId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${generationId}/submit`,
        })
      ).json().id;
      const res = await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("draft_not_approved");
      expect(state.reddit.posts).toHaveLength(0);
    });

    it("refuses connections that are not social-capable", async () => {
      // Connect the no-auth custom provider — valid connection, wrong category.
      const custom = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/custom/connect`,
        payload: { baseUrl: "https://api.example.com" },
      });
      expect(custom.statusCode).toBe(201);
      const draftId = await approvedDraft();
      const res = await publish(draftId, {
        connectionId: custom.json().id,
        target: "test",
        title: "T",
      });
      expect(res.statusCode).toBe(400);
    });

    it("blocks persona drafts from publishing through unassigned accounts", async () => {
      const persona = await createPersona("CEO");
      const assigned = await connectReddit("nango-reddit-ceo");
      const unassigned = await connectReddit("nango-reddit-other");
      await assignSocialAccount(persona.id, assigned.id, "reddit", true);
      const draftId = await approvedDraft({ personaId: persona.id, channel: "linkedin" });

      const res = await publish(draftId, {
        connectionId: unassigned.id,
        target: "test",
        title: "Wrong account",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("persona_account_mismatch");
    });

    it("gates on platform constraints before anything leaves", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const res = await publish(draftId, {
        connectionId: connection.id,
        target: "test",
        title: "t".repeat(301),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("publish_validation");
      expect(res.json().violations.some((v: { field: string }) => v.field === "title")).toBe(true);
      expect(state.reddit.posts).toHaveLength(0);
    });

    it("refuses a duplicate live publication for the same draft+connection+target", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      const dupe = await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      expect(dupe.statusCode).toBe(409);
      expect(dupe.json().error).toBe("already_published");
      // A different subreddit is a different publication.
      const other = await publish(draftId, { connectionId: connection.id, target: "other", title: "T" });
      expect(other.statusCode).toBe(201);
    });

    it("records adapter failures as a failed receipt and allows retry", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      state.reddit.inBandErrors = [["RATELIMIT", "slow down", "ratelimit"]];
      const res = await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      expect(res.statusCode).toBe(201);
      const failed = res.json();
      expect(failed.status).toBe("failed");
      expect(failed.lastError).toContain("RATELIMIT");
      expect(failed.externalUrl).toBeNull();

      state.reddit.inBandErrors = null;
      const retry = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/publications/${failed.id}/retry`,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ status: "published", externalId: "t3_post1" });
    });

    it("refuses retrying a publication that is not failed", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const publication = (
        await publish(draftId, { connectionId: connection.id, target: "test", title: "T" })
      ).json();
      const retry = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/publications/${publication.id}/retry`,
      });
      expect(retry.statusCode).toBe(409);
    });
  });

  describe("scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-12T10:00:00Z"));
    });

    it("stores a future publish as scheduled and fires it when due", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const due = Date.now() + 60_000;
      const res = await publish(draftId, {
        connectionId: connection.id,
        target: "test",
        title: "Later",
        scheduledFor: due,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ status: "scheduled", scheduledFor: due });
      expect(state.reddit.posts).toHaveLength(0);

      // Not due yet — the run is a no-op.
      const early = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/publish/run`,
      });
      expect(early.json().results).toEqual([]);

      vi.setSystemTime(new Date(due + 1000));
      const run = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/publish/run`,
      });
      expect(run.json().results).toEqual([{ id: res.json().id, ok: true }]);
      expect(state.reddit.posts).toHaveLength(1);
      const [publication] = await listPublications();
      expect(publication).toMatchObject({ status: "published", title: "Later" });
    });

    it("rejects a scheduledFor in the past", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const res = await publish(draftId, {
        connectionId: connection.id,
        target: "test",
        title: "T",
        scheduledFor: Date.now() - 1000,
      });
      expect(res.statusCode).toBe(400);
    });

    it("records per-row failures during a run without aborting it", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const due = Date.now() + 60_000;
      const scheduled = (
        await publish(draftId, {
          connectionId: connection.id,
          target: "test",
          title: "T",
          scheduledFor: due,
        })
      ).json();
      state.reddit.failStatus = 500;
      vi.setSystemTime(new Date(due + 1000));
      const run = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/publish/run`,
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().results[0]).toMatchObject({ id: scheduled.id, ok: false });
      const [publication] = await listPublications();
      expect(publication.status).toBe("failed");
      expect(publication.lastError).toBeTruthy();
    });

    it("cancels a scheduled publication, and only a scheduled one", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      const scheduled = (
        await publish(draftId, {
          connectionId: connection.id,
          target: "test",
          title: "T",
          scheduledFor: Date.now() + 60_000,
        })
      ).json();
      const cancel = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/publications/${scheduled.id}`,
      });
      expect(cancel.statusCode).toBe(204);
      expect(await listPublications()).toEqual([]);

      const published = (
        await publish(draftId, { connectionId: connection.id, target: "test", title: "T" })
      ).json();
      expect(published.status).toBe("published");
      const refuse = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/publications/${published.id}`,
      });
      expect(refuse.statusCode).toBe(409);
    });
  });

  describe("listing", () => {
    it("returns publications newest-first with their draft", async () => {
      const connection = await connectReddit();
      const draftId = await approvedDraft();
      await publish(draftId, { connectionId: connection.id, target: "test", title: "T" });
      const [publication] = await listPublications();
      expect(publication.draft).toMatchObject({
        id: draftId,
        taskType: "linkedin_post",
        content: "Generated post text.",
      });
    });
  });
});
