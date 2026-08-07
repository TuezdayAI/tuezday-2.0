import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { externalActionSubmissionSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import { InstagramAdapter } from "../src/connectors/social/instagram";
import type { Db } from "../src/db";
import { connections, drafts, publications } from "../src/db/schema";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

interface InstagramState {
  calls: Array<{ method: string; path: string; form?: Record<string, string> }>;
  status: "IN_PROGRESS" | "PUBLISHED" | "FINISHED" | "ERROR";
}

function fabricFor(state: InstagramState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "unused" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: "{}" };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, options) {
      state.calls.push({ method, path, form: options?.form });
      let result: ProxyJsonResult;
      if (method === "POST" && path === "/ig-user/media") {
        result = { status: 200, json: { id: "container-1" } };
      } else if (method === "GET" && path === "/container-1?fields=status_code") {
        result = { status: 200, json: { status_code: state.status } };
      } else if (method === "POST" && path === "/ig-user/media_publish") {
        result = { status: 200, json: { id: "media-1" } };
      } else if (method === "GET" && path === "/media-1?fields=permalink") {
        result = { status: 200, json: { permalink: "https://instagram.test/p/media-1" } };
      } else {
        result = { status: 404, json: { error: { message: `unexpected ${method} ${path}` } } };
      }
      return result;
    },
  };
}

function adapterFor(state: InstagramState): InstagramAdapter {
  return new InstagramAdapter(fabricFor(state), {
    nangoConnectionId: "nango-1",
    integrationKey: "tuezday-instagram",
    externalAccountId: "ig-user",
  });
}

function calls(state: InstagramState, method: string, suffix: string): number {
  return state.calls.filter((call) => call.method === method && call.path.endsWith(suffix)).length;
}

describe("InstagramAdapter asynchronous video finalization", () => {
  it("keeps image-only publishing synchronous", async () => {
    const state: InstagramState = { calls: [], status: "FINISHED" };
    const result = await adapterFor(state).publishPost({
      target: "feed",
      title: "",
      body: "Image caption",
      media: [{ url: "https://cdn.test/image.jpg", type: "image" }],
    });

    expect(result).toEqual({
      status: "published",
      externalId: "media-1",
      url: "https://instagram.test/p/media-1",
    });
    expect(calls(state, "GET", "?fields=status_code")).toBe(0);
  });

  it("returns immediately after creating a video container", async () => {
    const state: InstagramState = { calls: [], status: "IN_PROGRESS" };
    const result = await adapterFor(state).publishPost({
      target: "feed",
      title: "",
      body: "Video caption",
      media: [{ url: "https://cdn.test/video.mp4", type: "video" }],
    });

    expect(result).toEqual({
      status: "processing",
      operationId: "container-1",
      retryAfterMs: expect.any(Number),
    });
    expect(calls(state, "GET", "?fields=status_code")).toBe(0);
    expect(calls(state, "POST", "/media_publish")).toBe(0);
  });

  it.each(["IN_PROGRESS", "PUBLISHED"] as const)(
    "performs one status read and stays processing for %s",
    async (status) => {
      const state: InstagramState = { calls: [], status };
      const result = await adapterFor(state).finalizePost("container-1");

      expect(result).toEqual({
        status: "processing",
        operationId: "container-1",
        retryAfterMs: expect.any(Number),
      });
      expect(calls(state, "GET", "?fields=status_code")).toBe(1);
      expect(calls(state, "POST", "/media_publish")).toBe(0);
    },
  );

  it("publishes a finished container once and reads its permalink", async () => {
    const state: InstagramState = { calls: [], status: "FINISHED" };
    await expect(adapterFor(state).finalizePost("container-1")).resolves.toEqual({
      status: "published",
      externalId: "media-1",
      url: "https://instagram.test/p/media-1",
    });
    expect(calls(state, "GET", "?fields=status_code")).toBe(1);
    expect(calls(state, "POST", "/media_publish")).toBe(1);
    expect(calls(state, "GET", "?fields=permalink")).toBe(1);
  });

  it("fails a provider-rejected container without trying media_publish", async () => {
    const state: InstagramState = { calls: [], status: "ERROR" };
    const adapter = adapterFor(state);
    const finalize = vi.fn(() => adapter.finalizePost("container-1"));

    await expect(finalize()).rejects.toThrow("could not process the video");
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(calls(state, "POST", "/media_publish")).toBe(0);
  });
});

