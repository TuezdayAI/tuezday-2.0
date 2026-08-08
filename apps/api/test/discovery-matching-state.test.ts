import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db";
import {
  discoveredItems,
  discoverySources,
  signals,
  workspaces,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  claimMatchingBatch,
  heartbeatMatchingClaim,
  runMatchingBatch,
} from "../src/services/discovery-matching";
import {
  acceptDiscoveredItem,
  getDiscoveredItem,
  skipDiscoveredItem,
} from "../src/services/discovery";
import { createTestDb } from "./helpers";

async function seedItem(
  db: Db,
  input: {
    id?: string;
    state?: "pending" | "running" | "ready" | "retryable_error" | "frozen";
    status?: "new" | "accepted" | "skipped" | "duplicate";
  } = {},
) {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sourceId = "22222222-2222-4222-8222-222222222222";
  await db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "Matching",
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing();
  await db.insert(discoverySources)
    .values({
      id: sourceId,
      workspaceId,
      type: "rss",
      name: "Source",
      configJson: "{}",
      enabled: true,
      status: "active",
      lastError: null,
      lastFetchedAt: null,
      connectionId: null,
      cursorJson: "{}",
      backoffUntil: null,
      lastAttemptedAt: null,
      executionVersion: 1,
      createdAt: 1,
    })
    .onConflictDoNothing();
  const id = input.id ?? "33333333-3333-4333-8333-333333333333";
  await db.insert(discoveredItems)
    .values({
      id,
      workspaceId,
      sourceId,
      externalId: id,
      title: "A relevant item",
      url: "https://example.com/item",
      summary: "Summary",
      publishedAt: 1,
      score: null,
      suggestedPersonaId: null,
      suggestedCampaignId: null,
      scoreReason: null,
      status: input.status ?? "new",
      signalId: null,
      scoredAt: null,
      urlHash: null,
      contentHash: "content",
      duplicateOfId: null,
      matchingState: input.state ?? "pending",
      matchingVersion: 0,
      matchingInputFingerprint: null,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
      createdAt: 1,
    });
  return { workspaceId, sourceId, itemId: id };
}

const validLlm: LlmGateway = {
  async generate() {
    return {
      text: JSON.stringify([{ index: 0, score: 42, matches: [] }]),
      model: "fake",
      provider: "fake",
      durationMs: 1,
    };
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("discovery matching state", () => {
  it("reclaims expired work with a higher version and rejects the old heartbeat", async () => {
    const db = await createTestDb();
    const { workspaceId } = await seedItem(db);
    const [first] = await claimMatchingBatch(db, {
      workspaceId,
      owner: "owner-a",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();
    await db.update(discoveredItems)
      .set({ matchingLeaseExpiresAt: 0 })
      .where(eq(discoveredItems.id, first!.itemId));
    const [second] = await claimMatchingBatch(db, {
      workspaceId,
      owner: "owner-b",
      limit: 1,
      leaseMs: 60_000,
    });

    expect(second!.version).toBe(first!.version + 1);
    expect(await heartbeatMatchingClaim(db, first!, 60_000)).toBe(false);
    expect(await heartbeatMatchingClaim(db, second!, 60_000)).toBe(true);
  });

  it.each(["pending", "running", "retryable_error"] as const)(
    "blocks acceptance while matching is %s",
    async (state) => {
      const db = await createTestDb();
      const { workspaceId, itemId } = await seedItem(db, { state });

      expect(async () =>
        await acceptDiscoveredItem(db, workspaceId, itemId),
      ).toThrow("matching_not_ready");
      expect(await db.select().from(signals)).toHaveLength(0);
    },
  );

  it("accepts a ready zero-match item and freezes matching", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db, { state: "ready" });

    const accepted = await acceptDiscoveredItem(db, workspaceId, itemId);

    expect(accepted.item.status).toBe("accepted");
    expect(
      (await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId)))[0],
    ).toMatchObject({
      matchingState: "frozen",
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
    });
  });

  it("keeps matching lease internals out of the founder-visible item", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db, { state: "ready" });

    const item = (await getDiscoveredItem(db, workspaceId, itemId))!;

    expect(item).toMatchObject({
      matchingState: "ready",
      matchingError: null,
    });
    for (const key of [
      "matchingVersion",
      "matchingInputFingerprint",
      "matchingLeaseOwner",
      "matchingLeaseExpiresAt",
      "matchingHeartbeatAt",
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it("freezes matching when an item is skipped", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db, { state: "ready" });
    const item = (await getDiscoveredItem(db, workspaceId, itemId))!;

    await skipDiscoveredItem(db, workspaceId, item);

    expect(
      ((await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId)))[0])!.matchingState,
    ).toBe("frozen");
  });

  it("marks malformed model output retryable instead of ready", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db);
    const claims = await claimMatchingBatch(db, {
      workspaceId,
      owner: "owner",
      limit: 1,
      leaseMs: 60_000,
    });

    const result = await runMatchingBatch(
      {
        db,
        llm: {
          async generate() {
            return {
              text: "not-json",
              model: "fake",
              provider: "fake",
              durationMs: 1,
            };
          },
        },
        leaseMs: 60_000,
        heartbeatMs: 30_000,
      },
      claims,
      new AbortController().signal,
    );

    expect(result).toEqual({ ready: 0, retryableErrors: 1 });
    expect(
      (await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId)))[0],
    ).toMatchObject({
      matchingState: "retryable_error",
      matchingError: "matching_malformed_response",
    });
  });

  it("does not let a delayed scorer overwrite a triaged item", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db);
    const claims = await claimMatchingBatch(db, {
      workspaceId,
      owner: "owner",
      limit: 1,
      leaseMs: 60_000,
    });
    const started = deferred<void>();
    const release = deferred<void>();
    const run = await runMatchingBatch(
      {
        db,
        llm: {
          async generate() {
            started.resolve();
            await release.promise;
            return await validLlm.generate({ prompt: "test" });
          },
        },
        leaseMs: 60_000,
        heartbeatMs: 30_000,
      },
      claims,
      new AbortController().signal,
    );
    await started.promise;
    await db.update(discoveredItems)
      .set({
        status: "accepted",
        matchingState: "frozen",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
      })
      .where(eq(discoveredItems.id, itemId));
    release.resolve();
    await run;

    expect(
      (await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId)))[0],
    ).toMatchObject({
      status: "accepted",
      matchingState: "frozen",
      score: null,
    });
  });

  it("passes cancellation to the gateway and records a stable timeout", async () => {
    const db = await createTestDb();
    const { workspaceId, itemId } = await seedItem(db);
    const claims = await claimMatchingBatch(db, {
      workspaceId,
      owner: "owner",
      limit: 1,
      leaseMs: 60_000,
    });
    const controller = new AbortController();
    let gatewaySignal: AbortSignal | undefined;
    const started = deferred<void>();
    const run = await runMatchingBatch(
      {
        db,
        llm: {
          async generate(input) {
            gatewaySignal = input.signal;
            started.resolve();
            return new Promise((_, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(input.signal?.reason),
                { once: true },
              );
            });
          },
        },
        leaseMs: 60_000,
        heartbeatMs: 30_000,
      },
      claims,
      controller.signal,
    );
    await started.promise;
    controller.abort(
      Object.assign(new Error("matching_timeout"), {
        code: "matching_timeout",
      }),
    );
    await run;

    expect(gatewaySignal?.aborted).toBe(true);
    expect(
      ((await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId)))[0])!.matchingError,
    ).toBe("matching_timeout");
  });
});
