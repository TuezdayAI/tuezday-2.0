import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DiscoverySourceType } from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  discoveryJobs,
  discoverySources,
  trackedSocialAccounts,
  workspaces,
} from "../src/db/schema";
import {
  PermissionRequiredError,
  fetchConnectedSourcePage,
  getConnectedDiscoveryErrorMetrics,
} from "../src/discovery/connected-adapters";
import {
  readCursor,
  reconcileTargets,
  safeCursorProgress,
  type DiscoveryPage,
  type DiscoveryPageReader,
} from "../src/discovery/paging";
import { NullIntentProvider } from "../src/discovery/intent";
import type { LlmGateway } from "../src/llm/gateway";
import {
  DEFAULT_DISCOVERY_POLICY,
  type DiscoveryOperatorPolicy,
} from "../src/runtime/operator-policy";
import { listDiscoverySources } from "../src/services/discovery";
import {
  claimNextDiscoveryJob,
  enqueueDueDiscoveryJobs,
} from "../src/services/discovery-jobs";
import {
  deleteTrackedSocialAccount,
  updateTrackedSocialAccount,
} from "../src/services/tracked-social-accounts";
import {
  runDiscoveryScheduler,
  type DiscoveryOperatorEvent,
} from "../src/services/discovery-scheduler";
import type { SafeFetchService } from "../src/safe-fetch";
import { buildAuthedApp, createTestDb } from "./helpers";

const noScoringLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const unusedSafeFetch = {
  validateUrl(url: string) {
    return new URL(url);
  },
  async fetch(): Promise<never> {
    throw new Error("safe fetch must not be called by the fake page reader");
  },
};

const unusedFabric = {} as Parameters<typeof runDiscoveryScheduler>[0]["fabric"];

async function seedWorkspace(db: Db, id = "workspace-1"): Promise<void> {
  await db.insert(workspaces)
    .values({ id, name: id, createdAt: 1, updatedAt: 1 });
}

