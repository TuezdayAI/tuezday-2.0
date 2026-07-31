import { randomUUID } from "node:crypto";
import { test, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildAuthedApp, createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { signalMatches, signals, workspaces } from "../src/db/schema";
import { createApiKey } from "../src/services/api-keys";
import type { TuezdayApp } from "../src/app";

let db: Db;
let app: TuezdayApp;
const WS = "test-public-api-ws";
let ideasKey: string;
let draftsKey: string;

beforeAll(async () => {
  db = createTestDb();
  app = await buildAuthedApp({ db });
  db.insert(workspaces).values({
    id: WS,
    name: "Public API WS",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run();

  ideasKey = createApiKey(db, WS, { name: "ideas", scopes: ["ideas:write"] }).rawKey;
  draftsKey = createApiKey(db, WS, { name: "drafts", scopes: ["drafts:read", "drafts:write"] }).rawKey;
});

afterAll(async () => {
  await app.close();
});

test("ideas endpoint requires ideas:write", async () => {
  // Wrong scope
  const res1 = await app.inject({
    method: "POST",
    url: "/api/v1/ideas",
    headers: { authorization: `Bearer ${draftsKey}` },
    payload: { content: "New idea", source: "other" }
  });
  expect(res1.statusCode).toBe(403);

  // Correct scope
  const res2 = await app.inject({
    method: "POST",
    url: "/api/v1/ideas",
    headers: { authorization: `Bearer ${ideasKey}` },
    payload: { content: "New idea", source: "other" }
  });
  expect(res2.statusCode).toBe(201);
});

test.each(["persona", "campaign", "both"] as const)(
  "ideas endpoint does not disclose or persist foreign and unknown %s references",
  async (referenceKind) => {
    const isolatedDb = createTestDb();
    const isolatedApp = await buildAuthedApp({ db: isolatedDb });
    try {
      const targetWorkspaceId = (
        await isolatedApp.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Target API Workspace" },
        })
      ).json().id as string;
      const foreignWorkspaceId = (
        await isolatedApp.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign API Workspace" },
        })
      ).json().id as string;
      const foreignPersonaId = (
        await isolatedApp.inject({
          method: "POST",
          url: `/workspaces/${foreignWorkspaceId}/personas`,
          payload: { name: "Foreign Persona" },
        })
      ).json().id as string;
      const foreignCampaignId = (
        await isolatedApp.inject({
          method: "POST",
          url: `/workspaces/${foreignWorkspaceId}/campaigns`,
          payload: { name: "Foreign Campaign", objective: "Stay isolated" },
        })
      ).json().id as string;
      const key = createApiKey(isolatedDb, targetWorkspaceId, {
        name: "isolated-ideas",
        scopes: ["ideas:write"],
      }).rawKey;
      const referenceInput = (personaId: string, campaignId: string) => ({
        ...(referenceKind === "persona" || referenceKind === "both"
          ? { suggestedPersonaId: personaId }
          : {}),
        ...(referenceKind === "campaign" || referenceKind === "both"
          ? { suggestedCampaignId: campaignId }
          : {}),
      });
      const submit = (payload: Record<string, unknown>) =>
        isolatedApp.inject({
          method: "POST",
          url: "/api/v1/ideas",
          headers: { authorization: `Bearer ${key}` },
          payload: { content: "Tenant-scoped idea", source: "other", ...payload },
        });

      const foreign = await submit(
        referenceInput(foreignPersonaId, foreignCampaignId),
      );
      const unknown = await submit(referenceInput(randomUUID(), randomUUID()));

      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: "related_object_not_found" });
      expect(foreign.json()).toEqual(unknown.json());
      expect(
        isolatedDb
          .select()
          .from(signals)
          .where(eq(signals.workspaceId, targetWorkspaceId))
          .all(),
      ).toHaveLength(0);
      expect(
        isolatedDb
          .select()
          .from(signalMatches)
          .where(eq(signalMatches.workspaceId, targetWorkspaceId))
          .all(),
      ).toHaveLength(0);
    } finally {
      await isolatedApp.close();
    }
  },
);

test("drafts endpoint requires drafts:read", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/drafts",
    headers: { authorization: `Bearer ${draftsKey}` },
  });
  expect(res.statusCode).toBe(200);
});

test("insights endpoint returns 200", async () => {
  const insightsKey = createApiKey(db, WS, { name: "insights", scopes: ["analytics:read"] }).rawKey;
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/insights",
    headers: { authorization: `Bearer ${insightsKey}` },
  });
  expect(res.statusCode).toBe(200);
});
