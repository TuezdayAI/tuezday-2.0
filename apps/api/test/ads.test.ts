import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adAccountSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import {
  ConnectorFabricError,
  type ConnectorFabric,
  type ProxyJsonResult,
} from "../src/connectors/fabric";
import { DEFAULT_CONVERSION_ACTIONS, MetaAdsAdapter } from "../src/connectors/ads/meta";
import { NangoFabric } from "../src/connectors/nango";
import type { LlmGateway } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "generated", model: "fake", provider: "fake", durationMs: 5 };
  },
};

// ---------------------------------------------------------------------------
// Fake fabric with an in-memory Graph API behind the proxy
// ---------------------------------------------------------------------------

interface GraphInsightRow {
  campaign_id: string;
  campaign_name: string;
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

interface GraphState {
  accounts: Array<{ id: string; name: string; currency: string }>;
  /** Insight rows per ad account id; filtered by the requested time_range. */
  insights: Record<string, GraphInsightRow[]>;
  /** Page size applied to both endpoints (drives cursor pagination). */
  perPage: number;
  /** When set, every proxied request returns this status with an error body. */
  failStatus: number | null;
  /** Recorded insights request paths (to assert query params). */
  insightRequests: string[];
}

function graphState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    accounts: [{ id: "act_111", name: "Tuezday Main", currency: "USD" }],
    insights: {},
    perPage: 100,
    failStatus: null,
    insightRequests: [],
    ...overrides,
  };
}

function paginate<T>(items: T[], state: GraphState, path: string): { data: T[]; paging?: unknown } {
  const after = Number(new URLSearchParams(path.split("?")[1] ?? "").get("after") ?? "0");
  const slice = items.slice(after, after + state.perPage);
  const nextOffset = after + state.perPage;
  if (nextOffset >= items.length) return { data: slice };
  return {
    data: slice,
    paging: { cursors: { after: String(nextOffset) }, next: "https://graph.facebook.com/next" },
  };
}

function handleGraph(state: GraphState, method: string, path: string): ProxyJsonResult {
  if (state.failStatus) {
    return { status: state.failStatus, json: { error: { message: "graph says no" } } };
  }
  if (method !== "GET") return { status: 405, json: { error: { message: "method" } } };

  if (path.startsWith("/v23.0/me/adaccounts")) {
    return { status: 200, json: paginate(state.accounts, state, path) };
  }
  const insightsMatch = /^\/v23\.0\/(act_\d+)\/insights/.exec(path);
  if (insightsMatch) {
    state.insightRequests.push(path);
    const params = new URLSearchParams(path.split("?")[1] ?? "");
    const range = JSON.parse(params.get("time_range") ?? "{}") as { since?: string; until?: string };
    const rows = (state.insights[insightsMatch[1]!] ?? []).filter(
      (r) => (!range.since || r.date_start >= range.since) && (!range.until || r.date_start <= range.until),
    );
    return { status: 200, json: paginate(rows, state, path) };
  }
  return { status: 404, json: { error: { message: "no such endpoint" } } };
}

interface FabricState {
  healthy: boolean;
  integrations: Set<string>;
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  proxyStatus: number;
  graph: GraphState;
}

function fabricState(graph: GraphState = graphState()): FabricState {
  return { healthy: true, integrations: new Set(), connections: new Map(), proxyStatus: 200, graph };
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return state.healthy ? { healthy: true } : { healthy: false, detail: "nango is down" };
    },
    async ensureIntegration(uniqueKey) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      state.integrations.add(uniqueKey);
    },
    async createConnectSession() {
      return { token: "session-token" };
    },
    async importConnection(providerConfigKey, connectionId, credentials) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
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
    async proxyJson(method, path) {
      return handleGraph(state.graph, method, path);
    },
  };
}

// ---------------------------------------------------------------------------
// NangoFabric OAUTH2 import wire shape
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetcher(recorded: RecordedRequest[], respond: () => Response): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    recorded.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return respond();
  }) as typeof fetch;
}

describe("NangoFabric OAUTH2 import (Sprint 14)", () => {
  it("sends the access token under Nango's snake_case key (camelCase kept for template interpolation)", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response("{}", { status: 200 })),
    );
    await fabric.importConnection("tuezday-meta_ads", "ws-1-meta_ads", {
      type: "OAUTH2",
      accessToken: "EAAB-token",
    });
    const body = JSON.parse(recorded[0]!.body);
    expect(body.credentials.type).toBe("OAUTH2");
    expect(body.credentials.access_token).toBe("EAAB-token");
    expect(body.credentials.accessToken).toBe("EAAB-token");
  });
});

