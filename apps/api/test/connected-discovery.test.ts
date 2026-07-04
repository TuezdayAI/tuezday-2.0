import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { connections, discoveryJobs, discoverySources } from "../src/db/schema";
import type { Fetcher } from "../src/discovery/adapters";
import type { LlmGateway } from "../src/llm/gateway";
import { RATE_LIMIT_BACKOFF_BASE_MS, listDiscoverySources } from "../src/services/discovery";
import { buildAuthedApp, createTestDb } from "./helpers";

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

// ---------------------------------------------------------------------------
// Fakes: a fetcher that records keyless URLs and a fabric that records
// proxied provider calls, both programmable per test.
// ---------------------------------------------------------------------------

const EMPTY_RSS = '<rss version="2.0"><channel><title>t</title></channel></rss>';

function rssWith(title: string, description: string, link: string): string {
  return `<rss version="2.0"><channel><title>t</title><item><title>${title}</title><description>${description}</description><link>${link}</link><guid>${link}</guid></item></channel></rss>`;
}

interface ProxyCall {
  method: string;
  path: string;
  connectionId: string;
  integrationKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

type ProxyHandler = (path: string) => ProxyJsonResult | undefined;

function makeFakeFabric(getHandler: () => ProxyHandler) {
  const calls: ProxyCall[] = [];
  const fabric: ConnectorFabric = {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "session-token" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: "{}" };
    },
    async proxyJson(method, path, connectionId, providerConfigKey, opts) {
      calls.push({
        method,
        path,
        connectionId,
        integrationKey: providerConfigKey,
        baseUrl: opts?.baseUrlOverride,
        headers: opts?.headers,
      });
      const res = getHandler()(path);
      if (!res) throw new Error(`Unexpected proxy call in test: ${path}`);
      return res;
    },
  };
  return { fabric, calls };
}

// X API fixtures ------------------------------------------------------------

const X_SEARCH_FIXTURE = {
  data: [
    {
      id: "1801",
      text: "Acme raises $10M Series A to build agentic GTM tooling",
      created_at: "2026-07-01T10:00:00Z",
      author_id: "u1",
      public_metrics: { like_count: 12, retweet_count: 3, reply_count: 1 },
    },
    { id: "1802", text: "Unattributed take on GTM automation", author_id: "u2" },
  ],
  includes: { users: [{ id: "u1", username: "acme" }] },
};

const REDDIT_LISTING_FIXTURE = {
  data: {
    children: [
      {
        kind: "t3",
        data: {
          id: "abc",
          name: "t3_abc",
          title: "Anyone using agentic GTM tools?",
          selftext: "Looking for recommendations before Q3 planning.",
          permalink: "/r/startups/comments/abc/anyone/",
          created_utc: 1_751_600_000,
        },
      },
    ],
  },
};