describe("Instagram publication recovery", () => {
  let app: TuezdayApp | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    app = undefined;
  });

  async function startVideo(status: InstagramState["status"]) {
    const state: InstagramState = { calls: [], status };
    const db: Db = createTestDb();
    const testApp = await buildAuthedApp({ db, connectors: fabricFor(state) });
    app = testApp;
    const workspaceId = (
      await testApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Instagram" } })
    ).json().id;
    const connectionId = randomUUID();
    const draftId = randomUUID();
    const now = Date.now();
    db.insert(connections)
      .values({
        id: connectionId,
        workspaceId,
        providerKey: "instagram",
        nangoConnectionId: "nango-instagram",
        externalAccountId: "ig-user",
        externalAccountHandle: "founder",
        displayName: "Founder Instagram",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(drafts)
      .values({
        id: draftId,
        workspaceId,
        taskType: "instagram_post",
        channel: "instagram",
        originalContent: "A durable reel",
        content: "A durable reel",
        state: "approved",
        mediaJson: JSON.stringify([{ url: "https://cdn.test/reel.mp4", type: "video" }]),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(
      (
        await putActionPolicy(testApp, workspaceId, "workspace", workspaceId, {
          publish: "autonomous",
        })
      ).statusCode,
    ).toBe(200);
    const started = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/publish`,
      payload: {
        connectionId,
        target: "feed",
        title: "Reel",
        idempotencyKey: `instagram:reel:${randomUUID()}`,
      },
    });
    return { state, db, testApp, workspaceId, now, started };
  }

  it("persists and resumes one provider operation until its action succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T10:00:00Z"));
    const { state, db, testApp, workspaceId, now, started } = await startVideo("IN_PROGRESS");
    expect(started.statusCode).toBe(201);
    expect(externalActionSubmissionSchema.parse(started.json())).toMatchObject({
      action: { status: "dispatching", completedAt: null },
      execution: { status: "processing", error: null },
    });
    const [processing] = db.select().from(publications).all();
    expect(processing).toMatchObject({
      status: "processing",
      providerOperationId: "container-1",
      processingStartedAt: now,
      processingAttempts: 0,
      lastError: null,
    });
    expect(processing!.nextAttemptAt).toBeGreaterThan(now);
    expect(calls(state, "POST", "/media")).toBe(1);
    expect(calls(state, "GET", "?fields=status_code")).toBe(0);

    const legacy = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/publish/run`,
    });
    expect(legacy.json()).toEqual({ results: [] });
    expect(calls(state, "GET", "?fields=status_code")).toBe(0);

    // Dispatching actions are runnable, but an early retry is a pure database
    // read: no status request and, critically, no second container.
    const early = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/run`,
    });
    expect(early.json().actions[0]).toMatchObject({
      action: { status: "dispatching" },
      execution: { status: "processing" },
    });
    expect(calls(state, "POST", "/media")).toBe(1);
    expect(calls(state, "GET", "?fields=status_code")).toBe(0);

    vi.setSystemTime(new Date(processing!.nextAttemptAt! + 1));
    const pending = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/run`,
    });
    expect(pending.json().actions[0]).toMatchObject({ action: { status: "dispatching" } });
    expect(calls(state, "GET", "?fields=status_code")).toBe(1);
    expect(db.select().from(publications).get()).toMatchObject({ processingAttempts: 1 });

    const retryAt = db.select().from(publications).get()!.nextAttemptAt!;
    vi.setSystemTime(new Date(retryAt + 1));
    state.status = "FINISHED";
    const finished = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/run`,
    });
    expect(finished.json().actions[0]).toMatchObject({
      action: { status: "succeeded", completedAt: expect.any(Number) },
      execution: { status: "published", error: null },
    });
    expect(db.select().from(publications).get()).toMatchObject({
      status: "published",
      providerOperationId: "container-1",
      externalId: "media-1",
      externalUrl: "https://instagram.test/p/media-1",
      processingAttempts: 2,
    });
    expect(calls(state, "POST", "/media")).toBe(1);
    expect(calls(state, "POST", "/media_publish")).toBe(1);

    const settledCalls = state.calls.length;
    expect(
      (
        await testApp.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/external-actions/run`,
        })
      ).json().actions,
    ).toEqual([]);
    expect(state.calls).toHaveLength(settledCalls);
  });

  it("keeps a failed provider operation for an idempotent receipt retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-07T10:00:00Z"));
    const { state, db, testApp, workspaceId } = await startVideo("ERROR");
    const processing = db.select().from(publications).get()!;
    vi.setSystemTime(new Date(processing.nextAttemptAt! + 1));

    const failed = await testApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/external-actions/run`,
    });
    expect(failed.json().actions[0]).toMatchObject({
      action: { status: "failed", completedAt: expect.any(Number) },
      execution: { status: "failed", error: expect.stringContaining("could not process") },
    });
    expect(db.select().from(publications).get()).toMatchObject({
      status: "failed",
      providerOperationId: "container-1",
      processingAttempts: 1,
      nextAttemptAt: null,
      lastError: expect.stringContaining("could not process"),
    });
    expect(calls(state, "POST", "/media")).toBe(1);
    expect(calls(state, "POST", "/media_publish")).toBe(0);
  });
});
