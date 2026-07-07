import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectorFabric } from "../src/connectors/fabric";
import type { LlmGateway } from "../src/llm/gateway";
import { brandProfiles } from "../src/db/schema";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";

const PROFILE = {
  businessName: "Hexalog",
  tagline: "Logs, but hexagonal",
  summary: "Hexalog is a logging platform for platform teams.",
  targetAgeRange: "25-45",
  tone: "Confident and technical",
  voiceDimensions: {
    purpose: "Clarity in production",
    audience: "Platform engineers",
    tone: "Direct",
    emotions: "Calm",
    character: "Senior SRE",
    syntax: "Short",
    language: "US English",
  },
  pillars: ["Observability"],
  sourceNotes: "",
};

const emptyFabric: ConnectorFabric = {
  health: async () => ({ healthy: true }),
  ensureIntegration: async () => {},
  createConnectSession: async () => ({ token: "t" }),
  importConnection: async () => {},
  connectionExists: async () => true,
  deleteConnection: async () => {},
  proxyGet: async () => ({ status: 404, body: "" }) as never,
  proxyJson: async () => ({ status: 404, json: {} }),
};

const echoLlm: LlmGateway = {
  async generate({ prompt }) {
    const m = /drafting the "([^"]+)"/.exec(prompt);
    return {
      text: `## ${m?.[1] ?? "Doc"}\n\nDrafted from the verified profile for Hexalog.`,
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  },
};

describe("POST /workspaces/:id/brain/auto-draft (route)", () => {
  let app: TuezdayApp;

  afterEach(async () => {
    await app.close();
  });

  it("drafts all five docs for a ready profile and returns accounting + brain", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, llm: echoLlm, connectors: emptyFabric });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    const now = Date.now();
    db.insert(brandProfiles)
      .values({
        id: randomUUID(),
        workspaceId: ws.id,
        sourceUrl: "https://hexalog.com",
        status: "ready",
        profileJson: JSON.stringify(PROFILE),
        error: null,
        corpusChars: 1000,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brain/auto-draft`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.insufficient).toBe(false);
    expect([...body.drafted].sort()).toEqual(["history", "icp", "now", "soul", "voice"]);
    expect(body.skipped).toEqual([]);
    expect(body.brain.completeness.percent).toBeGreaterThan(0);
    for (const doc of body.brain.docs) {
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });

  it("returns insufficient without touching docs when there is nothing to draft from", async () => {
    const db = createTestDb();
    app = await buildAuthedApp({ db, llm: echoLlm, connectors: emptyFabric });
    const ws = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "W" } })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/brain/auto-draft`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().insufficient).toBe(true);
    expect(res.json().drafted).toEqual([]);
    for (const doc of res.json().brain.docs) expect(doc.content).toBe("");
  });
});
