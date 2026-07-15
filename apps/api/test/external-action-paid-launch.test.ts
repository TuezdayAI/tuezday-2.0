import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { externalActionSubmissionSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { adLaunches, drafts, externalActions } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

/** Fake gateway producing a parseable Meta ad creative (mirrors ads-execution). */
const fakeLlm: LlmGateway = {
  async generate({ prompt }) {
    const match = /Write (\d+) distinct Meta ad/.exec(prompt);
    const n = match ? Number(match[1]) : 1;
    const text = Array.from(
      { length: n },
      (_, i) =>
        `Primary text: Angle ${i + 1} for the offer.\nHeadline: Headline ${i + 1}\nDescription: Desc ${i + 1}`,
    ).join("\n---\n");
    return { text, model: "fake", provider: "fake", durationMs: 1 };
  },
};

interface GraphState {
  nextId: number;
  campaignPosts: number;
  statusFlips: Array<{ campaignId: string; status: string }>;
  calls: string[];
  failOn: string | null;
}

function graphState(): GraphState {
  return { nextId: 1, campaignPosts: 0, statusFlips: [], calls: [], failOn: null };
}

function handleGraph(state: GraphState, method: string, path: string, body: unknown): ProxyJsonResult {
  state.calls.push(`${method} ${path.split("?")[0]}`);
  if (state.failOn && path.includes(state.failOn)) {
    return { status: 400, json: { error: { message: "graph says no" } } };
  }
  if (method === "GET" && path.startsWith("/v23.0/me/adaccounts")) {
    return { status: 200, json: { data: [{ id: "act_111", name: "Main", currency: "USD" }] } };
  }
  if (method === "GET") return { status: 200, json: { data: [] } };
  if (/^\/v23\.0\/act_\d+\/campaigns$/.test(path)) {
    state.campaignPosts += 1;
    return { status: 200, json: { id: `cmp_${state.nextId++}` } };
  }
  if (/^\/v23\.0\/act_\d+\/(adsets|adcreatives|ads)$/.test(path)) {
    return { status: 200, json: { id: `obj_${state.nextId++}` } };
  }
  const flip = /^\/v23\.0\/(cmp_\d+)$/.exec(path);
  if (flip) {
    state.statusFlips.push({
      campaignId: flip[1]!,
      status: ((body ?? {}) as { status?: string }).status ?? "",
    });
    return { status: 200, json: { success: true } };
  }
  return { status: 404, json: { error: { message: "no such endpoint" } } };
}

function fakeFabric(state: GraphState): ConnectorFabric {
  return {
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
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _key, opts) {
      return handleGraph(state, method, path, opts?.body);
    },
  };
}

