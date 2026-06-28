import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personaSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { ConnectorFabricError, type ConnectorFabric } from "../src/connectors/fabric";
import { buildAuthedApp, createTestDb } from "./helpers";

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
  let workspaceId: string;
  let state: FabricState;

  beforeEach(async () => {
    state = { healthy: true, connections: new Map() };
    app = await buildAuthedApp({ db: createTestDb(), connectors: fakeFabric(state) });
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
});
