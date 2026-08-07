import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db";
import {
  canonicalExternalStories,
  discoveredItems,
  discoveryJobs,
  discoverySourceOccurrences,
  discoverySources,
  storyOccurrences,
  workspaces,
} from "../src/db/schema";
import {
  getDiscoverySourceExecution,
  listDiscoverySources,
  persistDiscoveryPage,
  runClaimedDiscoverySource,
} from "../src/services/discovery";
import {
  claimNextDiscoveryJob,
  enqueueDueDiscoveryJobs,
} from "../src/services/discovery-jobs";
import { NullIntentProvider } from "../src/discovery/intent";
import {
  cursorMode,
  readCursor,
  reconcileTargets,
  resolveDiscoveryTargets,
} from "../src/discovery/paging";
import { CursorInvalidError } from "../src/discovery/connected-adapters";
import { createTestDb } from "./helpers";

async function claimedFixture(
  sourceInput: {
    type?: "rss" | "x";
    config?: Record<string, unknown>;
  } = {},
) {
  const db = createTestDb();
  await db.insert(workspaces)
    .values({
      id: "workspace-1",
      name: "Idempotency",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db.insert(discoverySources)
    .values({
      id: "source-1",
      workspaceId: "workspace-1",
      type: sourceInput.type ?? "rss",
      name: "Source",
      configJson: JSON.stringify(
        sourceInput.config ?? {
          feedUrl: "https://example.com/feed.xml",
        },
      ),
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
    .run();
  await enqueueDueDiscoveryJobs(
    db,
    "workspace-1",
    await listDiscoverySources(db, "workspace-1"),
    1,
  );
  const claim = (await claimNextDiscoveryJob(db, {
    workspaceId: "workspace-1",
    owner: "worker-1",
    leaseMs: 60_000,
  }))!;
  const source = (await getDiscoverySourceExecution(
    db,
    "workspace-1",
    "source-1",
  ))!;
  const targets = resolveDiscoveryTargets({
    source,
    trackedAccounts: [],
  });
  const cursor = reconcileTargets(
    readCursor("{}", cursorMode(source)),
    targets,
  );
  const page = {
    targetKey: targets[0]!.key,
    items: [
      {
        externalId: "occurrence-1",
        title: "One",
        url: "https://example.com/one",
        summary: "One",
        publishedAt: 1,
      },
    ],
    nextToken: null,
    reachedBoundary: false,
    exhausted: true,
    callsUsed: 1,
    decodedBytes: 10,
  };
  return { db, claim, source, cursor, page, targets };
}

const unusedSourceDependencies = {
  safeFetch: {
    validateUrl(url: string) {
      return new URL(url);
    },
    async fetch(): Promise<never> {
      throw new Error("unused safe fetch");
    },
  },
  intentProvider: new NullIntentProvider(),
  fabric: {} as Parameters<
    typeof runClaimedDiscoverySource
  >[0]["fabric"],
};

function sourceBudget() {
  return {
    deadlineMs: Date.now() + 60_000,
    maxItems: 100,
    maxPages: 10,
    maxCalls: 10,
    maxResponseBytes: 1_000,
    maxBytes: 10_000,
  };
}

async function occurrenceCount(db: Db): Promise<number> {
  return (await db.select().from(discoveredItems).all()).length;
}

describe("atomic discovery occurrence checkpoints", () => {
  it.each([
    "afterOccurrenceInsert",
    "afterStoryResolution",
    "afterCanonicalization",
    "beforeCursorUpdate",
  ] as const)("rolls back the whole page when %s fails", async (hook) => {
    const { db, claim, source, cursor, page } = await claimedFixture();

    expect(async () =>
      await persistDiscoveryPage(db, {
        claim,
        source,
        page,
        cursor,
        hooks: {
          [hook]: () => {
            throw new Error(`fault:${hook}`);
          },
        },
      }),
    ).toThrow(`fault:${hook}`);

    expect(await occurrenceCount(db)).toBe(0);
    // Sprint 60 shadow layer rolls back with the page too.
    expect(await db.select().from(discoverySourceOccurrences).all()).toHaveLength(0);
    expect(await db.select().from(canonicalExternalStories).all()).toHaveLength(0);
    expect(await db.select().from(storyOccurrences).all()).toHaveLength(0);
    const sourceRow = (await db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id))
      .get())!;
    expect(sourceRow.cursorJson).toBe("{}");
    const job = (await db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, claim.id))
      .get())!;
    expect(job.fetchedCount).toBe(0);
    expect(job.newCount).toBe(0);
  });

  it("does not let a stale owner mutate occurrences, cursor, or counters", async () => {
    const { db, claim, source, cursor, page } = await claimedFixture();
    await db.update(discoveryJobs)
      .set({ leaseOwner: "new-owner", leaseVersion: claim.leaseVersion + 1 })
      .where(eq(discoveryJobs.id, claim.id))
      .run();

    expect(
      await persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toBeNull();
    expect(await occurrenceCount(db)).toBe(0);
    expect(
      (await db
        .select({ cursorJson: discoverySources.cursorJson })
        .from(discoverySources)
        .where(eq(discoverySources.id, source.id))
        .get())!.cursorJson,
    ).toBe("{}");
    expect(
      await db
        .select({
          fetchedCount: discoveryJobs.fetchedCount,
          newCount: discoveryJobs.newCount,
        })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id))
        .get(),
    ).toEqual({ fetchedCount: 0, newCount: 0 });
  });

  it("commits one occurrence and ignores a replay of the same stable id", async () => {
    const { db, claim, source, cursor, page } = await claimedFixture();

    expect(
      await persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toEqual({ inserted: 1, fetched: 1 });
    expect(
      await persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toEqual({ inserted: 0, fetched: 1 });

    expect(await occurrenceCount(db)).toBe(1);
    expect(
      await db
        .select()
        .from(discoveredItems)
        .where(
          and(
            eq(discoveredItems.sourceId, source.id),
            eq(discoveredItems.externalId, "occurrence-1"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("rejects an adapter occurrence without a stable external id", async () => {
    const { db, claim, source, cursor, page } = await claimedFixture();
    page.items[0]!.externalId = "";

    expect(async () =>
      await persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toThrow("adapter_missing_external_id");
    expect(await occurrenceCount(db)).toBe(0);
  });

  it("fails the claimed job with a stable missing-id code", async () => {
    const { db, claim } = await claimedFixture();

    const result = await runClaimedDiscoverySource(
      {
        db,
        ...unusedSourceDependencies,
        pageReader: async (input) => ({
          targetKey: input.target.key,
          items: [
            {
              externalId: "",
              title: "Missing id",
              url: "https://example.com/missing-id",
              summary: "",
              publishedAt: null,
            },
          ],
          nextToken: null,
          reachedBoundary: false,
          exhausted: true,
          callsUsed: 1,
          decodedBytes: 10,
        }),
      },
      claim,
      sourceBudget(),
      new AbortController().signal,
    );

    expect(result.error).toBe("adapter_missing_external_id");
    expect(await occurrenceCount(db)).toBe(0);
    expect(
      (await db
        .select({ error: discoveryJobs.error })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id))
        .get())!.error,
    ).toBe("adapter_missing_external_id");
  });

  it("resumes after a committed checkpoint without duplicating the prior occurrence", async () => {
    const { db, claim, targets } = await claimedFixture({
      type: "x",
      config: {
        mode: "account_timeline",
        handles: ["first", "second"],
      },
    });
    let firstRunCalls = 0;
    const firstResult = await runClaimedDiscoverySource(
      {
        db,
        ...unusedSourceDependencies,
        pageReader: async (input) => {
          firstRunCalls += 1;
          if (firstRunCalls === 2) {
            throw new Error("fault_after_committed_checkpoint");
          }
          return {
            targetKey: input.target.key,
            items: [
              {
                externalId: "occurrence-first",
                title: "First",
                url: "https://example.com/first",
                summary: "First",
                publishedAt: 1,
              },
            ],
            nextToken: null,
            reachedBoundary: false,
            exhausted: true,
            callsUsed: 1,
            decodedBytes: 10,
          };
        },
      },
      claim,
      sourceBudget(),
      new AbortController().signal,
    );
    expect(firstResult.error).toContain("transport_failed");
    expect(await occurrenceCount(db)).toBe(1);

    await enqueueDueDiscoveryJobs(
      db,
      "workspace-1",
      await listDiscoverySources(db, "workspace-1"),
      2,
    );
    const retryClaim = (await claimNextDiscoveryJob(db, {
      workspaceId: "workspace-1",
      owner: "worker-2",
      leaseMs: 60_000,
    }))!;
    const visited: string[] = [];
    await runClaimedDiscoverySource(
      {
        db,
        ...unusedSourceDependencies,
        pageReader: async (input) => {
          visited.push(input.target.key);
          const suffix = input.target.handle ?? "default";
          return {
            targetKey: input.target.key,
            items: [
              {
                externalId: `occurrence-${suffix}`,
                title: suffix,
                url: `https://example.com/${suffix}`,
                summary: suffix,
                publishedAt: 1,
              },
            ],
            nextToken: null,
            reachedBoundary: false,
            exhausted: true,
            callsUsed: 1,
            decodedBytes: 10,
          };
        },
      },
      retryClaim,
      sourceBudget(),
      new AbortController().signal,
    );

    expect(visited[0]).toBe(targets[1]!.key);
    expect(
      (await db
        .select({
          externalId: discoveredItems.externalId,
        })
        .from(discoveredItems)
        .all())
        .map((row) => row.externalId)
        .sort(),
    ).toEqual(["occurrence-first", "occurrence-second"]);
  });

  it("checkpoints a four-page burst and resumes the remaining pages on the next job", async () => {
    const { db, claim } = await claimedFixture({
      type: "x",
      config: { mode: "query", query: "founder" },
    });
    const visitedTokens: Array<string | null> = [];
    const pageReader: NonNullable<
      Parameters<typeof runClaimedDiscoverySource>[0]["pageReader"]
    > = async (input) => {
      const token =
        input.checkpoint.continuation?.providerToken ?? null;
      visitedTokens.push(token);
      const pageNumber = token === null ? 1 : Number(token) + 1;
      return {
        targetKey: input.target.key,
        items: [
          {
            externalId: `occurrence-page-${pageNumber}`,
            title: `Page ${pageNumber}`,
            url: `https://example.com/page-${pageNumber}`,
            summary: "",
            publishedAt: pageNumber,
          },
        ],
        nextToken: pageNumber < 6 ? String(pageNumber) : null,
        reachedBoundary: false,
        exhausted: pageNumber === 6,
        callsUsed: 1,
        decodedBytes: 10,
      };
    };

    const first = await runClaimedDiscoverySource(
      { db, ...unusedSourceDependencies, pageReader },
      claim,
      { ...sourceBudget(), maxPages: 4 },
      new AbortController().signal,
    );
    expect(first.error).toBe("page_budget_exhausted");
    expect(visitedTokens).toEqual([null, "1", "2", "3"]);
    expect(await occurrenceCount(db)).toBe(4);

    await enqueueDueDiscoveryJobs(
      db,
      "workspace-1",
      await listDiscoverySources(db, "workspace-1"),
      Date.now() + 1,
    );
    const retryClaim = (await claimNextDiscoveryJob(db, {
      workspaceId: "workspace-1",
      owner: "worker-2",
      leaseMs: 60_000,
    }))!;
    const second = await runClaimedDiscoverySource(
      { db, ...unusedSourceDependencies, pageReader },
      retryClaim,
      { ...sourceBudget(), maxPages: 4 },
      new AbortController().signal,
    );

    expect(second.error).toBeUndefined();
    expect(visitedTokens).toEqual([null, "1", "2", "3", "4", "5"]);
    expect(await occurrenceCount(db)).toBe(6);
  });

  it("replays only the affected target when its provider cursor is rejected", async () => {
    const { db, claim, cursor, targets } = await claimedFixture({
      type: "x",
      config: { mode: "query", query: "founder" },
    });
    cursor.targets[targets[0]!.key]!.continuation = {
      providerToken: "expired",
      boundaryExternalId: null,
      newestExternalId: "occurrence-newest",
      newestPublishedAt: 5,
    };
    await db.update(discoverySources)
      .set({ cursorJson: JSON.stringify(cursor) })
      .where(eq(discoverySources.id, claim.sourceId))
      .run();
    const visitedTokens: Array<string | null> = [];

    const result = await runClaimedDiscoverySource(
      {
        db,
        ...unusedSourceDependencies,
        pageReader: async (input) => {
          const token =
            input.checkpoint.continuation?.providerToken ?? null;
          visitedTokens.push(token);
          if (token) throw new CursorInvalidError();
          return {
            targetKey: input.target.key,
            items: [
              {
                externalId: "occurrence-replayed",
                title: "Replayed",
                url: "https://example.com/replayed",
                summary: "",
                publishedAt: 10,
              },
            ],
            nextToken: null,
            reachedBoundary: false,
            exhausted: true,
            callsUsed: 1,
            decodedBytes: 10,
          };
        },
      },
      claim,
      sourceBudget(),
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(visitedTokens).toEqual(["expired", null]);
    expect(await occurrenceCount(db)).toBe(1);
  });
});
