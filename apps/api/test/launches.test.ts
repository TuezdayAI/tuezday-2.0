import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  CHANNELS,
  SOCIAL_POST_CONSTRAINTS,
  TASK_TYPES,
  launchDetailSchema,
  launchSchema,
  leadSchema,
  validateSocialPost,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import {
  ConnectorFabricError,
  type ConnectorFabric,
  type ProxyJsonResult,
} from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { launchMessages } from "../src/db/schema";
import { InstagramAdapter } from "../src/connectors/social/instagram";
import { LinkedInAdapter } from "../src/connectors/social/linkedin";
import { XAdapter } from "../src/connectors/social/x";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated first-touch message.", model: "fake", provider: "fake", durationMs: 3 };
  },
};

// ---------------------------------------------------------------------------
// A fake fabric with in-memory LinkedIn / Instagram / X behind the proxy
// ---------------------------------------------------------------------------

interface PlatformState {
  healthy: boolean;
  integrations: Set<string>;
  integrationOAuth: Map<string, { clientId: string; clientSecret: string; scopes: string }>;
  sessions: Array<{ integrationKey: string; endUserId: string }>;
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  proxyStatus: number;
  /** X handles the lookup should 404 on. */
  xUnknownHandles: Set<string>;
  /** X handles whose DM should be refused (403). */
  xFailHandles: Set<string>;
  igContainers: number;
  igPublished: number;
  dms: number;
  calls: Array<{ method: string; path: string; opts?: unknown }>;
}

function platformState(): PlatformState {
  return {
    healthy: true,
    integrations: new Set(),
    integrationOAuth: new Map(),
    sessions: [],
    connections: new Map(),
    proxyStatus: 200,
    xUnknownHandles: new Set(),
    xFailHandles: new Set(),
    igContainers: 0,
    igPublished: 0,
    dms: 0,
    calls: [],
  };
}

function handlePlatform(
  state: PlatformState,
  method: string,
  path: string,
  opts: { form?: Record<string, string>; body?: unknown } | undefined,
): ProxyJsonResult {
  const p = path.split("?")[0]!;
  state.calls.push({ method, path, opts });

  // LinkedIn
  if (p === "/v2/userinfo") return { status: 200, json: { sub: "li-123" } };
  if (p === "/v2/ugcPosts") return { status: 201, json: { id: "urn:li:share:99" } };

  // X (Twitter)
  if (p.startsWith("/2/users/by/username/")) {
    const handle = decodeURIComponent(p.split("/").pop()!);
    if (state.xUnknownHandles.has(handle)) {
      return { status: 404, json: { errors: [{ detail: "Could not find user." }] } };
    }
    return { status: 200, json: { data: { id: `x-${handle}`, username: handle } } };
  }
  if (p.startsWith("/2/dm_conversations/with/")) {
    const id = p.split("/")[4]!;
    const handle = id.replace(/^x-/, "");
    if (state.xFailHandles.has(handle)) {
      return { status: 403, json: { errors: [{ detail: "You cannot send messages to this user." }] } };
    }
    state.dms += 1;
    return { status: 201, json: { data: { dm_event_id: `dm-${state.dms}`, dm_conversation_id: `c-${state.dms}` } } };
  }

  // Instagram (Graph API)
  if (p.endsWith("/media_publish")) {
    state.igPublished += 1;
    return { status: 200, json: { id: `ig-media-${state.igPublished}` } };
  }
  if (p.endsWith("/media")) {
    state.igContainers += 1;
    return { status: 200, json: { id: `ig-container-${state.igContainers}` } };
  }
  if (p.includes("/me/accounts")) {
    return { status: 200, json: { data: [{ instagram_business_account: { id: "ig-1" } }] } };
  }
  if (p.startsWith("/v23.0/ig-container-")) return { status: 200, json: { status_code: "FINISHED" } };
  if (p.startsWith("/v23.0/ig-media-")) {
    return { status: 200, json: { permalink: "https://www.instagram.com/p/abc/" } };
  }

  return { status: 404, json: { error: { message: `no endpoint for ${p}` } } };
}

