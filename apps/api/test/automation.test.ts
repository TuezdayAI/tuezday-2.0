import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_MODES,
  automationRunResultSchema,
  campaignSchema,
  socialAutomationSettingsSchema,
  updateCampaignAutomationInputSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { applyDraftAction, listDecisions, listDrafts, submitDraft } from "../src/services/drafts";
import { insertSignalMatch } from "../src/services/matching";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Auto headline\nThe generated body.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

// Monday 08:00:00 UTC — a fixed clock so slot timestamps are deterministic.
const MONDAY_8AM_UTC = new Date("2026-07-06T08:00:00Z");

interface FabricState {
  connections: Map<string, unknown>;
  posts: Array<{ sr: string; title: string }>;
  nextId: number;
}

function fabricState(): FabricState {
  return { connections: new Map(), posts: [], nextId: 1 };
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession(integrationKey, endUserId) {
      return { token: `tok-${integrationKey}-${endUserId}` };
    },
    async importConnection(_key, connectionId, credentials) {
      state.connections.set(connectionId, credentials);
    },
    async connectionExists(connectionId) {
      return state.connections.has(connectionId);
    },
    async deleteConnection(connectionId) {
      state.connections.delete(connectionId);
    },
    async proxyGet() {
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, opts): Promise<ProxyJsonResult> {
      if (method === "POST" && path.startsWith("/api/submit")) {
        const id = state.nextId++;
        const form = opts?.form ?? {};
        state.posts.push({ sr: form.sr ?? "", title: form.title ?? "" });
        return {
          status: 200,
          json: { json: { errors: [], data: { name: `t3_p${id}`, url: `https://reddit.com/p${id}` } } },
        };
      }
      if (method === "GET" && path.startsWith("/api/v1/me")) {
        return { status: 200, json: { name: "founder" } };
      }
      return { status: 404, json: { message: "no endpoint" } };
    },
  };
}

