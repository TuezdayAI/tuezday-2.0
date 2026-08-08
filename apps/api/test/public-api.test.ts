import { randomUUID } from "node:crypto";
import { test, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { signalSchema } from "@tuezday/contracts";
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
  db = await createTestDb();
  app = await buildAuthedApp({ db });
  await db.insert(workspaces).values({
    id: WS,
    name: "Public API WS",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  ideasKey = (await createApiKey(db, WS, { name: "ideas", scopes: ["ideas:write"] })).rawKey;
  draftsKey = (await createApiKey(db, WS, { name: "drafts", scopes: ["drafts:read", "drafts:write"] })).rawKey;
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
    const isolatedDb = await createTestDb();
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
      const key = (await createApiKey(isolatedDb, targetWorkspaceId, {
        name: "isolated-ideas",
        scopes: ["ideas:write"],
      })).rawKey;
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
        await isolatedDb
          .select()
          .from(signals)
          .where(eq(signals.workspaceId, targetWorkspaceId)),
      ).toHaveLength(0);
      expect(
        await isolatedDb
          .select()
          .from(signalMatches)
          .where(eq(signalMatches.workspaceId, targetWorkspaceId)),
      ).toHaveLength(0);
    } finally {
      await isolatedApp.close();
    }
  },
);

// Sprint 53 (D3b): the public idea endpoint used to persist the legacy columns
// with no backing match row at all. It now routes through the explicit-intent
// path, so the same request body produces a real score-100 match — and the
// response contract callers see is unchanged.
test("ideas endpoint turns explicit routing into a real score-100 match", async () => {
  const isolatedDb = await createTestDb();
  const isolatedApp = await buildAuthedApp({ db: isolatedDb });
  try {
    const workspaceId = (
      await isolatedApp.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Ideas Routing Workspace" },
      })
    ).json().id as string;
    const persona = (
      await isolatedApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "Field CTO" },
      })
    ).json();
    const campaign = (
      await isolatedApp.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win fintech VPs", personaIds: [persona.id] },
      })
    ).json();
    const key = (await createApiKey(isolatedDb, workspaceId, {
      name: "routing-ideas",
      scopes: ["ideas:write"],
    })).rawKey;

    const res = await isolatedApp.inject({
      method: "POST",
      url: "/api/v1/ideas",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        content: "Partner-submitted idea with routing",
        source: "other",
        suggestedPersonaId: persona.id,
        suggestedCampaignId: campaign.id,
      },
    });

    expect(res.statusCode).toBe(201);
    const signal = res.json();
    expect(signalSchema.safeParse(signal).success).toBe(true);
    expect(signal.suggestedPersonaId).toBe(persona.id);
    expect(signal.suggestedCampaignId).toBe(campaign.id);
    expect(signal.matches).toHaveLength(1);
    expect(signal.matches[0]).toMatchObject({
      personaId: persona.id,
      campaignId: campaign.id,
      score: 100,
    });

    const rows = await isolatedDb
      .select()
      .from(signalMatches)
      .where(eq(signalMatches.signalId, signal.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      personaId: persona.id,
      campaignId: campaign.id,
      score: 100,
    });

    const stored = ((await isolatedDb.select().from(signals).where(eq(signals.id, signal.id)))[0])!;
    expect(stored.suggestedPersonaId).toBeNull();
    expect(stored.suggestedCampaignId).toBeNull();
  } finally {
    await isolatedApp.close();
  }
});

test("drafts endpoint requires drafts:read", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/drafts",
    headers: { authorization: `Bearer ${draftsKey}` },
  });
  expect(res.statusCode).toBe(200);
});

test("insights endpoint returns 200", async () => {
  const insightsKey = (await createApiKey(db, WS, { name: "insights", scopes: ["analytics:read"] })).rawKey;
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/insights",
    headers: { authorization: `Bearer ${insightsKey}` },
  });
  expect(res.statusCode).toBe(200);
});
