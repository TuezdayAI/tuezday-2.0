import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEQUENCE_CHANNELS,
  SEQUENCE_RECIPIENT_STATUSES,
  setSequenceInputSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import { inboxItems, socialAutomationSettings } from "../src/db/schema";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Personalized sequence message.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

// ---------------------------------------------------------------------------
// Minimal fake fabric — just enough X-DM behaviour for sequence dispatch.
// ---------------------------------------------------------------------------

interface State {
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  integrations: Set<string>;
  sessions: number;
  dms: number;
}

function newState(): State {
  return { connections: new Map(), integrations: new Set(), sessions: 0, dms: 0 };
}

function handle(state: State, _method: string, path: string): ProxyJsonResult {
  const p = path.split("?")[0]!;
  if (p.startsWith("/2/users/by/username/")) {
    const h = decodeURIComponent(p.split("/").pop()!);
    return { status: 200, json: { data: { id: `x-${h}`, username: h } } };
  }
  if (p.startsWith("/2/dm_conversations/with/")) {
    state.dms += 1;
    return { status: 201, json: { data: { dm_event_id: `dm-${state.dms}` } } };
  }
  return { status: 404, json: { error: { message: `no endpoint for ${p}` } } };
}

function fakeFabric(state: State): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration(uniqueKey) {
      state.integrations.add(uniqueKey);
    },
    async createConnectSession() {
      state.sessions += 1;
      return { token: `session-${state.sessions}` };
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
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path) {
      return handle(state, method, path);
    },
  };
}

// ---------------------------------------------------------------------------
// Contracts vocab
// ---------------------------------------------------------------------------

