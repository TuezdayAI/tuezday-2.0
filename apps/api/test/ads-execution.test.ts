import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adLaunchTransitionTo, createAdLaunchInputSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { type ConnectorFabric, type ProxyJsonResult } from "../src/connectors/fabric";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

/** Fake gateway producing valid ad-creative formats (mirrors ad-creatives.test.ts). */
function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      let text: string;
      if (prompt.includes("Google responsive search ad")) {
        const headlines = Array.from({ length: 3 }, (_, i) => `Headline ${i + 1}: H${i + 1}`);
        const descriptions = Array.from({ length: 2 }, (_, i) => `Description ${i + 1}: D${i + 1}`);
        text = [...headlines, ...descriptions].join("\n");
      } else {
        const match = /Write (\d+) distinct Meta ad/.exec(prompt);
        const n = match ? Number(match[1]) : 1;
        text = Array.from(
          { length: n },
          (_, i) =>
            `Primary text: Angle ${i + 1} for the offer.\nHeadline: Headline ${i + 1}\nDescription: Desc ${i + 1}`,
        ).join("\n---\n");
      }
      return { text, model: "fake", provider: "fake", durationMs: 5 };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake fabric with a writable in-memory Graph API behind the proxy. The real
// MetaAdsAdapter runs against this, so the wire mapping is covered end-to-end.
// ---------------------------------------------------------------------------

interface RecordedPost {
  path: string;
  body: Record<string, unknown>;
}

interface ExecGraphState {
  accounts: Array<{ id: string; name: string; currency: string }>;
  nextId: number;
  campaignPosts: RecordedPost[];
  adSetPosts: RecordedPost[];
  creativePosts: RecordedPost[];
  adPosts: RecordedPost[];
  /** Status flips POSTed to /{campaignId}. */
  statusFlips: Array<{ campaignId: string; status: string }>;
  /** effective_status served by the campaign listing; flips update it. */
  effectiveStatus: Record<string, string>;
  /** Ordered log of every proxied call ("POST /v23.0/act_111/adsets"). */
  calls: string[];
  /** Substring of a path that should fail with failStatus. */
  failOn: string | null;
  failStatus: number;
}

function execGraphState(): ExecGraphState {
  return {
    accounts: [{ id: "act_111", name: "Tuezday Main", currency: "USD" }],
    nextId: 1,
    campaignPosts: [],
    adSetPosts: [],
    creativePosts: [],
    adPosts: [],
    statusFlips: [],
    effectiveStatus: {},
    calls: [],
    failOn: null,
    failStatus: 400,
  };
}

function handleGraph(
  state: ExecGraphState,
  method: string,
  path: string,
  body: unknown,
): ProxyJsonResult {
  state.calls.push(`${method} ${path.split("?")[0]}`);
  if (state.failOn && path.includes(state.failOn)) {
    return { status: state.failStatus, json: { error: { message: "graph says no" } } };
  }

  if (method === "GET") {
    if (path.startsWith("/v23.0/me/adaccounts")) {
      return { status: 200, json: { data: state.accounts } };
    }
    if (/^\/v23\.0\/act_\d+\/campaigns/.test(path)) {
      return {
        status: 200,
        json: {
          data: Object.entries(state.effectiveStatus).map(([id, effective_status]) => ({
            id,
            effective_status,
          })),
        },
      };
    }
    if (/^\/v23\.0\/act_\d+\/insights/.test(path)) {
      return { status: 200, json: { data: [] } };
    }
    return { status: 404, json: { error: { message: "no such endpoint" } } };
  }

  const record = (path: string, list: RecordedPost[], idPrefix: string): ProxyJsonResult => {
    const id = `${idPrefix}_${state.nextId++}`;
    list.push({ path, body: (body ?? {}) as Record<string, unknown> });
    return { status: 200, json: { id } };
  };
  if (/^\/v23\.0\/act_\d+\/campaigns$/.test(path)) {
    const result = record(path, state.campaignPosts, "cmp");
    const created = (body ?? {}) as { status?: string };
    state.effectiveStatus[(result.json as { id: string }).id] = created.status ?? "ACTIVE";
    return result;
  }
  if (/^\/v23\.0\/act_\d+\/adsets$/.test(path)) return record(path, state.adSetPosts, "as");
  if (/^\/v23\.0\/act_\d+\/adcreatives$/.test(path)) return record(path, state.creativePosts, "crv");
  if (/^\/v23\.0\/act_\d+\/ads$/.test(path)) return record(path, state.adPosts, "ad");
  const flip = /^\/v23\.0\/(cmp_\d+)$/.exec(path);
  if (flip) {
    const status = ((body ?? {}) as { status?: string }).status ?? "";
    state.statusFlips.push({ campaignId: flip[1]!, status });
    state.effectiveStatus[flip[1]!] = status;
    return { status: 200, json: { success: true } };
  }
  return { status: 404, json: { error: { message: "no such endpoint" } } };
}

