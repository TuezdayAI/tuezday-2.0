import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import { ConnectorFabricError } from "../src/connectors/fabric";
import { hasSocialConnection, readSocialCorpus } from "../src/services/social-corpus";
import { connections } from "../src/db/schema";
import type { Db } from "../src/db";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";
import { createWorkspace } from "../src/services/workspaces";
import { registerAccount } from "../src/services/auth";

// ---------------------------------------------------------------------------
// Fixtures — a fabric whose proxyJson answers per platform path.
// ---------------------------------------------------------------------------

const X_ME = {
  data: { id: "42", username: "hexalog", name: "Hexalog", description: "Logs, but hexagonal" },
};
const X_TWEETS = {
  data: [
    { id: "1", text: "We shipped hex packing!", created_at: "2026-06-01T10:00:00Z" },
    { id: "2", text: "Logs should be honest.", created_at: "2026-06-02T10:00:00Z" },
  ],
};

function corpusFabric(opts?: { failTwitter?: boolean }): ConnectorFabric {
  const unused = async (): Promise<never> => {
    throw new Error("unused in this test");
  };
  return {
    health: async () => ({ healthy: true }),
    ensureIntegration: async () => {},
    createConnectSession: unused,
    importConnection: async () => {},
    connectionExists: async () => true,
    deleteConnection: async () => {},
    proxyGet: unused,
    async proxyJson(_method, path): Promise<ProxyJsonResult> {
      if (opts?.failTwitter) return { status: 401, json: { title: "Unauthorized" } };
      if (path.startsWith("/2/users/me")) return { status: 200, json: X_ME };
      if (/^\/2\/users\/42\/tweets/.test(path)) return { status: 200, json: X_TWEETS };
      return { status: 404, json: { message: `no fixture for ${path}` } };
    },
  };
}

function seedConnection(db: Db, workspaceId: string, providerKey: string, status = "connected") {
  db.insert(connections)
    .values({
      id: randomUUID(),
      workspaceId,
      providerKey,
      nangoConnectionId: `ws-${workspaceId}-${providerKey}`,
      configJson: "{}",
      status,
      lastCheckedAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

function setup() {
  const db = createTestDb();
  const { user } = registerAccount(db, {
    email: `sc-${randomUUID()}@test.dev`,
    password: "test-password-1",
    name: "SC",
  });
  const ws = createWorkspace(db, { name: "Corpus WS" }, user.id);
  return { db, ws };
}

// ---------------------------------------------------------------------------
// hasSocialConnection
// ---------------------------------------------------------------------------

describe("hasSocialConnection", () => {
  it("false with no connections, true with one connected social", () => {
    const { db, ws } = setup();
    expect(hasSocialConnection(db, ws.id)).toBe(false);
    seedConnection(db, ws.id, "slack"); // non-social: still false
    expect(hasSocialConnection(db, ws.id)).toBe(false);
    seedConnection(db, ws.id, "twitter");
    expect(hasSocialConnection(db, ws.id)).toBe(true);
  });

  it("ignores disconnected social connections", () => {
    const { db, ws } = setup();
    seedConnection(db, ws.id, "linkedin", "disconnected");
    expect(hasSocialConnection(db, ws.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readSocialCorpus
// ---------------------------------------------------------------------------

describe("readSocialCorpus", () => {
  it("reads a connected twitter account into the corpus", async () => {
    const { db, ws } = setup();
    seedConnection(db, ws.id, "twitter");
    const corpus = await readSocialCorpus(db, corpusFabric(), ws.id);
    expect(corpus.connected).toEqual(["twitter"]);
    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]!.profile?.handle).toBe("hexalog");
    expect(corpus.entries[0]!.error).toBeNull();
    expect(corpus.corpus).toContain("Logs, but hexagonal");
    expect(corpus.corpus).toContain("We shipped hex packing!");
  });

  it("isolates a failing provider as an error entry", async () => {
    const { db, ws } = setup();
    seedConnection(db, ws.id, "twitter");
    const corpus = await readSocialCorpus(db, corpusFabric({ failTwitter: true }), ws.id);
    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]!.profile).toBeNull();
    expect(corpus.entries[0]!.error).toBeTruthy();
    expect(corpus.corpus).toBe("");
  });

  it("returns an empty corpus with no social connections", async () => {
    const { db, ws } = setup();
    const corpus = await readSocialCorpus(db, corpusFabric(), ws.id);
    expect(corpus).toEqual({ connected: [], entries: [], corpus: "" });
  });
});

// ---------------------------------------------------------------------------
// Routes + onboarding gate
// ---------------------------------------------------------------------------

describe("social corpus API + onboarding gate", () => {
  let app: TuezdayApp;

  afterEach(async () => {
    await app.close();
  });

  it("GET /workspaces/:id/social-corpus returns the aggregate", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, connectors: corpusFabric() });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    seedConnection(db, ws.id, "twitter");
    const res = await app.inject({ method: "GET", url: `/workspaces/${ws.id}/social-corpus` });
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toEqual(["twitter"]);
    expect(res.json().corpus).toContain("hexalog");
  });

  it("blocks advancing past connect without a social connection (409)", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, connectors: corpusFabric() });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}/onboarding`,
      payload: { step: "verify" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("needs_social_connection");
  });

  it("allows advancing to connect/earlier and to done without a connection", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, connectors: corpusFabric() });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    for (const step of ["connect", "website", "done"]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${ws.id}/onboarding`,
        payload: { step },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("allows advancing past connect once a social account is connected", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, connectors: corpusFabric() });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    seedConnection(db, ws.id, "linkedin");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${ws.id}/onboarding`,
      payload: { step: "verify" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboardingStep).toBe("verify");
  });
});
