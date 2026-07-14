import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_ITEM_KINDS,
  INBOX_ITEM_STATUSES,
  METRIC_WINDOWS,
  TASK_TYPES,
  inboxItemSchema,
  inboxRunResultSchema,
  publicationMetricSchema,
  socialAutomationSettingsSchema,
  updateInboxItemStatusInputSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { applyDraftAction, listDecisions, submitDraft } from "../src/services/drafts";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Thanks for the thoughtful comment — here's our take.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const MONDAY_8AM_UTC = new Date("2026-07-06T08:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface RedditComment {
  name: string;
  parent_id: string;
  author: string;
  body: string;
  permalink: string;
  created_utc: number;
}

interface FabricState {
  connections: Map<string, unknown>;
  nextPostId: number;
  nextReplyId: number;
  /** Comments on a post, keyed by the post's bare id (e.g. "p1"). */
  comments: Map<string, RedditComment[]>;
  /** Engagement keyed by the post's t3 fullname. */
  engagement: Map<string, { score: number; num_comments: number }>;
  postedReplies: Array<{ thing_id: string; text: string }>;
}

function fabricState(): FabricState {
  return {
    connections: new Map(),
    nextPostId: 1,
    nextReplyId: 1,
    comments: new Map(),
    engagement: new Map(),
    postedReplies: [],
  };
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
        const id = state.nextPostId++;
        return {
          status: 200,
          json: { json: { errors: [], data: { name: `t3_p${id}`, url: `https://reddit.com/p${id}` } } },
        };
      }
      if (method === "GET" && path.startsWith("/comments/")) {
        const bare = path.replace("/comments/", "");
        const children = (state.comments.get(bare) ?? []).map((c) => ({ kind: "t1", data: c }));
        return { status: 200, json: [{ data: { children: [] } }, { data: { children } }] };
      }
      if (method === "GET" && path.startsWith("/api/info")) {
        const id = new URLSearchParams(path.split("?")[1] ?? "").get("id") ?? "";
        const e = state.engagement.get(id) ?? { score: 0, num_comments: 0 };
        return { status: 200, json: { data: { children: [{ data: e }] } } };
      }
      if (method === "POST" && path.startsWith("/api/comment")) {
        const form = opts?.form ?? {};
        const id = state.nextReplyId++;
        state.postedReplies.push({ thing_id: form.thing_id ?? "", text: form.text ?? "" });
        return {
          status: 200,
          json: {
            json: {
              errors: [],
              data: { things: [{ kind: "t1", data: { name: `t1_r${id}`, permalink: `/r/test/comments/x/r${id}/` } }] },
            },
          },
        };
      }
      return { status: 404, json: { message: "no endpoint" } };
    },
  };
}

