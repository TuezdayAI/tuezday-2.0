import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crmContactSchema } from "@tuezday/contracts";
import { buildApp, type TuezdayApp } from "../src/app";
import {
  ConnectorFabricError,
  type ConnectorFabric,
  type ProxyJsonResult,
} from "../src/connectors/fabric";
import { FreshsalesAdapter } from "../src/connectors/crm/freshsales";
import { NangoFabric } from "../src/connectors/nango";
import type { LlmGateway } from "../src/llm/gateway";
import { createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Hi {{lead}}, drafted by Tuezday.", model: "fake", provider: "fake", durationMs: 5 };
  },
};

// ---------------------------------------------------------------------------
// Fake fabric with an in-memory Freshsales behind the proxy
// ---------------------------------------------------------------------------

interface FreshsalesContact {
  id: number;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  emails?: Array<{ value: string; is_primary?: boolean }>;
  job_title?: string;
  sales_accounts?: Array<{ id: number; name: string; is_primary?: boolean }>;
}

interface FreshsalesState {
  contacts: FreshsalesContact[];
  notes: Array<{ description: string; targetable_type: string; targetable_id: number }>;
  nextId: number;
  perPage: number;
  /** When set, every proxied request returns this status with an error body. */
  failStatus: number | null;
}

interface FabricState {
  healthy: boolean;
  integrations: Set<string>;
  connections: Map<
    string,
    { providerConfigKey: string; credentials: unknown; connectionConfig?: Record<string, string> }
  >;
  proxyStatus: number;
  freshsales: FreshsalesState;
}

function freshsalesState(contacts: FreshsalesContact[] = []): FreshsalesState {
  return { contacts, notes: [], nextId: 1000, perPage: 100, failStatus: null };
}

function fabricState(contacts: FreshsalesContact[] = []): FabricState {
  return {
    healthy: true,
    integrations: new Set(),
    connections: new Map(),
    proxyStatus: 200,
    freshsales: freshsalesState(contacts),
  };
}

function handleFreshsales(state: FreshsalesState, method: string, path: string, body: unknown): ProxyJsonResult {
  if (state.failStatus) return { status: state.failStatus, json: { errors: ["boom"] } };

  if (method === "GET" && path.startsWith("/api/contacts/filters")) {
    return {
      status: 200,
      json: { filters: [{ id: 9, name: "My Contacts" }, { id: 4, name: "All Contacts" }] },
    };
  }
  if (method === "GET" && path.startsWith("/api/contacts/view/")) {
    const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? "1");
    const totalPages = Math.max(1, Math.ceil(state.contacts.length / state.perPage));
    const slice = state.contacts.slice((page - 1) * state.perPage, page * state.perPage);
    return { status: 200, json: { contacts: slice, meta: { total_pages: totalPages } } };
  }
  if (method === "POST" && path.startsWith("/api/contacts")) {
    const input = (body as { contact: Record<string, unknown> }).contact;
    const contact: FreshsalesContact = { id: state.nextId++, ...input } as FreshsalesContact;
    state.contacts.push(contact);
    return { status: 201, json: { contact: { id: contact.id } } };
  }
  if (method === "POST" && path.startsWith("/api/notes")) {
    const note = (body as { note: FreshsalesState["notes"][number] }).note;
    state.notes.push(note);
    return { status: 201, json: { note: { id: 1 } } };
  }
  return { status: 404, json: { errors: ["no such endpoint"] } };
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
    async importConnection(providerConfigKey, connectionId, credentials, connectionConfig) {
      if (!state.healthy) throw new ConnectorFabricError("nango is down");
      state.connections.set(connectionId, { providerConfigKey, credentials, connectionConfig });
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
      return handleFreshsales(state.freshsales, method, path, opts?.body);
    },
  };
}

// ---------------------------------------------------------------------------
// NangoFabric request shapes for the Sprint 13 additions
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetcher(recorded: RecordedRequest[], respond: () => Response): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    recorded.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return respond();
  }) as typeof fetch;
}

