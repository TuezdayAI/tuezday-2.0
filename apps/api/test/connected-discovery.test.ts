import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Connection, DiscoverySource } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import {
  connections,
  discoveredItems,
  discoveryJobs,
  discoverySources,
  trackedSocialAccounts,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { RATE_LIMIT_BACKOFF_BASE_MS, listDiscoverySources } from "../src/services/discovery";
import {
  CursorInvalidError,
  fetchConnectedSourcePage,
} from "../src/discovery/connected-adapters";
import {
  emptyTargetCheckpoint,
  type DiscoveryTarget,
  type DiscoveryTargetCheckpoint,
} from "../src/discovery/paging";
import { buildAuthedApp, createTestDb } from "./helpers";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";

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

function paginationSource(
  type: DiscoverySource["type"],
  config: DiscoverySource["config"],
): DiscoverySource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    type,
    name: "Pagination",
    config,
    enabled: true,
    status: "active",
    lastError: null,
    lastFetchedAt: null,
    connectionId: "33333333-3333-4333-8333-333333333333",
    cursor: {
      version: 1,
      targetCount: 1,
      backlog: false,
      lastCheckpointAt: null,
    },
    backoffUntil: null,
    lastAttemptedAt: null,
    createdAt: 1,
  };
}

function paginationConnection(providerKey: string): Connection {
  const directInstagram = providerKey === "instagram";
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    providerKey,
    nangoConnectionId: "nango-pagination",
    config: directInstagram
      ? { authArchitecture: "instagram_login" }
      : {},
    displayName: providerKey,
    timezone: "UTC",
    externalAccountId: directInstagram ? "ig-user" : null,
    externalAccountName: null,
    externalAccountHandle: directInstagram ? "rival" : null,
    externalAccountUrl: null,
    status: "connected",
    lastCheckedAt: 1,
    lastError: null,
    contentProfile: { topics: [], guidance: "" },
    createdAt: 1,
    updatedAt: 1,
  };
}

function continuationCheckpoint(
  fingerprint: string,
  providerToken: string,
): DiscoveryTargetCheckpoint {
  return {
    ...emptyTargetCheckpoint(fingerprint),
    continuation: {
      providerToken,
      boundaryExternalId: null,
      newestExternalId: null,
      newestPublishedAt: null,
    },
  };
}

async function connectedPage(input: {
  source: DiscoverySource;
  providerKey: string;
  target?: DiscoveryTarget;
  checkpoint?: DiscoveryTargetCheckpoint;
  handler: ProxyHandler;
}) {
  const { fabric, calls } = makeFakeFabric(() => input.handler);
  const target = input.target ?? {
    key: "target",
    fingerprint: "fingerprint",
  };
  const page = await fetchConnectedSourcePage({
    source: input.source,
    connection: paginationConnection(input.providerKey),
    fabric,
    trackedAccounts: [],
    target,
    checkpoint:
      input.checkpoint ?? emptyTargetCheckpoint(target.fingerprint),
    signal: new AbortController().signal,
    maxItems: 25,
    maxCalls: 10,
    maxResponseBytes: 100_000,
    maxBytes: 500_000,
  });
  return { page, calls };
}

