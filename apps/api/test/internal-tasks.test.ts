import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { createTestDb, registerUser } from "./helpers";

const WORKER_TOKEN = "worker-test-token-with-enough-entropy";

describe("internal task boundary", () => {
  let app: TuezdayApp;
  let db: Db;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp({ db, workerToken: WORKER_TOKEN });
  });

  afterEach(async () => {
    await app.close();
  });

  function workerHeaders(token = WORKER_TOKEN) {
    return { authorization: `Bearer ${token}` };
  }

  it.each([
    "/internal/discovery/tick",
    "/internal/automation/tick",
  ])("requires the worker credential for POST %s", async (url) => {
    const absent = await app.inject({
      method: "POST",
      url,
      payload: {},
    });
    const wrong = await app.inject({
      method: "POST",
      url,
      payload: {},
      headers: workerHeaders("wrong"),
    });

    expect(absent.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("does not let a user session call internal tasks", async () => {
    const user = await registerUser(app, "internal-user@test.dev");
    const response = await app.inject({
      method: "POST",
      url: "/internal/discovery/tick",
      payload: {},
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it("runs both API-owned scheduler entrypoints with the worker token", async () => {
    const discovery = await app.inject({
      method: "POST",
      url: "/internal/discovery/tick",
      payload: {},
      headers: workerHeaders(),
    });
    const automation = await app.inject({
      method: "POST",
      url: "/internal/automation/tick",
      payload: {},
      headers: workerHeaders(),
    });

    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(automation.statusCode, automation.body).toBe(200);
    expect(discovery.json()).toMatchObject({ busy: false, processed: 0 });
    expect(automation.json()).toMatchObject({ busy: false, processed: 0 });
  });

  it.each([
    "/internal/discovery/tick",
    "/internal/automation/tick",
  ])("accepts only an empty body on %s", async (url) => {
    const accepted = await app.inject({
      method: "POST",
      url,
      payload: {},
      headers: workerHeaders(),
    });
    const workspaceInjected = await app.inject({
      method: "POST",
      url,
      payload: { workspaceId: "11111111-1111-4111-8111-111111111111" },
      headers: workerHeaders(),
    });
    const ownerInjected = await app.inject({
      method: "POST",
      url,
      payload: { owner: "attacker-controlled" },
      headers: workerHeaders(),
    });

    expect(accepted.statusCode).toBe(200);
    expect(workspaceInjected.statusCode).toBe(400);
    expect(ownerInjected.statusCode).toBe(400);
  });

  it.each([
    ["GET", "/auth/me"],
    ["GET", "/workspaces/11111111-1111-4111-8111-111111111111/brain"],
    ["GET", "/workspaces/11111111-1111-4111-8111-111111111111/billing"],
    ["GET", "/workspaces/11111111-1111-4111-8111-111111111111/drafts"],
    ["GET", "/workspaces/11111111-1111-4111-8111-111111111111/evidence/documents"],
    ["GET", "/workspaces/11111111-1111-4111-8111-111111111111/connections"],
    ["POST", "/workspaces/11111111-1111-4111-8111-111111111111/discovery/run"],
    ["POST", "/workspaces/11111111-1111-4111-8111-111111111111/automation/run"],
  ] as const)("rejects worker access outside the allowlist: %s %s", async (method, url) => {
    const response = await app.inject({
      method,
      url,
      payload: method === "POST" ? {} : undefined,
      headers: workerHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("permits only the exact existing maintenance allowlist", async () => {
    const user = await registerUser(app, "allowlist-owner@test.dev");
    const created = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Worker allowlist" },
      headers: { authorization: `Bearer ${user.token}` },
    });
    const workspaceId = created.json().id as string;
    const allowed = [
      ["GET", "/workspaces"],
      ["GET", `/workspaces/${workspaceId}/learning/syntheses`],
      ["POST", `/workspaces/${workspaceId}/learning/synthesize`],
      ["POST", `/workspaces/${workspaceId}/ads/sync`],
      ["POST", `/workspaces/${workspaceId}/publish/run`],
      ["POST", `/workspaces/${workspaceId}/cadences/run`],
      ["POST", `/workspaces/${workspaceId}/inbox/run`],
      ["POST", `/workspaces/${workspaceId}/mailbox-inbox/run`],
      ["POST", `/workspaces/${workspaceId}/outreach/run`],
      ["POST", `/workspaces/${workspaceId}/sequences/run`],
      ["POST", `/workspaces/${workspaceId}/evidence/candidates/sweep`],
    ] as const;

    for (const [method, url] of allowed) {
      const response = await app.inject({
        method,
        url,
        payload: method === "POST" ? {} : undefined,
        headers: workerHeaders(),
      });
      expect(
        [401, 403].includes(response.statusCode),
        `${method} ${url}: ${response.body}`,
      ).toBe(false);
      expect(response.statusCode).toBeLessThan(500);
    }
  });

  it.each([
    ["GET", "/t/o/not-a-signed-token"],
    ["GET", "/t/c/not-a-signed-token"],
  ] as const)(
    "lets unauthenticated tracking requests reach token validation: %s %s",
    async (method, url) => {
      const response = await app.inject({ method, url });

      expect(response.statusCode).not.toBe(401);
    },
  );
});
