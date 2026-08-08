import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { discoveryJobSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { discoveryJobs, discoverySources, workspaces } from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { safeFetchError, safeFetchPublicMessage } from "../src/safe-fetch";
import {
  DISCOVERY_JOB_BATCH_SIZE,
  claimNextDiscoveryJob,
  completeDiscoveryJob,
  enqueueDueDiscoveryJobs,
  failDiscoveryJob,
  heartbeatDiscoveryJob,
} from "../src/services/discovery-jobs";
import { listDiscoverySources } from "../src/services/discovery";
import { buildAuthedApp, connectTestDbAgain, createTestDb } from "./helpers";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";
import { DATABASE_NOW_MS } from "../src/services/task-leases";

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

/** Serves an empty-but-valid RSS feed; URLs containing "failing" 500. */
const stubFetcher = fixtureSafeFetch((request) => {
  if (request.url.includes("failing")) {
    return {
      contentType: "application/xml",
      error: safeFetchError("upstream_status"),
    };
  }
  return {
    body: '<rss version="2.0"><channel><title>t</title></channel></rss>',
    contentType: "application/xml",
  };
});

describe("discovery job ledger (Sprint 46)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await buildAuthedApp({ db, llm: stubLlm, safeFetch: stubFetcher });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Jobs" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function addRssSource(n: number) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/sources`,
      payload: { type: "rss", config: { feedUrl: `https://feeds.example.com/${n}.xml` } },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  async function sources() {
    return await listDiscoverySources(db, workspaceId);
  }

  async function jobRows() {
    return await db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.workspaceId, workspaceId));
  }

  it("enqueues one queued job per due source, never a duplicate", async () => {
    const now = Date.now();
    await addRssSource(1);
    await addRssSource(2);
    const sourceSnapshot = await sources();
    const selectSpy = vi.spyOn(db, "select");
    expect(await enqueueDueDiscoveryJobs(db, workspaceId, sourceSnapshot, now)).toBe(2);
    expect(selectSpy).not.toHaveBeenCalled();
    // second enqueue is a no-op while the jobs are still queued
    expect(await enqueueDueDiscoveryJobs(db, workspaceId, sourceSnapshot, now + 1)).toBe(0);
    const rows = await jobRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(discoveryJobSchema.safeParse(row).success).toBe(true);
      expect(row.status).toBe("queued");
      expect(row.attempt).toBe(0);
    }
  });

  it("converges concurrent enqueue attempts through the database unique index", async () => {
    const dbA = await createTestDb();
    // Instance B is a separate pool onto the same database — the unique index
    // is the only thing arbitrating between them.
    const dbB = await connectTestDbAgain(dbA);
    await dbA.insert(workspaces)
      .values({
        id: "workspace-shared",
        name: "Shared",
        createdAt: 1,
        updatedAt: 1,
      });
    await dbA.insert(discoverySources)
      .values({
        id: "source-shared",
        workspaceId: "workspace-shared",
        type: "rss",
        name: "Shared source",
        configJson: JSON.stringify({
          feedUrl: "https://feeds.example.com/shared.xml",
        }),
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
    const [source] = await listDiscoverySources(dbA, "workspace-shared");

    const attempts = await Promise.allSettled([
      Promise.resolve().then(async () =>
        enqueueDueDiscoveryJobs(
          dbA,
          "workspace-shared",
          [source!],
          10,
        ),
      ),
      Promise.resolve().then(async () =>
        enqueueDueDiscoveryJobs(
          dbB,
          "workspace-shared",
          [source!],
          10,
        ),
      ),
    ]);

    expect(
      attempts.map((attempt) =>
        attempt.status === "fulfilled" ? attempt.value : "rejected",
      ),
    ).toEqual(expect.arrayContaining([0, 1]));
    expect(
      await dbA
        .select()
        .from(discoveryJobs)
        .where(eq(discoveryJobs.sourceId, "source-shared")),
    ).toHaveLength(1);

    const claims = await Promise.allSettled([
      Promise.resolve().then(async () =>
        claimNextDiscoveryJob(dbA, {
          workspaceId: "workspace-shared",
          owner: "api-a:shared-claim",
          leaseMs: 45_000,
        }),
      ),
      Promise.resolve().then(async () =>
        claimNextDiscoveryJob(dbB, {
          workspaceId: "workspace-shared",
          owner: "api-b:shared-claim",
          leaseMs: 45_000,
        }),
      ),
    ]);
    const claimedRows = claims
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof claimNextDiscoveryJob>>
        > => attempt.status === "fulfilled",
      )
      .map((attempt) => attempt.value)
      .filter((claim) => claim !== null);
    expect(claimedRows).toHaveLength(1);
    expect(
      ((await dbA
        .select()
        .from(discoveryJobs)
        .where(eq(discoveryJobs.sourceId, "source-shared")))[0])!.leaseOwner,
    ).toBe(claimedRows[0]!.leaseOwner);
  });

  it("skips a source in backoff until it is due", async () => {
    const source = await addRssSource(1);
    const now = Date.now();
    await db.update(discoverySources)
      .set({ backoffUntil: now + 60_000 })
      .where(eq(discoverySources.id, source.id));
    expect(await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), now)).toBe(0);
    expect(await jobRows()).toHaveLength(0);
    // past the backoff the source is due again
    expect(await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), now + 60_001)).toBe(1);
  });

  it("claims one oldest job at a time and leaves later jobs queued", async () => {
    const first = await addRssSource(1);
    const rest = [];
    for (let n = 2; n <= DISCOVERY_JOB_BATCH_SIZE + 2; n += 1) rest.push(await addRssSource(n));
    const base = Date.now();
    // the first source was enqueued on an earlier run
    await enqueueDueDiscoveryJobs(db, workspaceId, (await sources()).filter((s) => s.id === first.id), base - 1000);
    await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), base);
    expect(await jobRows()).toHaveLength(DISCOVERY_JOB_BATCH_SIZE + 2);

    const claimed = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-1",
      leaseMs: 45_000,
    }))!;
    expect(claimed.sourceId).toBe(first.id);
    expect(claimed.status).toBe("running");
    expect(claimed.attempt).toBe(1);
    expect(claimed.leaseVersion).toBe(1);
    expect(claimed.leaseOwner).toBe("api-a:job-1");
    expect(claimed.leaseExpiresAt).toBeGreaterThan(claimed.lockedAt!);
    expect((await jobRows()).filter((row) => row.status === "queued")).toHaveLength(
      DISCOVERY_JOB_BATCH_SIZE + 1,
    );
  });

  it("rejects a live overlap and reclaims only after database-clock expiry", async () => {
    await addRssSource(1);
    const t0 = Date.now();
    await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), t0);
    const first = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-1",
      leaseMs: 45_000,
    }))!;

    expect(
      await claimNextDiscoveryJob(db, {
        workspaceId,
        owner: "api-b:job-2",
        leaseMs: 45_000,
      }),
    ).toBeNull();
    expect(await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), t0 + 1)).toBe(0);

    await db.update(discoveryJobs)
      .set({
        leaseExpiresAt: sql`${DATABASE_NOW_MS} - 1`,
      })
      .where(eq(discoveryJobs.id, first.id));

    const reclaimed = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-b:job-2",
      leaseMs: 45_000,
    }))!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.leaseOwner).toBe("api-b:job-2");
    expect(reclaimed.leaseVersion).toBe(first.leaseVersion + 1);
    expect(reclaimed.attempt).toBe(2);
    expect(await jobRows()).toHaveLength(1);
  });

  it("increments source execution version and cancels old jobs atomically", async () => {
    const source = await addRssSource(1);
    await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), Date.now());
    const claim = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:old-source-version",
      leaseMs: 45_000,
    }))!;
    expect(claim.sourceExecutionVersion).toBe(1);

    const response = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
      payload: {
        config: { feedUrl: "https://feeds.example.com/changed.xml" },
      },
    });
    expect(response.statusCode).toBe(200);

    const updatedSource = ((await db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id)))[0])!;
    expect(updatedSource.executionVersion).toBe(2);

    const cancelled = ((await db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, claim.id)))[0])!;
    expect(cancelled.status).toBe("skipped");
    expect(cancelled.error).toBe("source_version_changed");
    expect(cancelled.finishedAt).not.toBeNull();
    expect(cancelled.leaseOwner).toBeNull();
    expect(
      await completeDiscoveryJob(db, claim, { fetchedCount: 1, newCount: 1 }),
    ).toBe(false);
  });

  it("does not cancel work or bump execution version for a name-only edit", async () => {
    const source = await addRssSource(1);
    await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), Date.now());
    const claim = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:same-source-version",
      leaseMs: 45_000,
    }))!;

    const response = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
      payload: { name: "Renamed source" },
    });
    expect(response.statusCode).toBe(200);

    const updatedSource = ((await db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id)))[0])!;
    expect(updatedSource.executionVersion).toBe(1);
    expect(
      ((await db
        .select()
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id)))[0])!.status,
    ).toBe("running");
  });

  describe("bounded /discovery/run (Sprint 46)", () => {
    async function runDiscoveryRoute() {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/run`,
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        queued: number;
        processed: number;
        sources: { sourceId: string; error?: string }[];
        scored: number;
      };
    }

    it("processes a bounded batch and continues where it left off next run", async () => {
      const total = DISCOVERY_JOB_BATCH_SIZE + 2;
      for (let n = 1; n <= total; n += 1) await addRssSource(n);

      const first = await runDiscoveryRoute();
      expect(first.queued).toBe(total);
      expect(first.processed).toBe(DISCOVERY_JOB_BATCH_SIZE);
      expect(first.sources).toHaveLength(DISCOVERY_JOB_BATCH_SIZE);
      expect((await jobRows()).filter((r) => r.status === "queued")).toHaveLength(2);
      expect((await jobRows()).filter((r) => r.status === "succeeded")).toHaveLength(
        DISCOVERY_JOB_BATCH_SIZE,
      );

      // Next run re-enqueues the 5 already-processed sources (their jobs
      // finished) and claims the 2 leftovers first — nothing is starved.
      const second = await runDiscoveryRoute();
      expect(second.queued).toBe(DISCOVERY_JOB_BATCH_SIZE);
      expect(second.processed).toBe(DISCOVERY_JOB_BATCH_SIZE);
      const succeededSources = new Set(
        (await jobRows())
          .filter((r) => r.status === "succeeded")
          .map((r) => r.sourceId),
      );
      expect(succeededSources.size).toBe(total); // every source ran at least once
      expect((await jobRows()).filter((r) => r.status === "queued")).toHaveLength(2);
    });

    it("marks the job failed when a keyless fetch fails, without failing the run", async () => {
      await addRssSource(1);
      const bad = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: { type: "rss", config: { feedUrl: "https://failing.example.com/feed.xml" } },
        })
      ).json() as { id: string };

      const result = await runDiscoveryRoute();
      expect(result.queued).toBe(2);
      expect(result.processed).toBe(2);
      const badResult = result.sources.find((s) => s.sourceId === bad.id)!;
      expect(badResult.error).toBe(
        `upstream_status: ${safeFetchPublicMessage("upstream_status")}`,
      );

      const failedJob = (await jobRows()).find((r) => r.sourceId === bad.id)!;
      expect(failedJob.status).toBe("failed");
      expect(failedJob.error).toBe(
        `upstream_status: ${safeFetchPublicMessage("upstream_status")}`,
      );
      const okJob = (await jobRows()).find((r) => r.sourceId !== bad.id)!;
      expect(okJob.status).toBe("succeeded");

      const badSource = (await sources()).find((s) => s.id === bad.id)!;
      expect(badSource.status).toBe("error");
      expect(badSource.lastAttemptedAt).not.toBeNull();
    });
  });

  it("fences heartbeat, completion, and failure by live owner/version", async () => {
    await addRssSource(1);
    await addRssSource(2);
    const t0 = Date.now();
    await enqueueDueDiscoveryJobs(db, workspaceId, await sources(), t0);
    const a = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-a",
      leaseMs: 45_000,
    }))!;
    const b = (await claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-b",
      leaseMs: 45_000,
    }))!;

    expect(await heartbeatDiscoveryJob(db, a, 45_000)).toMatchObject({
      id: a.id,
      leaseOwner: a.leaseOwner,
      leaseVersion: a.leaseVersion,
    });
    expect(
      await completeDiscoveryJob(
        db,
        { ...a, leaseOwner: "stale-owner" },
        { fetchedCount: 10, newCount: 4 },
      ),
    ).toBe(false);
    expect(
      await completeDiscoveryJob(db, a, { fetchedCount: 10, newCount: 4 }),
    ).toBe(true);
    expect(await failDiscoveryJob(db, a, "late stale failure")).toBe(false);
    expect(await failDiscoveryJob(db, b, "x".repeat(600))).toBe(true);

    const done = ((await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, a.id)))[0])!;
    expect(done.status).toBe("succeeded");
    expect(done.fetchedCount).toBe(10);
    expect(done.newCount).toBe(4);
    expect(done.finishedAt).not.toBeNull();
    expect(done.error).toBeNull();

    const failed = ((await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, b.id)))[0])!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toHaveLength(500);
    expect(failed.finishedAt).not.toBeNull();
    expect(discoveryJobSchema.safeParse(failed).success).toBe(true);
  });
});
