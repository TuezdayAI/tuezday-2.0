import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKGROUND_RECURRING_JOB_KINDS,
  backgroundJobPayloadSchema,
} from "@tuezday/contracts";
import type { Db } from "../src/db";
import {
  backgroundJobs,
  backgroundSchedules,
  workspaces,
} from "../src/db/schema";
import { DEFAULT_BACKGROUND_JOB_POLICY } from "../src/runtime/background-job-policy";
import {
  claimBackgroundJobs,
  enqueueBackgroundJob,
} from "../src/services/background-jobs";
import {
  admitDueBackgroundSchedules,
  reconcileBackgroundSchedules,
} from "../src/services/background-schedules";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("persisted background schedules", () => {
  let db: Db;
  const t0 = 1_800_000_000_000;

  beforeEach(async () => {
    db = createTestDb();
    await db.insert(workspaces)
      .values({
        id: WORKSPACE_ID,
        name: "Scheduled",
        createdAt: t0,
        updatedAt: t0,
      })
      .run();
  });

  it("creates every recurring schedule once and updates intervals in place", async () => {
    expect(
      await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0),
    ).toBe(BACKGROUND_RECURRING_JOB_KINDS.length);
    expect(
      await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0 + 1),
    ).toBe(0);

    const rows = await db.select().from(backgroundSchedules).all();
    expect(rows).toHaveLength(BACKGROUND_RECURRING_JOB_KINDS.length);
    expect(new Set(rows.map((row) => row.kind))).toEqual(
      new Set(BACKGROUND_RECURRING_JOB_KINDS),
    );
    expect(rows.every((row) => row.nextRunAt === t0)).toBe(true);

    const changed = {
      ...DEFAULT_BACKGROUND_JOB_POLICY,
      intervals: {
        ...DEFAULT_BACKGROUND_JOB_POLICY.intervals,
        evidence: 45 * 60_000,
      },
    };
    expect(await reconcileBackgroundSchedules(db, changed, t0 + 2)).toBe(0);
    expect(
      await db
        .select()
        .from(backgroundSchedules)
        .where(eq(backgroundSchedules.kind, "evidence"))
        .get(),
    ).toMatchObject({ intervalMs: 45 * 60_000, nextRunAt: t0 });
  });

  it("atomically admits each due occurrence once with validated payloads", async () => {
    await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);

    expect(
      await admitDueBackgroundSchedules(
        db,
        t0,
        DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts,
      ),
    ).toEqual({ admitted: BACKGROUND_RECURRING_JOB_KINDS.length, scanned: 13 });
    expect(
      await admitDueBackgroundSchedules(
        db,
        t0,
        DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts,
      ),
    ).toEqual({ admitted: 0, scanned: 0 });

    const jobs = await db.select().from(backgroundJobs).all();
    expect(jobs).toHaveLength(BACKGROUND_RECURRING_JOB_KINDS.length);
    for (const job of jobs) {
      expect(backgroundJobPayloadSchema.parse(JSON.parse(job.payloadJson))).toEqual({
        kind: job.kind,
        workspaceId: WORKSPACE_ID,
      });
      expect(job.idempotencyKey).toMatch(/^schedule:.+:1800000000000$/);
    }
  });

  it("admits one overdue occurrence and advances beyond now without a catch-up storm", async () => {
    await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);
    const evidence = (await db
      .select()
      .from(backgroundSchedules)
      .where(eq(backgroundSchedules.kind, "evidence"))
      .get())!;
    await db.delete(backgroundSchedules)
      .where(eq(backgroundSchedules.id, evidence.id))
      .run();
    await db.update(backgroundSchedules)
      .set({ enabled: false })
      .where(eq(backgroundSchedules.workspaceId, WORKSPACE_ID))
      .run();
    await db.insert(backgroundSchedules).values(evidence).run();

    const now = t0 + evidence.intervalMs * 4 + 123;
    expect(
      await admitDueBackgroundSchedules(db, now, DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts),
    ).toEqual({ admitted: 1, scanned: 1 });
    const advanced = (await db
      .select()
      .from(backgroundSchedules)
      .where(eq(backgroundSchedules.id, evidence.id))
      .get())!;
    expect(advanced.nextRunAt).toBe(t0 + evidence.intervalMs * 5);
    expect(advanced.nextRunAt).toBeGreaterThan(now);
  });

  it("claims prioritised work ahead of scans admitted in the same millisecond", async () => {
    // Timestamps have millisecond resolution, so a job enqueued just before a
    // tick admits the recurring scans leaves every row equally "old". The last
    // tiebreaker is a random uuid, so priority is the only thing that can keep
    // interactive work in front of the scans.
    const launch = await enqueueBackgroundJob(db, {
      payload: {
        kind: "launch_generate",
        workspaceId: WORKSPACE_ID,
        launchId: "44444444-4444-4444-8444-444444444444",
        input: {},
        actor: { userId: "55555555-5555-4555-8555-555555555555", label: "founder", human: true },
      },
      idempotencyKey: "launch-generate:v1:priority",
      priority: 1,
    });
    await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);
    await admitDueBackgroundSchedules(db, t0);
    // Collapse every admission onto one already-elapsed instant so that only
    // priority can decide which job is claimed.
    const collapsed = 1_700_000_000_000;
    await db.update(backgroundJobs)
      .set({ availableAt: collapsed, createdAt: collapsed })
      .run();

    const [claim] = await claimBackgroundJobs(db, {
      owner: "worker-a",
      leaseMs: 30_000,
      limit: 1,
      perWorkspaceLimit: 1,
    });
    expect(claim?.id).toBe(launch.id);
    expect(claim?.kind).toBe("launch_generate");
  });

  it("cascades schedules when a workspace is deleted", async () => {
    await reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);
    await db.delete(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).run();
    expect(await db.select().from(backgroundSchedules).all()).toEqual([]);
  });
});