describe("sequence contracts", () => {
  it("exposes the sequence vocabulary", () => {
    expect(SEQUENCE_CHANNELS).toEqual(["email", "x"]);
    expect(SEQUENCE_RECIPIENT_STATUSES).toContain("replied");
    expect(SEQUENCE_RECIPIENT_STATUSES).toContain("stopped");
    expect(SEQUENCE_RECIPIENT_STATUSES).toContain("completed");
  });

  it("rejects step lists with gaps or duplicates and accepts a contiguous chain", () => {
    expect(setSequenceInputSchema.safeParse({ steps: [{ channel: "email", stepNumber: 2 }] }).success).toBe(
      false,
    );
    expect(
      setSequenceInputSchema.safeParse({
        steps: [
          { channel: "email", stepNumber: 1 },
          { channel: "email", stepNumber: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      setSequenceInputSchema.safeParse({
        steps: [
          { channel: "email", stepNumber: 1, instruction: "", delayHours: 0 },
          { channel: "email", stepNumber: 2, instruction: "bump", delayHours: 24 },
        ],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe("multi-step sequences", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let state: State;
  const T0 = new Date("2026-07-06T08:00:00Z"); // a Monday, deterministic
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.stubEnv("TWITTER_CLIENT_ID", "cid");
    vi.stubEnv("TWITTER_CLIENT_SECRET", "csecret");
    db = createTestDb();
    state = newState();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Seq" } })
    ).json().id;
    // Legacy engine scenarios: sends run autonomously so kill-switch/stop-on-
    // reply behaviour stays observable. The send authorization queue is covered
    // in external-action-messaging.test.ts.
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, {
      send: "autonomous",
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });

  function setNow(ms: number): void {
    vi.setSystemTime(new Date(ms));
  }

  async function createLead(name: string, xHandle = ""): Promise<string> {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name, email: `${name.toLowerCase()}@acme.com`, company: "Acme", role: "VP", xHandle },
      })
    ).json().id;
  }

  async function audienceOf(leadIds: string[]): Promise<string> {
    const id = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences`,
        payload: { name: "Targets", kind: "static" },
      })
    ).json().id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/audiences/${id}/members`,
      payload: { members: leadIds.map((lid) => ({ type: "lead", id: lid })) },
    });
    return id;
  }

  async function makeLaunch(
    channels: string[],
    audienceId: string,
    automationMode: string,
    stopOnReply = true,
  ): Promise<string> {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: { name: "Outreach", audienceId, channels, automationMode, stopOnReply },
      })
    ).json().id;
  }

  function setSequence(launchId: string, steps: unknown[]) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence`,
      payload: { steps },
    });
  }

  const start = (launchId: string) =>
    app.inject({ method: "POST", url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/start` });
  const runSeq = (launchId: string) =>
    app.inject({ method: "POST", url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/run` });
  const runAll = () => app.inject({ method: "POST", url: `/workspaces/${workspaceId}/sequences/run` });
  const detail = (launchId: string) =>
    app.inject({ method: "GET", url: `/workspaces/${workspaceId}/launches/${launchId}` }).then((r) => r.json());
  const exportCsv = (launchId: string) =>
    app.inject({ method: "GET", url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv` });

  async function connectTwitter(): Promise<string> {
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/connectors/twitter/oauth/session` });
    const nangoId = `nango-twitter-${randomUUID()}`;
    state.connections.set(nangoId, { providerConfigKey: "tuezday-twitter", credentials: { type: "OAUTH2" } });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/twitter/oauth/complete`,
      payload: { connectionId: nangoId },
    });
    return complete.json().id as string;
  }

  async function approve(draftId: string): Promise<void> {
    const r = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/drafts/${draftId}/approve` });
    expect(r.statusCode).toBe(200);
  }

  function emailMessages(d: {
    messages: Array<{
      channel: string;
      draftId: string;
      status: string;
      draftState: string;
      stepNumber: number;
      recipientName: string;
    }>;
  }) {
    return d.messages.filter((m) => m.channel === "email");
  }

  it("refuses /generate on a sequence launch and /start with no sequence", async () => {
    const lead = await createLead("Alice");
    const aud = await audienceOf([lead]);
    const launchId = await makeLaunch(["email"], aud, "manual");

    const noSeq = await start(launchId);
    expect(noSeq.statusCode).toBe(409);
    expect(noSeq.json().error).toBe("no_sequence");

    await setSequence(launchId, [{ channel: "email", stepNumber: 1, instruction: "", delayHours: 0 }]);
    const gen = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/generate`,
      payload: {},
    });
    expect(gen.statusCode).toBe(409);
    expect(gen.json().error).toBe("is_sequence");
  });

  it("only accepts steps for channels the launch selected", async () => {
    const lead = await createLead("Alice");
    const aud = await audienceOf([lead]);
    const launchId = await makeLaunch(["email"], aud, "manual");

    const badChannel = await setSequence(launchId, [{ channel: "x", stepNumber: 1 }]);
    expect(badChannel.statusCode).toBe(400);
    expect(badChannel.json().error).toBe("channel_not_in_launch");

    const ok = await setSequence(launchId, [
      { channel: "email", stepNumber: 1, instruction: "", delayHours: 0 },
      { channel: "email", stepNumber: 2, instruction: "bump", delayHours: 24 },
    ]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().steps).toHaveLength(2);
  });

  it("runs a 3-step email chain on schedule in scheduled_auto, then completes", async () => {
    const lead = await createLead("Alice");
    const aud = await audienceOf([lead]);
    const launchId = await makeLaunch(["email"], aud, "scheduled_auto");
    await setSequence(launchId, [
      { channel: "email", stepNumber: 1, instruction: "", delayHours: 0 },
      { channel: "email", stepNumber: 2, instruction: "add the case study", delayHours: 24 },
      { channel: "email", stepNumber: 3, instruction: "breakup note", delayHours: 24 },
    ]);

    const started = await start(launchId);
    expect(started.statusCode).toBe(200);
    expect(started.json().enrolled).toBe(1);

    let d = await detail(launchId);
    expect(d.sequenceRecipients).toHaveLength(1);
    expect(d.sequenceRecipients[0].currentStep).toBe(1);
    expect(d.sequenceRecipients[0].status).toBe("active");
    // Step 1 auto-approved, awaiting the manual export (deliverability boundary).
    expect(emailMessages(d)).toHaveLength(1);
    expect(emailMessages(d)[0]!.draftState).toBe("approved");
    expect(emailMessages(d)[0]!.status).toBe("pending");

    // Export step 1 → marks it sent, starting the next step's delay clock.
    expect((await exportCsv(launchId)).statusCode).toBe(200);
    expect(emailMessages(await detail(launchId))[0]!.status).toBe("sent");

    // Before the delay elapses, no step 2.
    await runSeq(launchId);
    expect(emailMessages(await detail(launchId))).toHaveLength(1);

    // After 24h, step 2 generates + auto-approves.
    setNow(T0.getTime() + 24 * HOUR + 60_000);
    await runSeq(launchId);
    d = await detail(launchId);
    const step2 = emailMessages(d).find((m) => m.stepNumber === 2);
    expect(step2).toBeTruthy();
    expect(step2!.draftState).toBe("approved");
    await exportCsv(launchId);

    // After another 24h, step 3 generates; export; then the recipient completes.
    setNow(T0.getTime() + 48 * HOUR + 120_000);
    await runSeq(launchId);
    expect(emailMessages(await detail(launchId)).some((m) => m.stepNumber === 3)).toBe(true);
    await exportCsv(launchId);
    await runSeq(launchId);
    expect((await detail(launchId)).sequenceRecipients[0].status).toBe("completed");
  });

  it("a manual stop halts one recipient's email chain while others continue", async () => {
    const alice = await createLead("Alice");
    const bob = await createLead("Bob");
    const aud = await audienceOf([alice, bob]);
    const launchId = await makeLaunch(["email"], aud, "scheduled_auto");
    await setSequence(launchId, [
      { channel: "email", stepNumber: 1, instruction: "", delayHours: 0 },
      { channel: "email", stepNumber: 2, instruction: "bump", delayHours: 24 },
    ]);
    await start(launchId);
    await exportCsv(launchId); // step 1 sent for both

    const stop = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/stop`,
      payload: { emails: ["alice@acme.com"] },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().stopped).toBe(1);

    setNow(T0.getTime() + 24 * HOUR + 60_000);
    await runSeq(launchId);
    const d = await detail(launchId);
    const aliceR = d.sequenceRecipients.find((r: { recipientName: string }) => r.recipientName === "Alice");
    const bobR = d.sequenceRecipients.find((r: { recipientName: string }) => r.recipientName === "Bob");
    expect(aliceR.status).toBe("stopped");
    expect(emailMessages(d).filter((m) => m.recipientName === "Alice")).toHaveLength(1); // no step 2
    expect(bobR.status).toBe("active");
    expect(emailMessages(d).some((m) => m.recipientName === "Bob" && m.stepNumber === 2)).toBe(true);
  });

  it("auto-sends X DMs and stops the chain when a recipient replies", async () => {
    const connectionId = await connectTwitter();
    const alice = await createLead("Alice", "alice");
    const bob = await createLead("Bob", "bob");
    const aud = await audienceOf([alice, bob]);
    const launchId = await makeLaunch(["x"], aud, "scheduled_auto", true);
    await setSequence(launchId, [
      { channel: "x", stepNumber: 1, instruction: "", delayHours: 0 },
      { channel: "x", stepNumber: 2, instruction: "bump", delayHours: 24 },
    ]);

    await start(launchId);
    expect(state.dms).toBe(2); // both DM 1s sent at start
    let d = await detail(launchId);
    expect(d.messages.filter((m: { channel: string; status: string }) => m.channel === "x" && m.status === "sent")).toHaveLength(2);

    // Alice replies (Sprint 29 inbox row), after her DM 1 went out.
    const now = Date.now();
    db.insert(inboxItems)
      .values({
        id: randomUUID(),
        workspaceId,
        connectionId,
        providerKey: "twitter",
        kind: "dm",
        channel: "x",
        externalId: "reply-1",
        parentExternalId: null,
        publicationId: null,
        launchMessageId: null,
        authorHandle: "alice",
        authorName: "Alice",
        content: "interested!",
        url: null,
        status: "unread",
        replyDraftId: null,
        postedReplyExternalId: null,
        postedReplyUrl: null,
        externalCreatedAt: T0.getTime() + HOUR,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    setNow(T0.getTime() + 24 * HOUR + 60_000);
    await runSeq(launchId);
    d = await detail(launchId);
    const aliceR = d.sequenceRecipients.find((r: { recipientName: string }) => r.recipientName === "Alice");
    const bobR = d.sequenceRecipients.find((r: { recipientName: string }) => r.recipientName === "Bob");
    expect(aliceR.status).toBe("replied");
    expect(bobR.status).toBe("active");
    expect(state.dms).toBe(3); // only Bob's DM 2 went out
    expect(
      d.messages.some(
        (m: { recipientName: string; stepNumber: number }) => m.recipientName === "Alice" && m.stepNumber === 2,
      ),
    ).toBe(false);
  });

  it("human_in_the_loop parks each X step at the gate until approved", async () => {
    await connectTwitter();
    const alice = await createLead("Alice", "alice");
    const aud = await audienceOf([alice]);
    const launchId = await makeLaunch(["x"], aud, "human_in_the_loop");
    await setSequence(launchId, [{ channel: "x", stepNumber: 1, instruction: "", delayHours: 0 }]);

    await start(launchId);
    let d = await detail(launchId);
    const step1 = d.messages.find((m: { channel: string }) => m.channel === "x");
    expect(step1.draftState).toBe("pending_review"); // NOT auto-approved
    expect(step1.status).toBe("pending"); // NOT sent
    expect(state.dms).toBe(0);

    await approve(step1.draftId);
    await runSeq(launchId);
    d = await detail(launchId);
    expect(d.messages.find((m: { channel: string }) => m.channel === "x").status).toBe("sent");
    expect(state.dms).toBe(1);
  });

  it("manual launches never advance on the worker tick; the founder drives them", async () => {
    await connectTwitter();
    const alice = await createLead("Alice", "alice");
    const aud = await audienceOf([alice]);
    const launchId = await makeLaunch(["x"], aud, "manual");
    await setSequence(launchId, [{ channel: "x", stepNumber: 1, instruction: "", delayHours: 0 }]);

    await start(launchId);
    let d = await detail(launchId);
    const step1 = d.messages.find((m: { channel: string }) => m.channel === "x");
    expect(step1.draftState).toBe("pending_review");
    expect(state.dms).toBe(0);

    await runAll(); // worker tick — manual launches are skipped
    expect(state.dms).toBe(0);

    await approve(step1.draftId);
    await runSeq(launchId); // explicit founder run
    expect((await detail(launchId)).messages.find((m: { channel: string }) => m.channel === "x").status).toBe("sent");
    expect(state.dms).toBe(1);
  });

  it("the kill switch holds an auto X DM (chain pauses, not errors)", async () => {
    await connectTwitter();
    const now = Date.now();
    db.insert(socialAutomationSettings)
      .values({
        workspaceId,
        killSwitch: 1,
        perConnectionDailyCap: 10,
        perCampaignDailyCap: 5,
        autoReplyEnabled: 0,
        updatedAt: now,
      })
      .run();

    const alice = await createLead("Alice", "alice");
    const aud = await audienceOf([alice]);
    const launchId = await makeLaunch(["x"], aud, "scheduled_auto", false);
    await setSequence(launchId, [{ channel: "x", stepNumber: 1, instruction: "", delayHours: 0 }]);

    await start(launchId);
    let d = await detail(launchId);
    const step1 = d.messages.find((m: { channel: string }) => m.channel === "x");
    expect(step1.draftState).toBe("approved"); // auto-approve still happens
    expect(step1.status).toBe("pending"); // but the send is held
    expect(state.dms).toBe(0);
    expect(d.sequenceRecipients[0].status).toBe("active"); // not failed — it retries

    // Turn the kill switch off; the held step now dispatches.
    db.insert(socialAutomationSettings)
      .values({ workspaceId, killSwitch: 0, perConnectionDailyCap: 10, perCampaignDailyCap: 5, autoReplyEnabled: 0, updatedAt: now })
      .onConflictDoUpdate({ target: socialAutomationSettings.workspaceId, set: { killSwitch: 0 } })
      .run();

    await runSeq(launchId);
    expect((await detail(launchId)).messages.find((m: { channel: string }) => m.channel === "x").status).toBe("sent");
    expect(state.dms).toBe(1);
  });
});
