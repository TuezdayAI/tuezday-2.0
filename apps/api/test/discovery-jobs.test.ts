import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { discoveryJobSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { createDb, type Db } from "../src/db";
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
import { buildAuthedApp, createTestDb } from "./helpers";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";

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
    db = createTestDb();
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

  function sources() {
    return listDiscoverySources(db, workspaceId);
  }

  function jobRows() {
    return db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.workspaceId, workspaceId))
      .all();
  }

  it("enqueues one queued job per due source, never a duplicate", async () => {
    const now = Date.now();
    await addRssSource(1);
    await addRssSource(2);
    const sourceSnapshot = sources();
    const selectSpy = vi.spyOn(db, "select");
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sourceSnapshot, now)).toBe(2);
    expect(selectSpy).not.toHaveBeenCalled();
    // second enqueue is a no-op while the jobs are still queued
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sourceSnapshot, now + 1)).toBe(0);
    const rows = jobRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(discoveryJobSchema.safeParse(row).success).toBe(true);
      expect(row.status).toBe("queued");
      expect(row.attempt).toBe(0);
    }
  });

  it("converges concurrent enqueue attempts through the database unique index", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "tuezday-s49-enqueue-"));
    const databaseFile = path.join(tempDir, "shared.sqlite");
    const dbA = createDb(databaseFile);
    const dbB = createDb(databaseFile);
    try {
      dbA.insert(workspaces)
        .values({
          id: "workspace-shared",
          name: "Shared",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      dbA.insert(discoverySources)
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
        })
        .run();
      const [source] = listDiscoverySources(dbA, "workspace-shared");

      const attempts = await Promise.allSettled([
        Promise.resolve().then(() =>
          enqueueDueDiscoveryJobs(
            dbA,
            "workspace-shared",
            [source!],
            10,
          ),
        ),
        Promise.resolve().then(() =>
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
        dbA
          .select()
          .from(discoveryJobs)
          .where(eq(discoveryJobs.sourceId, "source-shared"))
          .all(),
      ).toHaveLength(1);

      const claims = await Promise.allSettled([
        Promise.resolve().then(() =>
          claimNextDiscoveryJob(dbA, {
            workspaceId: "workspace-shared",
            owner: "api-a:shared-claim",
            leaseMs: 45_000,
          }),
        ),
        Promise.resolve().then(() =>
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
            ReturnType<typeof claimNextDiscoveryJob>
          > => attempt.status === "fulfilled",
        )
        .map((attempt) => attempt.value)
        .filter((claim) => claim !== null);
      expect(claimedRows).toHaveLength(1);
      expect(
        dbA
          .select()
          .from(discoveryJobs)
          .where(eq(discoveryJobs.sourceId, "source-shared"))
          .get()!.leaseOwner,
      ).toBe(claimedRows[0]!.leaseOwner);
    } finally {
      (dbA as Db & { $client: { close(): void } }).$client.close();
      (dbB as Db & { $client: { close(): void } }).$client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips a source in backoff until it is due", async () => {
    const source = await addRssSource(1);
    const now = Date.now();
    db.update(discoverySources)
      .set({ backoffUntil: now + 60_000 })
      .where(eq(discoverySources.id, source.id))
      .run();
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), now)).toBe(0);
    expect(jobRows()).toHaveLength(0);
    // past the backoff the source is due again
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), now + 60_001)).toBe(1);
  });

  it("claims one oldest job at a time and leaves later jobs queued", async () => {
    const first = await addRssSource(1);
    const rest = [];
    for (let n = 2; n <= DISCOVERY_JOB_BATCH_SIZE + 2; n += 1) rest.push(await addRssSource(n));
    const base = Date.now();
    // the first source was enqueued on an earlier run
    enqueueDueDiscoveryJobs(db, workspaceId, sources().filter((s) => s.id === first.id), base - 1000);
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), base);
    expect(jobRows()).toHaveLength(DISCOVERY_JOB_BATCH_SIZE + 2);

    const claimed = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-1",
      leaseMs: 45_000,
    })!;
    expect(claimed.sourceId).toBe(first.id);
    expect(claimed.status).toBe("running");
    expect(claimed.attempt).toBe(1);
    expect(claimed.leaseVersion).toBe(1);
    expect(claimed.leaseOwner).toBe("api-a:job-1");
    expect(claimed.leaseExpiresAt).toBeGreaterThan(claimed.lockedAt!);
    expect(jobRows().filter((row) => row.status === "queued")).toHaveLength(
      DISCOVERY_JOB_BATCH_SIZE + 1,
    );
  });

  it("rejects a live overlap and reclaims only after database-clock expiry", async () => {
    await addRssSource(1);
    const t0 = Date.now();
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0);
    const first = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-1",
      leaseMs: 45_000,
    })!;

    expect(
      claimNextDiscoveryJob(db, {
        workspaceId,
        owner: "api-b:job-2",
        leaseMs: 45_000,
      }),
    ).toBeNull();
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0 + 1)).toBe(0);

    db.update(discoveryJobs)
      .set({
        leaseExpiresAt: sql`
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 1
        `,
      })
      .where(eq(discoveryJobs.id, first.id))
      .run();

    const reclaimed = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-b:job-2",
      leaseMs: 45_000,
    })!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.leaseOwner).toBe("api-b:job-2");
    expect(reclaimed.leaseVersion).toBe(first.leaseVersion + 1);
    expect(reclaimed.attempt).toBe(2);
    expect(jobRows()).toHaveLength(1);
  });

  it("increments source execution version and cancels old jobs atomically", async () => {
    const source = await addRssSource(1);
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), Date.now());
    const claim = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:old-source-version",
      leaseMs: 45_000,
    })!;
    expect(claim.sourceExecutionVersion).toBe(1);

    const response = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
      payload: {
        config: { feedUrl: "https://feeds.example.com/changed.xml" },
      },
    });
    expect(response.statusCode).toBe(200);

    const updatedSource = db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id))
      .get()!;
    expect(updatedSource.executionVersion).toBe(2);

    const cancelled = db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, claim.id))
      .get()!;
    expect(cancelled.status).toBe("skipped");
    expect(cancelled.error).toBe("source_version_changed");
    expect(cancelled.finishedAt).not.toBeNull();
    expect(cancelled.leaseOwner).toBeNull();
    expect(
      completeDiscoveryJob(db, claim, { fetchedCount: 1, newCount: 1 }),
    ).toBe(false);
  });

  it("does not cancel work or bump execution version for a name-only edit", async () => {
    const source = await addRssSource(1);
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), Date.now());
    const claim = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:same-source-version",
      leaseMs: 45_000,
    })!;

    const response = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
      payload: { name: "Renamed source" },
    });
    expect(response.statusCode).toBe(200);

    const updatedSource = db
      .select()
      .from(discoverySources)
      .where(eq(discoverySources.id, source.id))
      .get()!;
    expect(updatedSource.executionVersion).toBe(1);
    expect(
      db
        .select()
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, claim.id))
        .get()!.status,
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
      expect(jobRows().filter((r) => r.status === "queued")).toHaveLength(2);
      expect(jobRows().filter((r) => r.status === "succeeded")).toHaveLength(
        DISCOVERY_JOB_BATCH_SIZE,
      );

      // Next run re-enqueues the 5 already-processed sources (their jobs
      // finished) and claims the 2 leftovers first — nothing is starved.
      const second = await runDiscoveryRoute();
      expect(second.queued).toBe(DISCOVERY_JOB_BATCH_SIZE);
      expect(second.processed).toBe(DISCOVERY_JOB_BATCH_SIZE);
      const succeededSources = new Set(
        jobRows()
          .filter((r) => r.status === "succeeded")
          .map((r) => r.sourceId),
      );
      expect(succeededSources.size).toBe(total); // every source ran at least once
      expect(jobRows().filter((r) => r.status === "queued")).toHaveLength(2);
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

      const failedJob = jobRows().find((r) => r.sourceId === bad.id)!;
      expect(failedJob.status).toBe("failed");
      expect(failedJob.error).toBe(
        `upstream_status: ${safeFetchPublicMessage("upstream_status")}`,
      );
      const okJob = jobRows().find((r) => r.sourceId !== bad.id)!;
      expect(okJob.status).toBe("succeeded");

      const badSource = sources().find((s) => s.id === bad.id)!;
      expect(badSource.status).toBe("error");
      expect(badSource.lastAttemptedAt).not.toBeNull();
    });
  });

  it("fences heartbeat, completion, and failure by live owner/version", async () => {
    await addRssSource(1);
    await addRssSource(2);
    const t0 = Date.now();
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0);
    const a = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-a",
      leaseMs: 45_000,
    })!;
    const b = claimNextDiscoveryJob(db, {
      workspaceId,
      owner: "api-a:job-b",
      leaseMs: 45_000,
    })!;

    expect(heartbeatDiscoveryJob(db, a, 45_000)).toMatchObject({
      id: a.id,
      leaseOwner: a.leaseOwner,
      leaseVersion: a.leaseVersion,
    });
    expect(
      completeDiscoveryJob(
        db,
        { ...a, leaseOwner: "stale-owner" },
        { fetchedCount: 10, newCount: 4 },
      ),
    ).toBe(false);
    expect(
      completeDiscoveryJob(db, a, { fetchedCount: 10, newCount: 4 }),
    ).toBe(true);
    expect(failDiscoveryJob(db, a, "late stale failure")).toBe(false);
    expect(failDiscoveryJob(db, b, "x".repeat(600))).toBe(true);

    const done = db.select().from(discoveryJobs).where(eq(discoveryJobs.id, a.id)).get()!;
    expect(done.status).toBe("succeeded");
    expect(done.fetchedCount).toBe(10);
    expect(done.newCount).toBe(4);
    expect(done.finishedAt).not.toBeNull();
    expect(done.error).toBeNull();

    const failed = db.select().from(discoveryJobs).where(eq(discoveryJobs.id, b.id)).get()!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toHaveLength(500);
    expect(failed.finishedAt).not.toBeNull();
    expect(discoveryJobSchema.safeParse(failed).success).toBe(true);
  });
});