describe("external-action paid launch boundary", () => {
  let app: TuezdayApp;
  let db: Db;
  let state: GraphState;
  let received: Array<{ eventType: string | null }>;
  let workspaceId: string;
  let accountId: string;
  let approvedDraftId: string;
  let campaignId: string;

  beforeEach(async () => {
    db = createTestDb();
    state = graphState();
    received = [];
    const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      received.push({ eventType: headers["X-Tuezday-Event"] ?? null });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state), fetcher });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Paid" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/webhooks`,
      payload: { url: "https://hooks.test/ads", eventTypes: ["ad.launched"] },
    });
    const connected = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
      payload: { accessToken: "EAAB-token" },
    });
    expect(connected.statusCode).toBe(201);
    const imported = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/accounts/import`,
      payload: { connectionId: connected.json().id },
    });
    expect(imported.statusCode).toBe(200);
    accountId = imported.json().accounts[0].id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Paid push", objective: "Win the launch" },
      })
    ).json().id;
    const generated = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ad-creatives/generate`,
        payload: { taskType: "meta_ad_creative", campaignId },
      })
    ).json();
    approvedDraftId = generated.drafts[0].id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${approvedDraftId}/approve`,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function createLaunch(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches`,
      payload: {
        adAccountId: accountId,
        creativeDraftId: approvedDraftId,
        name: "June traffic push",
        objective: "OUTCOME_TRAFFIC",
        pageId: "123456789",
        linkUrl: "https://tuezday.app",
        dailyBudgetCents: 500,
        countries: ["US"],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  const act = (launchId: string, action: string) =>
    app.inject({ method: "POST", url: `/workspaces/${workspaceId}/ads/launches/${launchId}/${action}` });

  async function approvedLaunch(): Promise<string> {
    const id = await createLaunch();
    expect((await act(id, "submit")).statusCode).toBe(200);
    expect((await act(id, "approve")).statusCode).toBe(200);
    return id;
  }

  const getLaunch = (launchId: string) =>
    app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/launches/${launchId}` })
      .then((r) => r.json());

  const authorize = (actionId: string) =>
    app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${actionId}/authorize`,
      payload: {},
    });

  function actionRows() {
    return db.select().from(externalActions).where(eq(externalActions.workspaceId, workspaceId)).all();
  }

  async function setAutonomous() {
    // The launch carries its creative's campaign, whose explicit rule replaces
    // the workspace baseline — so autonomy is granted at the campaign scope.
    const res = await putActionPolicy(app, workspaceId, "campaign", campaignId, {
      paid_launch: "autonomous",
    });
    expect(res.statusCode).toBe(200);
  }

  it("still requires setup approval before any action is proposed", async () => {
    const id = await createLaunch();
    const early = await act(id, "launch");
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("launch_not_approved");
    expect(actionRows()).toHaveLength(0);
  });

  it("queues a human-required launch without provider records, then launches exactly once", async () => {
    const id = await approvedLaunch();
    const queued = await act(id, "launch");
    expect(queued.statusCode).toBe(202);
    const submission = externalActionSubmissionSchema.parse(queued.json());
    expect(submission.action.kind).toBe("paid_launch");
    expect(submission.action.status).toBe("authorization_required");
    expect(submission.action.subject.kind).toBe("ad_launch");
    expect(state.campaignPosts).toBe(0);

    // An identical retry returns the same queued action.
    const retry = await act(id, "launch");
    expect(retry.statusCode).toBe(202);
    expect(retry.json().action.id).toBe(submission.action.id);
    expect(actionRows()).toHaveLength(1);

    const authorized = await authorize(submission.action.id);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("succeeded");
    expect(authorized.json().execution).toMatchObject({ kind: "ad_launch", status: "launched" });
    expect(state.campaignPosts).toBe(1);
    expect(state.statusFlips).toEqual([{ campaignId: "cmp_1", status: "ACTIVE" }]);
    expect(received.filter((h) => h.eventType === "ad.launched")).toHaveLength(1);

    const launch = await getLaunch(id);
    expect(launch.status).toBe("launched");
    expect(launch.externalActionId).toBe(submission.action.id);
    expect(launch.decisions.map((d: { action: string }) => d.action)).toEqual([
      "submit",
      "approve",
      "launch",
    ]);

    expect((await authorize(submission.action.id)).statusCode).toBe(409);
    const again = await act(id, "launch");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_launched");
  });

  it("marks the queued launch stale when the creative changes", async () => {
    const id = await approvedLaunch();
    const queued = await act(id, "launch");
    db.update(drafts)
      .set({
        content: "Primary text: Edited angle.\nHeadline: New headline\nDescription: New desc",
        updatedAt: Date.now(),
      })
      .where(eq(drafts.id, approvedDraftId))
      .run();
    const authorized = await authorize(queued.json().action.id);
    expect(authorized.statusCode).toBe(409);
    expect(authorized.json().action.status).toBe("stale");
    expect(state.campaignPosts).toBe(0);
  });

  it("denies without touching the launch's approval history", async () => {
    const id = await approvedLaunch();
    const queued = await act(id, "launch");
    const denied = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${queued.json().action.id}/deny`,
      payload: { reason: "Budget freeze" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().action.status).toBe("cancelled");
    const launch = await getLaunch(id);
    expect(launch.status).toBe("approved");
    expect(launch.decisions.map((d: { action: string }) => d.action)).toEqual(["submit", "approve"]);
    // The launch can be proposed again after the denial.
    expect((await act(id, "launch")).statusCode).toBe(202);
  });

  it("keeps the kill switch as an autonomous guardrail", async () => {
    await setAutonomous();
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/ads/settings`,
      payload: { killSwitch: true },
    });
    const id = await approvedLaunch();
    const res = await act(id, "launch");
    expect(res.statusCode).toBe(201);
    expect(res.json().action.status).toBe("blocked");
    expect(res.json().action.blocker.code).toBe("kill_switch_on");
    expect(state.campaignPosts).toBe(0);
    expect((await getLaunch(id)).status).toBe("approved");
  });

  it("persists provider failure on both the action and the ad launch, then resumes on retry", async () => {
    await setAutonomous();
    const id = await approvedLaunch();
    state.failOn = "/adsets";
    const failed = await act(id, "launch");
    expect(failed.statusCode).toBe(201);
    expect(failed.json().action.status).toBe("failed");
    expect(failed.json().execution.error).toContain("graph says no");
    const after = await getLaunch(id);
    expect(after.status).toBe("approved");
    expect(after.externalCampaignId).toBe("cmp_1");
    expect(after.lastError).toContain("graph says no");
    expect(
      db.select().from(adLaunches).where(eq(adLaunches.id, id)).get()?.externalActionId,
    ).toBe(failed.json().action.id);

    state.failOn = null;
    const retried = await act(id, "launch");
    expect(retried.statusCode).toBe(201);
    expect(retried.json().action.status).toBe("succeeded");
    expect(retried.json().action.id).not.toBe(failed.json().action.id);
    // The campaign from the first attempt is reused, not duplicated.
    expect(state.campaignPosts).toBe(1);
    expect((await getLaunch(id)).status).toBe("launched");
  });
});