describe("NangoFabric (Sprint 13 additions)", () => {
  it("sends connection_config when importing a connection", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response("{}", { status: 200 })),
    );
    await fabric.importConnection(
      "tuezday-freshsales",
      "ws-1-freshsales",
      { type: "API_KEY", apiKey: "fs-key" },
      { bundleAlias: "acme.myfreshworks.com/crm/sales" },
    );
    const body = JSON.parse(recorded[0]!.body);
    expect(body.connection_config).toEqual({ bundleAlias: "acme.myfreshworks.com/crm/sales" });
    expect(body.credentials).toEqual({ type: "API_KEY", apiKey: "fs-key" });
  });

  it("omits connection_config when not given", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response("{}", { status: 200 })),
    );
    await fabric.importConnection("tuezday-smartlead", "ws-1-smartlead", {
      type: "API_KEY",
      apiKey: "sk",
    });
    expect(JSON.parse(recorded[0]!.body)).not.toHaveProperty("connection_config");
  });

  it("proxies JSON GETs with connection headers and parses the body", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response('{"filters":[]}', { status: 200 })),
    );
    const result = await fabric.proxyJson("GET", "/api/contacts/filters", "conn-1", "tuezday-freshsales", {
      baseUrlOverride: "https://acme.myfreshworks.com/crm/sales",
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ filters: [] });
    const req = recorded[0]!;
    expect(req.url).toBe("http://nango.test/proxy/api/contacts/filters");
    expect(req.method).toBe("GET");
    expect(req.headers["Connection-Id"]).toBe("conn-1");
    expect(req.headers["Provider-Config-Key"]).toBe("tuezday-freshsales");
    expect(req.headers["Base-Url-Override"]).toBe("https://acme.myfreshworks.com/crm/sales");
    expect(req.body).toBe("");
  });

  it("proxies JSON POSTs with a serialized body", async () => {
    const recorded: RecordedRequest[] = [];
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher(recorded, () => new Response('{"contact":{"id":7}}', { status: 201 })),
    );
    const result = await fabric.proxyJson("POST", "/api/contacts", "conn-1", "tuezday-freshsales", {
      body: { contact: { first_name: "Asha" } },
    });
    expect(result.status).toBe(201);
    expect(result.json).toEqual({ contact: { id: 7 } });
    const req = recorded[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ contact: { first_name: "Asha" } });
  });

  it("returns undefined json for non-JSON responses without throwing", async () => {
    const fabric = new NangoFabric(
      "http://nango.test",
      "secret",
      recordingFetcher([], () => new Response("<html>upstream error</html>", { status: 502 })),
    );
    const result = await fabric.proxyJson("GET", "/api/x", "conn-1", "key");
    expect(result.status).toBe(502);
    expect(result.json).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FreshsalesAdapter
// ---------------------------------------------------------------------------

function adapterFor(state: FreshsalesState): FreshsalesAdapter {
  const fabric = {
    async proxyJson(method: "GET" | "POST", path: string, _c: string, _k: string, opts?: { body?: unknown }) {
      return handleFreshsales(state, method, path, opts?.body);
    },
  } as unknown as ConnectorFabric;
  return new FreshsalesAdapter(fabric, {
    nangoConnectionId: "ws-1-freshsales",
    integrationKey: "tuezday-freshsales",
    baseUrl: "https://acme.myfreshworks.com/crm/sales",
  });
}

describe("FreshsalesAdapter", () => {
  it("lists contacts from the All Contacts view and maps fields defensively", async () => {
    const state = freshsalesState([
      {
        id: 1,
        display_name: "Asha Rao",
        emails: [
          { value: "old@acme.io", is_primary: false },
          { value: "asha@acme.io", is_primary: true },
        ],
        job_title: "VP Marketing",
        sales_accounts: [{ id: 5, name: "Acme", is_primary: true }],
      },
      { id: 2, first_name: "Ben", last_name: "Iyer", email: "ben@zen.io" },
      { id: 3, first_name: "NoEmail" },
    ]);
    const { contacts, truncated } = await adapterFor(state).listContacts();
    expect(truncated).toBe(false);
    expect(contacts).toEqual([
      { externalId: "1", name: "Asha Rao", email: "asha@acme.io", company: "Acme", role: "VP Marketing" },
      { externalId: "2", name: "Ben Iyer", email: "ben@zen.io", company: "", role: "" },
      { externalId: "3", name: "NoEmail", email: "", company: "", role: "" },
    ]);
  });

  it("walks pagination and reports truncation at the page cap", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      display_name: `Contact ${i + 1}`,
      email: `c${i + 1}@x.io`,
    }));
    const state = freshsalesState(many);
    state.perPage = 25;
    const { contacts, truncated } = await adapterFor(state).listContacts();
    expect(contacts).toHaveLength(60);
    expect(truncated).toBe(false);

    // 30 "pages" of 1 → capped at 25 pages
    const wide = freshsalesState(Array.from({ length: 30 }, (_, i) => ({ id: i + 1, email: `c${i}@x.io` })));
    wide.perPage = 1;
    const capped = await adapterFor(wide).listContacts();
    expect(capped.contacts).toHaveLength(25);
    expect(capped.truncated).toBe(true);
  });

  it("creates a contact with the supported emails array shape and split name", async () => {
    const state = freshsalesState();
    const externalId = await adapterFor(state).createContact({
      name: "Asha Devi Rao",
      email: "asha@acme.io",
      role: "VP Marketing",
    });
    expect(externalId).toBe("1000");
    const created = state.contacts[0]!;
    expect(created.first_name).toBe("Asha Devi");
    expect(created.last_name).toBe("Rao");
    expect(created.emails).toEqual([{ value: "asha@acme.io", is_primary: true }]);
    expect(created.job_title).toBe("VP Marketing");
  });

  it("puts single-word names in first_name", async () => {
    const state = freshsalesState();
    await adapterFor(state).createContact({ name: "Cher", email: "cher@x.io" });
    expect(state.contacts[0]!.first_name).toBe("Cher");
    expect(state.contacts[0]!.last_name).toBeUndefined();
  });

  it("logs a note against the contact", async () => {
    const state = freshsalesState();
    await adapterFor(state).createNote("42", "Approved email body");
    expect(state.notes).toEqual([
      { description: "Approved email body", targetable_type: "Contact", targetable_id: 42 },
    ]);
  });

  it("raises ConnectorFabricError on non-2xx responses", async () => {
    const state = freshsalesState();
    state.failStatus = 500;
    await expect(adapterFor(state).listContacts()).rejects.toThrow(ConnectorFabricError);
    await expect(
      adapterFor(state).createContact({ name: "X", email: "x@x.io" }),
    ).rejects.toThrow(ConnectorFabricError);
  });
});

