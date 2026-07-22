import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  externalActionSubmissionSchema,
  type ExternalActionKind,
  type ExternalActionPolicyRule,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { drafts, externalActions, inboxItems, launchMessages, publications } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated messaging body.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const T0 = new Date("2026-07-06T08:00:00Z");
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// One fake fabric covering Reddit replies, LinkedIn broadcasts, and X DMs.
// ---------------------------------------------------------------------------

interface FabricState {
  connections: Map<string, unknown>;
  postedReplies: Array<{ thing_id: string; text: string }>;
  linkedInPosts: number;
  dms: number;
  /** X handles whose DM send is refused (403). */
  xFailHandles: Set<string>;
}

function fabricState(): FabricState {
  return {
    connections: new Map(),
    postedReplies: [],
    linkedInPosts: 0,
    dms: 0,
    xFailHandles: new Set(),
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
      const p = path.split("?")[0]!;

      // Reddit — reply posting + inbox polling endpoints (return empties).
      if (method === "POST" && p.startsWith("/api/comment")) {
        const form = opts?.form ?? {};
        state.postedReplies.push({ thing_id: form.thing_id ?? "", text: form.text ?? "" });
        const n = state.postedReplies.length;
        return {
          status: 200,
          json: {
            json: {
              errors: [],
              data: { things: [{ kind: "t1", data: { name: `t1_r${n}`, permalink: `/r/test/x/r${n}/` } }] },
            },
          },
        };
      }
      if (method === "GET" && p.startsWith("/comments/")) {
        return { status: 200, json: [{ data: { children: [] } }, { data: { children: [] } }] };
      }
      if (method === "GET" && p.startsWith("/api/info")) {
        return { status: 200, json: { data: { children: [{ data: { score: 0, num_comments: 0 } }] } } };
      }

      // LinkedIn — broadcast publishing.
      if (p === "/v2/userinfo") return { status: 200, json: { sub: "li-123" } };
      if (p === "/v2/ugcPosts") {
        state.linkedInPosts += 1;
        return { status: 201, json: { id: `urn:li:share:${state.linkedInPosts}` } };
      }

      // X — handle lookup + DM send.
      if (p.startsWith("/2/users/by/username/")) {
        const handle = decodeURIComponent(p.split("/").pop()!);
        return { status: 200, json: { data: { id: `x-${handle}`, username: handle } } };
      }
      if (p.startsWith("/2/dm_conversations/with/")) {
        const handle = p.split("/")[4]!.replace(/^x-/, "");
        if (state.xFailHandles.has(handle)) {
          return { status: 403, json: { errors: [{ detail: "You cannot send messages to this user." }] } };
        }
        state.dms += 1;
        return { status: 201, json: { data: { dm_event_id: `dm-${state.dms}` } } };
      }

      return { status: 404, json: { message: `no endpoint for ${p}` } };
    },
  };
}