// ---------------------------------------------------------------------------
// MetaAdsAdapter
// ---------------------------------------------------------------------------

function adapterFor(state: GraphState): MetaAdsAdapter {
  const fabric = {
    async proxyJson(method: "GET" | "POST", path: string) {
      return handleGraph(state, method, path);
    },
  } as unknown as ConnectorFabric;
  return new MetaAdsAdapter(fabric, {
    nangoConnectionId: "ws-1-meta_ads",
    integrationKey: "tuezday-meta_ads",
  });
}

function insightRow(overrides: Partial<GraphInsightRow> = {}): GraphInsightRow {
  return {
    campaign_id: "238",
    campaign_name: "Lead gen June",
    date_start: "2026-06-01",
    date_stop: "2026-06-01",
    spend: "12.34",
    impressions: "4000",
    clicks: "85",
    actions: [
      { action_type: "lead", value: "6" },
      // Pixel sub-type of "lead" — counting it as well would double-count.
      { action_type: "offsite_conversion.fb_pixel_lead", value: "4" },
      { action_type: "link_click", value: "85" },
    ],
    ...overrides,
  };
}

describe("MetaAdsAdapter", () => {
  it("lists ad accounts across cursor pages", async () => {
    const state = graphState({
      accounts: Array.from({ length: 3 }, (_, i) => ({
        id: `act_${i + 1}`,
        name: `Account ${i + 1}`,
        currency: i === 2 ? "INR" : "USD",
      })),
      perPage: 2,
    });
    const { accounts } = await adapterFor(state).listAdAccounts();
    expect(accounts).toEqual([
      { externalId: "act_1", name: "Account 1", currency: "USD" },
      { externalId: "act_2", name: "Account 2", currency: "USD" },
      { externalId: "act_3", name: "Account 3", currency: "INR" },
    ]);
  });

  it("maps daily rows: spend to cents, conversions from aggregate actions only", async () => {
    const state = graphState({
      insights: {
        act_111: [
          insightRow(),
          insightRow({
            campaign_id: "239",
            campaign_name: "Retargeting",
            date_start: "2026-06-02",
            date_stop: "2026-06-02",
            spend: "0.999",
            actions: [
              { action_type: "purchase", value: "2" },
              { action_type: "complete_registration", value: "1" },
              { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
            ],
          }),
          // Sparse row: Graph omits fields with no data.
          insightRow({
            campaign_id: "240",
            campaign_name: "Empty",
            date_start: "2026-06-03",
            spend: undefined,
            impressions: undefined,
            clicks: undefined,
            actions: undefined,
          }),
        ],
      },
    });
    const { metrics, truncated } = await adapterFor(state).listDailyMetrics(
      "act_111",
      "2026-06-01",
      "2026-06-28",
    );
    expect(truncated).toBe(false);
    expect(metrics).toEqual([
      {
        externalCampaignId: "238",
        campaignName: "Lead gen June",
        date: "2026-06-01",
        spendCents: 1234,
        impressions: 4000,
        clicks: 85,
        conversions: 6,
      },
      {
        externalCampaignId: "239",
        campaignName: "Retargeting",
        date: "2026-06-02",
        spendCents: 100,
        impressions: 4000,
        clicks: 85,
        conversions: 3,
      },
      {
        externalCampaignId: "240",
        campaignName: "Empty",
        date: "2026-06-03",
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      },
    ]);
    // The request asks for daily campaign-level rows in the given range.
    const req = state.insightRequests[0]!;
    expect(req).toContain("level=campaign");
    expect(req).toContain("time_increment=1");
    expect(decodeURIComponent(req)).toContain('"since":"2026-06-01"');
  });

  it("keeps the aggregate conversion action list free of sub-types", () => {
    expect(DEFAULT_CONVERSION_ACTIONS).toEqual(["lead", "purchase", "complete_registration"]);
  });

  it("walks insights pagination and reports truncation at the page cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      insightRow({ campaign_id: "238", date_start: `2026-05-${String(i + 1).padStart(2, "0")}` }),
    );
    const state = graphState({ insights: { act_111: many }, perPage: 1 });
    const { metrics, truncated } = await adapterFor(state).listDailyMetrics(
      "act_111",
      "2026-05-01",
      "2026-05-30",
    );
    expect(metrics).toHaveLength(25);
    expect(truncated).toBe(true);
  });

  it("raises ConnectorFabricError on non-2xx responses", async () => {
    const state = graphState();
    state.failStatus = 401;
    await expect(adapterFor(state).listAdAccounts()).rejects.toThrow(ConnectorFabricError);
    await expect(
      adapterFor(state).listDailyMetrics("act_111", "2026-06-01", "2026-06-02"),
    ).rejects.toThrow(ConnectorFabricError);
  });
});

