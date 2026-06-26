import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../../test/helpers";
import { registerInsightsRoutes } from "./insights";
import { workspaces, campaigns } from "../db/schema";
import { campaignInsightsSchema, workspaceInsightsSchema } from "@tuezday/contracts";

describe("insights.routes", () => {
  it("GET /workspaces/:id/campaigns/:cid/insights returns 200 JSON shaped by schema", async () => {
    const db = createTestDb();
    const wsId = randomUUID();
    const cId = randomUUID();
    db.insert(workspaces).values({ id: wsId, name: "W", createdAt: Date.now(), updatedAt: Date.now() }).run();
    db.insert(campaigns).values({ id: cId, workspaceId: wsId, name: "C", objective: "", kpi: "", timeframe: "", audience: "", pillarsJson: "[]", channelsJson: "[]", personaIdsJson: "[]", overlay: "", status: "active", automationMode: "manual", createdAt: Date.now(), updatedAt: Date.now() }).run();

    const app = Fastify();
    registerInsightsRoutes(app, db);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/campaigns/${cId}/insights`,
    });
    expect(res.statusCode).toBe(200);
    const parsed = campaignInsightsSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
  });

  it("GET /workspaces/:id/campaigns/:cid/insights?format=csv returns CSV", async () => {
    const db = createTestDb();
    const wsId = randomUUID();
    const cId = randomUUID();
    db.insert(workspaces).values({ id: wsId, name: "W", createdAt: Date.now(), updatedAt: Date.now() }).run();
    db.insert(campaigns).values({ id: cId, workspaceId: wsId, name: "C", objective: "", kpi: "", timeframe: "", audience: "", pillarsJson: "[]", channelsJson: "[]", personaIdsJson: "[]", overlay: "", status: "active", automationMode: "manual", createdAt: Date.now(), updatedAt: Date.now() }).run();

    const app = Fastify();
    registerInsightsRoutes(app, db);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/campaigns/${cId}/insights?format=csv`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv");
    expect(res.body).toContain("Section,Metric,Value");
  });

  it("GET /workspaces/:id/insights returns 200 JSON shaped by schema", async () => {
    const db = createTestDb();
    const wsId = randomUUID();
    db.insert(workspaces).values({ id: wsId, name: "W", createdAt: Date.now(), updatedAt: Date.now() }).run();

    const app = Fastify();
    registerInsightsRoutes(app, db);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/insights`,
    });
    expect(res.statusCode).toBe(200);
    const parsed = workspaceInsightsSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
  });
});
