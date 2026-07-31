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

function seedItem(
  db: Db,
  input: {
    id?: string;
    state?: "pending" | "running" | "ready" | "retryable_error" | "frozen";
    status?: "new" | "accepted" | "skipped" | "duplicate";
  } = {},
) {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sourceId = "22222222-2222-4222-8222-222222222222";
  db.insert(workspaces)
    .values({
      id: workspaceId,
      name: "Matching",
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
    .run();
  db.insert(discoverySources)
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
    .onConflictDoNothing()
    .run();
  const id = input.id ?? "33333333-3333-4333-8333-333333333333";
  db.insert(discoveredItems)
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
    })
    .run();
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
  it("reclaims expired work with a higher version and rejects the old heartbeat", () => {
    const db = createTestDb();
    const { workspaceId } = seedItem(db);
    const [first] = claimMatchingBatch(db, {
      workspaceId,
      owner: "owner-a",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();
    db.update(discoveredItems)
      .set({ matchingLeaseExpiresAt: 0 })
      .where(eq(discoveredItems.id, first!.itemId))
      .run();
    const [second] = claimMatchingBatch(db, {
      workspaceId,
      owner: "owner-b",
      limit: 1,
      leaseMs: 60_000,
    });

    expect(second!.version).toBe(first!.version + 1);
    expect(heartbeatMatchingClaim(db, first!, 60_000)).toBe(false);
    expect(heartbeatMatchingClaim(db, second!, 60_000)).toBe(true);
  });

  it.each(["pending", "running", "retryable_error"] as const)(
    "blocks acceptance while matching is %s",
    (state) => {
      const db = createTestDb();
      const { workspaceId, itemId } = seedItem(db, { state });

      expect(() =>
        acceptDiscoveredItem(db, workspaceId, itemId),
      ).toThrow("matching_not_ready");
      expect(db.select().from(signals).all()).toHaveLength(0);
    },
  );

  it("accepts a ready zero-match item and freezes matching", () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db, { state: "ready" });

    const accepted = acceptDiscoveredItem(db, workspaceId, itemId);

    expect(accepted.item.status).toBe("accepted");
    expect(
      db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId))
        .get(),
    ).toMatchObject({
      matchingState: "frozen",
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
    });
  });

  it("keeps matching lease internals out of the founder-visible item", () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db, { state: "ready" });

    const item = getDiscoveredItem(db, workspaceId, itemId)!;

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

  it("freezes matching when an item is skipped", () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db, { state: "ready" });
    const item = getDiscoveredItem(db, workspaceId, itemId)!;

    skipDiscoveredItem(db, workspaceId, item);

    expect(
      db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId))
        .get()!.matchingState,
    ).toBe("frozen");
  });

  it("marks malformed model output retryable instead of ready", async () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db);
    const claims = claimMatchingBatch(db, {
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
      db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId))
        .get(),
    ).toMatchObject({
      matchingState: "retryable_error",
      matchingError: "matching_malformed_response",
    });
  });

  it("does not let a delayed scorer overwrite a triaged item", async () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db);
    const claims = claimMatchingBatch(db, {
      workspaceId,
      owner: "owner",
      limit: 1,
      leaseMs: 60_000,
    });
    const started = deferred<void>();
    const release = deferred<void>();
    const run = runMatchingBatch(
      {
        db,
        llm: {
          async generate() {
            started.resolve();
            await release.promise;
            return validLlm.generate({ prompt: "test" });
          },
        },
        leaseMs: 60_000,
        heartbeatMs: 30_000,
      },
      claims,
      new AbortController().signal,
    );
    await started.promise;
    db.update(discoveredItems)
      .set({
        status: "accepted",
        matchingState: "frozen",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
      })
      .where(eq(discoveredItems.id, itemId))
      .run();
    release.resolve();
    await run;

    expect(
      db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId))
        .get(),
    ).toMatchObject({
      status: "accepted",
      matchingState: "frozen",
      score: null,
    });
  });

  it("passes cancellation to the gateway and records a stable timeout", async () => {
    const db = createTestDb();
    const { workspaceId, itemId } = seedItem(db);
    const claims = claimMatchingBatch(db, {
      workspaceId,
      owner: "owner",
      limit: 1,
      leaseMs: 60_000,
    });
    const controller = new AbortController();
    let gatewaySignal: AbortSignal | undefined;
    const started = deferred<void>();
    const run = runMatchingBatch(
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
      db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, itemId))
        .get()!.matchingError,
    ).toBe("matching_timeout");
  });
});
