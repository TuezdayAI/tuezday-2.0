import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { metrics } from "../src/db/schema";
import { listMetricsForSubject, recordMetric, recordMetrics } from "../src/services/metrics";
import { randomUUID } from "node:crypto";
import { workspaces } from "../src/db/schema";

function seedWorkspace(db: Db): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(workspaces)
    .values({ id, name: "Metrics WS", createdAt: now, updatedAt: now })
    .run();
  return id;
}

describe("recordMetric", () => {
  let db: Db;
  let workspaceId: string;

  beforeEach(() => {
    db = createTestDb();
    workspaceId = seedWorkspace(db);
  });

  const grain = (subjectId: string) =>
    ({
      subjectType: "publication",
      subjectId,
      metricKey: "impressions",
      window: "24h",
      periodStart: 1_754_000_000_000,
      source: "captured",
      capturedAt: 1_754_086_400_000,
    }) as const;

  it("re-recording the same grain updates in place, never duplicates", () => {
    const subjectId = randomUUID();
    recordMetric(db, workspaceId, { ...grain(subjectId), value: 100 });
    recordMetric(db, workspaceId, { ...grain(subjectId), value: 250 });

    const rows = db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(250);
  });

  it("different grains coexist", () => {
    const subjectId = randomUUID();
    recordMetric(db, workspaceId, { ...grain(subjectId), value: 100 });
    recordMetric(db, workspaceId, { ...grain(subjectId), window: "7d", value: 900 });
    recordMetric(db, workspaceId, { ...grain(subjectId), metricKey: "clicks", value: 12 });

    const rows = db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId)).all();
    expect(rows).toHaveLength(3);
  });

  it("a null or undefined value records nothing — absence is not zero", () => {
    const subjectId = randomUUID();
    recordMetric(db, workspaceId, { ...grain(subjectId), value: null });
    recordMetric(db, workspaceId, { ...grain(subjectId), value: undefined });

    const rows = db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId)).all();
    expect(rows).toHaveLength(0);
  });

  it("refuses vocabulary violations", () => {
    const subjectId = randomUUID();
    expect(() =>
      recordMetric(db, workspaceId, { ...grain(subjectId), metricKey: "replies" as never, value: 1 }),
    ).toThrow();
    expect(() =>
      recordMetric(db, workspaceId, { ...grain(subjectId), window: "30d" as never, value: 1 }),
    ).toThrow();
    expect(() =>
      recordMetric(db, workspaceId, { ...grain(subjectId), subjectType: "lane" as never, value: 1 }),
    ).toThrow();
    expect(() =>
      recordMetric(db, workspaceId, { ...grain(subjectId), source: "derived" as never, value: 1 }),
    ).toThrow();
    // Money is integer cents; no floats.
    expect(() =>
      recordMetric(db, workspaceId, { ...grain(subjectId), value: 12.5 }),
    ).toThrow();
  });

  it("recordMetrics skips null values and writes the rest in one call", () => {
    const subjectId = randomUUID();
    const written = recordMetrics(db, workspaceId, [
      { ...grain(subjectId), metricKey: "likes", value: 5 },
      { ...grain(subjectId), metricKey: "comments", value: null },
      { ...grain(subjectId), metricKey: "shares", value: 2 },
    ]);
    expect(written).toBe(2);
    const rows = listMetricsForSubject(db, workspaceId, "publication", subjectId);
    expect(rows.map((r) => r.metricKey).sort()).toEqual(["likes", "shares"]);
  });
});
