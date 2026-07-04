import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { discoveryJobSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import { discoveryJobs, discoverySources } from "../src/db/schema";
import type { Fetcher } from "../src/discovery/adapters";
import type { LlmGateway } from "../src/llm/gateway";
import {
  DISCOVERY_JOB_BATCH_SIZE,
  DISCOVERY_JOB_LOCK_TIMEOUT_MS,
  claimDiscoveryJobs,
  completeDiscoveryJob,
  enqueueDueDiscoveryJobs,
  failDiscoveryJob,
  releaseStaleDiscoveryJobs,
} from "../src/services/discovery-jobs";
import { listDiscoverySources } from "../src/services/discovery";
import { buildAuthedApp, createTestDb } from "./helpers";

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

const stubFetcher = (async () =>
  new Response("<rss version=\"2.0\"><channel><title>t</title></channel></rss>", {
    status: 200,
  })) as Fetcher;

describe("discovery job ledger (Sprint 46)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: stubLlm, fetcher: stubFetcher });
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
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), now)).toBe(2);
    // second enqueue is a no-op while the jobs are still queued
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), now + 1)).toBe(0);
    const rows = jobRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(discoveryJobSchema.safeParse(row).success).toBe(true);
      expect(row.status).toBe("queued");
      expect(row.attempt).toBe(0);
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

  it("claims oldest-first up to the limit and marks them running", async () => {
    const first = await addRssSource(1);
    const rest = [];
    for (let n = 2; n <= DISCOVERY_JOB_BATCH_SIZE + 2; n += 1) rest.push(await addRssSource(n));
    const base = Date.now();
    // the first source was enqueued on an earlier run
    enqueueDueDiscoveryJobs(db, workspaceId, sources().filter((s) => s.id === first.id), base - 1000);
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), base);
    expect(jobRows()).toHaveLength(DISCOVERY_JOB_BATCH_SIZE + 2);

    const claimed = claimDiscoveryJobs(db, workspaceId, DISCOVERY_JOB_BATCH_SIZE, base + 10);
    expect(claimed).toHaveLength(DISCOVERY_JOB_BATCH_SIZE);
    expect(claimed[0]!.sourceId).toBe(first.id); // oldest job claimed first
    for (const job of claimed) {
      expect(job.status).toBe("running");
      expect(job.attempt).toBe(1);
      expect(job.lockedAt).toBe(base + 10);
      expect(job.startedAt).toBe(base + 10);
    }
    const stillQueued = jobRows().filter((r) => r.status === "queued");
    expect(stillQueued).toHaveLength(2);
  });

  it("releases only stale running jobs and frees their sources", async () => {
    const source = await addRssSource(1);
    const t0 = Date.now();
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0);
    const [job] = claimDiscoveryJobs(db, workspaceId, 1, t0);

    // within the lock window nothing is released
    expect(releaseStaleDiscoveryJobs(db, t0 + DISCOVERY_JOB_LOCK_TIMEOUT_MS - 1)).toBe(0);
    // and the source cannot be double-enqueued while its job runs
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0 + 1)).toBe(0);

    const later = t0 + DISCOVERY_JOB_LOCK_TIMEOUT_MS + 1;
    expect(releaseStaleDiscoveryJobs(db, later)).toBe(1);
    const released = db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, job!.id))
      .get()!;
    expect(released.status).toBe("failed");
    expect(released.error).toBe("stale_lock");
    expect(released.finishedAt).toBe(later);

    // the source is eligible again
    expect(enqueueDueDiscoveryJobs(db, workspaceId, sources(), later)).toBe(1);
    const fresh = db
      .select()
      .from(discoveryJobs)
      .where(
        and(eq(discoveryJobs.sourceId, source.id), eq(discoveryJobs.status, "queued")),
      )
      .all();
    expect(fresh).toHaveLength(1);
  });

  it("records success counts and truncated failure errors", async () => {
    await addRssSource(1);
    await addRssSource(2);
    const t0 = Date.now();
    enqueueDueDiscoveryJobs(db, workspaceId, sources(), t0);
    const [a, b] = claimDiscoveryJobs(db, workspaceId, 2, t0);

    completeDiscoveryJob(db, a!.id, { fetchedCount: 10, newCount: 4 }, t0 + 5);
    failDiscoveryJob(db, b!.id, "x".repeat(600), t0 + 6);

    const done = db.select().from(discoveryJobs).where(eq(discoveryJobs.id, a!.id)).get()!;
    expect(done.status).toBe("succeeded");
    expect(done.fetchedCount).toBe(10);
    expect(done.newCount).toBe(4);
    expect(done.finishedAt).toBe(t0 + 5);
    expect(done.error).toBeNull();

    const failed = db.select().from(discoveryJobs).where(eq(discoveryJobs.id, b!.id)).get()!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toHaveLength(500);
    expect(failed.finishedAt).toBe(t0 + 6);
    expect(discoveryJobSchema.safeParse(failed).success).toBe(true);
  });
});