describe("connected provider pagination", () => {
  it.each([
    {
      label: "X search",
      providerKey: "twitter",
      source: paginationSource("x", {
        mode: "query",
        query: "agentic gtm",
      }),
      pathPrefix: "/2/tweets/search/recent",
      response: {
        data: [{ id: "x-1", text: "Newest" }],
        meta: { next_token: "x-next" },
      },
      expectedToken: "x-next",
      suppliedToken: "x-resume",
      tokenFragment: "pagination_token=x-resume",
    },
    {
      label: "Reddit",
      providerKey: "reddit",
      source: paginationSource("reddit", { subreddit: "startups" }),
      pathPrefix: "/r/startups/new",
      response: {
        data: {
          children: [
            {
              kind: "t3",
              data: { id: "one", name: "t3_one", title: "Newest" },
            },
          ],
          after: "t3_next",
        },
      },
      expectedToken: "t3_next",
      suppliedToken: "t3_resume",
      tokenFragment: "after=t3_resume",
    },
    {
      label: "LinkedIn",
      providerKey: "linkedin",
      source: paginationSource("linkedin", {
        mode: "account_timeline",
        handle: "urn:li:organization:123",
      }),
      pathPrefix: "/rest/posts",
      response: {
        elements: [{ id: "urn:li:share:1", commentary: "Newest" }],
        paging: { start: 0, count: 25, total: 60 },
      },
      expectedToken: "25",
      suppliedToken: "50",
      tokenFragment: "start=50",
    },
  ])(
    "maps $label provider cursors to the internal page contract",
    async (fixture) => {
      const first = await connectedPage({
        source: fixture.source,
        providerKey: fixture.providerKey,
        handler: (path) =>
          path.startsWith(fixture.pathPrefix)
            ? { status: 200, json: fixture.response }
            : undefined,
      });
      expect(first.page.nextToken).toBe(fixture.expectedToken);
      expect(first.page.exhausted).toBe(false);

      const resumed = await connectedPage({
        source: fixture.source,
        providerKey: fixture.providerKey,
        checkpoint: continuationCheckpoint(
          "fingerprint",
          fixture.suppliedToken,
        ),
        handler: (path) =>
          path.startsWith(fixture.pathPrefix)
            ? { status: 200, json: fixture.response }
            : undefined,
      });
      expect(resumed.calls.at(-1)!.path).toContain(
        fixture.tokenFragment,
      );
    },
  );

  it.each([
    {
      label: "account timeline",
      config: { mode: "account_timeline", handle: "rival" } as const,
      target: {
        key: "account",
        fingerprint: "account-fingerprint",
        handle: "rival",
        externalId: "user-9",
      },
      prefix: "/2/users/user-9/tweets",
    },
    {
      label: "list timeline",
      config: { mode: "list_timeline", listId: "list-9" } as const,
      target: {
        key: "list",
        fingerprint: "list-fingerprint",
      },
      prefix: "/2/lists/list-9/tweets",
    },
  ])("resumes an X $label", async ({ config, target, prefix }) => {
    const resumed = await connectedPage({
      source: paginationSource("x", config),
      providerKey: "twitter",
      target,
      checkpoint: continuationCheckpoint(
        target.fingerprint,
        "x-page-2",
      ),
      handler: (path) =>
        path.startsWith(prefix)
          ? {
              status: 200,
              json: {
                data: [{ id: "x-2", text: "Older" }],
                meta: { next_token: "x-page-3" },
              },
            }
          : undefined,
    });
    expect(resumed.calls.at(-1)!.path).toContain(
      "pagination_token=x-page-2",
    );
    expect(resumed.page.nextToken).toBe("x-page-3");
  });

  it("resumes direct Instagram own-account media through Graph cursors", async () => {
    const config = {
      mode: "account_timeline" as const,
      handle: "rival",
    };
    const target: DiscoveryTarget = {
      key: config.mode,
      fingerprint: `${config.mode}-fingerprint`,
      handle: config.handle,
    };
    const resumed = await connectedPage({
      source: paginationSource("instagram", config),
      providerKey: "instagram",
      target,
      checkpoint: continuationCheckpoint(
        target.fingerprint,
        "ig-page-2",
      ),
      handler: (path) => {
        if (path.startsWith("/ig-user/media")) {
          return {
            status: 200,
            json: {
              data: [{ id: "ig-2", caption: "Older" }],
              paging: { cursors: { after: "ig-page-3" } },
            },
          };
        }
        return undefined;
      },
    });
    expect(resumed.calls.at(-1)!.path).toContain("after=ig-page-2");
    expect(resumed.calls.at(-1)!.baseUrl).toBe(
      "https://graph.instagram.com",
    );
    expect(resumed.calls.map((call) => call.path).join(" ")).not.toContain(
      "/me/accounts",
    );
    expect(resumed.page.nextToken).toBe("ig-page-3");
  });

  it("stops at the durable boundary and excludes older rows", async () => {
    const target = { key: "query", fingerprint: "query-fingerprint" };
    const checkpoint = emptyTargetCheckpoint(target.fingerprint);
    checkpoint.highWatermark = {
      externalId: "x:old-boundary",
      publishedAt: 1,
    };
    const result = await connectedPage({
      source: paginationSource("x", { mode: "query", query: "gtm" }),
      providerKey: "twitter",
      target,
      checkpoint,
      handler: () => ({
        status: 200,
        json: {
          data: [
            { id: "new", text: "New" },
            { id: "old-boundary", text: "Boundary" },
            { id: "older", text: "Older" },
          ],
          meta: { next_token: "must-not-continue" },
        },
      }),
    });
    expect(result.page.items.map((item) => item.externalId)).toEqual([
      "x:new",
    ]);
    expect(result.page).toMatchObject({
      reachedBoundary: true,
      exhausted: true,
      nextToken: null,
    });
  });

  it("classifies a rejected continuation as an invalid cursor", async () => {
    await expect(
      await connectedPage({
        source: paginationSource("x", {
          mode: "query",
          query: "gtm",
        }),
        providerKey: "twitter",
        checkpoint: continuationCheckpoint(
          "fingerprint",
          "expired-token",
        ),
        handler: () => ({
          status: 400,
          json: { errors: [{ code: "invalid_cursor" }] },
        }),
      }),
    ).rejects.toBeInstanceOf(CursorInvalidError);
  });
});