function fakeFabric(state: PlatformState): ConnectorFabric {
  return {
    async health() {
      return state.healthy ? { healthy: true } : { healthy: false, detail: "down" };
    },
    async ensureIntegration(uniqueKey, _provider, oauth) {
      state.integrations.add(uniqueKey);
      if (oauth) state.integrationOAuth.set(uniqueKey, oauth);
    },
    async createConnectSession(integrationKey, endUserId) {
      state.sessions.push({ integrationKey, endUserId });
      return { token: `session-token-${state.sessions.length}` };
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
      return { status: state.proxyStatus, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, opts) {
      return handlePlatform(state, method, path, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Contracts: new channel / task types / constraints
// ---------------------------------------------------------------------------

describe("launch contracts", () => {
  it("adds instagram as a channel and the new task types", () => {
    expect(CHANNELS).toContain("instagram");
    expect(TASK_TYPES).toContain("x_dm");
    expect(TASK_TYPES).toContain("instagram_post");
  });

  it("has social-post constraints for linkedin and instagram (IG requires media)", () => {
    expect(SOCIAL_POST_CONSTRAINTS.linkedin.bodyMaxChars).toBe(3000);
    expect(SOCIAL_POST_CONSTRAINTS.instagram.requiresMedia).toBe(true);
  });

  it("validates a linkedin post body length", () => {
    expect(validateSocialPost("linkedin", { target: "feed", title: "x", body: "hi" }).ok).toBe(true);
    const over = validateSocialPost("linkedin", { target: "feed", title: "x", body: "b".repeat(3001) });
    expect(over.ok).toBe(false);
  });

  it("carries xHandle on the lead schema", () => {
    const lead = {
      id: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
      name: "A",
      email: "a@b.com",
      company: "",
      role: "",
      notes: "",
      xHandle: "founder",
      createdAt: 1,
    };
    expect(leadSchema.parse(lead).xHandle).toBe("founder");
  });
});

// ---------------------------------------------------------------------------
// Adapters over the fake fabric
// ---------------------------------------------------------------------------

describe("social adapters", () => {
  const config = { nangoConnectionId: "nc-1", integrationKey: "tuezday-x" };

  it("LinkedIn posts a member share and returns the post id + url", async () => {
    const state = platformState();
    const result = await new LinkedInAdapter(fakeFabric(state), {
      ...config,
      integrationKey: "tuezday-linkedin",
    }).publishPost({ target: "feed", title: "Launch", body: "Hello world" });
    expect(result.externalId).toBe("urn:li:share:99");
    expect(result.url).toContain("urn:li:share:99");
  });

  it("Instagram runs container → publish for a single image", async () => {
    const state = platformState();
    const result = await new InstagramAdapter(fakeFabric(state), {
      ...config,
      integrationKey: "tuezday-instagram",
    }).publishPost({ target: "feed", title: "", body: "Caption", media: [{ url: "https://img/1.jpg", type: "image" }] });
    expect(result.externalId).toBe("ig-media-1");
    expect(state.igContainers).toBe(1);
    expect(state.igPublished).toBe(1);
  });

  it("Instagram builds a carousel from multiple media", async () => {
    const state = platformState();
    await new InstagramAdapter(fakeFabric(state), { ...config, integrationKey: "tuezday-instagram" }).publishPost({
      target: "feed",
      title: "",
      body: "Caption",
      media: [
        { url: "https://img/1.jpg", type: "image" },
        { url: "https://img/2.jpg", type: "image" },
      ],
    });
    // two child containers + one parent container = 3 /media calls
    expect(state.igContainers).toBe(3);
    expect(state.igPublished).toBe(1);
  });

  it("Instagram refuses to publish with no media", async () => {
    const state = platformState();
    await expect(
      new InstagramAdapter(fakeFabric(state), { ...config, integrationKey: "tuezday-instagram" }).publishPost({
        target: "feed",
        title: "",
        body: "Caption",
      }),
    ).rejects.toThrow(ConnectorFabricError);
  });

  it("X resolves a handle then sends the DM", async () => {
    const state = platformState();
    const result = await new XAdapter(fakeFabric(state), { ...config, integrationKey: "tuezday-twitter" }).sendDm({
      recipientHandle: "@alice",
      body: "hey",
    });
    expect(result.externalId).toBe("dm-1");
  });

  it("X surfaces a refused DM as an error", async () => {
    const state = platformState();
    state.xFailHandles.add("blocked");
    await expect(
      new XAdapter(fakeFabric(state), { ...config, integrationKey: "tuezday-twitter" }).sendDm({
        recipientHandle: "blocked",
        body: "hey",
      }),
    ).rejects.toThrow(/refused/);
  });
});

// ---------------------------------------------------------------------------
// Launch API (routes + services over the fake fabric)
// ---------------------------------------------------------------------------

describe("targeted launch API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let state: PlatformState;

  beforeEach(async () => {
    for (const k of ["LINKEDIN", "INSTAGRAM", "TWITTER"]) {
      vi.stubEnv(`${k}_CLIENT_ID`, "cid");
      vi.stubEnv(`${k}_CLIENT_SECRET`, "csecret");
    }
    state = platformState();
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Launcher" } })
    ).json().id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  async function createLead(name: string, xHandle = ""): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/leads`,
      payload: { name, email: `${name.toLowerCase()}@acme.com`, company: "Acme", role: "VP", xHandle },
    });
    return res.json().id;
  }

  async function staticAudience(memberIds: string[]): Promise<string> {
    const audienceId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/audiences`,
        payload: { name: "Targets", kind: "static" },
      })
    ).json().id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`,
      payload: { members: memberIds.map((id) => ({ type: "lead", id })) },
    });
    return audienceId;
  }

  async function connect(
    providerKey: string,
    nangoConnectionId = `nango-${providerKey}-${Math.random().toString(36).slice(2)}`,
  ): Promise<{ id: string }> {
    const session = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/session`,
    });
    expect(session.statusCode).toBe(200);
    state.connections.set(nangoConnectionId, {
      providerConfigKey: `tuezday-${providerKey}`,
      credentials: { type: "OAUTH2" },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json();
  }

  async function connectSocial(providerKey: string, nangoConnectionId: string): Promise<{ id: string }> {
    return connect(providerKey, nangoConnectionId);
  }

  async function createPersona(name = "CEO") {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function assignSocialAccount(
    personaId: string,
    connectionId: string,
    channel: string,
    isPrimary = true,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${personaId}/social-accounts`,
      payload: { connectionId, channel, isPrimary },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function approveDraft(draftId: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
    });
    expect(res.statusCode).toBe(200);
  }

  function detail(launchId: string) {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/launches/${launchId}` })
      .then((r) => r.json());
  }

  async function readyLaunch(opts: { personaId?: string; channels: string[] }): Promise<{ id: string }> {
    const alice = await createLead("Alice", "alice");
    const audienceId = await staticAudience([alice]);
    const launch = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: {
          name: "Persona launch",
          audienceId,
          personaId: opts.personaId,
          channels: opts.channels,
        },
      })
    ).json();
    const generated = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launch.id}/generate`,
      payload: {},
    });
    expect(generated.statusCode).toBe(200);
    return launch;
  }

  async function approveLaunchDrafts(launchId: string): Promise<void> {
    const d = await detail(launchId);
    for (const message of d.messages as Array<{ draftId: string | null }>) {
      if (message.draftId) await approveDraft(message.draftId);
    }
  }

  async function publishedConnectionIds(): Promise<string[]> {
    const publications = await app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
      .then((r) => r.json());
    return publications.map((publication: { connectionId: string }) => publication.connectionId);
  }

  async function fullLaunch(): Promise<{ launchId: string }> {
    const alice = await createLead("Alice", "alice");
    const bob = await createLead("Bob", "bob");
    const carol = await createLead("Carol"); // no X handle
    const audienceId = await staticAudience([alice, bob, carol]);
    const launchId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: { name: "Spring", audienceId, channels: ["email", "linkedin", "instagram", "x"] },
      })
    ).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/launches/${launchId}/generate`, payload: {} });
    return { launchId };
  }

  it("creates, generates, and shapes messages per channel", async () => {
    const { launchId } = await fullLaunch();
    const d = launchDetailSchema.parse(await detail(launchId));
    expect(d.launch.status).toBe("ready");
    expect(d.recipientCount).toBe(3);

    const email = d.messages.filter((m) => m.channel === "email");
    const x = d.messages.filter((m) => m.channel === "x");
    const linkedin = d.messages.filter((m) => m.channel === "linkedin");
    const instagram = d.messages.filter((m) => m.channel === "instagram");

    expect(email).toHaveLength(3);
    expect(email.every((m) => m.draftState === "pending_review")).toBe(true);
    expect(x).toHaveLength(3);
    expect(x.filter((m) => m.status === "skipped")).toHaveLength(1); // Carol
    expect(x.find((m) => m.recipientName === "Carol")!.skipReason).toMatch(/handle/i);
    expect(linkedin).toHaveLength(1);
    expect(linkedin[0]!.kind).toBe("broadcast");
    expect(instagram).toHaveLength(1);
  });

  it("refuses to regenerate a launch that is not in draft", async () => {
    const { launchId } = await fullLaunch();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/generate`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("exports approved email messages as a CSV and marks them sent", async () => {
    const { launchId } = await fullLaunch();
    let d = await detail(launchId);
    const emailDrafts = d.messages.filter((m: { channel: string }) => m.channel === "email");
    for (const m of emailDrafts) await approveDraft(m.draftId);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toContain("personalized_message");
    expect(lines).toHaveLength(4); // header + 3 recipients
    expect(res.body).toContain("Generated first-touch message.");

    d = await detail(launchId);
    expect(d.messages.filter((m: { channel: string; status: string }) => m.channel === "email" && m.status === "sent")).toHaveLength(3);
  });

  it("only exports approved email messages", async () => {
    const { launchId } = await fullLaunch();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/launches/${launchId}/export.csv`,
    });
    expect(res.body.trim().split("\n")).toHaveLength(1); // header only — none approved
  });

  it("dispatches the LinkedIn broadcast and records the publication", async () => {
    await connect("linkedin");
    const { launchId } = await fullLaunch();
    const d = await detail(launchId);
    const li = d.messages.find((m: { channel: string }) => m.channel === "linkedin");
    await approveDraft(li.draftId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/linkedin/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].status).toBe("sent");

    const after = await detail(launchId);
    const sent = after.messages.find((m: { channel: string }) => m.channel === "linkedin");
    expect(sent.status).toBe("sent");
    expect(sent.externalUrl).toContain("urn:li:share");

    const pubs = await app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/publications` })
      .then((r) => r.json());
    expect(pubs).toHaveLength(1);
  });

  it("dispatches LinkedIn launch broadcasts through the launch persona primary account", async () => {
    const persona = await createPersona("CEO");
    const ceoLinkedIn = await connectSocial("linkedin", "nango-linkedin-ceo");
    const otherLinkedIn = await connectSocial("linkedin", "nango-linkedin-other");
    await assignSocialAccount(persona.id, ceoLinkedIn.id, "linkedin", true);
    const launch = await readyLaunch({ personaId: persona.id, channels: ["linkedin"] });
    await approveLaunchDrafts(launch.id);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launch.id}/channels/linkedin/dispatch`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    await expect(publishedConnectionIds()).resolves.toEqual([ceoLinkedIn.id]);
    await expect(publishedConnectionIds()).resolves.not.toContain(otherLinkedIn.id);
  });

  it("requires media for an Instagram dispatch", async () => {
    await connect("instagram");
    const { launchId } = await fullLaunch();
    const d = await detail(launchId);
    const ig = d.messages.find((m: { channel: string }) => m.channel === "instagram");
    await approveDraft(ig.draftId);

    const without = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/instagram/dispatch`,
      payload: {},
    });
    expect(without.statusCode).toBe(400);
    expect(without.json().error).toBe("media_required");

    const withMedia = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/instagram/dispatch`,
      payload: { media: [{ url: "https://img/1.jpg", type: "image" }] },
    });
    expect(withMedia.statusCode).toBe(200);
    expect(withMedia.json().results[0].status).toBe("sent");
  });

  it("sends X DMs per recipient, surfacing a refusal without aborting the rest", async () => {
    state.xFailHandles.add("bob");
    const connection = await connect("twitter");
    const { launchId } = await fullLaunch();
    const d = await detail(launchId);
    for (const m of d.messages.filter((m: { channel: string; draftId: string | null }) => m.channel === "x" && m.draftId)) {
      await approveDraft(m.draftId);
    }
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/x/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const after = await detail(launchId);
    const x = after.messages.filter((m: { channel: string }) => m.channel === "x");
    expect(x.find((m: { recipientName: string }) => m.recipientName === "Alice").status).toBe("sent");
    expect(x.find((m: { recipientName: string }) => m.recipientName === "Bob").status).toBe("failed");
    expect(x.find((m: { recipientName: string }) => m.recipientName === "Carol").status).toBe("skipped");
    const sentRows = db
      .select()
      .from(launchMessages)
      .where(eq(launchMessages.channel, "x"))
      .all()
      .filter((row) => row.status === "sent");
    expect(sentRows.map((row) => row.connectionId)).toEqual([connection.id]);
  });

  it("does not dispatch messages whose draft is not approved", async () => {
    await connect("linkedin");
    const { launchId } = await fullLaunch();
    // do not approve the LinkedIn draft
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/linkedin/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].error).toMatch(/not approved/i);
    const after = await detail(launchId);
    expect(after.messages.find((m: { channel: string }) => m.channel === "linkedin").status).toBe("pending");
  });

  it("rejects dispatching a channel the launch did not select", async () => {
    const alice = await createLead("Alice", "alice");
    const audienceId = await staticAudience([alice]);
    const launchId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/launches`,
        payload: { name: "Email only", audienceId, channels: ["email"] },
      })
    ).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/launches/${launchId}/generate`, payload: {} });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/linkedin/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("channel_not_selected");
  });

  it("returns no_connection when no social account is connected", async () => {
    const { launchId } = await fullLaunch();
    const d = await detail(launchId);
    const li = d.messages.find((m: { channel: string }) => m.channel === "linkedin");
    await approveDraft(li.draftId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches/${launchId}/channels/linkedin/dispatch`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_connection");
  });

  it("404s an unknown launch and validates inputs", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/launches/33333333-3333-3333-3333-333333333333`,
    });
    expect(missing.statusCode).toBe(404);

    const badAudience = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/launches`,
      payload: { name: "x", audienceId: "44444444-4444-4444-4444-444444444444", channels: ["email"] },
    });
    expect(badAudience.statusCode).toBe(404);
    expect(badAudience.json().error).toBe("audience_not_found");
  });

  it("edits a lead's X handle via PATCH", async () => {
    const alice = await createLead("Alice");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/leads/${alice}`,
      payload: { xHandle: "@alice_co" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().xHandle).toBe("alice_co"); // @ stripped
  });
});