function fakeFabric(state: ExecGraphState): ConnectorFabric {
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

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe("ad launch contracts (Sprint 20)", () => {
  it("encodes the launch state machine", () => {
    expect(adLaunchTransitionTo("draft", "submit")).toBe("pending_review");
    expect(adLaunchTransitionTo("pending_review", "approve")).toBe("approved");
    expect(adLaunchTransitionTo("pending_review", "reject")).toBe("rejected");
    expect(adLaunchTransitionTo("pending_review", "revise")).toBe("draft");
    expect(adLaunchTransitionTo("rejected", "revise")).toBe("draft");
    // An approved launch can be pulled back until it launches.
    expect(adLaunchTransitionTo("approved", "revise")).toBe("draft");
    // Illegal moves.
    expect(adLaunchTransitionTo("draft", "approve")).toBeUndefined();
    expect(adLaunchTransitionTo("approved", "approve")).toBeUndefined();
    expect(adLaunchTransitionTo("launched", "revise")).toBeUndefined();
  });

  it("bounds the launch input", () => {
    const valid = {
      adAccountId: "5b6bd44b-9219-4d61-9b53-0f8b07a3a8e5",
      creativeDraftId: "9e2f3a39-2bb1-43ce-9869-90640ed344ab",
      name: "June push",
      objective: "OUTCOME_TRAFFIC",
      pageId: "123456789",
      linkUrl: "https://tuezday.app",
      dailyBudgetCents: 500,
      countries: ["US"],
    };
    const parsed = createAdLaunchInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ageMin).toBe(18);
      expect(parsed.data.ageMax).toBe(65);
    }

    expect(createAdLaunchInputSchema.safeParse({ ...valid, dailyBudgetCents: 99 }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, countries: ["USA"] }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, countries: [] }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, linkUrl: "http://tuezday.app" }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, pageId: "not-digits" }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, ageMin: 40, ageMax: 30 }).success).toBe(false);
    expect(createAdLaunchInputSchema.safeParse({ ...valid, objective: "OUTCOME_SALES" }).success).toBe(false);
    // Lowercase country codes are normalized, not rejected.
    const lower = createAdLaunchInputSchema.safeParse({ ...valid, countries: ["us", "de"] });
    expect(lower.success).toBe(true);
    if (lower.success) expect(lower.data.countries).toEqual(["US", "DE"]);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("ads execution API (Sprint 20)", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: ExecGraphState;
  let received: ReceivedHook[];
  let campaignId: string;
  let accountId: string;
  let approvedDraftId: string;
  let pendingDraftId: string;

  beforeEach(async () => {
    state = execGraphState();
    received = [];
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: fakeGateway(),
      connectors: fakeFabric(state),
      fetcher: webhookFetcher(received),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Ads exec" } })
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
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win the launch" },
      })
    ).json().id;
    // Legacy direct-launch scenarios: paid launches run autonomously so the
    // provider chain stays observable. The authorization queue itself is
    // covered in external-action-paid-launch.test.ts.
    await putActionPolicy(app, workspaceId, "campaign", campaignId, {
      paid_launch: "autonomous",
    });

    const connection = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
        payload: { accessToken: "EAAB-token" },
      })
    ).json();
    const imported = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/accounts/import`,
      payload: { connectionId: connection.id },
    });
    expect(imported.statusCode).toBe(200);
    accountId = imported.json().accounts[0].id;

    const generated = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ad-creatives/generate`,
        payload: { taskType: "meta_ad_creative", campaignId },
      })
    ).json();
    approvedDraftId = generated.drafts[0].id;
    pendingDraftId = generated.drafts[1].id;
    const approved = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${approvedDraftId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
  });

  function launchPayload(overrides: Record<string, unknown> = {}) {
    return {
      adAccountId: accountId,
      creativeDraftId: approvedDraftId,
      name: "June traffic push",
      objective: "OUTCOME_TRAFFIC",
      pageId: "123456789",
      linkUrl: "https://tuezday.app",
      dailyBudgetCents: 500,
      countries: ["US"],
      ...overrides,
    };
  }

  async function createLaunch(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches`,
      payload: launchPayload(overrides),
    });
  }

  function act(launchId: string, action: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ads/launches/${launchId}/${action}`,
    });
  }

  /** Create + submit + approve, returning the launch id. */
  async function approvedLaunch(overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await createLaunch(overrides);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await act(id, "submit")).statusCode).toBe(200);
    expect((await act(id, "approve")).statusCode).toBe(200);
    return id;
  }

  async function getLaunch(launchId: string) {
    return (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/launches/${launchId}` })
    ).json();
  }

  function putSettings(payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/ads/settings`,
      payload,
    });
  }

  describe("create + edit + delete", () => {
    it("creates a draft launch carrying the creative's campaign and the parsed copy", async () => {
      const res = await createLaunch();
      expect(res.statusCode).toBe(201);
      const launch = res.json();
      expect(launch.status).toBe("draft");
      expect(launch.campaignId).toBe(campaignId);
      expect(launch.dailyBudgetCents).toBe(500);
      expect(launch.countries).toEqual(["US"]);
      expect(launch.externalCampaignId).toBeNull();

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/launches` })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].account).toMatchObject({ name: "Tuezday Main", currency: "USD" });
      expect(list[0].creative).toMatchObject({
        primaryText: "Angle 1 for the offer.",
        headline: "Headline 1",
        description: "Desc 1",
      });
    });

    it("refuses the CSV account", async () => {
      const csv = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/import-csv`,
        payload: {
          rows: [{ date: "2026-06-01", campaignName: "Old push", spend: 1, impressions: 1, clicks: 1, conversions: 0 }],
        },
      });
      expect(csv.statusCode).toBe(200);
      const res = await createLaunch({ adAccountId: csv.json().accountId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("account_not_launchable");
    });

    it("requires an approved Meta creative", async () => {
      const pending = await createLaunch({ creativeDraftId: pendingDraftId });
      expect(pending.statusCode).toBe(409);
      expect(pending.json().error).toBe("creative_not_approved");

      // An approved Google RSA draft is the wrong platform format.
      const rsa = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/ad-creatives/generate`,
          payload: { taskType: "google_rsa", campaignId },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${rsa.drafts[0].id}/approve`,
      });
      const wrong = await createLaunch({ creativeDraftId: rsa.drafts[0].id });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toBe("creative_not_meta");
    });

    it("404s unknown references", async () => {
      expect(
        (await createLaunch({ adAccountId: "1f7e3b1a-93d0-4f6c-9d5e-1a2b3c4d5e6f" })).statusCode,
      ).toBe(404);
      expect(
        (await createLaunch({ creativeDraftId: "1f7e3b1a-93d0-4f6c-9d5e-1a2b3c4d5e6f" })).statusCode,
      ).toBe(404);
    });

    it("edits drafts only", async () => {
      const id = (await createLaunch()).json().id;
      const edited = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/ads/launches/${id}`,
        payload: { name: "Renamed", dailyBudgetCents: 700 },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ name: "Renamed", dailyBudgetCents: 700 });

      await act(id, "submit");
      const locked = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/ads/launches/${id}`,
        payload: { name: "Nope" },
      });
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error).toBe("not_editable");
    });

    it("deletes anything unlaunched, never a launched campaign", async () => {
      const id = (await createLaunch()).json().id;
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/workspaces/${workspaceId}/ads/launches/${id}`,
          })
        ).statusCode,
      ).toBe(204);

      const live = await approvedLaunch();
      expect((await act(live, "launch")).statusCode).toBe(201);
      const blocked = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/ads/launches/${live}`,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe("already_launched");
    });
  });

  describe("approval gate", () => {
    it("walks the state machine and logs every decision with the acting user", async () => {
      const id = (await createLaunch()).json().id;
      expect((await act(id, "submit")).json().status).toBe("pending_review");
      expect((await act(id, "approve")).json().status).toBe("approved");

      const me = (await app.inject({ method: "GET", url: "/auth/me" })).json();
      const detail = await getLaunch(id);
      expect(detail.decisions).toHaveLength(2);
      expect(detail.decisions.map((d: { action: string }) => d.action)).toEqual([
        "submit",
        "approve",
      ]);
      for (const decision of detail.decisions) {
        expect(decision.actor).toBe("founder");
        expect(decision.actorId).toBe(me.user.id);
      }
      expect(detail.decisions[1]).toMatchObject({ fromState: "pending_review", toState: "approved" });
    });

    it("supports reject and revise, including pulling back an approved launch", async () => {
      const id = (await createLaunch()).json().id;
      await act(id, "submit");
      expect((await act(id, "reject")).json().status).toBe("rejected");
      expect((await act(id, "revise")).json().status).toBe("draft");
      await act(id, "submit");
      await act(id, "approve");
      expect((await act(id, "revise")).json().status).toBe("draft");
    });

    it("409s illegal transitions", async () => {
      const id = (await createLaunch()).json().id;
      const res = await act(id, "approve");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("invalid_transition");
    });
  });

  describe("launch", () => {
    it("creates the Meta object chain and activates the campaign last", async () => {
      const id = await approvedLaunch({ startAt: Date.now() + 60_000 });
      const res = await act(id, "launch");
      expect(res.statusCode).toBe(201);
      expect(res.json().action.status).toBe("succeeded");
      expect(res.json().execution).toMatchObject({ kind: "ad_launch", status: "launched" });
      const launch = await getLaunch(id);
      expect(launch.status).toBe("launched");
      expect(launch.externalActionId).toBe(res.json().action.id);
      expect(launch.platformStatus).toBe("ACTIVE");
      expect(launch.launchedAt).toBeGreaterThan(0);
      expect(launch.externalCampaignId).toBe("cmp_1");
      expect(launch.externalAdSetId).toBe("as_2");
      expect(launch.externalCreativeId).toBe("crv_3");
      expect(launch.externalAdId).toBe("ad_4");

      // Campaign is born PAUSED so a partial chain never spends.
      expect(state.campaignPosts).toHaveLength(1);
      expect(state.campaignPosts[0]!.body).toMatchObject({
        name: "June traffic push",
        objective: "OUTCOME_TRAFFIC",
        status: "PAUSED",
        special_ad_categories: [],
      });
      const adSet = state.adSetPosts[0]!.body;
      expect(adSet).toMatchObject({
        campaign_id: "cmp_1",
        daily_budget: 500,
        billing_event: "IMPRESSIONS",
        optimization_goal: "LINK_CLICKS",
        status: "ACTIVE",
      });
      expect(adSet.targeting).toEqual({
        geo_locations: { countries: ["US"] },
        age_min: 18,
        age_max: 65,
      });
      expect(typeof adSet.start_time).toBe("string");
      expect(state.creativePosts[0]!.body.object_story_spec).toEqual({
        page_id: "123456789",
        link_data: {
          link: "https://tuezday.app",
          message: "Angle 1 for the offer.",
          name: "Headline 1",
          description: "Desc 1",
        },
      });
      expect(state.adPosts[0]!.body).toMatchObject({
        adset_id: "as_2",
        creative: { creative_id: "crv_3" },
        status: "ACTIVE",
      });
      // Activation is the final call of the chain.
      expect(state.statusFlips).toEqual([{ campaignId: "cmp_1", status: "ACTIVE" }]);
      expect(state.calls[state.calls.length - 1]).toBe("POST /v23.0/cmp_1");

      // The decision log records who pulled the trigger.
      const detail = await getLaunch(id);
      const actions = detail.decisions.map((d: { action: string }) => d.action);
      expect(actions).toEqual(["submit", "approve", "launch"]);

      // The event fired.
      expect(received.filter((h) => h.eventType === "ad.launched")).toHaveLength(1);
    });

    it("maps the awareness objective to REACH", async () => {
      const id = await approvedLaunch({ objective: "OUTCOME_AWARENESS" });
      expect((await act(id, "launch")).statusCode).toBe(201);
      expect(state.adSetPosts[0]!.body.optimization_goal).toBe("REACH");
    });

    it("registers the launched campaign in Sprint 14 reporting, linked to the Tuezday campaign", async () => {
      const id = await approvedLaunch();
      await act(id, "launch");
      const launch = await getLaunch(id);
      expect(launch.adCampaignId).toBeTruthy();

      const report = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/report` })
      ).json();
      const mirrored = report.campaigns.find(
        (c: { adCampaign: { externalId: string } }) => c.adCampaign.externalId === "cmp_1",
      );
      expect(mirrored).toBeDefined();
      expect(mirrored.adCampaign.linkedCampaign).toMatchObject({ id: campaignId });
    });

    it("only launches approved launches, exactly once", async () => {
      const id = (await createLaunch()).json().id;
      const early = await act(id, "launch");
      expect(early.statusCode).toBe(409);
      expect(early.json().error).toBe("launch_not_approved");

      await act(id, "submit");
      await act(id, "approve");
      expect((await act(id, "launch")).statusCode).toBe(201);
      const again = await act(id, "launch");
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_launched");
    });

    it("is blocked by the kill switch", async () => {
      const id = await approvedLaunch();
      await putSettings({ killSwitch: true });
      const res = await act(id, "launch");
      expect(res.statusCode).toBe(201);
      expect(res.json().action.status).toBe("blocked");
      expect(res.json().action.blocker.code).toBe("kill_switch_on");
      expect(state.campaignPosts).toHaveLength(0);
      expect((await getLaunch(id)).status).toBe("approved");
    });

    it("enforces the workspace daily cap over committed budgets, ignoring paused launches", async () => {
      await putSettings({ dailyCapCents: 800 });
      const first = await approvedLaunch({ dailyBudgetCents: 500 });
      expect((await act(first, "launch")).statusCode).toBe(201);

      const second = await approvedLaunch({ dailyBudgetCents: 500, name: "Second push" });
      const blocked = await act(second, "launch");
      expect(blocked.statusCode).toBe(201);
      expect(blocked.json().action.status).toBe("blocked");
      expect(blocked.json().action.blocker.code).toBe("daily_cap_exceeded");

      // Pausing the first frees its committed budget for a fresh attempt.
      expect((await act(first, "pause")).statusCode).toBe(200);
      const retried = await act(second, "launch");
      expect(retried.statusCode).toBe(201);
      expect(retried.json().action.status).toBe("succeeded");
    });

    it("keeps partial progress on failure and resumes the chain on retry", async () => {
      const id = await approvedLaunch();
      state.failOn = "/adsets";
      const failed = await act(id, "launch");
      expect(failed.statusCode).toBe(201);
      expect(failed.json().action.status).toBe("failed");
      expect(failed.json().execution.error).toContain("graph says no");

      const after = await getLaunch(id);
      expect(after.status).toBe("approved");
      expect(after.externalCampaignId).toBe("cmp_1");
      expect(after.externalAdSetId).toBeNull();
      expect(after.lastError).toContain("graph says no");

      state.failOn = null;
      const retried = await act(id, "launch");
      expect(retried.statusCode).toBe(201);
      expect(retried.json().action.status).toBe("succeeded");
      // The campaign from the first attempt is reused, not duplicated.
      expect(state.campaignPosts).toHaveLength(1);
      const relaunched = await getLaunch(id);
      expect(relaunched.externalCampaignId).toBe("cmp_1");
      expect(relaunched.status).toBe("launched");
    });
  });

  describe("pause + resume", () => {
    it("flips the platform campaign status", async () => {
      const id = await approvedLaunch();
      await act(id, "launch");

      const paused = await act(id, "pause");
      expect(paused.statusCode).toBe(200);
      expect(paused.json().platformStatus).toBe("PAUSED");
      expect(state.statusFlips).toContainEqual({ campaignId: "cmp_1", status: "PAUSED" });
      const again = await act(id, "pause");
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_paused");

      const resumed = await act(id, "resume");
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().platformStatus).toBe("ACTIVE");
    });

    it("refuses pause before launch", async () => {
      const id = (await createLaunch()).json().id;
      const res = await act(id, "pause");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_launched");
    });

    it("re-checks guardrails on resume", async () => {
      const id = await approvedLaunch();
      await act(id, "launch");
      await act(id, "pause");

      await putSettings({ killSwitch: true });
      const killed = await act(id, "resume");
      expect(killed.statusCode).toBe(409);
      expect(killed.json().error).toBe("kill_switch_on");

      await putSettings({ killSwitch: false, dailyCapCents: 400 });
      const capped = await act(id, "resume");
      expect(capped.statusCode).toBe(409);
      expect(capped.json().error).toBe("daily_cap_exceeded");
    });
  });

  describe("settings + kill switch", () => {
    it("serves defaults and upserts", async () => {
      const defaults = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/settings` })
      ).json();
      expect(defaults).toMatchObject({ dailyCapCents: 5000, killSwitch: false });

      expect((await putSettings({ dailyCapCents: 12_000 })).statusCode).toBe(200);
      const updated = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/settings` })
      ).json();
      expect(updated).toMatchObject({ dailyCapCents: 12_000, killSwitch: false });
    });

    it("pauses every spending launch when the kill switch flips on", async () => {
      const first = await approvedLaunch({ dailyBudgetCents: 200 });
      const second = await approvedLaunch({ dailyBudgetCents: 300, name: "Second push" });
      await act(first, "launch");
      await act(second, "launch");

      const res = await putSettings({ killSwitch: true });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.settings.killSwitch).toBe(true);
      expect(body.paused).toHaveLength(2);
      expect(body.paused.every((p: { ok: boolean }) => p.ok)).toBe(true);

      for (const id of [first, second]) {
        expect((await getLaunch(id)).platformStatus).toBe("PAUSED");
      }
      expect(state.statusFlips.filter((f) => f.status === "PAUSED")).toHaveLength(2);
    });
  });

  describe("status sync", () => {
    it("stamps the platform's effective status on launches during ads sync", async () => {
      const id = await approvedLaunch();
      await act(id, "launch");
      state.effectiveStatus["cmp_1"] = "DISAPPROVED";

      const sync = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/sync`,
        payload: {},
      });
      expect(sync.statusCode).toBe(200);
      expect((await getLaunch(id)).platformStatus).toBe("DISAPPROVED");
    });

    it("never lets a status-listing failure break the metric sync", async () => {
      const id = await approvedLaunch();
      await act(id, "launch");
      state.failOn = "/campaigns?";

      const sync = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/sync`,
        payload: {},
      });
      expect(sync.statusCode).toBe(200);
      expect(sync.json().results[0].ok).toBe(true);
      // Status untouched, not corrupted.
      expect((await getLaunch(id)).platformStatus).toBe("ACTIVE");
    });
  });
});
