import { test, expect, beforeAll, afterAll } from "vitest";
import { buildAuthedApp, createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { workspaces } from "../src/db/schema";
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
