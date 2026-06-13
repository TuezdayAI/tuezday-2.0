import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { ConnectorFabricError, type ConnectorFabric } from "../src/connectors/fabric";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Generated.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

interface FabricState {
  healthy: boolean;
  integrations: Set<string>;
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  proxyStatus: number;
}

function fakeFabric(state: FabricState): ConnectorFabric {
  return {
    async health() {
      return state.healthy ? { healthy: true } : { healthy: false, detail: "nango is down" };
    },
    async ensureIntegration(uniqueKey) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      state.integrations.add(uniqueKey);
    },
    async createConnectSession() {
      return { token: "session-token" };
    },
    async importConnection(providerConfigKey, connectionId, credentials) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
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
    async proxyJson() {
      return { status: state.proxyStatus, json: { ok: true } };
    },
  };
}

interface ReceivedHook {
  url: string;
  body: string;
  signature: string | null;
  eventType: string | null;
}

function webhookFetcher(received: ReceivedHook[], failUrls: string[] = []): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    received.push({
      url: u,
      body: String(init?.body ?? ""),
      signature: headers["X-Tuezday-Signature"] ?? null,
      eventType: headers["X-Tuezday-Event"] ?? null,
    });
    if (failUrls.some((f) => u.includes(f))) return new Response("nope", { status: 500 });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

describe("connector fabric API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FabricState;
  let received: ReceivedHook[];

  beforeEach(async () => {
    state = { healthy: true, integrations: new Set(), connections: new Map(), proxyStatus: 200 };
    received = [];
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: fakeLlm,
      connectors: fakeFabric(state),
      fetcher: webhookFetcher(received, ["failing.example.com"]),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Conn" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function connect(providerKey = "smartlead", payload: Record<string, unknown> = { apiKey: "sk-live-123" }) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/${providerKey}/connect`,
      payload,
    });
  }

  describe("connections", () => {
    it("lists the registry with fabric health", async () => {
      const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` });
      const body = res.json();
      expect(body.providers.length).toBeGreaterThan(3);
      expect(body.fabric.healthy).toBe(true);
      expect(body.connections).toEqual([]);
    });

    it("connects an api_key provider, storing no credentials locally", async () => {
      const res = await connect();
      expect(res.statusCode).toBe(201);
      const connection = res.json();
      expect(connectionSchema.safeParse(connection).success).toBe(true);
      expect(connection.status).toBe("connected");
      expect(JSON.stringify(connection)).not.toContain("sk-live-123");
      // credentials reached the fabric, integration was ensured
      expect(state.integrations.has("tuezday-smartlead")).toBe(true);
      const stored = [...state.connections.values()][0];
      expect(stored!.credentials).toEqual({ type: "API_KEY", apiKey: "sk-live-123" });
    });

    it("refuses oauth providers until an OAuth app exists", async () => {
      const res = await connect("hubspot");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("needs_oauth_app");
    });

    it("requires a baseUrl for the custom provider", async () => {
      const res = await connect("custom", {});
      expect(res.statusCode).toBe(400);
    });

    it("requires an api key for api_key providers", async () => {
      const res = await connect("smartlead", {});
      expect(res.statusCode).toBe(400);
    });

    it("connects the custom provider without credentials", async () => {
      const res = await connect("custom", {
        baseUrl: "https://api.example.com",
        testPath: "/status",
      });
      expect(res.statusCode).toBe(201);
      const stored = [...state.connections.values()][0];
      expect(stored!.credentials).toEqual({ type: "NONE" });
      expect(res.json().config).toEqual({
        baseUrl: "https://api.example.com",
        testPath: "/status",
      });
    });

    it("refuses double-connect with 409", async () => {
      await connect();
      const res = await connect();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("already_connected");
    });

    it("returns 503 when the fabric is down", async () => {
      state.healthy = false;
      const res = await connect();
      expect(res.statusCode).toBe(503);
    });

    it("tests a connection through the proxy and updates status", async () => {
      const connection = (await connect()).json();
      const ok = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connections/${connection.id}/test`,
      });
      expect(ok.json().ok).toBe(true);

      state.proxyStatus = 401;
      const bad = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connections/${connection.id}/test`,
      });
      expect(bad.json().ok).toBe(false);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
      ).json();
      expect(list.connections[0].status).toBe("error");
      expect(list.connections[0].lastError).toContain("401");
    });

    it("disconnects and reconnects", async () => {
      const connection = (await connect()).json();
      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/connections/${connection.id}`,
      });
      expect(del.statusCode).toBe(204);
      expect(state.connections.size).toBe(0);

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/connectors` })
      ).json();
      expect(list.connections[0].status).toBe("disconnected");

      const re = await connect();
      expect(re.statusCode).toBe(201);
      expect(re.json().id).toBe(connection.id); // same row revived
      expect(re.json().status).toBe("connected");
    });
  });

  describe("webhooks and events", () => {
    async function addWebhook(url = "https://hooks.example.com/tuezday", eventTypes = ["draft.approved"]) {
      return (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/webhooks`,
          payload: { url, eventTypes, secret: "supersecret1" },
        })
      ).json();
    }

    async function approveADraft() {
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      const draft = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generations/${gen.id}/submit`,
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });
      return draft;
    }

    it("delivers a signed event when a draft is approved", async () => {
      await addWebhook();
      const draft = await approveADraft();

      expect(received).toHaveLength(1);
      const hook = received[0]!;
      expect(hook.eventType).toBe("draft.approved");
      const expected = `sha256=${createHmac("sha256", "supersecret1").update(hook.body).digest("hex")}`;
      expect(hook.signature).toBe(expected);
      const payload = JSON.parse(hook.body);
      expect(payload.type).toBe("draft.approved");
      expect(payload.payload.draftId).toBe(draft.id);
      expect(payload.payload.content).toBe("Generated.");
    });

    it("filters by event type", async () => {
      await addWebhook("https://hooks.example.com/x", ["draft.rejected"]);
      await approveADraft();
      expect(received).toHaveLength(0);
    });

    it("records the event even with no subscriptions and never breaks the action", async () => {
      await addWebhook("https://failing.example.com/hook");
      await approveADraft(); // delivery fails but approve succeeded
      const events = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/events` })
      ).json();
      const approved = events.find((e: { type: string }) => e.type === "draft.approved");
      expect(approved).toBeDefined();
      expect(approved.deliveries[0].status).toBe("failed");
      expect(approved.deliveries[0].httpStatus).toBe(500);
    });

    it("pings a webhook regardless of its filters", async () => {
      const webhook = await addWebhook("https://hooks.example.com/y", ["draft.rejected"]);
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/webhooks/${webhook.id}/ping`,
      });
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.eventType).toBe("webhook.ping");
    });

    it("disabled webhooks receive nothing", async () => {
      const webhook = await addWebhook();
      await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/webhooks/${webhook.id}`,
        payload: { enabled: false },
      });
      await approveADraft();
      expect(received).toHaveLength(0);
    });

    it("deletes a webhook", async () => {
      const webhook = await addWebhook();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/webhooks/${webhook.id}`,
      });
      expect(res.statusCode).toBe(204);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/webhooks` })
      ).json();
      expect(list).toEqual([]);
    });
  });
});
