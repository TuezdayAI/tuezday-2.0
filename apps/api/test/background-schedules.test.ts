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
  admitDueBackgroundSchedules,
  reconcileBackgroundSchedules,
} from "../src/services/background-schedules";
import { createTestDb } from "./helpers";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("persisted background schedules", () => {
  let db: Db;
  const t0 = 1_800_000_000_000;

  beforeEach(() => {
    db = createTestDb();
    db.insert(workspaces)
      .values({
        id: WORKSPACE_ID,
        name: "Scheduled",
        createdAt: t0,
        updatedAt: t0,
      })
      .run();
  });

  it("creates every recurring schedule once and updates intervals in place", () => {
    expect(
      reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0),
    ).toBe(BACKGROUND_RECURRING_JOB_KINDS.length);
    expect(
      reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0 + 1),
    ).toBe(0);

    const rows = db.select().from(backgroundSchedules).all();
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
    expect(reconcileBackgroundSchedules(db, changed, t0 + 2)).toBe(0);
    expect(
      db
        .select()
        .from(backgroundSchedules)
        .where(eq(backgroundSchedules.kind, "evidence"))
        .get(),
    ).toMatchObject({ intervalMs: 45 * 60_000, nextRunAt: t0 });
  });

  it("atomically admits each due occurrence once with validated payloads", () => {
    reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);

    expect(
      admitDueBackgroundSchedules(
        db,
        t0,
        DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts,
      ),
    ).toEqual({ admitted: BACKGROUND_RECURRING_JOB_KINDS.length, scanned: 13 });
    expect(
      admitDueBackgroundSchedules(
        db,
        t0,
        DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts,
      ),
    ).toEqual({ admitted: 0, scanned: 0 });

    const jobs = db.select().from(backgroundJobs).all();
    expect(jobs).toHaveLength(BACKGROUND_RECURRING_JOB_KINDS.length);
    for (const job of jobs) {
      expect(backgroundJobPayloadSchema.parse(JSON.parse(job.payloadJson))).toEqual({
        kind: job.kind,
        workspaceId: WORKSPACE_ID,
      });
      expect(job.idempotencyKey).toMatch(/^schedule:.+:1800000000000$/);
    }
  });

  it("admits one overdue occurrence and advances beyond now without a catch-up storm", () => {
    reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);
    const evidence = db
      .select()
      .from(backgroundSchedules)
      .where(eq(backgroundSchedules.kind, "evidence"))
      .get()!;
    db.delete(backgroundSchedules)
      .where(eq(backgroundSchedules.id, evidence.id))
      .run();
    db.update(backgroundSchedules)
      .set({ enabled: false })
      .where(eq(backgroundSchedules.workspaceId, WORKSPACE_ID))
      .run();
    db.insert(backgroundSchedules).values(evidence).run();

    const now = t0 + evidence.intervalMs * 4 + 123;
    expect(
      admitDueBackgroundSchedules(db, now, DEFAULT_BACKGROUND_JOB_POLICY.maxAttempts),
    ).toEqual({ admitted: 1, scanned: 1 });
    const advanced = db
      .select()
      .from(backgroundSchedules)
      .where(eq(backgroundSchedules.id, evidence.id))
      .get()!;
    expect(advanced.nextRunAt).toBe(t0 + evidence.intervalMs * 5);
    expect(advanced.nextRunAt).toBeGreaterThan(now);
  });

  it("cascades schedules when a workspace is deleted", () => {
    reconcileBackgroundSchedules(db, DEFAULT_BACKGROUND_JOB_POLICY, t0);
    db.delete(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).run();
    expect(db.select().from(backgroundSchedules).all()).toEqual([]);
  });
});
