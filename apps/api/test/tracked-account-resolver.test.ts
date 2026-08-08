import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTrackedSocialAccountInputSchema,
  updateTrackedSocialAccountInputSchema,
  type TrackedSocialPlatform,
} from "@tuezday/contracts";
import type {
  ConnectorFabric,
  ProxyJsonResult,
} from "../src/connectors/fabric";
import type { Db } from "../src/db";
import {
  connections,
  trackedSocialAccounts,
  workspaces,
} from "../src/db/schema";
import { eq } from "drizzle-orm";
import type { LlmGateway } from "../src/llm/gateway";
import {
  ProviderCapabilityError,
} from "../src/discovery/provider-errors";
import {
  TrackedAccountConnectionError,
  resolveTrackedSocialAccount,
} from "../src/services/tracked-account-resolver";
import {
  createTrackedSocialAccount,
  getTrackedSocialAccount,
  updateTrackedSocialAccount,
} from "../src/services/tracked-social-accounts";
import { buildAuthedApp, createTestDb } from "./helpers";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";

async function fixture(
  handler: (path: string) => ProxyJsonResult = () => ({
    status: 404,
    json: {},
  }),
) {
  const db = await createTestDb();
  await db.insert(workspaces)
    .values([
      {
        id: workspaceId,
        name: "Resolver",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: otherWorkspaceId,
        name: "Other",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
  const calls: Array<{ path: string; baseUrl?: string }> = [];
  const fabric = {
    async proxyJson(_method, path, _connectionId, _integrationKey, opts) {
      calls.push({ path, baseUrl: opts?.baseUrlOverride });
      return handler(path);
    },
  } as ConnectorFabric;

  async function connection(
    providerKey: string,
    options: {
      id?: string;
      workspace?: string;
      status?: "connected" | "error" | "disconnected";
      externalAccountId?: string | null;
      externalAccountHandle?: string | null;
      config?: Record<string, unknown>;
    } = {},
  ) {
    const id = options.id ?? randomUUID();
    await db.insert(connections)
      .values({
        id,
        workspaceId: options.workspace ?? workspaceId,
        providerKey,
        nangoConnectionId: `nango-${id}`,
        configJson: JSON.stringify(options.config ?? {}),
        displayName: providerKey,
        externalAccountId: options.externalAccountId ?? null,
        externalAccountName: null,
        externalAccountHandle: options.externalAccountHandle ?? null,
        externalAccountUrl: null,
        status: options.status ?? "connected",
        lastCheckedAt: 1,
        lastError: null,
        contentProfileJson: "{}",
        createdAt: 1,
        updatedAt: 1,
      });
    return id;
  }

  async function account(platform: TrackedSocialPlatform, handle: string) {
    return await createTrackedSocialAccount(db, workspaceId, {
      platform,
      handle,
    });
  }

  return { db, fabric, calls, connection, account };
}

describe("tracked account public inputs", () => {
  it("strips founder-supplied provider ids and clears cache on handle change", async () => {
    expect(
      createTrackedSocialAccountInputSchema.parse({
        platform: "x",
        handle: "@acme",
        externalId: "founder-supplied",
      }),
    ).not.toHaveProperty("externalId");
    expect(
      updateTrackedSocialAccountInputSchema.parse({
        externalId: "founder-supplied",
      }),
    ).not.toHaveProperty("externalId");

    const f = await fixture();
    const created = await f.account("x", "@acme");
    await f.db
      .update(trackedSocialAccounts)
      .set({
        externalId: "cached-id",
        lastResolvedAt: 10,
        lastError: "old-error",
      })
      .where(eq(trackedSocialAccounts.id, created.id));
    const updated = (await updateTrackedSocialAccount(
      f.db,
      workspaceId,
      created.id,
      { handle: "@new_handle" },
    ))!;
    expect(updated).toMatchObject({
      handle: "new_handle",
      externalId: null,
      lastResolvedAt: null,
      lastError: null,
    });
  });
});

describe("tracked account resolver", () => {
  it("resolves X through the selected connection and persists its id", async () => {
    const f = await fixture((path) =>
      path === "/2/users/by/username/acme"
        ? {
            status: 200,
            json: { data: { id: "x-user-42", username: "acme" } },
          }
        : { status: 404, json: {} },
    );
    const connectionId = await f.connection("twitter");
    const account = await f.account("x", "@Acme");

    const resolved = await resolveTrackedSocialAccount(
      { db: f.db, fabric: f.fabric },
      { workspaceId, accountId: account.id, connectionId },
    );

    expect(resolved.externalId).toBe("x-user-42");
    expect(resolved.lastResolvedAt).toEqual(expect.any(Number));
    expect(resolved.lastError).toBeNull();
    expect(f.calls).toEqual([
      {
        path: "/2/users/by/username/acme",
        baseUrl: "https://api.twitter.com",
      },
    ]);
  });

  it("reuses exact LinkedIn vanity resolution", async () => {
    const f = await fixture((path) =>
      path === "/rest/organizations?q=vanityName&vanityName=acme"
        ? {
            status: 200,
            json: { elements: [{ id: 73, vanityName: "acme" }] },
          }
        : { status: 404, json: {} },
    );
    const connectionId = await f.connection("linkedin");
    const account = await f.account("linkedin", "acme");

    await expect(
      await resolveTrackedSocialAccount(
        { db: f.db, fabric: f.fabric },
        { workspaceId, accountId: account.id, connectionId },
      ),
    ).resolves.toMatchObject({
      externalId: "urn:li:organization:73",
      lastError: null,
    });
  });

  it("stores Reddit's normalized handle without a network call", async () => {
    const f = await fixture();
    const connectionId = await f.connection("reddit");
    const account = await f.account("reddit", "r/Startups");

    const resolved = await resolveTrackedSocialAccount(
      { db: f.db, fabric: f.fabric },
      { workspaceId, accountId: account.id, connectionId },
    );
    expect(resolved.externalId).toBe("startups");
    expect(f.calls).toEqual([]);
  });

  it("allows only the direct Instagram connection's own account", async () => {
    const f = await fixture();
    const connectionId = await f.connection("instagram", {
      config: { authArchitecture: "instagram_login" },
      externalAccountId: "ig-direct-42",
      externalAccountHandle: "tuezday",
    });
    const own = await f.account("instagram", "@tuezday");
    const competitor = await f.account("instagram", "@rival");

    await expect(
      await resolveTrackedSocialAccount(
        { db: f.db, fabric: f.fabric },
        { workspaceId, accountId: own.id, connectionId },
      ),
    ).resolves.toMatchObject({ externalId: "ig-direct-42" });
    await expect(
      await resolveTrackedSocialAccount(
        { db: f.db, fabric: f.fabric },
        { workspaceId, accountId: competitor.id, connectionId },
      ),
    ).rejects.toMatchObject({ code: "unsupported_target" });
  });

  it("does not reveal why a connection is unavailable", async () => {
    const f = await fixture();
    const account = await f.account("x", "acme");
    const candidates = [
      randomUUID(),
      await f.connection("twitter", { workspace: otherWorkspaceId }),
      await f.connection("twitter", { status: "disconnected" }),
      await f.connection("linkedin"),
    ];

    for (const connectionId of candidates) {
      await expect(
        await resolveTrackedSocialAccount(
          { db: f.db, fabric: f.fabric },
          { workspaceId, accountId: account.id, connectionId },
        ),
      ).rejects.toEqual(new TrackedAccountConnectionError());
    }
  });

  it("retains a good cache on failed force and replaces it on success", async () => {
    let response: ProxyJsonResult = {
      status: 200,
      json: { data: { id: "x-old" } },
    };
    const f = await fixture(() => response);
    const connectionId = await f.connection("twitter");
    const account = await f.account("x", "acme");
    const first = await resolveTrackedSocialAccount(
      { db: f.db, fabric: f.fabric },
      { workspaceId, accountId: account.id, connectionId },
    );

    response = { status: 404, json: {} };
    await expect(
      await resolveTrackedSocialAccount(
        { db: f.db, fabric: f.fabric },
        {
          workspaceId,
          accountId: account.id,
          connectionId,
          force: true,
        },
      ),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(
      await getTrackedSocialAccount(f.db, workspaceId, account.id),
    ).toMatchObject({
      externalId: "x-old",
      lastResolvedAt: first.lastResolvedAt,
      lastError: expect.stringContaining("target_unresolvable"),
    });

    response = {
      status: 200,
      json: { data: { id: "x-new" } },
    };
    await expect(
      await resolveTrackedSocialAccount(
        { db: f.db, fabric: f.fabric },
        {
          workspaceId,
          accountId: account.id,
          connectionId,
          force: true,
        },
      ),
    ).resolves.toMatchObject({
      externalId: "x-new",
      lastError: null,
    });
  });
});

describe("tracked account resolve route", () => {
  it("forces an authorized resolution and returns the cached row", async () => {
    const db = await createTestDb();
    const calls: string[] = [];
    const fabric = {
      async health() {
        return { healthy: true };
      },
      async proxyJson(
        _method: "GET" | "POST",
        path: string,
      ) {
        calls.push(path);
        return {
          status: 200,
          json: { data: { id: "x-route-42", username: "acme" } },
        };
      },
    } as unknown as ConnectorFabric;
    const llm: LlmGateway = {
      async generate() {
        return {
          text: "[]",
          model: "fake",
          provider: "fake",
          durationMs: 1,
        };
      },
    };
    const app = await buildAuthedApp({ db, llm, connectors: fabric });
    const routeWorkspaceId = (
      await app.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Route" },
      })
    ).json().id;
    const connectionId = randomUUID();
    await db.insert(connections)
      .values({
        id: connectionId,
        workspaceId: routeWorkspaceId,
        providerKey: "twitter",
        nangoConnectionId: "nango-twitter-route",
        configJson: "{}",
        displayName: "X",
        externalAccountId: null,
        externalAccountName: null,
        externalAccountHandle: null,
        externalAccountUrl: null,
        status: "connected",
        lastCheckedAt: 1,
        lastError: null,
        contentProfileJson: "{}",
        createdAt: 1,
        updatedAt: 1,
      });
    const account = await createTrackedSocialAccount(
      db,
      routeWorkspaceId,
      { platform: "x", handle: "@acme" },
    );

    const response = await app.inject({
      method: "POST",
      url:
        `/workspaces/${routeWorkspaceId}/discovery/tracked-accounts/` +
        `${account.id}/resolve`,
      payload: { connectionId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ externalId: "x-route-42" });
    expect(calls).toEqual(["/2/users/by/username/acme"]);
    await app.close();
  });
});