describe("connected discovery (Sprint 46)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let proxyHandler: ProxyHandler;
  let proxyCalls: ProxyCall[];
  let fetchedUrls: string[];
  let feedXml: string;

  beforeEach(async () => {
    db = await createTestDb();
    proxyHandler = () => undefined;
    fetchedUrls = [];
    feedXml = EMPTY_RSS;
    const { fabric, calls } = makeFakeFabric(() => proxyHandler);
    proxyCalls = calls;
    const safeFetch = fixtureSafeFetch((request) => {
      fetchedUrls.push(request.url);
      return { body: feedXml, contentType: "application/xml" };
    });
    app = await buildAuthedApp({ db, llm: stubLlm, safeFetch, connectors: fabric });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Connected" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function insertConnection(
    providerKey: string,
    status: "connected" | "disconnected" = "connected",
    wsId = workspaceId,
  ): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await db.insert(connections)
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
      });
    return id;
  }

  async function insertDirectInstagramConnection(handle = "tuezday"): Promise<string> {
    const id = await insertConnection("instagram");
    await db.update(connections)
      .set({
        configJson: JSON.stringify({
          authArchitecture: "instagram_login",
        }),
        externalAccountId: "ig-direct-42",
        externalAccountHandle: handle,
      })
      .where(eq(connections.id, id));
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

  async function createTrackedAccount(
    wsId: string,
    platform: "x" | "linkedin" | "instagram" | "reddit",
    handle: string,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/discovery/tracked-accounts`,
      payload: { platform, handle },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; platform: string; handle: string };
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

  async function sourceRow(sourceId: string) {
    return ((await db.select().from(discoverySources).where(eq(discoverySources.id, sourceId)))[0])!;
  }

  async function jobsFor(sourceId: string) {
    return await db.select().from(discoveryJobs).where(eq(discoveryJobs.sourceId, sourceId));
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
      const redditConnection = await insertConnection("reddit");
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
      const stale = await insertConnection("twitter", "disconnected");
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

      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Connection Workspace" },
        })
      ).json().id as string;
      const foreignConnectionId = await insertConnection(
        "twitter",
        "connected",
        otherWorkspaceId,
      );
      const foreign = await createSource(
        {
          type: "x",
          config: { mode: "query", query: "gtm" },
          connectionId: foreignConnectionId,
        },
        400,
      );
      expect(foreign).toEqual(missing);
    });

    it("creates an active connected source with a matching connection", async () => {
      const connectionId = await insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "agentic gtm" },
        connectionId,
      });
      await db.update(discoverySources)
        .set({
          configJson: JSON.stringify({
            ...source.config,
            baseUrl: "http://169.254.169.254/latest/meta-data",
          }),
        })
        .where(eq(discoverySources.id, source.id));
      expect(source).toMatchObject({ type: "x", status: "active", connectionId });
      // keyless x sources still park as needs_api_key
      const keyless = await createSource({ type: "x", config: { query: "agentic gtm" } });
      expect(keyless.status).toBe("needs_api_key");
    });

    it("validates connection changes on update too", async () => {
      const connectionId = await insertConnection("twitter");
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

    it.each([
      ["query", { mode: "query" }, "A query-mode source needs a query"],
      [
        "account timeline",
        { mode: "account_timeline" },
        "An account_timeline source needs a handle or a tracked account",
      ],
      [
        "list timeline",
        { mode: "list_timeline" },
        "A list_timeline source needs a listId",
      ],
    ] as const)(
      "rejects a connected %s mode missing its target and preserves the row",
      async (_label, config, message) => {
        const connectionId = await insertConnection("twitter");
        const source = await createSource({
          type: "x",
          config: { mode: "query", query: "gtm" },
          connectionId,
        });

        const update = await app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
          payload: { config },
        });

        expect(update.statusCode).toBe(400);
        expect(update.json()).toEqual({ error: "invalid_input", message });
        expect(await sourceRow(source.id)).toMatchObject({
          configJson: JSON.stringify(source.config),
          connectionId,
        });
      },
    );

    it("rejects foreign, wrong-provider, and disconnected connection patches without mutation", async () => {
      const source = await createSource({
        type: "x",
        config: { query: "gtm" },
      });
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Patch Connection Workspace" },
        })
      ).json().id as string;
      const candidates = [
        {
          id: await insertConnection("twitter", "connected", otherWorkspaceId),
          error: "connection_required",
        },
        { id: await insertConnection("reddit"), error: "wrong_provider" },
        {
          id: await insertConnection("twitter", "disconnected"),
          error: "connection_disconnected",
        },
      ];

      for (const candidate of candidates) {
        const update = await app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
          payload: { connectionId: candidate.id },
        });
        expect(update.statusCode).toBe(400);
        expect(update.json().error).toBe(candidate.error);
        expect(await sourceRow(source.id)).toMatchObject({
          configJson: JSON.stringify(source.config),
          connectionId: null,
          status: "needs_api_key",
        });
      }
    });

    it("derives active and needs_api_key when attaching and detaching an optional connection", async () => {
      const source = await createSource({
        type: "x",
        config: { query: "gtm" },
      });
      const connectionId = await insertConnection("twitter");

      const attached = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { connectionId },
      });
      expect(attached.statusCode).toBe(200);
      expect(attached.json()).toMatchObject({
        connectionId,
        status: "active",
        lastError: null,
        backoffUntil: null,
      });

      const detached = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { connectionId: null },
      });
      expect(detached.statusCode).toBe(200);
      expect(detached.json()).toMatchObject({
        connectionId: null,
        status: "needs_api_key",
        lastError: null,
        backoffUntil: null,
      });
    });

    it("rejects foreign, unknown, mixed, and wrong-platform tracked IDs before create", async () => {
      const connectionId = await insertConnection("twitter");
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Tracked Accounts" },
        })
      ).json().id as string;
      const foreign = await createTrackedAccount(otherWorkspaceId, "x", "foreign-rival");
      const valid = await createTrackedAccount(workspaceId, "x", "valid-rival");
      const wrongPlatform = await createTrackedAccount(
        workspaceId,
        "instagram",
        "instagram-rival",
      );
      const submit = (config: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: {
            type: "x",
            config: { mode: "account_timeline", ...config },
            connectionId,
          },
        });

      const foreignResult = await submit({ trackedAccountId: foreign.id });
      const unknownResult = await submit({ trackedAccountId: randomUUID() });
      const mixedResult = await submit({
        trackedAccountIds: [valid.id, foreign.id],
      });
      const wrongPlatformResult = await submit({
        trackedAccountId: wrongPlatform.id,
      });

      for (const result of [
        foreignResult,
        unknownResult,
        mixedResult,
        wrongPlatformResult,
      ]) {
        expect(result.statusCode).toBe(404);
        expect(result.json()).toEqual({ error: "related_object_not_found" });
      }
      expect(foreignResult.json()).toEqual(unknownResult.json());
      expect(await listDiscoverySources(db, workspaceId)).toHaveLength(0);
    });

    it("rejects foreign and unknown tracked IDs on update without changing the source", async () => {
      const connectionId = await insertConnection("twitter");
      const valid = await createTrackedAccount(workspaceId, "x", "valid-update-rival");
      const source = await createSource({
        type: "x",
        config: { mode: "account_timeline", trackedAccountId: valid.id },
        connectionId,
      });
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Update Accounts" },
        })
      ).json().id as string;
      const foreign = await createTrackedAccount(otherWorkspaceId, "x", "foreign-update-rival");
      const update = (trackedAccountId: string) =>
        app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
          payload: {
            config: { mode: "account_timeline", trackedAccountId },
          },
        });

      const foreignResult = await update(foreign.id);
      const unknownResult = await update(randomUUID());

      expect(foreignResult.statusCode).toBe(404);
      expect(unknownResult.statusCode).toBe(404);
      expect(foreignResult.json()).toEqual({ error: "related_object_not_found" });
      expect(foreignResult.json()).toEqual(unknownResult.json());
      expect(await listDiscoverySources(db, workspaceId)).toEqual([
        expect.objectContaining({
          id: source.id,
          config: {
            mode: "account_timeline",
            trackedAccountId: valid.id,
          },
        }),
      ]);
    });

    it("fails connected fetch when a referenced tracked account becomes disabled", async () => {
      const connectionId = await insertConnection("twitter");
      const tracked = await createTrackedAccount(workspaceId, "x", "disabled-rival");
      const source = await createSource({
        type: "x",
        config: { mode: "account_timeline", trackedAccountId: tracked.id },
        connectionId,
      });
      const disabled = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/tracked-accounts/${tracked.id}`,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);

      const result = await runDiscoveryRoute();

      expect(result.sources).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          error: "related_object_not_found",
        }),
      ]);
      expect(proxyCalls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // X connected sources
  // -------------------------------------------------------------------------

  describe("connected X sources", () => {
    it("fetches recent search results into discovered items", async () => {
      const connectionId = await insertConnection("twitter");
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
      expect(search.baseUrl).not.toContain("169.254.169.254");

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
      const connectionId = await insertConnection("twitter");
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
      expect(
        (await db
          .select()
          .from(trackedSocialAccounts)
          .where(eq(trackedSocialAccounts.id, tracked.id)))[0],
      ).toMatchObject({
        externalId: "u9",
        lastResolvedAt: expect.any(Number),
        lastError: null,
      });
    });

    it("backs off exponentially on 429 without erroring the source", async () => {
      const connectionId = await insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      proxyHandler = () => ({ status: 429, json: {} });

      const before = Date.now();
      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toBe("rate_limited");

      const row = await sourceRow(source.id);
      expect(row.status).toBe("active"); // rate limits are not source errors
      expect(row.backoffUntil).toBeGreaterThanOrEqual(before + RATE_LIMIT_BACKOFF_BASE_MS);
      expect((await jobsFor(source.id)).at(-1)).toMatchObject({ status: "failed", error: "rate_limited" });

      // while in backoff the source is not even enqueued
      const skipped = await runDiscoveryRoute();
      expect(skipped.queued).toBe(0);
      expect(skipped.processed).toBe(0);

      // a second consecutive rate limit doubles the wait
      await db.update(discoverySources)
        .set({ backoffUntil: null })
        .where(eq(discoverySources.id, source.id));
      const secondBefore = Date.now();
      await runDiscoveryRoute();
      expect((await sourceRow(source.id)).backoffUntil).toBeGreaterThanOrEqual(
        secondBefore + 2 * RATE_LIMIT_BACKOFF_BASE_MS,
      );
    });

    it("converts a 403 on list timelines into a permission_required source error", async () => {
      const connectionId = await insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "list_timeline", listId: "789" },
        connectionId,
      });
      proxyHandler = (path) =>
        path.startsWith("/2/lists/789/tweets") ? { status: 403, json: {} } : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toContain("permission_required");
      const row = await sourceRow(source.id);
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
      const connectionId = await insertConnection("reddit");
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

    it("blocks a keyless fetch when its tracked account becomes disabled", async () => {
      const tracked = await createTrackedAccount(
        workspaceId,
        "reddit",
        "tracked-saas",
      );
      const source = await createSource({
        type: "reddit",
        config: {
          subreddit: "saas",
          trackedAccountId: tracked.id,
        },
      });
      const disabled = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/tracked-accounts/${tracked.id}`,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);

      const result = await runDiscoveryRoute();

      expect(result.sources).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          error: "related_object_not_found",
        }),
      ]);
      expect(fetchedUrls.some((url) => url.includes("/r/saas/"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // LinkedIn + Instagram permission gating
  // -------------------------------------------------------------------------

  describe("permission-gated providers", () => {
    it("resolves a plain LinkedIn company handle before fetching its posts", async () => {
      const connectionId = await insertConnection("linkedin");
      const tracked = await createTrackedAccount(
        workspaceId,
        "linkedin",
        "@Acme",
      );
      await createSource({
        type: "linkedin",
        config: {
          mode: "account_timeline",
          trackedAccountId: tracked.id,
        },
        connectionId,
      });
      proxyHandler = (path) => {
        if (path.startsWith("/rest/organizations")) {
          return {
            status: 200,
            json: {
              elements: [{ id: 73, vanityName: "Acme" }],
            },
          };
        }
        if (path.startsWith("/rest/posts")) {
          return {
            status: 200,
            json: {
              elements: [
                {
                  id: "urn:li:share:73",
                  commentary: "Company update",
                },
              ],
            },
          };
        }
        return undefined;
      };

      const run = await runDiscoveryRoute();

      expect(run.sources[0]).toMatchObject({ fetched: 1, new: 1 });
      expect(proxyCalls.map((call) => call.path.split("?")[0])).toEqual([
        "/rest/organizations",
        "/rest/posts",
      ]);
      expect(proxyCalls[1]!.path).toContain(
        `author=${encodeURIComponent("urn:li:organization:73")}`,
      );
      expect(proxyCalls[0]!.headers?.["LinkedIn-Version"]).toBe("202607");
      expect(proxyCalls[1]!.headers?.["LinkedIn-Version"]).toBe("202607");
      expect(
        (await db
          .select()
          .from(trackedSocialAccounts)
          .where(eq(trackedSocialAccounts.id, tracked.id)))[0],
      ).toMatchObject({
        externalId: "urn:li:organization:73",
        lastResolvedAt: expect.any(Number),
        lastError: null,
      });
    });

    it("fails an unresolvable LinkedIn handle without member or posts fallback", async () => {
      const connectionId = await insertConnection("linkedin");
      const source = await createSource({
        type: "linkedin",
        config: {
          mode: "account_timeline",
          handle: "missing-company",
        },
        connectionId,
      });
      proxyHandler = (path) =>
        path.startsWith("/rest/organizations")
          ? { status: 200, json: { elements: [] } }
          : undefined;

      const run = await runDiscoveryRoute();

      expect(run.sources[0]!.error).toContain("target_unresolvable");
      expect((await sourceRow(source.id)).lastError).toContain(
        "target_unresolvable",
      );
      expect(proxyCalls.map((call) => call.path)).toHaveLength(1);
      expect(proxyCalls[0]!.path).toContain("/rest/organizations");
      expect(proxyCalls.some((call) => call.path === "/v2/userinfo")).toBe(
        false,
      );
      expect(
        proxyCalls.some((call) => call.path.startsWith("/rest/posts")),
      ).toBe(false);
    });

    it("marks only the LinkedIn source as permission_required while others succeed", async () => {
      const connectionId = await insertConnection("linkedin");
      const linkedin = await createSource({
        type: "linkedin",
        config: {
          mode: "account_timeline",
          handle: "urn:li:organization:73",
        },
        connectionId,
      });
      const rss = await createSource({ type: "rss", config: { feedUrl: "https://ok.dev/f.xml" } });

      proxyHandler = (path) =>
        path.startsWith("/rest/posts")
          ? {
              status: 403,
              json: {
                message: "Not enough permissions",
                diagnostic: "provider-secret-must-not-escape",
              },
            }
          : undefined;

      const run = await runDiscoveryRoute();
      expect(run.sources.find((s) => s.sourceId === rss.id)!.error).toBeUndefined();
      expect(run.sources.find((s) => s.sourceId === linkedin.id)!.error).toContain(
        "permission_required",
      );

      const row = await sourceRow(linkedin.id);
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("permission_required");
      expect(row.lastError).toContain("LinkedIn read scope or author role required");
      expect((await jobsFor(rss.id)).at(-1)!.status).toBe("succeeded");
      expect((await jobsFor(linkedin.id)).at(-1)!.status).toBe("failed");
      expect(JSON.stringify(run)).not.toContain("provider-secret-must-not-escape");
      expect(row.lastError).not.toContain("provider-secret-must-not-escape");
      expect((await jobsFor(linkedin.id)).at(-1)!.error).not.toContain(
        "provider-secret-must-not-escape",
      );
    });

    it("fails legacy Instagram sources closed with reconnect_required", async () => {
      const connectionId = await insertConnection("instagram");
      const instagram = await createSource({
        type: "instagram",
        config: { mode: "hashtag", hashtag: "buildinpublic" },
        connectionId,
      });

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toContain("reconnect_required");
      const row = await sourceRow(instagram.id);
      expect(row.status).toBe("error");
      expect(row.lastError).toContain("reconnect_required");
    });

    it("rejects Instagram hashtag and competitor discovery with stable capability errors", async () => {
      const connectionId = await insertDirectInstagramConnection();
      const hashtag = await createSource({
        type: "instagram",
        config: { mode: "hashtag", hashtag: "buildinpublic" },
        connectionId,
      });
      const competitor = await createSource({
        type: "instagram",
        config: { mode: "account_timeline", handle: "@rivalco" },
        connectionId,
      });

      const run = await runDiscoveryRoute();
      expect(
        run.sources.find((source) => source.sourceId === hashtag.id)!.error,
      ).toContain("unsupported_mode");
      expect(
        run.sources.find((source) => source.sourceId === competitor.id)!
          .error,
      ).toContain("unsupported_target");
      expect(proxyCalls).toHaveLength(0);
    });

    it("fetches only the direct Instagram connection's own media", async () => {
      const connectionId = await insertDirectInstagramConnection();
      await createSource({
        type: "instagram",
        config: { mode: "account_timeline", handle: "@tuezday" },
        connectionId,
      });
      proxyHandler = (path) => {
        if (path.startsWith("/ig-direct-42/media")) {
          return {
            status: 200,
            json: {
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
      expect(proxyCalls[0]).toMatchObject({
        baseUrl: "https://graph.instagram.com",
      });
      expect(proxyCalls.map((call) => call.path).join(" ")).not.toContain(
        "/me/accounts",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Run integration: disconnection, dedup and accept
  // -------------------------------------------------------------------------

  describe("run integration", () => {
    it("fails a source whose connection was disconnected after setup", async () => {
      const connectionId = await insertConnection("twitter");
      const source = await createSource({
        type: "x",
        config: { mode: "query", query: "gtm" },
        connectionId,
      });
      await db.update(connections)
        .set({ status: "disconnected" })
        .where(eq(connections.id, connectionId));

      const run = await runDiscoveryRoute();
      expect(run.sources[0]!.error).toBe("connection_disconnected");
      expect(await sourceRow(source.id)).toMatchObject({
        status: "error",
        lastError: "connection_disconnected",
      });
    });

    it("links the same story from connected X and keyless Google News to one canonical item", async () => {
      const story = "Acme raises $10M Series A to build agentic GTM tooling";
      const connectionId = await insertConnection("twitter");
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
      const connectionId = await insertConnection("twitter");
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
      await db.update(discoveredItems)
        .set({ matchingState: "ready", matchingError: null })
        .where(eq(discoveredItems.id, item!.id as string));
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
