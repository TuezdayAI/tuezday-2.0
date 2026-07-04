import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personaSchema, type InboxItem } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { ConnectorFabricError, type ConnectorFabric } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import { generateEngagementReply } from "../src/services/engagement-reply";
import { resolvePersonaSocialConnection } from "../src/services/persona-social-accounts";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated text.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

interface FabricState {
  healthy: boolean;
  connections: Map<string, { providerConfigKey: string }>;
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return state.healthy ? { healthy: true } : { healthy: false, detail: "nango is down" };
    },
    async ensureIntegration() {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
    },
    async createConnectSession() {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      return { token: "session-token" };
    },
    async importConnection(providerConfigKey, connectionId) {
      state.connections.set(connectionId, { providerConfigKey });
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
    async proxyJson() {
      return { status: 200, json: { ok: true } };
    },
  };
}

describe("personas API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let state: FabricState;

  beforeEach(async () => {
    db = createTestDb();
    state = { healthy: true, connections: new Map() };
    app = await buildAuthedApp({ db, llm: fakeLlm, connectors: fakeFabric(state) });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Personable" },
    });
    workspaceId = res.json().id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  async function createPersona(name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function connectSocial(providerKey: string, nangoConnectionId: string) {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "client-id");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "client-secret");
    const session = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/session`,
    });
    expect(session.statusCode).toBe(200);
    state.connections.set(nangoConnectionId, { providerConfigKey: `tuezday-${providerKey}` });
    const complete = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/oauth/complete`,
      payload: { connectionId: nangoConnectionId },
    });
    expect(complete.statusCode).toBe(201);
    return complete.json();
  }

  async function assign(personaId: string, connectionId: string, channel = "linkedin", isPrimary = true) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${personaId}/social-accounts`,
      payload: { connectionId, channel, isPrimary },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  // A history doc big enough to land in outline mode (> ZOOM_SMALL_DOC_TOKENS),
  // so Tier-3 zoom runs and the resolve output carries a zoomQuery.
  async function seedLongHistory() {
    const filler = "We shipped many things and learned from every launch we ran. ".repeat(30);
    const content = [
      "## Pricing experiment",
      `We tested usage-based pricing with design partners. ${filler}`,
      "## Agency churn",
      `Agencies churn when onboarding drags past week two. ${filler}`,
    ].join("\n\n");
    const res = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/history`,
      payload: { content },
    });
    expect(res.statusCode).toBe(200);
  }

  it("creates a persona with defaults", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "CEO" },
    });
    expect(res.statusCode).toBe(201);
    const persona = res.json();
    expect(personaSchema.safeParse(persona).success).toBe(true);
    expect(persona.name).toBe("CEO");
    expect(persona.description).toBe("");
    expect(persona.overlay).toBe("");
  });

  it("rejects an empty name", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/personas",
      payload: { name: "CEO" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists personas", async () => {
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "CEO" },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "Company page" },
    });
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/personas` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("updates a persona with a full replace", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO", overlay: "old overlay" },
      })
    ).json();

    const res = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/personas/${created.id}`,
      payload: { name: "CEO v2", description: "Founder voice", overlay: "new overlay" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.name).toBe("CEO v2");
    expect(updated.overlay).toBe("new overlay");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("deletes a persona", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Temp" },
      })
    ).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${created.id}`,
    });
    expect(del.statusCode).toBe(204);

    const list = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/personas` })
    ).json();
    expect(list).toHaveLength(0);
  });

  it("returns 404 updating or deleting an unknown persona", async () => {
    const missing = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const upd = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/personas/${missing}`,
      payload: { name: "Ghost" },
    });
    expect(upd.statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${missing}`,
    });
    expect(del.statusCode).toBe(404);
  });

  it("assigns connected social accounts to a persona and enforces one primary", async () => {
    const persona = await createPersona("CEO");
    const first = await connectSocial("linkedin", "nango-linkedin-a");
    const second = await connectSocial("linkedin", "nango-linkedin-b");

    const a = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
      payload: { connectionId: first.id, channel: "linkedin", isPrimary: true },
    });
    expect(a.statusCode).toBe(201);

    const b = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
      payload: { connectionId: second.id, channel: "linkedin", isPrimary: true },
    });
    expect(b.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
    });
    const assignments = list.json();
    expect(assignments).toHaveLength(2);
    expect(assignments.filter((x: { isPrimary: boolean }) => x.isPrimary)).toHaveLength(1);
    expect(assignments.find((x: { connectionId: string }) => x.connectionId === second.id).isPrimary).toBe(true);
  });

  it("updates and deletes persona social account assignments", async () => {
    const persona = await createPersona("CEO");
    const first = await connectSocial("linkedin", "nango-linkedin-c");
    const second = await connectSocial("linkedin", "nango-linkedin-d");

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
      payload: { connectionId: first.id, channel: "linkedin", isPrimary: true },
    });
    expect(created.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts/${created.json().id}`,
      payload: {
        connectionId: second.id,
        channel: "linkedin",
        isPrimary: false,
        defaultTarget: "company-page",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      connectionId: second.id,
      isPrimary: false,
      defaultTarget: "company-page",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts/${created.json().id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
    });
    expect(list.json()).toHaveLength(0);
  });

  it("rejects persona account assignment to a non-social connection", async () => {
    const persona = await createPersona("CEO");
    const crm = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/smartlead/connect`,
      payload: { apiKey: "sk-live-123" },
    });
    expect(crm.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas/${persona.id}/social-accounts`,
      payload: { connectionId: crm.json().id, channel: "linkedin", isPrimary: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_social");
  });

  it("resolves a persona primary account and rejects mismatched explicit accounts", async () => {
    const persona = await createPersona("CEO");
    const ceoAccount = await connectSocial("linkedin", "nango-linkedin-ceo");
    const otherAccount = await connectSocial("linkedin", "nango-linkedin-other");
    await assign(persona.id, ceoAccount.id, "linkedin", true);

    const primary = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: persona.id,
      providerKey: "linkedin",
      channel: "linkedin",
    });
    expect(primary.ok).toBe(true);
    if (!primary.ok) throw new Error(primary.error);
    expect(primary.connection.id).toBe(ceoAccount.id);

    const mismatch = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: persona.id,
      providerKey: "linkedin",
      channel: "linkedin",
      explicitConnectionId: otherAccount.id,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error("expected persona_account_mismatch");
    expect(mismatch.error).toBe("persona_account_mismatch");
  });

  it("reports missing persona primary accounts and allows persona-less explicit accounts", async () => {
    const persona = await createPersona("CEO");
    const account = await connectSocial("linkedin", "nango-linkedin-manual");

    const missing = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: persona.id,
      providerKey: "linkedin",
      channel: "linkedin",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected persona_account_missing");
    expect(missing.error).toBe("persona_account_missing");

    const explicit = resolvePersonaSocialConnection(db, workspaceId, {
      personaId: null,
      providerKey: "linkedin",
      channel: "linkedin",
      explicitConnectionId: account.id,
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.connection.id).toBe(account.id);
  });

  describe("persona topics & structured drafting fields (Sprint 44)", () => {
    it("defaults the new fields to empty", async () => {
      const persona = await createPersona("Plain");
      expect(persona).toMatchObject({ topics: [], tone: "", styleRules: "", avoid: "" });
    });

    it("round-trips topics/tone/styleRules/avoid through create, update, and list", async () => {
      const created = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: {
            name: "Field CTO",
            topics: ["agentic coding", "evals"],
            tone: "dry, technical",
            styleRules: "Short sentences.\nNo emoji.",
            avoid: "synergy",
          },
        })
      ).json();
      expect(created.topics).toEqual(["agentic coding", "evals"]);
      expect(created.tone).toBe("dry, technical");

      const updated = (
        await app.inject({
          method: "PUT",
          url: `/workspaces/${workspaceId}/personas/${created.id}`,
          payload: { name: "Field CTO", topics: ["context engineering"], avoid: "delve" },
        })
      ).json();
      expect(updated.topics).toEqual(["context engineering"]);
      expect(updated.avoid).toBe("delve");
      expect(updated.tone).toBe(""); // full replace, like overlay

      const listed = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/personas` })
      ).json();
      expect(listed[0].topics).toEqual(["context engineering"]);
    });

    it("rejects more than 20 topics", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Too many", topics: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      });
      expect(res.statusCode).toBe(400);
    });

    it("renders labeled persona lines in the /resolve trace and feeds topics into the zoom query", async () => {
      await seedLongHistory();
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: {
            name: "Field CTO",
            description: "Founder voice",
            topics: ["usage-based pricing"],
            tone: "dry, technical",
            styleRules: "Short sentences.",
            avoid: "synergy",
          },
        })
      ).json();

      const resolved = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/resolve`,
          payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
        })
      ).json();

      const section = resolved.sections.find((s: { key: string }) => s.key === "persona");
      expect(section.content).toContain("Topics this persona covers: usage-based pricing");
      expect(section.content).toContain("Tone: dry, technical");
      expect(section.content).toContain("Style rules:\nShort sentences.");
      expect(section.content).toContain("Never say / avoid:\nsynergy");
      expect(resolved.zoomQuery).toContain("usage-based pricing");
    });
  });

  describe("account content profile injection (Sprint 44)", () => {
    async function boundPersonaAndConnection() {
      const persona = await createPersona("CEO");
      const connection = await connectSocial("linkedin", "nango-linkedin-profile");
      await assign(persona.id, connection.id, "linkedin", true);
      return { persona, connection };
    }

    function setProfile(connectionId: string, profile: { topics: string[]; guidance: string }) {
      return app.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/connections/${connectionId}/content-profile`,
        payload: profile,
      });
    }

    it("injects the account section into a draft when the bound connection has a profile", async () => {
      const { persona, connection } = await boundPersonaAndConnection();
      const saved = await setProfile(connection.id, {
        topics: ["churn for agencies"],
        guidance: "Plain-spoken. No hashtags.",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().contentProfile).toEqual({
        topics: ["churn for agencies"],
        guidance: "Plain-spoken. No hashtags.",
      });

      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
        })
      ).json();

      const keys = gen.sections.map((s: { key: string }) => s.key);
      expect(keys.indexOf("account")).toBe(keys.indexOf("persona") + 1);
      const account = gen.sections.find((s: { key: string }) => s.key === "account");
      expect(account.content).toContain("Publishing as: LinkedIn on linkedin.");
      expect(account.content).toContain("This account covers: churn for agencies");
      expect(account.content).toContain("Account guidelines:\nPlain-spoken. No hashtags.");
      expect(account.reason).toContain("Account content profile");

      // The inspector shows what a generation sends: account topics feed Tier 3.
      await seedLongHistory();
      const resolved = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/resolve`,
          payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
        })
      ).json();
      expect(resolved.zoomQuery).toContain("churn for agencies");
    });

    it("omits the account section when the connection has no content profile", async () => {
      const { persona } = await boundPersonaAndConnection();
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
        })
      ).json();
      expect(gen.sections.some((s: { key: string }) => s.key === "account")).toBe(false);
    });

    it("an engagement reply takes its account from the inbox item's own connection", async () => {
      const connection = await connectSocial("linkedin", "nango-linkedin-inbox");
      await setProfile(connection.id, { topics: ["gtm memory"], guidance: "" });

      const now = Date.now();
      const item: InboxItem = {
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        workspaceId,
        connectionId: connection.id,
        providerKey: "linkedin",
        kind: "comment",
        channel: "linkedin",
        externalId: "ext-1",
        parentExternalId: null,
        publicationId: null,
        launchMessageId: null,
        authorHandle: "someone",
        authorName: "Someone",
        content: "How does this handle churn?",
        url: null,
        status: "unread",
        replyDraftId: null,
        postedReplyExternalId: null,
        postedReplyUrl: null,
        externalCreatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      const draft = await generateEngagementReply(
        db,
        fakeLlm,
        {
          async health() {
            return { healthy: false, detail: "test" };
          },
          async createCollection() {
            throw new Error("unavailable");
          },
          async addDocument() {
            throw new Error("unavailable");
          },
          async attachDocument() {
            throw new Error("unavailable");
          },
          async deleteDocument() {
            throw new Error("unavailable");
          },
          async search() {
            throw new Error("unavailable");
          },
        },
        { id: workspaceId, name: "Personable" },
        item,
        {},
        { userId: null, label: "test" },
      );
      expect(draft.taskType).toBe("engagement_reply");

      const generations = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/generations` })
      ).json();
      const reply = generations.find((g: { taskType: string }) => g.taskType === "engagement_reply");
      const account = reply.sections.find((s: { key: string }) => s.key === "account");
      expect(account.content).toContain("This account covers: gtm memory");
    });
  });
});