// ---------------------------------------------------------------------------
// Ads API (routes + services over the fake fabric)
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

describe("Ads reporting API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FabricState;
  let received: ReceivedHook[];

  beforeEach(async () => {
    state = fabricState(
      graphState({
        insights: {
          act_111: [
            insightRow(),
            insightRow({ date_start: "2026-06-02", date_stop: "2026-06-02", spend: "20.00" }),
            insightRow({
              campaign_id: "239",
              campaign_name: "Retargeting",
              date_start: "2026-06-02",
              date_stop: "2026-06-02",
              spend: "5.50",
              actions: [{ action_type: "purchase", value: "1" }],
            }),
          ],
        },
      }),
    );
    received = [];
    app = await buildApp({
      db: createTestDb(),
      llm: fakeLlm,
      connectors: fakeFabric(state),
      fetcher: webhookFetcher(received),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Ads" } })
    ).json().id;
    // Events only show up in `received` through a subscribed webhook.
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/webhooks`,
      payload: { url: "https://hooks.test/ads", eventTypes: ["ads.synced"] },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function connectMetaAds() {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
      payload: { accessToken: "EAAB-token" },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function importAccounts(connectionId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/accounts/import`,
      payload: { connectionId },
    });
  }

  async function importedAccount(): Promise<{ id: string }> {
    const connection = await connectMetaAds();
    const res = await importAccounts(connection.id);
    expect(res.statusCode).toBe(200);
    return res.json().accounts[0];
  }

  function syncAccount(accountId: string, payload: Record<string, unknown> = { since: "2026-06-01", until: "2026-06-28" }) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/accounts/${accountId}/sync`,
      payload,
    });
  }

  function report(query = "?since=2026-06-01&until=2026-06-28") {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/report${query}` })
      .then((r) => r.json());
  }

  describe("connect", () => {
    it("connects meta_ads with a pasted token, stored as OAUTH2 credentials in the fabric", async () => {
      await connectMetaAds();
      const stored = state.connections.get(`ws-${workspaceId}-meta_ads`);
      expect(stored).toBeDefined();
      expect(stored!.credentials).toEqual({ type: "OAUTH2", accessToken: "EAAB-token" });
    });

    it("refuses meta_ads without an access token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("account import", () => {
    it("imports ad accounts and is idempotent", async () => {
      const connection = await connectMetaAds();
      const first = await importAccounts(connection.id);
      expect(first.statusCode).toBe(200);
      expect(first.json().created).toBe(1);
      const account = first.json().accounts[0];
      expect(adAccountSchema.safeParse(account).success).toBe(true);
      expect(account.externalId).toBe("act_111");
      expect(account.name).toBe("Tuezday Main");
      expect(account.currency).toBe("USD");

      state.graph.accounts[0]!.name = "Tuezday Renamed";
      const again = await importAccounts(connection.id);
      expect(again.json().created).toBe(0);
      const accounts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/accounts` })
      ).json();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe("Tuezday Renamed");
      expect(accounts[0].provider?.key).toBe("meta_ads");
    });

    it("refuses a non-ads connection", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/smartlead/connect`,
        payload: { apiKey: "sk" },
      });
      const bad = await importAccounts(res.json().id);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("not_an_ads_connection");
    });

    it("returns 502 on a Graph failure", async () => {
      const connection = await connectMetaAds();
      state.graph.failStatus = 500;
      expect((await importAccounts(connection.id)).statusCode).toBe(502);
    });
  });

  describe("sync", () => {
    it("pulls daily campaign metrics into the model and emits ads.synced", async () => {
      const account = await importedAccount();
      const res = await syncAccount(account.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ campaigns: 2, rows: 3, created: 3, updated: 0, truncated: false });

      const data = await report();
      expect(data.campaigns).toHaveLength(2);
      const leadGen = data.campaigns.find(
        (c: { adCampaign: { name: string } }) => c.adCampaign.name === "Lead gen June",
      );
      // Sorted by spend desc — lead gen (12.34 + 20.00) above retargeting (5.50).
      expect(data.campaigns[0].adCampaign.name).toBe("Lead gen June");
      expect(leadGen.totals).toEqual({
        spendCents: 3234,
        impressions: 8000,
        clicks: 170,
        conversions: 12,
      });
      expect(leadGen.days).toHaveLength(2);
      expect(leadGen.adCampaign.account.name).toBe("Tuezday Main");
      expect(leadGen.adCampaign.account.currency).toBe("USD");

      expect(received.filter((h) => h.eventType === "ads.synced")).toHaveLength(1);
    });

    it("re-sync is idempotent and restated values update rows without re-emitting on no change", async () => {
      const account = await importedAccount();
      await syncAccount(account.id);
      const again = await syncAccount(account.id);
      expect(again.json()).toEqual({ campaigns: 2, rows: 3, created: 0, updated: 0, truncated: false });
      expect(received.filter((h) => h.eventType === "ads.synced")).toHaveLength(1);

      // Meta restates conversions retroactively — the row updates in place.
      state.graph.insights.act_111![0]!.actions = [{ action_type: "lead", value: "9" }];
      const restated = await syncAccount(account.id);
      expect(restated.json().updated).toBe(1);
      expect(received.filter((h) => h.eventType === "ads.synced")).toHaveLength(2);

      const data = await report();
      const leadGen = data.campaigns.find(
        (c: { adCampaign: { name: string } }) => c.adCampaign.name === "Lead gen June",
      );
      expect(leadGen.totals.conversions).toBe(15);
    });

    it("applies the default 28-day window when no range is given", async () => {
      const account = await importedAccount();
      const res = await syncAccount(account.id, {});
      expect(res.statusCode).toBe(200);
      const req = state.graph.insightRequests[0]!;
      const range = JSON.parse(
        new URLSearchParams(req.split("?")[1] ?? "").get("time_range")!,
      ) as { since: string; until: string };
      const days =
        (Date.parse(range.until) - Date.parse(range.since)) / (24 * 60 * 60 * 1000);
      expect(days).toBe(27);
    });

    it("404s an unknown account and 400s the CSV account", async () => {
      expect((await syncAccount("7c9e6679-7425-40de-944b-e07fc1f90ae7")).statusCode).toBe(404);
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: {
          rows: [{ date: "2026-06-01", campaignName: "Manual", spend: 10, impressions: 1, clicks: 1, conversions: 0 }],
        },
      });
      const accounts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/accounts` })
      ).json();
      const csvAccount = accounts.find((a: { connectionId: string | null }) => a.connectionId === null);
      const res = await syncAccount(csvAccount.id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("account_not_syncable");
    });

    it("returns 502 and records lastError when Graph fails; a later sync clears it", async () => {
      const account = await importedAccount();
      state.graph.failStatus = 500;
      expect((await syncAccount(account.id)).statusCode).toBe(502);
      let accounts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/accounts` })
      ).json();
      expect(accounts[0].lastError).toBeTruthy();

      state.graph.failStatus = null;
      expect((await syncAccount(account.id)).statusCode).toBe(200);
      accounts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/accounts` })
      ).json();
      expect(accounts[0].lastError).toBeNull();
      expect(accounts[0].lastSyncedAt).toBeTruthy();
    });

    it("sync-all covers every connected account and skips the CSV account", async () => {
      const account = await importedAccount();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: {
          rows: [{ date: "2026-06-01", campaignName: "Manual", spend: 10, impressions: 1, clicks: 1, conversions: 0 }],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/sync`,
        payload: { since: "2026-06-01", until: "2026-06-28" },
      });
      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results).toHaveLength(1);
      expect(results[0].accountId).toBe(account.id);
      expect(results[0].ok).toBe(true);
      expect(results[0].rows).toBe(3);
    });
  });

  describe("CSV import", () => {
    const rows = [
      { date: "2026-06-01", campaignName: "Manual Launch", spend: 12.34, impressions: 100, clicks: 5, conversions: 1 },
      { date: "2026-06-02", campaignName: "Manual Launch", spend: 7.66, impressions: 50, clicks: 2, conversions: 0 },
      { date: "2026-06-01", campaignName: "Other", spend: 1, impressions: 10, clicks: 1, conversions: 0 },
    ];

    it("creates the CSV account lazily and reports without any connection", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: { accountName: "Spreadsheet", currency: "inr", rows },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ campaigns: 2, rows: 3, created: 3, updated: 0 });

      const accounts = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/accounts` })
      ).json();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].connectionId).toBeNull();
      expect(accounts[0].name).toBe("Spreadsheet");
      expect(accounts[0].currency).toBe("INR");

      const data = await report();
      const launch = data.campaigns.find(
        (c: { adCampaign: { name: string } }) => c.adCampaign.name === "Manual Launch",
      );
      expect(launch.totals.spendCents).toBe(2000);
      expect(launch.days.map((d: { source: string }) => d.source)).toEqual(["csv", "csv"]);
    });

    it("re-import is idempotent; changed values update", async () => {
      const url = `/workspaces/${workspaceId}/ads/import-csv`;
      await app.inject({ method: "POST", url, payload: { rows } });
      const again = await app.inject({ method: "POST", url, payload: { rows } });
      expect(again.json()).toMatchObject({ created: 0, updated: 0 });
      const changed = await app.inject({
        method: "POST",
        url,
        payload: { rows: [{ ...rows[0]!, spend: 99 }] },
      });
      expect(changed.json()).toMatchObject({ created: 0, updated: 1 });
    });

    it("rejects malformed rows with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: { rows: [{ date: "June 1", campaignName: "X", spend: 1 }] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("report ranges", () => {
    it("filters by the requested range", async () => {
      const account = await importedAccount();
      await syncAccount(account.id);
      const data = await report("?since=2026-06-02&until=2026-06-02");
      const leadGen = data.campaigns.find(
        (c: { adCampaign: { name: string } }) => c.adCampaign.name === "Lead gen June",
      );
      expect(leadGen.totals.spendCents).toBe(2000);
      expect(leadGen.days).toHaveLength(1);
    });

    it("rejects a malformed range", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/ads/report?since=yesterday`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("campaign linking", () => {
    async function linkedSetup() {
      const account = await importedAccount();
      await syncAccount(account.id);
      const campaign = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/campaigns`,
          payload: { name: "June push" },
        })
      ).json();
      const data = await report();
      const adCampaignId = data.campaigns.find(
        (c: { adCampaign: { name: string } }) => c.adCampaign.name === "Lead gen June",
      ).adCampaign.id;
      return { campaign, adCampaignId };
    }

    it("links and unlinks an ad campaign to a Tuezday campaign", async () => {
      const { campaign, adCampaignId } = await linkedSetup();
      const link = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/${adCampaignId}/link`,
        payload: { campaignId: campaign.id },
      });
      expect(link.statusCode).toBe(200);
      expect(link.json().campaignId).toBe(campaign.id);

      const data = await report();
      const leadGen = data.campaigns.find(
        (c: { adCampaign: { id: string } }) => c.adCampaign.id === adCampaignId,
      );
      expect(leadGen.adCampaign.linkedCampaign).toEqual({ id: campaign.id, name: "June push" });

      const unlink = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/${adCampaignId}/link`,
        payload: { campaignId: null },
      });
      expect(unlink.json().campaignId).toBeNull();
    });

    it("404s unknown ids", async () => {
      const { campaign, adCampaignId } = await linkedSetup();
      const badCampaign = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/${adCampaignId}/link`,
        payload: { campaignId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
      });
      expect(badCampaign.statusCode).toBe(404);
      const badAdCampaign = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/7c9e6679-7425-40de-944b-e07fc1f90ae7/link`,
        payload: { campaignId: campaign.id },
      });
      expect(badAdCampaign.statusCode).toBe(404);
    });

    it("puts paid totals on the campaign detail and null when nothing is linked", async () => {
      const { campaign, adCampaignId } = await linkedSetup();
      const before = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
      });
      expect(before.json().adMetrics).toBeNull();

      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/campaigns/${adCampaignId}/link`,
        payload: { campaignId: campaign.id },
      });
      const after = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/campaigns/${campaign.id}`,
      });
      const adMetrics = after.json().adMetrics;
      expect(adMetrics.totals).toEqual({
        spendCents: 3234,
        impressions: 8000,
        clicks: 170,
        conversions: 12,
      });
      expect(adMetrics.adCampaigns).toHaveLength(1);
      expect(adMetrics.adCampaigns[0]).toMatchObject({
        name: "Lead gen June",
        accountName: "Tuezday Main",
        currency: "USD",
      });
    });
  });
});