// ---------------------------------------------------------------------------
// CRM API (routes + services over the fake fabric)
// ---------------------------------------------------------------------------

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

describe("CRM read/write API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: FabricState;
  let received: ReceivedHook[];

  beforeEach(async () => {
    state = fabricState([
      {
        id: 1,
        display_name: "Asha Rao",
        emails: [{ value: "asha@acme.io", is_primary: true }],
        job_title: "VP Marketing",
        sales_accounts: [{ id: 5, name: "Acme", is_primary: true }],
      },
      { id: 2, first_name: "Ben", last_name: "Iyer", email: "ben@zen.io" },
      { id: 3, first_name: "NoEmail" },
    ]);
    received = [];
    app = await buildApp({
      db: createTestDb(),
      llm: fakeLlm,
      connectors: fakeFabric(state),
      fetcher: webhookFetcher(received),
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "CRM" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function connectFreshsales() {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/connectors/freshsales/connect`,
      payload: { apiKey: "fs-key-123", baseUrl: "https://acme.myfreshworks.com/crm/sales" },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function sync(connectionId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/crm/sync`,
      payload: { connectionId },
    });
  }

  function listContacts() {
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/crm/contacts` })
      .then((r) => r.json());
  }

  async function createLead(payload: Record<string, unknown>) {
    return (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/leads`, payload })
    ).json();
  }

  async function approvedOutboundDraftFor(leadId: string): Promise<string> {
    const draftRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outbound/draft`,
      payload: { leadIds: [leadId], useEvidence: false },
    });
    const draftId = draftRes.json().results[0].draftId as string;
    const approve = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
    });
    expect(approve.statusCode).toBe(200);
    return draftId;
  }

  describe("connect", () => {
    it("connects freshsales with a bundle base url, passing connection_config to the fabric", async () => {
      await connectFreshsales();
      const stored = state.connections.get(`ws-${workspaceId}-freshsales`);
      expect(stored).toBeDefined();
      expect(stored!.credentials).toEqual({ type: "API_KEY", apiKey: "fs-key-123" });
      expect(stored!.connectionConfig).toEqual({ bundleAlias: "acme.myfreshworks.com/crm/sales" });
    });

    it("refuses freshsales without a base url", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/freshsales/connect`,
        payload: { apiKey: "fs-key-123" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("sync (read)", () => {
    it("pulls contacts into the mirror", async () => {
      const connection = await connectFreshsales();
      const res = await sync(connection.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fetched: 3, created: 3, updated: 0, truncated: false });

      const contacts = await listContacts();
      expect(contacts).toHaveLength(3);
      const asha = contacts.find((c: { externalId: string }) => c.externalId === "1");
      expect(crmContactSchema.safeParse(asha).success).toBe(true);
      expect(asha.name).toBe("Asha Rao");
      expect(asha.email).toBe("asha@acme.io");
      expect(asha.company).toBe("Acme");
      expect(asha.role).toBe("VP Marketing");
      expect(asha.lead).toBeNull();
    });

    it("is idempotent and counts updates on changed contacts", async () => {
      const connection = await connectFreshsales();
      await sync(connection.id);

      const again = await sync(connection.id);
      expect(again.json()).toEqual({ fetched: 3, created: 0, updated: 0, truncated: false });

      state.freshsales.contacts[0]!.job_title = "CMO";
      const changed = await sync(connection.id);
      expect(changed.json()).toEqual({ fetched: 3, created: 0, updated: 1, truncated: false });
      const contacts = await listContacts();
      expect(contacts.find((c: { externalId: string }) => c.externalId === "1").role).toBe("CMO");
    });

    it("refuses syncing a non-CRM connection", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/smartlead/connect`,
        payload: { apiKey: "sk" },
      });
      const smartlead = res.json();
      const bad = await sync(smartlead.id);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("not_a_crm_connection");
    });

    it("refuses syncing a disconnected connection and 404s unknown ones", async () => {
      const connection = await connectFreshsales();
      await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/connections/${connection.id}`,
      });
      expect((await sync(connection.id)).statusCode).toBe(400);
      expect((await sync("7c9e6679-7425-40de-944b-e07fc1f90ae7")).statusCode).toBe(404);
    });

    it("returns 502 and writes nothing when the CRM call fails", async () => {
      const connection = await connectFreshsales();
      state.freshsales.failStatus = 500;
      const res = await sync(connection.id);
      expect(res.statusCode).toBe(502);
      expect(await listContacts()).toEqual([]);
    });
  });

  describe("import as lead", () => {
    async function syncedContacts() {
      const connection = await connectFreshsales();
      await sync(connection.id);
      return { connection, contacts: await listContacts() };
    }

    it("creates a lead from a CRM contact and links it", async () => {
      const { contacts } = await syncedContacts();
      const asha = contacts.find((c: { externalId: string }) => c.externalId === "1");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/contacts/${asha.id}/import-lead`,
      });
      expect(res.statusCode).toBe(201);
      const { lead, linkedExisting } = res.json();
      expect(linkedExisting).toBe(false);
      expect(lead.name).toBe("Asha Rao");
      expect(lead.email).toBe("asha@acme.io");
      expect(lead.company).toBe("Acme");
      expect(lead.role).toBe("VP Marketing");
      expect(lead.notes).toContain("Freshsales");

      const after = await listContacts();
      expect(after.find((c: { id: string }) => c.id === asha.id).lead).toEqual({
        id: lead.id,
        name: lead.name,
      });
    });

    it("links to an existing lead with the same email instead of duplicating", async () => {
      const existing = await createLead({ name: "Asha R.", email: "ASHA@acme.io" });
      const { contacts } = await syncedContacts();
      const asha = contacts.find((c: { externalId: string }) => c.externalId === "1");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/contacts/${asha.id}/import-lead`,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().linkedExisting).toBe(true);
      expect(res.json().lead.id).toBe(existing.id);
      const leads = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/leads` })
      ).json();
      expect(leads).toHaveLength(1);
    });

    it("refuses contacts without an email and double imports", async () => {
      const { contacts } = await syncedContacts();
      const noEmail = contacts.find((c: { externalId: string }) => c.externalId === "3");
      const bad = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/contacts/${noEmail.id}/import-lead`,
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("contact_has_no_email");

      const asha = contacts.find((c: { externalId: string }) => c.externalId === "1");
      const url = `/workspaces/${workspaceId}/crm/contacts/${asha.id}/import-lead`;
      await app.inject({ method: "POST", url });
      const again = await app.inject({ method: "POST", url });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_linked");
    });
  });

  describe("push lead (write)", () => {
    it("creates a CRM contact from a lead, stores the link, and emits crm.contact.created", async () => {
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/webhooks`,
        payload: {
          url: "https://hooks.example.com/crm",
          eventTypes: ["crm.contact.created"],
          secret: "supersecret1",
        },
      });
      const connection = await connectFreshsales();
      const lead = await createLead({
        name: "Devi Nair",
        email: "devi@startup.io",
        role: "Founder",
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/push-lead`,
        payload: { leadId: lead.id, connectionId: connection.id },
      });
      expect(res.statusCode).toBe(201);
      const mirror = res.json();
      expect(mirror.leadId).toBe(lead.id);
      expect(mirror.email).toBe("devi@startup.io");

      // it actually reached the CRM
      const pushed = state.freshsales.contacts.find((c) => c.id === Number(mirror.externalId));
      expect(pushed).toBeDefined();
      expect(pushed!.first_name).toBe("Devi");
      expect(pushed!.last_name).toBe("Nair");
      expect(pushed!.emails).toEqual([{ value: "devi@startup.io", is_primary: true }]);

      expect(received.filter((h) => h.eventType === "crm.contact.created")).toHaveLength(1);
    });

    it("refuses pushing an already linked lead", async () => {
      const connection = await connectFreshsales();
      const lead = await createLead({ name: "Devi Nair", email: "devi@startup.io" });
      const url = `/workspaces/${workspaceId}/crm/push-lead`;
      await app.inject({ method: "POST", url, payload: { leadId: lead.id, connectionId: connection.id } });
      const again = await app.inject({
        method: "POST",
        url,
        payload: { leadId: lead.id, connectionId: connection.id },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("already_linked");
    });

    it("returns 502 and stores no mirror row when the CRM rejects the write", async () => {
      const connection = await connectFreshsales();
      const lead = await createLead({ name: "Devi Nair", email: "devi@startup.io" });
      state.freshsales.failStatus = 422;
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/push-lead`,
        payload: { leadId: lead.id, connectionId: connection.id },
      });
      expect(res.statusCode).toBe(502);
      expect(await listContacts()).toEqual([]);
    });
  });

  describe("log approved draft (write)", () => {
    async function importedLead() {
      const connection = await connectFreshsales();
      await sync(connection.id);
      const contacts = await listContacts();
      const asha = contacts.find((c: { externalId: string }) => c.externalId === "1");
      const imported = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/contacts/${asha.id}/import-lead`,
      });
      return { connection, lead: imported.json().lead };
    }

    it("logs the approved email as a note on the linked contact and emits crm.note.logged", async () => {
      const { lead } = await importedLead();
      const draftId = await approvedOutboundDraftFor(lead.id);
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/log-draft`,
        payload: { draftId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().externalId).toBe("1");

      expect(state.freshsales.notes).toHaveLength(1);
      const note = state.freshsales.notes[0]!;
      expect(note.targetable_type).toBe("Contact");
      expect(note.targetable_id).toBe(1);
      expect(note.description).toContain("Hi {{lead}}, drafted by Tuezday.");
      expect(note.description).toContain("Tuezday");

      const events = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/events` })
      ).json();
      expect(events.some((e: { type: string }) => e.type === "crm.note.logged")).toBe(true);
    });

    it("refuses drafts that are not approved", async () => {
      const { lead } = await importedLead();
      const draftRes = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id], useEvidence: false },
      });
      const pendingDraftId = draftRes.json().results[0].draftId;
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/log-draft`,
        payload: { draftId: pendingDraftId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("draft_not_approved");
    });

    it("refuses drafts without a lead", async () => {
      await importedLead();
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
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve` });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/log-draft`,
        payload: { draftId: draft.id },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("draft_has_no_lead");
    });

    it("refuses when the lead is not linked to a CRM contact", async () => {
      await connectFreshsales();
      const lead = await createLead({ name: "Unlinked", email: "un@linked.io" });
      const draftId = await approvedOutboundDraftFor(lead.id);
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/crm/log-draft`,
        payload: { draftId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("lead_not_linked");
    });
  });
});