describe("connected discovery (Sprint 46)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let proxyHandler: ProxyHandler;
  let proxyCalls: ProxyCall[];
  let fetchedUrls: string[];
  let feedXml: string;

  beforeEach(async () => {
    db = createTestDb();
    proxyHandler = () => undefined;
    fetchedUrls = [];
    feedXml = EMPTY_RSS;
    const { fabric, calls } = makeFakeFabric(() => proxyHandler);
    proxyCalls = calls;
    const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
      fetchedUrls.push(String(url));
      return new Response(feedXml, { status: 200 });
    }) as Fetcher;
    app = await buildAuthedApp({ db, llm: stubLlm, fetcher, connectors: fabric });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Connected" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  function insertConnection(
    providerKey: string,
    status: "connected" | "disconnected" = "connected",
    wsId = workspaceId,
  ): string {
    const id = randomUUID();
    const now = Date.now();
    db.insert(connections)
      .values({
        id,
        workspaceId: wsId,
        providerKey,
        nangoConnectionId: `nango-${providerKey}-${id.slice(0, 8)}`,
        configJson: "{}",
        displayName: providerKey,
        externalAccountId: null,
        externalAccountName: null,
        externalAccountHandle: null,
        externalAccountUrl: null,
        status,
        lastCheckedAt: now,
        lastError: null,
        contentProfileJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  async function createSource(payload: Record<string, unknown>, expectStatus = 201) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/sources`,
      payload,
    });
    expect(res.statusCode, res.body).toBe(expectStatus);
    return res.json();
  }

  async function runDiscoveryRoute() {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/discovery/run` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      queued: number;
      processed: number;
      sources: { sourceId: string; name: string; fetched: number; new: number; error?: string }[];
      scored: number;
    };
  }

  async function listItems(status?: string) {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/discovery/items${status ? `?status=${status}` : ""}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Array<Record<string, unknown>>;
  }

  function sourceRow(sourceId: string) {
    return db.select().from(discoverySources).where(eq(discoverySources.id, sourceId)).get()!;
  }

  function jobsFor(sourceId: string) {
    return db.select().from(discoveryJobs).where(eq(discoveryJobs.sourceId, sourceId)).all();
  }

  // -------------------------------------------------------------------------
  // Tracked social accounts
  // -------------------------------------------------------------------------

  describe("tracked social accounts", () => {
    const base = () => `/workspaces/${workspaceId}/discovery/tracked-accounts`;

    it("creates accounts with normalized handles and rejects duplicates with 409", async () => {
      const created = await app.inject({
        method: "POST",
        url: base(),
        payload: { platform: "x", handle: "@RivalCo", displayName: "Rival Co" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ platform: "x", handle: "rivalco", enabled: true });

      // "@RivalCo" and "rivalco" are the same account
      const dupe = await app.inject({
        method: "POST",
        url: base(),
        payload: { platform: "x", handle: "rivalco" },
      });
      expect(dupe.statusCode).toBe(409);
      expect(dupe.json().error).toBe("duplicate_account");

      // the same handle on another platform is a different account
      const otherPlatform = await app.inject({
        method: "POST",
        url: base(),
        payload: { platform: "instagram", handle: "@rivalco" },
      });
      expect(otherPlatform.statusCode).toBe(201);

      // reddit strips the r/ prefix
      const subreddit = await app.inject({
        method: "POST",
        url: base(),
        payload: { platform: "reddit", handle: "r/Startups" },
      });
      expect(subreddit.json().handle).toBe("startups");
    });

    it("scopes the list to the workspace", async () => {
      await app.inject({ method: "POST", url: base(), payload: { platform: "x", handle: "rival" } });
      const otherWs = (
        await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Other" } })
      ).json().id;
      const otherList = await app.inject({
        method: "GET",
        url: `/workspaces/${otherWs}/discovery/tracked-accounts`,
      });
      expect(otherList.json()).toEqual([]);
      const list = await app.inject({ method: "GET", url: base() });
      expect(list.json()).toHaveLength(1);
    });

    it("updates and deletes accounts, keeping the uniqueness guarantee", async () => {
      const a = (
        await app.inject({ method: "POST", url: base(), payload: { platform: "x", handle: "one" } })
      ).json();
      const b = (
        await app.inject({ method: "POST", url: base(), payload: { platform: "x", handle: "two" } })
      ).json();

      const renamedIntoClash = await app.inject({
        method: "PATCH",
        url: `${base()}/${b.id}`,
        payload: { handle: "@One" },
      });
      expect(renamedIntoClash.statusCode).toBe(409);

      const disabled = await app.inject({
        method: "PATCH",
        url: `${base()}/${b.id}`,
        payload: { enabled: false, notes: "paused" },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ enabled: false, notes: "paused" });

      expect(
        (await app.inject({ method: "DELETE", url: `${base()}/${a.id}` })).statusCode,
      ).toBe(204);
      expect(
        (await app.inject({ method: "DELETE", url: `${base()}/${a.id}` })).statusCode,
      ).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Source connection validation
  // -------------------------------------------------------------------------

  describe("source connection validation", () => {
    it("requires a connection for connected-only source configs", async () => {
      const res = await createSource(
        { type: "instagram", config: { mode: "hashtag", hashtag: "buildinpublic" } },
        400,
      );
      expect(res.error).toBe("connection_required");

      const xConnected = await createSource(
        { type: "x", config: { mode: "query", query: "agentic gtm" } },
        400,
      );
      expect(xConnected.error).toBe("connection_required");
    });

    it("rejects a connection from the wrong provider", async () => {
      const redditConnection = insertConnection("reddit");
      const res = await createSource(
        { type: "x", config: { mode: "query", query: "gtm" }, connectionId: redditConnection },
        400,
      );
      expect(res.error).toBe("wrong_provider");

      const rss = await createSource(
        { type: "rss", config: { feedUrl: "https://a.dev/f.xml" }, connectionId: redditConnection },
        400,
      );
      expect(rss.error).toBe("wrong_provider");
    });

    it("rejects disconnected and unknown connections", async () => {
      const stale = insertConnection("twitter", "disconnected");
      const res = await createSource(
        { type: "x", config: { mode: "query", query: "gtm" }, connectionId: stale },
        400,
      );
      expect(res.error).toBe("connection_disconnected");

      const missing = await createSource(
        { type: "x", config: { mode: "query", query: "gtm" }, connectionId: randomUUID() },
        400,
      );
      expect(missing.error).toBe("connection_required");
    });

    it("creates an active connected source with a matching connection", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "agentic gtm" },
        connectionId,
      });
      expect(source).toMatchObject({ type: "x", status: "active", connectionId });
      // keyless x sources still park as needs_api_key
      const keyless = await createSource({ type: "x", config: { query: "agentic gtm" } });
      expect(keyless.status).toBe("needs_api_key");
    });

    it("validates connection changes on update too", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      const detach = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { connectionId: null },
      });
      expect(detach.statusCode).toBe(400);
      expect(detach.json().error).toBe("connection_required");
    });
  });

  // -------------------------------------------------------------------------
  // X connected sources
  // -------------------------------------------------------------------------

  describe("connected X sources", () => {
    it("fetches recent search results into discovered items", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "agentic gtm" },
        connectionId,
      });
      proxyHandler = (path) =>
        path.startsWith("/2/tweets/search/recent")
          ? { status: 200, json: X_SEARCH_FIXTURE }
          : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources).toEqual([
        expect.objectContaining({ sourceId: source.id, fetched: 2, new: 2 }),
      ]);

      const search = proxyCalls.find((c) => c.path.startsWith("/2/tweets/search/recent"))!;
      expect(search.path).toContain(`query=${encodeURIComponent("agentic gtm")}`);
      expect(search.integrationKey).toBe("tuezday-twitter");
      expect(search.baseUrl).toBe("https://api.twitter.com");

      const items = await listItems("new");
      expect(items).toHaveLength(2);
      const attributed = items.find((i) => i.externalId === "x:1801")!;
      expect(attributed.url).toBe("https://x.com/acme/status/1801");
      expect(attributed.title).toContain("Acme raises $10M");
      expect(attributed.summary).toContain("12 likes");
      expect(attributed.publishedAt).toBe(Date.parse("2026-07-01T10:00:00Z"));
      const unattributed = items.find((i) => i.externalId === "x:1802")!;
      expect(unattributed.url).toBe("https://x.com/i/web/status/1802");
    });

    it("resolves a tracked account handle before fetching its timeline", async () => {
      const connectionId = insertConnection("twitter");
      const tracked = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/tracked-accounts`,
          payload: { platform: "x", handle: "@RivalCo" },
        })
      ).json();
      await createSource({
        type: "x",
        config: { mode: "account_timeline", trackedAccountId: tracked.id },
        connectionId,
      });
      proxyHandler = (path) => {
        if (path === "/2/users/by/username/rivalco") {
          return { status: 200, json: { data: { id: "u9", username: "rivalco" } } };
        }
        if (path.startsWith("/2/users/u9/tweets")) {
          return {
            status: 200,
            json: { data: [{ id: "42", text: "We shipped a thing", created_at: "2026-07-03T08:00:00Z" }] },
          };
        }
        return undefined;
      };

      const run = await runDiscoveryRoute();
      expect(run.sources[0]).toMatchObject({ fetched: 1, new: 1 });
      // handle resolution happens before the timeline fetch
      expect(proxyCalls.map((c) => c.path.split("?")[0])).toEqual([
        "/2/users/by/username/rivalco",
        "/2/users/u9/tweets",
      ]);
      const [item] = await listItems("new");
      expect(item!.externalId).toBe("x:42");
      expect(item!.url).toBe("https://x.com/rivalco/status/42");
    });

    it("backs off exponentially on 429 without erroring the source", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      proxyHandler = () => ({ status: 429, json: {} });

      const before = Date.now();
      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toBe("rate_limited");

      const row = sourceRow(source.id);
      expect(row.status).toBe("active"); // rate limits are not source errors
      expect(row.backoffUntil).toBeGreaterThanOrEqual(before + RATE_LIMIT_BACKOFF_BASE_MS);
      expect(jobsFor(source.id).at(-1)).toMatchObject({ status: "failed", error: "rate_limited" });

      // while in backoff the source is not even enqueued
      const skipped = await runDiscoveryRoute();
      expect(skipped.queued).toBe(0);
      expect(skipped.processed).toBe(0);

      // a second consecutive rate limit doubles the wait
      db.update(discoverySources)
        .set({ backoffUntil: null })
        .where(eq(discoverySources.id, source.id))
        .run();
      const secondBefore = Date.now();
      await runDiscoveryRoute();
      expect(sourceRow(source.id).backoffUntil).toBeGreaterThanOrEqual(
        secondBefore + 2 * RATE_LIMIT_BACKOFF_BASE_MS,
      );
    });

    it("converts a 403 on list timelines into a permission_required source error", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "list_timeline", listId: "789" },
        connectionId,
      });
      proxyHandler = (path) =>
        path.startsWith("/2/lists/789/tweets") ? { status: 403, json: {} } : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toContain("permission_required");
      const row = sourceRow(source.id);
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("permission_required");
      expect(row.lastError).toContain("list.read");
    });
  });

  // -------------------------------------------------------------------------
  // Reddit: connected uses OAuth, keyless keeps RSS
  // -------------------------------------------------------------------------

  describe("reddit sources", () => {
    it("routes a connected subreddit source through OAuth and keyless through RSS", async () => {
      const connectionId = insertConnection("reddit");
      const connected = await createSource({
        type: "reddit",
        config: { subreddit: "startups" },
        connectionId,
      });
      const keyless = await createSource({ type: "reddit", config: { subreddit: "saas" } });

      proxyHandler = (path) =>
        path.startsWith("/r/startups/new") ? { status: 200, json: REDDIT_LISTING_FIXTURE } : undefined;

      const run = await runDiscoveryRoute();
      const connectedResult = run.sources.find((s) => s.sourceId === connected.id)!;
      expect(connectedResult).toMatchObject({ fetched: 1, new: 1 });
      expect(run.sources.find((s) => s.sourceId === keyless.id)!.error).toBeUndefined();

      // connected went through the fabric with Reddit's OAuth host...
      const oauthCall = proxyCalls.find((c) => c.path.startsWith("/r/startups/new"))!;
      expect(oauthCall.baseUrl).toBe("https://oauth.reddit.com");
      expect(oauthCall.integrationKey).toBe("tuezday-reddit");
      expect(oauthCall.headers?.["User-Agent"]).toContain("tuezday-discovery");
      // ...and never hit the public RSS endpoint
      expect(fetchedUrls.some((u) => u.includes("startups"))).toBe(false);
      // the keyless source still fetched RSS and never used the fabric
      expect(fetchedUrls.some((u) => u.includes("/r/saas/new.rss"))).toBe(true);

      const items = await listItems("new");
      const post = items.find((i) => i.externalId === "t3_abc")!;
      expect(post.url).toBe("https://www.reddit.com/r/startups/comments/abc/anyone/");
      expect(post.title).toBe("Anyone using agentic GTM tools?");
      expect(post.publishedAt).toBe(1_751_600_000_000);
    });
  });

  // -------------------------------------------------------------------------
  // LinkedIn + Instagram permission gating
  // -------------------------------------------------------------------------

  describe("permission-gated providers", () => {
    it("marks only the LinkedIn source as permission_required while others succeed", async () => {
      const connectionId = insertConnection("linkedin");
      const linkedin = await createSource({
        type: "linkedin",
        config: { mode: "account_timeline", handle: "urn:li:person:ME" },
        connectionId,
      });
      const rss = await createSource({ type: "rss", config: { feedUrl: "https://ok.dev/f.xml" } });

      proxyHandler = (path) =>
        path.startsWith("/rest/posts")
          ? { status: 403, json: { message: "Not enough permissions" } }
          : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources.find((s) => s.sourceId === rss.id)!.error).toBeUndefined();
      expect(run.sources.find((s) => s.sourceId === linkedin.id)!.error).toContain(
        "permission_required",
      );

      const row = sourceRow(linkedin.id);
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("permission_required");
      expect(row.lastError).toContain("LinkedIn read scope or author role required");
      expect(jobsFor(rss.id).at(-1)!.status).toBe("succeeded");
      expect(jobsFor(linkedin.id).at(-1)!.status).toBe("failed");
    });

    it("marks an Instagram source permission_required when Meta refuses access", async () => {
      const connectionId = insertConnection("instagram");
      const instagram = await createSource({
        type: "instagram",
        config: { mode: "hashtag", hashtag: "buildinpublic" },
        connectionId,
      });
      proxyHandler = (path) =>
        path.includes("/me/accounts")
          ? { status: 403, json: { error: { message: "Requires instagram_basic" } } }
          : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toContain("permission_required");
      const row = sourceRow(instagram.id);
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("Instagram professional account or app review required");
    });

    it("fetches Instagram business-discovery media when access exists", async () => {
      const connectionId = insertConnection("instagram");
      await createSource({
        type: "instagram",
        config: { mode: "account_timeline", handle: "@rivalco" },
        connectionId,
      });
      proxyHandler = (path) => {
        if (path.includes("/me/accounts")) {
          return { status: 200, json: { data: [{ instagram_business_account: { id: "ig1" } }] } };
        }
        if (path.includes("business_discovery")) {
          return {
            status: 200,
            json: {
              business_discovery: {
                media: {
                  data: [
                    {
                      id: "9001",
                      caption: "Launch day!",
                      permalink: "https://www.instagram.com/p/xyz/",
                      timestamp: "2026-07-02T12:00:00+0000",
                      like_count: 5,
                      comments_count: 2,
                    },
                  ],
                },
              },
            },
          };
        }
        return undefined;
      };

      const run = await runDiscoveryRoute();
      expect(run.sources[0]).toMatchObject({ fetched: 1, new: 1 });
      const [item] = await listItems("new");
      expect(item!.externalId).toBe("ig:9001");
      expect(item!.url).toBe("https://www.instagram.com/p/xyz/");
      expect(item!.summary).toContain("5 likes");
    });
  });

  // -------------------------------------------------------------------------
  // Run integration: disconnection, dedup and accept
  // -------------------------------------------------------------------------

  describe("run integration", () => {
    it("fails a source whose connection was disconnected after setup", async () => {
      const connectionId = insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      db.update(connections)
        .set({ status: "disconnected" })
        .where(eq(connections.id, connectionId))
        .run();

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toBe("connection_disconnected");
      expect(sourceRow(source.id)).toMatchObject({
        status: "error",
        lastError: "connection_disconnected",
      });
    });

    it("links the same story from connected X and keyless Google News to one canonical item", async () => {
      const story = "Acme raises $10M Series A to build agentic GTM tooling";
      const connectionId = insertConnection("twitter");
      await createSource({
        type: "x",
        config: { mode: "query", query: "acme" },
        connectionId,
      });
      await createSource({ type: "google_news", config: { query: "acme" } });

      feedXml = rssWith(story, story, "https://news.example.com/acme-series-a");
      proxyHandler = (path) =>
        path.startsWith("/2/tweets/search/recent")
          ? {
              status: 200,
              json: { data: [{ id: "77", text: story, author_id: "u1" }] },
            }
          : undefined;

      const run = await runDiscoveryRoute();
      expect(run.processed).toBe(2);

      const fresh = await listItems("new");
      const duplicates = await listItems("duplicate");
      expect(fresh).toHaveLength(1);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]!.duplicateOfId).toBe(fresh[0]!.id);
      expect(fresh[0]!.duplicateCount).toBe(1);
    });

    it("accepts a connected item into a signal with the x source attribution", async () => {
      const connectionId = insertConnection("twitter");
      await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      proxyHandler = (path) =>
        path.startsWith("/2/tweets/search/recent")
          ? { status: 200, json: X_SEARCH_FIXTURE }
          : undefined;
      await runDiscoveryRoute();

      const [item] = await listItems("new");
      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${item!.id}/accept`,
      });
      expect(accepted.statusCode).toBe(200);
      const body = accepted.json();
      expect(body.item.status).toBe("accepted");
      expect(body.signal.source).toBe("x");
      expect(body.signal.sourceUrl).toBe(item!.url);
    });
  });
});
