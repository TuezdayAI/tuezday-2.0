import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db";
import {
  discoveredItems,
  discoveryJobs,
  discoverySources,
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
import { createTestDb } from "./helpers";

function claimedFixture(
  sourceInput: {
    type?: "rss" | "x";
    config?: Record<string, unknown>;
  } = {},
) {
  const db = createTestDb();
  db.insert(workspaces)
    .values({
      id: "workspace-1",
      name: "Idempotency",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(discoverySources)
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
  enqueueDueDiscoveryJobs(
    db,
    "workspace-1",
    listDiscoverySources(db, "workspace-1"),
    1,
  );
  const claim = claimNextDiscoveryJob(db, {
    workspaceId: "workspace-1",
    owner: "worker-1",
    leaseMs: 60_000,
  })!;
  const source = getDiscoverySourceExecution(
    db,
    "workspace-1",
    "source-1",
  )!;
  const cursor = {
    version: 1 as const,
    mode: "rss",
    nextTargetIndex: 0,
    targets: {},
  };
  const page = {
    targetKey: "default",
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
  return { db, claim, source, cursor, page };
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

function occurrenceCount(db: Db): number {
  return db.select().from(discoveredItems).all().length;
}

describe("atomic discovery occurrence checkpoints", () => {
  it.each([
    "afterOccurrenceInsert",
    "afterCanonicalization",
    "beforeCursorUpdate",
  ] as const)("rolls back the whole page when %s fails", (hook) => {
    const { db, claim, source, cursor, page } = claimedFixture();

    expect(() =>
      persistDiscoveryPage(db, {
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

    expect(occurrenceCount(db)).toBe(0);
    const sourceRow = db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id))
      .get()!;
    expect(sourceRow.cursorJson).toBe("{}");
    const job = db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, claim.id))
      .get()!;
    expect(job.fetchedCount).toBe(0);
    expect(job.newCount).toBe(0);
  });

  it("does not let a stale owner mutate occurrences, cursor, or counters", () => {
    const { db, claim, source, cursor, page } = claimedFixture();
    db.update(discoveryJobs)
      .set({ leaseOwner: "new-owner", leaseVersion: claim.leaseVersion + 1 })
      .where(eq(discoveryJobs.id, claim.id))
      .run();

    expect(
      persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toBeNull();
    expect(occurrenceCount(db)).toBe(0);
    expect(
      db
        .select({ cursorJson: discoverySources.cursorJson })
        .from(discoverySources)
        .where(eq(discoverySources.id, source.id))
        .get()!.cursorJson,
    ).toBe("{}");
    expect(
      db
        .select({
          fetchedCount: discoveryJobs.fetchedCount,
          newCount: discoveryJobs.newCount,
        })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id))
        .get(),
    ).toEqual({ fetchedCount: 0, newCount: 0 });
  });

  it("commits one occurrence and ignores a replay of the same stable id", () => {
    const { db, claim, source, cursor, page } = claimedFixture();

    expect(
      persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toEqual({ inserted: 1, fetched: 1 });
    expect(
      persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toEqual({ inserted: 0, fetched: 1 });

    expect(occurrenceCount(db)).toBe(1);
    expect(
      db
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

  it("rejects an adapter occurrence without a stable external id", () => {
    const { db, claim, source, cursor, page } = claimedFixture();
    page.items[0]!.externalId = "";

    expect(() =>
      persistDiscoveryPage(db, { claim, source, page, cursor }),
    ).toThrow("adapter_missing_external_id");
    expect(occurrenceCount(db)).toBe(0);
  });

  it("fails the claimed job with a stable missing-id code", async () => {
    const { db, claim } = claimedFixture();

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
    expect(occurrenceCount(db)).toBe(0);
    expect(
      db
        .select({ error: discoveryJobs.error })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id))
        .get()!.error,
    ).toBe("adapter_missing_external_id");
  });

  it("resumes after a committed checkpoint without duplicating the prior occurrence", async () => {
    const { db, claim } = claimedFixture({
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
    expect(occurrenceCount(db)).toBe(1);

    enqueueDueDiscoveryJobs(
      db,
      "workspace-1",
      listDiscoverySources(db, "workspace-1"),
      2,
    );
    const retryClaim = claimNextDiscoveryJob(db, {
      workspaceId: "workspace-1",
      owner: "worker-2",
      leaseMs: 60_000,
    })!;
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

    expect(visited[0]).toBe("handle:second");
    expect(
      db
        .select({
          externalId: discoveredItems.externalId,
        })
        .from(discoveredItems)
        .all()
        .map((row) => row.externalId)
        .sort(),
    ).toEqual(["occurrence-first", "occurrence-second"]);
  });
});