describe("external-action messaging boundary", () => {
  let app: TuezdayApp;
  let db: Db;
  let state: FabricState;
  let workspaceId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    for (const k of ["REDDIT", "LINKEDIN", "TWITTER"]) {
      vi.stubEnv(`${k}_CLIENT_ID`, "cid");
      vi.stubEnv(`${k}_CLIENT_SECRET`, "csecret");
    }
    db = createTestDb();
    state = fabricState();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Messaging" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });

  // --- Shared helpers --------------------------------------------------------

  async function setPolicy(
    scope: "workspace" | "campaign",
    scopeId: string,
    rules: Array<{ actionKind: ExternalActionKind; rule: ExternalActionPolicyRule }>,
  ) {
    const res = await putActionPolicy(
      app,
      workspaceId,
      scope,
      scopeId,
      Object.fromEntries(rules.map((rule) => [rule.actionKind, rule.rule])),
    );
    expect(res.statusCode).toBe(200);
  }

  async function connectProvider(providerKey: string): Promise<string> {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/session`,
    });
    const nangoId = `nango-${providerKey}-${randomUUID()}`;
    state.connections.set(nangoId, { type: "OAUTH2" });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/complete`,
      payload: { connectionId: nangoId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json().id;
  }

  async function authorize(actionId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/${actionId}/authorize`,
      payload: {},
    });
  }

  function actionRows() {
    return db.select().from(externalActions).where(eq(externalActions.workspaceId, workspaceId)).all();
  }

  // --- Reply fixtures ---------------------------------------------------------

  /** A published Reddit post (draft + publication) plus one inbound comment. */
  function seedInboxComment(connectionId: string, campaignId: string | null): string {
    const now = Date.now();
    const draftId = randomUUID();
    db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        campaignId,
        taskType: "linkedin_post",
        channel: "linkedin",
        originalContent: "Original post body.",
        content: "Original post body.",
        state: "approved",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const publicationId = randomUUID();
    db.insert(publications)
      .values({
        id: publicationId,
        workspaceId,
        draftId,
        connectionId,
        providerKey: "reddit",
        target: "r/test",
        title: "Original post",
        status: "published",
        scheduledFor: now,
        publishedAt: now,
        externalId: "t3_post1",
        externalUrl: "https://reddit.com/p1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const itemId = randomUUID();
    db.insert(inboxItems)
      .values({
        id: itemId,
        workspaceId,
        connectionId,
        providerKey: "reddit",
        kind: "comment",
        channel: "linkedin",
        externalId: "t1_comment1",
        parentExternalId: "t3_post1",
        publicationId,
        launchMessageId: null,
        authorHandle: "curious_dev",
        authorName: "Curious Dev",
        content: "How does this work?",
        url: null,
        status: "unread",
        replyDraftId: null,
        postedReplyExternalId: null,
        postedReplyUrl: null,
        externalCreatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return itemId;
  }

  async function draftAndApproveReply(itemId: string): Promise<string> {
    const draft = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/${itemId}/reply` })
    ).json();
    const approved = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    return draft.id;
  }

  function postReply(itemId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/inbox/${itemId}/post-reply`,
    });
  }

  async function getItem(itemId: string) {
    const items = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/inbox` })
    ).json();
    return items.find((i: { id: string }) => i.id === itemId);
  }

  /** Campaign created through the API, patched to scheduled_auto when asked. */
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
    return id;
  }

  // --- Launch fixtures ---------------------------------------------------------

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

  async function generatedLaunch(channels: string[], leadIds: string[]): Promise<string> {
    const audienceId = await audienceOf(leadIds);
    const launchId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: { name: "Spring", audienceId, channels },
      })
    ).json().id;
    const gen = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/generate`,
      payload: {},
    });
    expect(gen.statusCode).toBe(200);
    return launchId;
  }

  const launchDetail = (launchId: string) =>
    app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/launches/${launchId}` })
      .then((r) => r.json());

  async function approveLaunchDrafts(launchId: string): Promise<void> {
    const d = await launchDetail(launchId);
    for (const m of d.messages as Array<{ draftId: string | null }>) {
      if (m.draftId) {
        const r = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/drafts/${m.draftId}/approve`,
        });
        expect(r.statusCode).toBe(200);
      }
    }
  }

  function dispatch(launchId: string, channel: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/${channel}/dispatch`,
      payload,
    });
  }

  // --- Manual reply ------------------------------------------------------------

  it("queues a manual reply under human policy and posts exactly once after authorization", async () => {
    const connectionId = await connectProvider("reddit");
    const itemId = seedInboxComment(connectionId, null);
    await draftAndApproveReply(itemId);

    const queued = await postReply(itemId);
    expect(queued.statusCode).toBe(202);
    const submission = externalActionSubmissionSchema.parse(queued.json());
    expect(submission.action.kind).toBe("reply");
    expect(submission.action.status).toBe("authorization_required");
    expect(submission.action.subject.kind).toBe("inbox_item");
    expect(state.postedReplies).toHaveLength(0);

    // An identical retry returns the same queued action.
    const retry = await postReply(itemId);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().action.id).toBe(submission.action.id);
    expect(actionRows()).toHaveLength(1);

    const authorized = await authorize(submission.action.id);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("succeeded");
    expect(authorized.json().execution.kind).toBe("inbox_reply");
    expect(state.postedReplies).toHaveLength(1);
    expect(state.postedReplies[0]?.thing_id).toBe("t1_comment1");

    const item = await getItem(itemId);
    expect(item.status).toBe("replied");
    expect(item.postedReplyExternalId).toBeTruthy();
    expect(item.externalActionId).toBe(submission.action.id);

    const again = await postReply(itemId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_replied");
  });

  // --- Automated replies ---------------------------------------------------------

  it("keeps auto-generated replies queued under human policy", async () => {
    const connectionId = await connectProvider("reddit");
    const campaignId = await createCampaign("scheduled_auto");
    const itemId = seedInboxComment(connectionId, campaignId);
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { autoReplyEnabled: true },
    });

    const run = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/run` })
    ).json();
    expect(run.repliesGenerated).toBe(1);
    expect(run.repliesAutoApproved).toBe(1);
    expect(run.repliesPosted).toBe(0);
    expect(state.postedReplies).toHaveLength(0);

    const rows = actionRows().filter((r) => r.kind === "reply");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("authorization_required");
    expect((await getItem(itemId)).status).not.toBe("replied");

    // A second cycle re-proposes idempotently.
    const rerun = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/run` })
    ).json();
    expect(rerun.repliesPosted).toBe(0);
    expect(actionRows().filter((r) => r.kind === "reply")).toHaveLength(1);
  });

  it("posts an autonomous reply exactly once", async () => {
    const connectionId = await connectProvider("reddit");
    const campaignId = await createCampaign("scheduled_auto");
    await setPolicy("campaign", campaignId, [{ actionKind: "reply", rule: "autonomous" }]);
    const itemId = seedInboxComment(connectionId, campaignId);
    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/automation/settings`,
      payload: { autoReplyEnabled: true },
    });

    const run = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/run` })
    ).json();
    expect(run.repliesPosted).toBe(1);
    expect(state.postedReplies).toHaveLength(1);
    const item = await getItem(itemId);
    expect(item.status).toBe("replied");
    expect(item.externalActionId).toBeTruthy();

    const rerun = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/inbox/run` })
    ).json();
    expect(rerun.repliesPosted).toBe(0);
    expect(state.postedReplies).toHaveLength(1);
    expect(actionRows().filter((r) => r.kind === "reply")).toHaveLength(1);
  });

  // --- Launch channel dispatch ------------------------------------------------

  it("queues a broadcast send and creates one linked publication after authorization", async () => {
    await connectProvider("linkedin");
    const launchId = await generatedLaunch(["linkedin"], [await createLead("Alice")]);
    await approveLaunchDrafts(launchId);

    const res = await dispatch(launchId, "linkedin");
    expect(res.statusCode).toBe(200);
    const { submissions } = res.json();
    expect(submissions).toHaveLength(1);
    const submission = externalActionSubmissionSchema.parse(submissions[0]);
    expect(submission.action.kind).toBe("send");
    expect(submission.action.status).toBe("authorization_required");
    expect(submission.action.subject.kind).toBe("launch_message");
    expect(state.linkedInPosts).toBe(0);
    expect(db.select().from(publications).all()).toHaveLength(0);

    const authorized = await authorize(submission.action.id);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("succeeded");
    expect(authorized.json().execution.kind).toBe("launch_message");
    expect(state.linkedInPosts).toBe(1);

    const pubs = db.select().from(publications).all();
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.externalActionId).toBe(submission.action.id);
    const message = db.select().from(launchMessages).where(eq(launchMessages.launchId, launchId)).get();
    expect(message?.status).toBe("sent");
    expect(message?.externalActionId).toBe(submission.action.id);

    // Re-dispatch returns the same terminal action and never re-posts.
    const again = await dispatch(launchId, "linkedin");
    expect(again.json().submissions[0].action.id).toBe(submission.action.id);
    expect(state.linkedInPosts).toBe(1);
    expect(db.select().from(publications).all()).toHaveLength(1);
  });

  it("sends one autonomous X action per message with durable partial outcomes", async () => {
    await setPolicy("workspace", workspaceId, [{ actionKind: "send", rule: "autonomous" }]);
    state.xFailHandles.add("bob");
    await connectProvider("twitter");
    const launchId = await generatedLaunch(
      ["x"],
      [await createLead("Alice", "alice"), await createLead("Bob", "bob"), await createLead("Carol")],
    );
    await approveLaunchDrafts(launchId);

    const res = await dispatch(launchId, "x");
    expect(res.statusCode).toBe(200);
    const { submissions } = res.json();
    expect(submissions).toHaveLength(2); // Carol has no handle → skipped, no action
    const statuses = submissions.map((s: { action: { status: string } }) => s.action.status).sort();
    expect(statuses).toEqual(["failed", "succeeded"]);
    expect(state.dms).toBe(1);

    const messages = db.select().from(launchMessages).where(eq(launchMessages.launchId, launchId)).all();
    const alice = messages.find((m) => m.recipientName === "Alice");
    const bob = messages.find((m) => m.recipientName === "Bob");
    expect(alice?.status).toBe("sent");
    expect(alice?.externalActionId).toBeTruthy();
    expect(bob?.status).toBe("failed");
    expect(bob?.externalActionId).toBeTruthy();
    const failed = submissions.find((s: { action: { status: string } }) => s.action.status === "failed");
    expect(failed.execution.error).toMatch(/cannot send/i);

    // An identical re-dispatch reuses both actions and sends nothing new.
    const again = await dispatch(launchId, "x");
    expect(
      again
        .json()
        .submissions.map((s: { action: { id: string } }) => s.action.id)
        .sort(),
    ).toEqual(submissions.map((s: { action: { id: string } }) => s.action.id).sort());
    expect(state.dms).toBe(1);
  });

  // --- Sequences ----------------------------------------------------------------

  async function sequenceLaunch(stopOnReply = true): Promise<string> {
    const alice = await createLead("Alice", "alice");
    const audienceId = await audienceOf([alice]);
    const launchId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: {
          name: "Outreach",
          audienceId,
          channels: ["x"],
          automationMode: "scheduled_auto",
          stopOnReply,
        },
      })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence`,
      payload: {
        steps: [
          { channel: "x", stepNumber: 1, instruction: "", delayHours: 0 },
          { channel: "x", stepNumber: 2, instruction: "bump", delayHours: 24 },
        ],
      },
    });
    return launchId;
  }

  it("proposes an approved sequence X step, waits for authorization, then advances", async () => {
    await connectProvider("twitter");
    const launchId = await sequenceLaunch();

    const started = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/start`,
    });
    expect(started.statusCode).toBe(200);
    expect(state.dms).toBe(0);

    let d = await launchDetail(launchId);
    const step1 = d.messages.find((m: { channel: string }) => m.channel === "x");
    expect(step1.draftState).toBe("approved"); // content approval still auto in scheduled_auto
    expect(step1.status).toBe("pending"); // but no send without authorization

    const sendActions = actionRows().filter((r) => r.kind === "send");
    expect(sendActions).toHaveLength(1);
    expect(sendActions[0]?.status).toBe("authorization_required");

    // Worker restart / rerun re-proposes idempotently — still one action, no DM.
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/run`,
    });
    expect(actionRows().filter((r) => r.kind === "send")).toHaveLength(1);
    expect(state.dms).toBe(0);

    const authorized = await authorize(sendActions[0]!.id);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("succeeded");
    expect(state.dms).toBe(1);
    d = await launchDetail(launchId);
    expect(d.messages.find((m: { channel: string }) => m.channel === "x").status).toBe("sent");

    // After the delay the next step generates and queues its own action.
    vi.setSystemTime(new Date(T0.getTime() + 24 * HOUR + 60_000));
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/run`,
    });
    const afterAdvance = actionRows().filter((r) => r.kind === "send");
    expect(afterAdvance).toHaveLength(2);
    expect(state.dms).toBe(1); // step 2 waits for authorization too
  });

  it("blocks a queued sequence send when the recipient already replied", async () => {
    const connectionId = await connectProvider("twitter");
    const launchId = await sequenceLaunch(true);
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/sequence/start`,
    });
    const action = actionRows().find((r) => r.kind === "send");
    expect(action?.status).toBe("authorization_required");

    // Alice replies before anyone authorizes the DM.
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
        content: "already interested!",
        url: null,
        status: "unread",
        replyDraftId: null,
        postedReplyExternalId: null,
        postedReplyUrl: null,
        externalCreatedAt: now + HOUR,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const authorized = await authorize(action!.id);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().action.status).toBe("blocked");
    expect(authorized.json().action.blocker.code).toBe("recipient_replied");
    expect(state.dms).toBe(0);
  });

  // --- Staleness -----------------------------------------------------------------

  it("marks a queued send stale when the draft content changes", async () => {
    await connectProvider("linkedin");
    const launchId = await generatedLaunch(["linkedin"], [await createLead("Alice")]);
    await approveLaunchDrafts(launchId);
    const queued = (await dispatch(launchId, "linkedin")).json().submissions[0];

    const message = db.select().from(launchMessages).where(eq(launchMessages.launchId, launchId)).get();
    db.update(drafts)
      .set({ content: "Edited after the proposal", updatedAt: Date.now() })
      .where(eq(drafts.id, message!.draftId!))
      .run();

    const authorized = await authorize(queued.action.id);
    expect(authorized.statusCode).toBe(409);
    expect(authorized.json().action.status).toBe("stale");
    expect(state.linkedInPosts).toBe(0);
    expect(db.select().from(publications).all()).toHaveLength(0);
  });

  // --- CSV remains a non-governed recovery path -----------------------------------

  it("keeps email CSV export outside governance without claiming delivery", async () => {
    const launchId = await generatedLaunch(["email"], [await createLead("Alice")]);
    await approveLaunchDrafts(launchId);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Generated messaging body.");
    const d = await launchDetail(launchId);
    expect(
      d.messages.filter((m: { channel: string; status: string }) => m.channel === "email" && m.status === "pending"),
    ).toHaveLength(1);
    expect(actionRows()).toHaveLength(0);
  });
});
