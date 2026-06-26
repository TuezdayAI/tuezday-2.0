import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import { createTestDb } from "./helpers";
import { registerAccount } from "../src/services/auth";
import { createWorkspace } from "../src/services/workspaces";
import { connections, generations } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("billing gating (Task 3)", () => {
  let app: TuezdayApp;
  let db: any;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
  });

  test("generations gate (50 per month)", async () => {
    const { token, user } = await registerAccount(db, { email: "u@t.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "ws" }, user.id);

    for (let i = 0; i < 50; i++) {
      db.insert(generations).values({
        id: randomUUID(),
        workspaceId: ws.id,
        taskType: "linkedin_post",
        channel: "linkedin",
        prompt: "test",
        sectionsJson: "[]",
        output: "out",
        model: "gpt-4",
        provider: "openai",
        durationMs: 100,
        createdAt: Date.now(),
      }).run();
    }

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/generate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { taskType: "linkedin_post", channel: "linkedin", prompt: "test 51" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required", key: "monthlyGenerations", limit: 50 });
  });

  test("connectors gate (1 per workspace)", async () => {
    const { token, user } = await registerAccount(db, { email: "u2@t.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "ws" }, user.id);

    // Mock nango fabric to prevent ConnectorFabricError.
    // Or we can just hit the /connect endpoint and it should return 402 BEFORE hitting nango.
    // Let's use the `/connectors/notion/connect` route for a non-oauth connector, or just oauth route.
    const res1 = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/connectors/reddit/oauth/session`,
      headers: { authorization: `Bearer ${token}` },
    });
    // First one will fail with 409 because we don't have OAuth app set up, but it passes the entitlement gate!
    // Wait, the entitlement gate runs FIRST.
    // Let's spoof a connection to use up the quota.
    db.insert(connections).values({
      id: "conn-1",
      workspaceId: ws.id,
      providerKey: "reddit",
      nangoConnectionId: "test-c1",
      configJson: "{}",
      status: "connected",
      createdAt: Date.now(),
    }).run();

    const res2 = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/connectors/notion/oauth/session`,
      headers: { authorization: `Bearer ${token}` },
    });
    // Now it should hit the entitlement gate.
    expect(res2.statusCode).toBe(402);
    expect(res2.json()).toEqual({ error: "upgrade_required", key: "connectors", limit: 1 });
  });

  test("seats gate (1 per workspace)", async () => {
    const { token, user } = await registerAccount(db, { email: "u3@t.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "ws" }, user.id);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/invites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "new@t.com" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required", key: "seats", limit: 1 });
  });
});