describe("engagement & reply inbox", () => {
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
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Inbox" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "workspace",
        scopeId: workspaceId,
        rules: [{ actionKind: "publish", rule: "autonomous" }],
      },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });

  async function connectReddit(): Promise<string> {
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/connectors/reddit/oauth/session` });
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

  async function createCampaign(automationMode = "manual"): Promise<string> {
    const id = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", channels: ["linkedin"] },
      })
    ).json().id;
    if (automationMode !== "manual") {
      await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/campaigns/${id}/automation`,
        payload: { automationMode },
      });
    }
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: id,
        rules: [{ actionKind: "publish", rule: "autonomous" }],
      },
    });
    return id;
  }

  function seedApprovedDraft(campaignId: string): string {
    const draft = submitDraft(
      db,
      {
        workspaceId,
        sourceGenerationId: randomUUID(),
        campaignId,
        personaId: null,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "Our original post body.",
      },
      { userId: null, label: "test" },
    );
    return applyDraftAction(db, draft, "approve", { userId: null, label: "test" }).id;
  }

  /** Publish an approved draft to Reddit (post-now) and return its receipt. */
  async function publishPost(connectionId: string, campaignId: string) {
    const draftId = seedApprovedDraft(campaignId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/publish`,
      payload: { connectionId, target: "r/test", title: "Our original post" },
    });
    expect(res.json().action.status).toBe("succeeded");
    const pub = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
    ).json()[0];
    expect(pub.externalId).toBeTruthy();
    return pub;
  }

  function addComment(postExternalId: string, over: Partial<RedditComment> = {}): void {
    const bare = postExternalId.replace(/^t3_/, "");
    const list = state.comments.get(bare) ?? [];
    const n = list.length + 1;
    list.push({
      name: `t1_c${bare}_${n}`,
      parent_id: postExternalId,
      author: "curious_dev",
      body: "Great point — how does this handle X?",
      permalink: `/r/test/comments/x/c${n}/`,
      created_utc: Math.floor(MONDAY_8AM_UTC.getTime() / 1000) + n,
      ...over,
    });
    state.comments.set(bare, list);
  }

  async function runInbox() {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/run` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function listInbox(status?: string) {
    const url = status
      ? `/workspaces/${workspaceId}/inbox?status=${status}`
      : `/workspaces/${workspaceId}/inbox`;
    return (await app.inject({ method: "GET", url })).json();
  }

  async function setAutoReply(on: boolean) {
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { autoReplyEnabled: on },
    });
  }

  // --- Contracts ------------------------------------------------------------

  describe("contracts", () => {
    it("defines the inbox + metric vocabulary and parses the schemas", () => {
      expect(INBOX_ITEM_KINDS).toEqual(["comment", "dm"]);
      expect(INBOX_ITEM_STATUSES).toEqual(["unread", "read", "replied", "dismissed"]);
      expect(METRIC_WINDOWS).toEqual(["24h", "7d"]);
      expect(TASK_TYPES).toContain("engagement_reply");
      expect(updateInboxItemStatusInputSchema.safeParse({ status: "read" }).success).toBe(true);
      expect(updateInboxItemStatusInputSchema.safeParse({ status: "replied" }).success).toBe(false);
      expect(
        inboxRunResultSchema.safeParse({
          polled: 0,
          newItems: 0,
          metricsCaptured: 0,
          repliesGenerated: 0,
          repliesAutoApproved: 0,
          repliesPosted: 0,
          ranAt: Date.now(),
        }).success,
      ).toBe(true);
      expect(
        socialAutomationSettingsSchema.safeParse({
          workspaceId: randomUUID(),
          killSwitch: false,
          perConnectionDailyCap: 10,
          perCampaignDailyCap: 5,
          autoReplyEnabled: true,
          matchThreshold: 50,
          updatedAt: 0,
        }).success,
      ).toBe(true);
    });
  });

  // --- Polling --------------------------------------------------------------

  it("polls comments on a published post into the inbox, idempotently", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);
    addComment(pub.externalId, { body: "Second comment", author: "another_user" });

    const first = await runInbox();
    expect(first.newItems).toBe(2);
    const items = await listInbox();
    expect(items).toHaveLength(2);
    expect(items.every((i: { kind: string }) => i.kind === "comment")).toBe(true);
    expect(items.every((i: { publicationId: string }) => i.publicationId === pub.id)).toBe(true);
    expect(items.every((i: { status: string }) => i.status === "unread")).toBe(true);
    expect(inboxItemSchema.safeParse(items[0]).success).toBe(true);

    // Idempotent — re-running with the same payload adds nothing.
    const second = await runInbox();
    expect(second.newItems).toBe(0);
    expect(await listInbox()).toHaveLength(2);

    // A new comment is picked up.
    addComment(pub.externalId, { body: "Third!", author: "late_arrival" });
    const third = await runInbox();
    expect(third.newItems).toBe(1);
    expect(await listInbox()).toHaveLength(3);
  });

  // --- Engagement metrics ---------------------------------------------------

  it("captures engagement at the 24h and 7d windows", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    const pub = await publishPost(connectionId, campaignId);
    state.engagement.set(pub.externalId, { score: 12, num_comments: 3 });

    // Before 24h: nothing captured.
    expect((await runInbox()).metricsCaptured).toBe(0);

    // Past 24h: one snapshot.
    vi.setSystemTime(new Date(MONDAY_8AM_UTC.getTime() + DAY_MS + 60_000));
    expect((await runInbox()).metricsCaptured).toBe(1);

    const pubs = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })).json();
    const mine = pubs.find((p: { id: string }) => p.id === pub.id);
    expect(mine.metrics).toHaveLength(1);
    expect(mine.metrics[0]).toMatchObject({ window: "24h", likes: 12, comments: 3 });
    expect(publicationMetricSchema.safeParse(mine.metrics[0]).success).toBe(true);

    // Past 7d: the 7d snapshot lands; 24h is not re-captured.
    vi.setSystemTime(new Date(MONDAY_8AM_UTC.getTime() + 7 * DAY_MS + 60_000));
    expect((await runInbox()).metricsCaptured).toBe(1);
    const pubs2 = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })).json();
    const windows = pubs2
      .find((p: { id: string }) => p.id === pub.id)
      .metrics.map((m: { window: string }) => m.window);
    expect(new Set(windows)).toEqual(new Set(["24h", "7d"]));
  });

  // --- Manual reply through the gate ---------------------------------------

  it("drafts a reply through the gate, then posts it on approval", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);
    await runInbox();
    const [item] = await listInbox();

    // Draft a reply — lands at the gate, linked to the item.
    const draft = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/${item.id}/reply` })
    ).json();
    expect(draft.taskType).toBe("engagement_reply");
    expect(draft.channel).toBe("linkedin");
    expect(draft.state).toBe("pending_review");

    // Posting before approval is refused.
    const early = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/inbox/${item.id}/post-reply`,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("reply_not_approved");

    // Approve, then post.
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve` });
    const posted = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/inbox/${item.id}/post-reply`,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().status).toBe("replied");
    expect(posted.json().postedReplyExternalId).toBeTruthy();
    expect(state.postedReplies).toHaveLength(1);
    expect(state.postedReplies[0]?.thing_id).toBe(item.externalId);

    // Posting again is refused.
    const again = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/inbox/${item.id}/post-reply`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_replied");
  });

  // --- Status transitions ---------------------------------------------------

  it("marks items read and dismissed, and rejects illegal status", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign();
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);
    await runInbox();
    const [item] = await listInbox();

    const read = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/inbox/${item.id}`,
      payload: { status: "read" },
    });
    expect(read.json().status).toBe("read");

    const dismissed = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/inbox/${item.id}`,
      payload: { status: "dismissed" },
    });
    expect(dismissed.json().status).toBe("dismissed");

    const bad = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/inbox/${item.id}`,
      payload: { status: "replied" },
    });
    expect(bad.statusCode).toBe(400);
  });

  // --- Auto-reply -----------------------------------------------------------

  it("auto-replies when the switch is on and the campaign is scheduled_auto", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign("scheduled_auto");
    await setAutoReply(true);
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);

    const result = await runInbox();
    expect(result.repliesGenerated).toBe(1);
    expect(result.repliesAutoApproved).toBe(1);
    expect(result.repliesPosted).toBe(1);

    const [item] = await listInbox();
    expect(item.status).toBe("replied");
    expect(item.postedReplyExternalId).toBeTruthy();
    expect(state.postedReplies).toHaveLength(1);

    // The reply went through the gate as the system actor.
    const decisions = listDecisions(db, item.replyDraftId);
    expect(decisions.map((d) => d.action)).toEqual(["submit", "approve"]);
    expect(decisions.every((d) => d.actor === "system")).toBe(true);
  });

  it("does not auto-reply when the master switch is off (default)", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign("scheduled_auto"); // auto campaign, but switch OFF
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);

    const result = await runInbox();
    expect(result.repliesGenerated).toBe(0);
    expect(result.repliesPosted).toBe(0);
    const [item] = await listInbox();
    expect(item.status).toBe("unread");
    expect(item.replyDraftId).toBeNull();
  });

  it("does not auto-reply on a manual campaign even with the switch on", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign("manual");
    await setAutoReply(true);
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);

    const result = await runInbox();
    expect(result.repliesGenerated).toBe(0);
    expect((await listInbox())[0].status).toBe("unread");
  });

  // --- Guardrails -----------------------------------------------------------

  it("kill switch and per-connection cap block auto-replies", async () => {
    const connectionId = await connectReddit();
    const campaignId = await createCampaign("scheduled_auto");
    await setAutoReply(true);
    const pub = await publishPost(connectionId, campaignId);
    addComment(pub.externalId);

    // Kill switch on → nothing auto-replies.
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { killSwitch: true },
    });
    expect((await runInbox()).repliesPosted).toBe(0);
    expect((await listInbox())[0].status).toBe("unread");

    // Switch off but per-connection cap of 1 (the published post already used it).
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { killSwitch: false, perConnectionDailyCap: 1 },
    });
    const capped = await runInbox();
    expect(capped.repliesGenerated).toBe(0);
    expect((await listInbox())[0].status).toBe("unread");

    // Manual reply still works under the cap (the human path isn't gated by it).
    const item = (await listInbox())[0];
    const draft = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/${item.id}/reply` })
    ).json();
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve` });
    const posted = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/inbox/${item.id}/post-reply`,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().status).toBe("replied");
  });
});