async function seedSource(
  db: Db,
  input: {
    id: string;
    workspaceId?: string;
    type?: DiscoverySourceType;
    config?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(discoverySources)
    .values({
      id: input.id,
      workspaceId: input.workspaceId ?? "workspace-1",
      type: input.type ?? "rss",
      name: input.id,
      configJson: JSON.stringify(
        input.config ?? { feedUrl: `https://feeds.example.com/${input.id}.xml` },
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
    });
}

function page(
  targetKey = "default",
  items: DiscoveryPage["items"] = [],
  overrides: Partial<DiscoveryPage> = {},
): DiscoveryPage {
  return {
    targetKey,
    items,
    nextToken: null,
    reachedBoundary: false,
    exhausted: true,
    callsUsed: 1,
    decodedBytes: 10,
    ...overrides,
  };
}

function item(id: string): DiscoveryPage["items"][number] {
  return {
    externalId: id,
    title: id,
    url: `https://example.com/${id}`,
    summary: id,
    publishedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function policy(
  overrides: Partial<DiscoveryOperatorPolicy> = {},
): DiscoveryOperatorPolicy {
  return { ...DEFAULT_DISCOVERY_POLICY, ...overrides };
}

function dependencies(
  db: Db,
  pageReader: DiscoveryPageReader,
  options: {
    policy?: DiscoveryOperatorPolicy;
    shutdownSignal?: AbortSignal;
    events?: DiscoveryOperatorEvent[];
  } = {},
): Parameters<typeof runDiscoveryScheduler>[0] {
  return {
    db,
    llm: noScoringLlm,
    safeFetch: unusedSafeFetch,
    intentProvider: new NullIntentProvider(),
    fabric: unusedFabric,
    policy: options.policy ?? policy(),
    instanceId: "api-test",
    shutdownSignal:
      options.shutdownSignal ?? new AbortController().signal,
    log: (event) => options.events?.push(event),
    pageReader,
  };
}

describe("discovery cursor safety", () => {
  it("repairs malformed state and never exposes provider continuation tokens", () => {
    expect(readCursor("not-json", "account_timeline")).toEqual({
      version: 1,
      mode: "account_timeline",
      nextTargetIndex: 0,
      targets: {},
    });

    const reconciled = reconcileTargets(
      readCursor(
        JSON.stringify({
          version: 1,
          mode: "account_timeline",
          nextTargetIndex: 9,
          targets: {
            a: {
              targetFingerprint: "old",
              highWatermark: null,
              continuation: {
                providerToken: "secret-provider-token",
                boundaryExternalId: "boundary",
                newestExternalId: "newest",
                newestPublishedAt: 2,
              },
              lastSafeError: null,
            },
          },
        }),
        "account_timeline",
      ),
      [{ key: "a", fingerprint: "current" }],
    );

    expect(reconciled.targets.a?.continuation).toBeNull();
    const safe = safeCursorProgress(reconciled, 123);
    expect(safe).toEqual({
      version: 1,
      targetCount: 1,
      backlog: false,
      lastCheckpointAt: 123,
    });
    expect(JSON.stringify(safe)).not.toContain("secret-provider-token");
  });
});

describe("connected page accounting", () => {
  it("retains safe call and byte counters when a provider page fails", async () => {
    const source = {
      id: "source",
      workspaceId: "workspace",
      type: "x",
      name: "source",
      config: { mode: "query", query: "founder" },
      enabled: true,
      status: "active",
      lastError: null,
      lastFetchedAt: null,
      connectionId: "connection",
      cursor: {
        version: 1,
        targetCount: 0,
        backlog: false,
        lastCheckpointAt: null,
      },
      backoffUntil: null,
      lastAttemptedAt: null,
      createdAt: 1,
    } as const;
    const connection = {
      id: "connection",
      workspaceId: "workspace",
      providerKey: "x",
      nangoConnectionId: "nango-connection",
      status: "connected",
    } as Parameters<typeof fetchConnectedSourcePage>[0]["connection"];
    const fabric = {
      async proxyJson() {
        return { status: 403, json: {}, decodedBytes: 19 };
      },
    } as unknown as Parameters<
      typeof fetchConnectedSourcePage
    >[0]["fabric"];
    let failure: unknown;
    try {
      await fetchConnectedSourcePage({
        source,
        connection,
        fabric,
        trackedAccounts: [],
        target: { key: "default", fingerprint: "target" },
        checkpoint: {
          targetFingerprint: "target",
          highWatermark: null,
          continuation: null,
          lastSafeError: null,
        },
        signal: new AbortController().signal,
        maxItems: 10,
        maxCalls: 10,
        maxResponseBytes: 1024,
        maxBytes: 1024,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PermissionRequiredError);
    expect(getConnectedDiscoveryErrorMetrics(failure)).toEqual({
      callsUsed: 1,
      decodedBytes: 19,
    });
  });
});

describe("tracked target version fences", () => {
  it.each(["update", "delete"] as const)(
    "invalidates leased source work when a tracked target is %s",
    async (operation) => {
      const db = await createTestDb();
      await seedWorkspace(db);
      await db.insert(trackedSocialAccounts)
        .values({
          id: "account-1",
          workspaceId: "workspace-1",
          platform: "x",
          handle: "before",
          displayName: null,
          externalId: null,
          url: null,
          notes: "",
          enabled: true,
          lastResolvedAt: null,
          lastError: null,
          createdAt: 1,
          updatedAt: 1,
        });
      await seedSource(db, {
        id: "tracked-source",
        type: "x",
        config: {
          mode: "account_timeline",
          trackedAccountId: "account-1",
        },
      });
      await enqueueDueDiscoveryJobs(
        db,
        "workspace-1",
        await listDiscoverySources(db, "workspace-1"),
        1,
      );
      const claim = (await claimNextDiscoveryJob(db, {
        workspaceId: "workspace-1",
        owner: "api:tracked-target",
        leaseMs: 45_000,
      }))!;

      if (operation === "update") {
        await updateTrackedSocialAccount(
          db,
          "workspace-1",
          "account-1",
          { handle: "after" },
        );
      } else {
        await deleteTrackedSocialAccount(
          db,
          "workspace-1",
          "account-1",
        );
      }

      expect(
        ((await db
          .select()
          .from(discoverySources)
          .where(eq(discoverySources.id, "tracked-source")))[0])!.executionVersion,
      ).toBe(2);
      expect(
        (await db
          .select()
          .from(discoveryJobs)
          .where(eq(discoveryJobs.id, claim.id)))[0],
      ).toMatchObject({
        status: "skipped",
        error: "source_version_changed",
        leaseOwner: null,
      });
    },
  );
});

describe("bounded leased discovery scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never enqueues a reserved source even when it is enabled", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, { id: "reserved-trends", type: "google_trends" });
    await db.update(discoverySources)
      .set({ status: "reserved", enabled: true })
      .where(eq(discoverySources.id, "reserved-trends"));
    let pageCalls = 0;

    const result = await runDiscoveryScheduler(
      dependencies(db, async ({ target }) => {
        pageCalls += 1;
        return page(target.key);
      }),
      { workspaceId: "workspace-1" },
    );

    expect(result.queued).toBe(0);
    expect(result.processed).toBe(0);
    expect(pageCalls).toBe(0);
    expect(await db.select().from(discoveryJobs)).toEqual([]);
  });

  it("never enqueues reserved intent even when a provider is configured", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, {
      id: "reserved-intent",
      type: "intent",
      config: { query: "market" },
    });
    await db.update(discoverySources)
      .set({ status: "reserved", enabled: true })
      .where(eq(discoverySources.id, "reserved-intent"));
    let pageCalls = 0;
    const deps = dependencies(db, async ({ target }) => {
      pageCalls += 1;
      return page(target.key);
    });
    deps.intentProvider = {
      isConfigured: () => true,
      async fetchSignals() {
        return [];
      },
    };

    const result = await runDiscoveryScheduler(
      deps,
      { workspaceId: "workspace-1" },
    );

    expect(result.queued).toBe(0);
    expect(result.processed).toBe(0);
    expect(pageCalls).toBe(0);
    expect(await db.select().from(discoveryJobs)).toEqual([]);
  });

  it("returns busy for overlap and makes zero calls from the losing tick", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, { id: "source-1" });
    const held = deferred<DiscoveryPage>();
    // Since Sprint 74 every database call is a round trip, so the scheduler
    // suspends before it reaches the reader. Wait for the first call rather
    // than assuming the tick got that far synchronously.
    const entered = deferred<void>();
    let calls = 0;
    const pageReader: DiscoveryPageReader = async ({ target }) => {
      calls += 1;
      entered.resolve();
      return await held.promise.then((result) => ({ ...result, targetKey: target.key }));
    };
    const deps = dependencies(db, pageReader);

    const first = runDiscoveryScheduler(deps, { workspaceId: "workspace-1" });
    await entered.promise;
    expect(calls).toBe(1);

    const overlap = await runDiscoveryScheduler(deps, {
      workspaceId: "workspace-1",
    });
    expect(overlap).toMatchObject({ busy: true, processed: 0 });
    expect(calls).toBe(1);

    held.resolve(page());
    await expect(first).resolves.toMatchObject({ busy: false, processed: 1 });
  });

  it("claims just in time and admits at most five jobs", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    for (let index = 1; index <= 6; index += 1) {
      await seedSource(db, { id: `source-${index}` });
    }
    const firstPage = deferred<DiscoveryPage>();
    const entered = deferred<void>();
    let calls = 0;
    const pageReader: DiscoveryPageReader = async ({ target }) => {
      calls += 1;
      entered.resolve();
      if (calls === 1) {
        return await firstPage.promise.then((result) => ({
          ...result,
          targetKey: target.key,
        }));
      }
      return page(target.key);
    };

    const pending = runDiscoveryScheduler(dependencies(db, pageReader), {
      workspaceId: "workspace-1",
    });
    await entered.promise;
    expect(calls).toBe(1);
    expect(
      (await db
        .select()
        .from(discoveryJobs))
        .filter((job) => job.status === "running"),
    ).toHaveLength(1);
    expect(
      (await db
        .select()
        .from(discoveryJobs))
        .filter((job) => job.status === "queued"),
    ).toHaveLength(5);

    firstPage.resolve(page());
    const result = await pending;
    expect(result.processed).toBe(5);
    expect(calls).toBe(5);
    expect(
      (await db
        .select()
        .from(discoveryJobs))
        .filter((job) => job.status === "queued"),
    ).toHaveLength(1);
  });

  it("applies item, page, call, and byte budgets across all targets", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, {
      id: "multi-target",
      type: "x",
      config: {
        mode: "account_timeline",
        handles: ["alpha", "beta", "gamma"],
      },
    });
    const targets: string[] = [];
    const events: DiscoveryOperatorEvent[] = [];
    const pageReader: DiscoveryPageReader = async ({ target }) => {
      targets.push(target.key);
      return page(target.key, [
        item(`${target.key}-1`),
        item(`${target.key}-2`),
      ]);
    };

    const result = await runDiscoveryScheduler(
      dependencies(db, pageReader, {
        events,
        policy: policy({
          maxJobsPerTick: 1,
          maxItemsPerSource: 3,
          maxPagesPerSource: 2,
          maxCallsPerSource: 2,
          maxBytesPerSource: 20,
        }),
      }),
      { workspaceId: "workspace-1" },
    );

    expect(targets).toHaveLength(2);
    expect(result).toMatchObject({
      processed: 1,
      budgetExhausted: true,
      sources: [{ fetched: 3, new: 3, error: "item_budget_exhausted" }],
    });
    expect(events[0]).toMatchObject({
      code: "item_budget_exhausted",
      calls: 2,
      pages: 2,
      bytes: 20,
      items: 3,
      continuationPending: true,
    });
  });

  it.each([
    [
      "page",
      { maxPagesPerSource: 1 },
      "page_budget_exhausted",
    ],
    [
      "call",
      { maxCallsPerSource: 1 },
      "call_budget_exhausted",
    ],
    [
      "source-byte",
      { maxBytesPerSource: 10 },
      "source_byte_budget_exhausted",
    ],
  ] as const)(
    "enforces the global %s cap before reading another target",
    async (_label, override, expectedCode) => {
      const db = await createTestDb();
      await seedWorkspace(db);
      await seedSource(db, {
        id: "bounded-targets",
        type: "x",
        config: {
          mode: "account_timeline",
          handles: ["alpha", "beta", "gamma"],
        },
      });
      let calls = 0;
      const pageReader: DiscoveryPageReader = async ({ target }) => {
        calls += 1;
        return page(target.key);
      };

      const result = await runDiscoveryScheduler(
        dependencies(db, pageReader, {
          policy: policy({
            maxJobsPerTick: 1,
            ...override,
          }),
        }),
        { workspaceId: "workspace-1" },
      );

      expect(calls).toBe(1);
      expect(result.sources[0]?.error).toBe(expectedCode);
      expect(result.budgetExhausted).toBe(true);
    },
  );

  it("continues after one target has a permission failure", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, {
      id: "permission-mix",
      type: "x",
      config: {
        mode: "account_timeline",
        handles: ["blocked", "healthy"],
      },
    });
    let calls = 0;
    const pageReader: DiscoveryPageReader = async ({ target }) => {
      calls += 1;
      if (target.handle === "blocked") {
        throw new PermissionRequiredError("raw provider permission detail");
      }
      return page(target.key, [item("healthy-item")]);
    };

    const result = await runDiscoveryScheduler(
      dependencies(db, pageReader, {
        policy: policy({ maxJobsPerTick: 1 }),
      }),
      { workspaceId: "workspace-1" },
    );

    expect(calls).toBe(2);
    expect(result.sources).toEqual([
      {
        sourceId: "permission-mix",
        name: "permission-mix",
        fetched: 1,
        new: 1,
      },
    ]);
  });

  it("aborts the page reader at the source deadline without sleeping", async () => {
    vi.useFakeTimers();
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, { id: "slow-source" });
    const entered = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const pageReader: DiscoveryPageReader = ({ signal }) => {
      receivedSignal = signal;
      entered.resolve();
      return new Promise<DiscoveryPage>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };

    const pending = runDiscoveryScheduler(
      dependencies(db, pageReader, {
        policy: policy({
          maxJobsPerTick: 1,
          tickTimeoutMs: 100,
          sourceTimeoutMs: 10,
          matchingTimeoutMs: 5,
          leaseMs: 45_000,
          heartbeatMs: 10_000,
        }),
      }),
      { workspaceId: "workspace-1" },
    );
    await entered.promise;
    expect(receivedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      sources: [{ error: "source_timeout" }],
      budgetExhausted: true,
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("stops before another claim when the tick has no meaningful source budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, { id: "source-1" });
    await seedSource(db, { id: "source-2" });
    let calls = 0;
    const pageReader: DiscoveryPageReader = async ({ target }) => {
      calls += 1;
      vi.setSystemTime(Date.now() + 6_001);
      return page(target.key);
    };

    const result = await runDiscoveryScheduler(
      dependencies(db, pageReader, {
        policy: policy({
          tickTimeoutMs: 10_000,
          sourceTimeoutMs: 5_000,
          matchingTimeoutMs: 1_000,
        }),
      }),
      { workspaceId: "workspace-1" },
    );

    expect(result.processed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(calls).toBe(1);
    expect(
      (await db
        .select()
        .from(discoveryJobs))
        .filter((job) => job.status === "queued"),
    ).toHaveLength(1);
  });

  it("emits stable safe fields without raw exceptions or cursor tokens", async () => {
    const db = await createTestDb();
    await seedWorkspace(db);
    await seedSource(db, { id: "broken-source" });
    const events: DiscoveryOperatorEvent[] = [];
    const pageReader: DiscoveryPageReader = async () => {
      throw new Error(
        "socket failed with provider-token=secret and body={private:true}",
      );
    };

    await runDiscoveryScheduler(
      dependencies(db, pageReader, {
        events,
        policy: policy({ maxJobsPerTick: 1 }),
      }),
      { workspaceId: "workspace-1" },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: "transport_failed",
      taskKey: "discovery:scheduler",
      jobId: expect.any(String),
      workspaceId: "workspace-1",
      sourceId: "broken-source",
      leaseVersion: 1,
      attempt: 1,
      replay: false,
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("provider-token");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("secret");
  });
});

describe("Fastify discovery shutdown", () => {
  function rssResult(): Awaited<ReturnType<SafeFetchService["fetch"]>> {
    const bytes = Buffer.from(
      '<rss version="2.0"><channel><item><guid>one</guid><title>One</title><link>https://example.com/one</link></item></channel></rss>',
    );
    return {
      finalUrl: "https://feeds.example.com/feed.xml",
      status: 200,
      contentType: "application/rss+xml",
      bytes,
      text: () => bytes.toString("utf8"),
      json: <T,>() => JSON.parse(bytes.toString("utf8")) as T,
    };
  }

  async function addWorkspaceAndSource(
    app: Awaited<ReturnType<typeof buildAuthedApp>>,
  ): Promise<string> {
    const workspaceId = (
      await app.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Shutdown" },
      })
    ).json().id as string;
    const source = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/sources`,
      payload: {
        type: "rss",
        config: { feedUrl: "https://feeds.example.com/feed.xml" },
      },
    });
    expect(source.statusCode).toBe(201);
    return workspaceId;
  }

  it("aborts an in-flight provider transport when the app closes", async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const safeFetch: SafeFetchService = {
      validateUrl(url) {
        return new URL(url);
      },
      fetch(request) {
        receivedSignal = request.signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(request.signal?.reason);
            },
            { once: true },
          );
          void resolve;
        });
      },
    };
    const app = await buildAuthedApp({
      db: await createTestDb(),
      llm: noScoringLlm,
      safeFetch,
      operatorLog() {},
    });
    const workspaceId = await addWorkspaceAndSource(app);

    const running = app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/run`,
    });
    await started.promise;
    const closing = app.close();

    await aborted.promise;
    expect(receivedSignal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ statusCode: 200 });
    await closing;
  });

  it("aborts an in-flight discovery judgment when the app closes", async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const llm: LlmGateway = {
      generate(params) {
        receivedSignal = params.signal;
        started.resolve();
        return new Promise((resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(params.signal?.reason);
            },
            { once: true },
          );
          void resolve;
        });
      },
    };
    const safeFetch: SafeFetchService = {
      validateUrl(url) {
        return new URL(url);
      },
      async fetch() {
        return rssResult();
      },
    };
    const app = await buildAuthedApp({
      db: await createTestDb(),
      llm,
      safeFetch,
      operatorLog() {},
    });
    const workspaceId = await addWorkspaceAndSource(app);

    const running = app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/run`,
    });
    await started.promise;
    const closing = app.close();

    await aborted.promise;
    expect(receivedSignal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ statusCode: 200 });
    await closing;
  });
});