describe("social automation", () => {
  let app: TuezdayApp;
  let db: Db;
  let state: FabricState;
  let workspaceId: string;

  beforeEach(async () => {
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "csecret");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MONDAY_8AM_UTC);
    db = createTestDb();
    state = fabricState();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Auto" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });

  async function connectReddit(): Promise<string> {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session`,
    });
    const nangoConnectionId = `nango-${randomUUID()}`;
    state.connections.set(nangoConnectionId, { type: "OAUTH2" });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/reddit/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json().id;
  }

  async function createCampaign(
    channels: string[] = ["linkedin"],
    name = "Launch",
    personaIds: string[] = [],
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name, channels, personaIds },
    });
    return res.json().id;
  }

  async function createPersona(name = "Field CTO"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function setAutomation(campaignId: string, automationMode: string, autoDailyCap: number | null = null) {
    return app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/automation`,
      payload: { automationMode, autoDailyCap },
    });
  }

  async function setPublishPolicy(campaignId: string, rule: "autonomous" | "human_required") {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: campaignId,
        rules: [{ actionKind: "publish", rule }],
      },
    });
  }

  async function createSignal(content = "Competitor X launched a feature"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/signals`,
      payload: { content, source: "other" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  /** Seed a signal→campaign match directly (Sprint 45 routing reads these). */
  function seedMatch(
    signalId: string,
    campaignId: string,
    opts: { personaId?: string | null; score?: number } = {},
  ): void {
    insertSignalMatch(db, workspaceId, signalId, {
      personaId: opts.personaId ?? null,
      campaignId,
      score: opts.score ?? 80,
      reason: "test match",
    });
  }

  async function run() {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/automation/run` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function createCadence(over: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences`,
      payload: {
        name: "Cadence",
        channel: "linkedin",
        target: "test",
        daysOfWeek: [1],
        timeOfDay: "09:00",
        timezone: "America/New_York",
        ...over,
      },
    });
    return res;
  }

  function seedApprovedDraft(campaignId: string, channel = "linkedin"): string {
    const draft = submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId,
        personaId: null,
        taskType: "linkedin_post",
        channel: channel as never,
        content: "Seeded headline\nbody",
      },
      { userId: null, label: "test" },
    );
    return applyDraftAction(db, draft, "approve", { userId: null, label: "test" }).id;
  }

  // --- Contracts ------------------------------------------------------------

  describe("contracts", () => {
    it("defines the three automation modes and parses the schemas", () => {
      expect(AUTOMATION_MODES).toEqual(["manual", "human_in_the_loop", "scheduled_auto"]);
      expect(updateCampaignAutomationInputSchema.parse({ automationMode: "scheduled_auto" }).autoDailyCap).toBeNull();
      expect(
        socialAutomationSettingsSchema.safeParse({
          workspaceId: randomUUID(),
          killSwitch: false,
          perConnectionDailyCap: 10,
          perCampaignDailyCap: 5,
          autoReplyEnabled: false,
          matchThreshold: 50,
          updatedAt: 0,
        }).success,
      ).toBe(true);
      expect(
        automationRunResultSchema.safeParse({ results: [], ranAt: Date.now() }).success,
      ).toBe(true);
    });

    it("campaign round-trips with automationMode + autoDailyCap", async () => {
      const id = await createCampaign();
      const patched = (await setAutomation(id, "scheduled_auto", 3)).json();
      expect(campaignSchema.safeParse(patched).success).toBe(true);
      expect(patched.automationMode).toBe("scheduled_auto");
      expect(patched.autoDailyCap).toBe(3);
      // A general campaign edit must not silently reset automation back to manual.
      await app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/campaigns/${id}`,
        payload: { name: "Renamed" },
      });
      const after = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/campaigns/${id}` })
      ).json();
      expect(after.campaign.automationMode).toBe("scheduled_auto");
      expect(after.campaign.autoDailyCap).toBe(3);
    });

    it("rejects a non-positive autoDailyCap", async () => {
      const id = await createCampaign();
      const res = await setAutomation(id, "scheduled_auto", 0);
      expect(res.statusCode).toBe(400);
    });
  });

  // --- Settings -------------------------------------------------------------

  describe("settings", () => {
    it("returns defaults then persists updates", async () => {
      const initial = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/automation/settings` })
      ).json();
      expect(initial).toMatchObject({
        killSwitch: false,
        perConnectionDailyCap: 10,
        perCampaignDailyCap: 5,
        matchThreshold: 50,
      });

      const updated = (
        await app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/automation/settings`,
          payload: { killSwitch: true, perConnectionDailyCap: 3, perCampaignDailyCap: 2, matchThreshold: 40 },
        })
      ).json();
      expect(updated).toMatchObject({
        killSwitch: true,
        perConnectionDailyCap: 3,
        perCampaignDailyCap: 2,
        matchThreshold: 40,
      });

      const bad = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/automation/settings`,
        payload: { perCampaignDailyCap: 0 },
      });
      expect(bad.statusCode).toBe(400);

      const badThreshold = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/automation/settings`,
        payload: { matchThreshold: 101 },
      });
      expect(badThreshold.statusCode).toBe(400);
    });
  });

  // --- Orchestrator modes ---------------------------------------------------

  it("manual mode generates nothing", async () => {
    const id = await createCampaign();
    await createSignal();
    const result = await run();
    // manual campaigns are not even in the automated set
    expect(result.results).toHaveLength(0);
    expect(listDrafts(db, workspaceId)).toHaveLength(0);
    void id;
  });

  it("human_in_the_loop drafts one per channel to the gate, idempotently", async () => {
    const id = await createCampaign(["linkedin", "x"]);
    await setAutomation(id, "human_in_the_loop");
    const signalId = await createSignal();
    seedMatch(signalId, id);

    const first = await run();
    expect(first.results[0]).toMatchObject({ mode: "human_in_the_loop", generated: 2, autoApproved: 0 });
    const drafts = listDrafts(db, workspaceId);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.state === "pending_review")).toBe(true);
    expect(drafts.every((d) => d.campaignId === id && d.sourceSignalId === signalId)).toBe(true);
    expect(new Set(drafts.map((d) => d.channel))).toEqual(new Set(["linkedin", "x"]));

    // Idempotent — a second run adds nothing for the same signal.
    const second = await run();
    expect(second.results[0].generated).toBe(0);
    expect(listDrafts(db, workspaceId)).toHaveLength(2);

    // A new matched signal fans out again.
    const secondSignal = await createSignal("Another market signal");
    seedMatch(secondSignal, id);
    await run();
    expect(listDrafts(db, workspaceId)).toHaveLength(4);
  });

  it("scheduled_auto auto-approves through the gate and posts on the cadence", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign(["linkedin"]);
    await setAutomation(campaignId, "scheduled_auto");
    await setPublishPolicy(campaignId, "autonomous");
    const signalId = await createSignal();
    seedMatch(signalId, campaignId);

    const result = await run();
    expect(result.results[0]).toMatchObject({ mode: "scheduled_auto", generated: 1, autoApproved: 1 });

    const [draft] = listDrafts(db, workspaceId, "approved");
    expect(draft).toBeTruthy();
    const decisions = listDecisions(db, draft!.id);
    expect(decisions.map((d) => d.action)).toEqual(["submit", "approve"]);
    expect(decisions.every((d) => d.actor === "system")).toBe(true);

    // The cadence slots the auto-approved draft, then the publish worker fires it.
    const cadence = await createCadence({ campaignId, connectionId });
    expect(cadence.statusCode).toBe(201);
    const fill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${cadence.json().id}/fill`,
    });
    expect(fill.json().filled).toBe(1);

    vi.setSystemTime(new Date("2026-07-06T13:05:00Z")); // past the 09:00 EDT (13:00Z) slot
    const published = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/publish/run` });
    expect(
      published
        .json()
        .actions.filter((submission: { action: { status: string } }) => submission.action.status === "succeeded"),
    ).toHaveLength(1);
    expect(state.posts).toHaveLength(1);
  });

  // --- Match-driven routing (Sprint 45) ---------------------------------------

  describe("match-driven routing", () => {
    it("routes a signal only to the campaign it matched, as the match's persona", async () => {
      const personaId = await createPersona("Field CTO");
      const campaignA = await createCampaign(["linkedin"], "Product Launch", [personaId]);
      const campaignB = await createCampaign(["x"], "Community");
      await setAutomation(campaignA, "human_in_the_loop");
      await setAutomation(campaignB, "human_in_the_loop");
      const signalId = await createSignal("Agentic coding benchmark released");
      seedMatch(signalId, campaignA, { personaId, score: 80 });

      const result = await run();
      const rowA = result.results.find((r: { campaignId: string }) => r.campaignId === campaignA);
      const rowB = result.results.find((r: { campaignId: string }) => r.campaignId === campaignB);
      expect(rowA).toMatchObject({ generated: 1, autoApproved: 0, skipped: 0, blocked: null });
      // The unmatched campaign generates nothing but still reports a result row.
      expect(rowB).toMatchObject({ generated: 0, autoApproved: 0, skipped: 0, blocked: null });

      const drafts = listDrafts(db, workspaceId);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        campaignId: campaignA,
        channel: "linkedin",
        personaId,
        sourceSignalId: signalId,
      });

      // Re-running with the same match set adds nothing (hasDraftFor idempotency).
      const again = await run();
      expect(again.results.every((r: { generated: number }) => r.generated === 0)).toBe(true);
      expect(listDrafts(db, workspaceId)).toHaveLength(1);
    });

    it("a signal matching two campaigns generates for both, each as its own persona", async () => {
      const personaA = await createPersona("Field CTO");
      const personaB = await createPersona("Community Lead");
      const campaignA = await createCampaign(["linkedin"], "Product Launch", [personaA]);
      const campaignB = await createCampaign(["x"], "Community", [personaB]);
      await setAutomation(campaignA, "human_in_the_loop");
      await setAutomation(campaignB, "human_in_the_loop");
      const signalId = await createSignal("Relevant to both pipelines");
      seedMatch(signalId, campaignA, { personaId: personaA, score: 80 });
      seedMatch(signalId, campaignB, { personaId: personaB, score: 70 });

      const result = await run();
      const rowA = result.results.find((r: { campaignId: string }) => r.campaignId === campaignA);
      const rowB = result.results.find((r: { campaignId: string }) => r.campaignId === campaignB);
      expect(rowA).toMatchObject({ generated: 1 });
      expect(rowB).toMatchObject({ generated: 1 });

      const drafts = listDrafts(db, workspaceId);
      expect(drafts).toHaveLength(2);
      const byCampaign = new Map(drafts.map((d) => [d.campaignId, d]));
      expect(byCampaign.get(campaignA)?.personaId).toBe(personaA);
      expect(byCampaign.get(campaignB)?.personaId).toBe(personaB);
    });

    it("a below-threshold match generates nothing until the threshold is lowered", async () => {
      const campaignId = await createCampaign(["linkedin"]);
      await setAutomation(campaignId, "human_in_the_loop");
      const signalId = await createSignal();
      seedMatch(signalId, campaignId, { score: 30 }); // below the default threshold of 50

      const first = await run();
      expect(first.results[0]).toMatchObject({ generated: 0, autoApproved: 0, skipped: 0, blocked: null });
      expect(listDrafts(db, workspaceId)).toHaveLength(0);

      const patched = (
        await app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/automation/settings`,
          payload: { matchThreshold: 30 },
        })
      ).json();
      expect(patched.matchThreshold).toBe(30);

      // 30 >= 30 — the threshold is inclusive, so the match now qualifies.
      const second = await run();
      expect(second.results[0].generated).toBe(1);
      expect(listDrafts(db, workspaceId)).toHaveLength(1);
    });

    it("a signal with no matches at all generates nothing", async () => {
      const campaignId = await createCampaign(["linkedin"]);
      await setAutomation(campaignId, "human_in_the_loop");
      await createSignal("Unrouted noise");

      const result = await run();
      expect(result.results[0]).toMatchObject({ generated: 0, autoApproved: 0, skipped: 0, blocked: null });
      expect(listDrafts(db, workspaceId)).toHaveLength(0);
    });
  });

  // --- Guardrails -----------------------------------------------------------

  it("kill switch stops auto-posting but not human-gated cadences", async () => {
    const connectionId = await connectReddit();
    const autoCampaign = await createCampaign(["linkedin"], "Auto");
    await setAutomation(autoCampaign, "scheduled_auto");

    // Seed an approved auto-draft + cadence, fill once (switch off) → 1 scheduled.
    seedApprovedDraft(autoCampaign);
    const autoCadence = (await createCadence({ campaignId: autoCampaign, connectionId })).json();
    const firstFill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${autoCadence.id}/fill`,
    });
    expect(firstFill.json().filled).toBe(1);

    // Flip the kill switch on.
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { killSwitch: true },
    });

    // run() now auto-approves nothing for scheduled_auto campaigns.
    await createSignal();
    const result = await run();
    expect(result.results[0]).toMatchObject({ blocked: "kill_switch_on", generated: 0, autoApproved: 0 });

    // A re-fill of the auto cadence slots nothing AND cancels its pending post.
    const refill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${autoCadence.id}/fill`,
    });
    expect(refill.json().filled).toBe(0);
    const cadencePubs = listDrafts(db, workspaceId); // approved seed draft still exists
    expect(cadencePubs.length).toBeGreaterThan(0);
    const detail = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/cadences/${autoCadence.id}` })
    ).json();
    expect(detail.publications ?? []).toHaveLength(0); // pending scheduled post canceled

    // A manual campaign's cadence still fills despite the kill switch.
    const manualCampaign = await createCampaign(["linkedin"], "Manual");
    seedApprovedDraft(manualCampaign);
    const manualCadence = (await createCadence({ campaignId: manualCampaign, connectionId })).json();
    const manualFill = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/cadences/${manualCadence.id}/fill`,
    });
    expect(manualFill.json().filled).toBe(1);
  });

  // Two Monday cadences at 09:00 and 10:00 put two slots on the same UTC day
  // (and again the following Monday), so a per-UTC-day cap of 1 must collapse the
  // two same-day slots into one post each day — total 2 across the two Mondays in
  // the 14-day horizon (it would be 4 uncapped).
  async function runCadences(): Promise<number> {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/cadences/run` });
    return res.json().results.reduce((s: number, r: { filled: number }) => s + r.filled, 0);
  }

  it("per-campaign daily cap collapses same-day auto-posts", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign(["linkedin"]);
    await setAutomation(campaignId, "scheduled_auto", 1); // 1 auto-post per campaign per day
    await setPublishPolicy(campaignId, "autonomous");
    for (let i = 0; i < 4; i++) seedApprovedDraft(campaignId);
    await createCadence({ campaignId, connectionId, name: "9am", timeOfDay: "09:00" });
    await createCadence({ campaignId, connectionId, name: "10am", timeOfDay: "10:00" });

    expect(await runCadences()).toBe(2); // one per Monday, the same-day duplicate capped
  });

  it("per-connection daily cap collapses same-day auto-posts", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign(["linkedin"]);
    await setAutomation(campaignId, "scheduled_auto", 50); // campaign cap out of the way
    await setPublishPolicy(campaignId, "autonomous");
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { perConnectionDailyCap: 1 },
    });
    for (let i = 0; i < 4; i++) seedApprovedDraft(campaignId);
    await createCadence({ campaignId, connectionId, name: "9am", timeOfDay: "09:00" });
    await createCadence({ campaignId, connectionId, name: "10am", timeOfDay: "10:00" });

    expect(await runCadences()).toBe(2); // one per Monday on this connection
  });
});
