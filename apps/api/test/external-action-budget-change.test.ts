import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { externalActions } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate({ prompt }) {
    const count = Number(/Write (\d+) distinct Meta ad/.exec(prompt)?.[1] ?? 1);
    return {
      text: Array.from(
        { length: count },
        (_, index) =>
          `Primary text: Angle ${index + 1}.\nHeadline: Headline ${index + 1}\nDescription: Desc`,
      ).join("\n---\n"),
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  },
};

interface GraphState {
  dailyBudgetCents: number;
  countries: string[];
  ageMin: number;
  ageMax: number;
  updatedTime: string;
  budgetUpdates: number[];
}

function graphState(): GraphState {
  return {
    dailyBudgetCents: 500,
    countries: ["US"],
    ageMin: 18,
    ageMax: 65,
    updatedTime: "2026-07-15T08:00:00Z",
    budgetUpdates: [],
  };
}

function graph(state: GraphState, method: string, path: string, body: unknown): ProxyJsonResult {
  if (method === "GET" && path.startsWith("/v23.0/me/adaccounts")) {
    return { status: 200, json: { data: [{ id: "act_111", name: "Main", currency: "USD" }] } };
  }
  if (method === "GET" && path.startsWith("/v23.0/set_1?fields=")) {
    return {
      status: 200,
      json: {
        id: "set_1",
        daily_budget: String(state.dailyBudgetCents),
        targeting: {
          geo_locations: { countries: state.countries },
          age_min: state.ageMin,
          age_max: state.ageMax,
        },
        updated_time: state.updatedTime,
      },
    };
  }
  if (method === "GET") return { status: 200, json: { data: [] } };
  if (/^\/v23\.0\/act_\d+\/campaigns$/.test(path)) {
    return { status: 200, json: { id: "cmp_1" } };
  }
  if (/^\/v23\.0\/act_\d+\/adsets$/.test(path)) {
    const input = body as {
      daily_budget: number;
      targeting: { geo_locations: { countries: string[] }; age_min: number; age_max: number };
    };
    state.dailyBudgetCents = input.daily_budget;
    state.countries = input.targeting.geo_locations.countries;
    state.ageMin = input.targeting.age_min;
    state.ageMax = input.targeting.age_max;
    return { status: 200, json: { id: "set_1" } };
  }
  if (/^\/v23\.0\/act_\d+\/adcreatives$/.test(path)) {
    return { status: 200, json: { id: "creative_1" } };
  }
  if (/^\/v23\.0\/act_\d+\/ads$/.test(path)) {
    return { status: 200, json: { id: "ad_1" } };
  }
  if (method === "POST" && path === "/v23.0/set_1") {
    const input = body as { daily_budget?: number };
    if (input.daily_budget !== undefined) {
      state.dailyBudgetCents = input.daily_budget;
      state.budgetUpdates.push(input.daily_budget);
      state.updatedTime = "2026-07-15T09:00:00Z";
    }
    return { status: 200, json: { success: true } };
  }
  if (method === "POST" && path === "/v23.0/cmp_1") {
    return { status: 200, json: { success: true } };
  }
  return { status: 404, json: { error: { message: "not found" } } };
}

function fakeFabric(state: GraphState): ConnectorFabric {
  return {
    async health() { return { healthy: true }; },
    async ensureIntegration() {},
    async createConnectSession() { return { token: "token" }; },
    async importConnection() {},
    async connectionExists() { return true; },
    async deleteConnection() {},
    async proxyGet() { return { status: 200, bodySnippet: "{}" }; },
    async proxyJson(method, path, _connectionId, _key, options) {
      return graph(state, method, path, options?.body);
    },
  };
}

describe("governed Meta budget changes", () => {
  let app: TuezdayApp;
  let db: Db;
  let state: GraphState;
  let workspaceId: string;
  let campaignId: string;
  let launchId: string;

  beforeEach(async () => {
    db = createTestDb();
    state = graphState();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Budget" } })).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "A durable company brain." },
    });
    const connection = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
      payload: { accessToken: "token" },
    });
    const account = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/accounts/import`,
      payload: { connectionId: connection.json().id },
    });
    campaignId = (await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: "Paid push", objective: "Grow" },
    })).json().id;
    const generated = (await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ad-creatives/generate`,
      payload: { taskType: "meta_ad_creative", campaignId },
    })).json();
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${generated.drafts[0].id}/approve`,
    });
    launchId = (await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches`,
      payload: {
        adAccountId: account.json().accounts[0].id,
        creativeDraftId: generated.drafts[0].id,
        name: "Launch",
        objective: "OUTCOME_TRAFFIC",
        pageId: "123",
        linkUrl: "https://tuezday.app",
        dailyBudgetCents: 500,
        countries: ["US"],
      },
    })).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/ads/launches/${launchId}/submit` });
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/ads/launches/${launchId}/approve` });
    await putActionPolicy(app, workspaceId, "campaign", campaignId, { paid_launch: "autonomous" });
    const launched = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches/${launchId}/launch`,
    });
    expect(launched.json().action.status).toBe("succeeded");
  });

  afterEach(async () => app.close());

  const propose = (dailyBudgetCents: number, idempotencyKey = "55555555-5555-4555-8555-555555555555") =>
    app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches/${launchId}/budget-change`,
      payload: { dailyBudgetCents, idempotencyKey },
    });

  const authorize = (actionId: string) =>
    app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${actionId}/authorize`,
      payload: {},
    });

  it("proposes an exact provider snapshot, deduplicates, and updates once after authorization", async () => {
    const proposed = await propose(750);
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json().action).toMatchObject({ kind: "budget_change", status: "authorization_required" });
    const row = db.select().from(externalActions).where(eq(externalActions.id, proposed.json().action.id)).get()!;
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      beforeDailyBudgetCents: 500,
      afterDailyBudgetCents: 750,
      externalAdSetId: "set_1",
    });
    expect((await propose(750)).json().action.id).toBe(proposed.json().action.id);

    const completed = await authorize(proposed.json().action.id);
    expect(completed.json().action.status).toBe("succeeded");
    expect(completed.json().execution).toMatchObject({ kind: "ad_mutation", status: "budget_updated" });
    expect(state.budgetUpdates).toEqual([750]);
    expect((await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/launches/${launchId}` })).json().dailyBudgetCents).toBe(750);
  });

  it("goes stale when Meta changes after proposal", async () => {
    const proposed = await propose(750);
    state.dailyBudgetCents = 600;
    state.updatedTime = "2026-07-15T08:30:00Z";
    const result = await authorize(proposed.json().action.id);
    expect(result.statusCode).toBe(409);
    expect(result.json().action.status).toBe("stale");
    expect(state.budgetUpdates).toEqual([]);
  });

  it("rechecks the kill switch and rejects idempotency-key reuse for another budget", async () => {
    const proposed = await propose(750);
    const conflict = await propose(900);
    expect(conflict.statusCode).toBe(409);
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/ads/settings`,
      payload: { killSwitch: true },
    });
    const blocked = await authorize(proposed.json().action.id);
    expect(blocked.json().action.status).toBe("blocked");
    expect(blocked.json().action.blocker.code).toBe("kill_switch");
    expect(state.budgetUpdates).toEqual([]);
  });
});
