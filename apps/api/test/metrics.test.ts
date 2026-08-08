import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers";
import type { Db } from "../src/db";
import { metrics } from "../src/db/schema";
import { listMetricsForSubject, recordMetric, recordMetrics } from "../src/services/metrics";
import { randomUUID } from "node:crypto";
import { workspaces } from "../src/db/schema";

async function seedWorkspace(db: Db): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(workspaces)
    .values({ id, name: "Metrics WS", createdAt: now, updatedAt: now });
  return id;
}

describe("recordMetric", () => {
  let db: Db;
  let workspaceId: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspaceId = await seedWorkspace(db);
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

  it("re-recording the same grain updates in place, never duplicates", async () => {
    const subjectId = randomUUID();
    await recordMetric(db, workspaceId, { ...grain(subjectId), value: 100 });
    await recordMetric(db, workspaceId, { ...grain(subjectId), value: 250 });

    const rows = await db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(250);
  });

  it("different grains coexist", async () => {
    const subjectId = randomUUID();
    await recordMetric(db, workspaceId, { ...grain(subjectId), value: 100 });
    await recordMetric(db, workspaceId, { ...grain(subjectId), window: "7d", value: 900 });
    await recordMetric(db, workspaceId, { ...grain(subjectId), metricKey: "clicks", value: 12 });

    const rows = await db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId));
    expect(rows).toHaveLength(3);
  });

  it("a null or undefined value records nothing — absence is not zero", async () => {
    const subjectId = randomUUID();
    await recordMetric(db, workspaceId, { ...grain(subjectId), value: null });
    await recordMetric(db, workspaceId, { ...grain(subjectId), value: undefined });

    const rows = await db.select().from(metrics).where(eq(metrics.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("refuses vocabulary violations", async () => {
    const subjectId = randomUUID();
    await expect((async () =>
      await recordMetric(db, workspaceId, { ...grain(subjectId), metricKey: "replies" as never, value: 1 }))(),
    ).rejects.toThrow();
    await expect((async () =>
      await recordMetric(db, workspaceId, { ...grain(subjectId), window: "30d" as never, value: 1 }))(),
    ).rejects.toThrow();
    await expect((async () =>
      await recordMetric(db, workspaceId, { ...grain(subjectId), subjectType: "lane" as never, value: 1 }))(),
    ).rejects.toThrow();
    await expect((async () =>
      await recordMetric(db, workspaceId, { ...grain(subjectId), source: "derived" as never, value: 1 }))(),
    ).rejects.toThrow();
    // Money is integer cents; no floats.
    await expect((async () =>
      await recordMetric(db, workspaceId, { ...grain(subjectId), value: 12.5 }))(),
    ).rejects.toThrow();
  });

  it("recordMetrics skips null values and writes the rest in one call", async () => {
    const subjectId = randomUUID();
    const written = await recordMetrics(db, workspaceId, [
      { ...grain(subjectId), metricKey: "likes", value: 5 },
      { ...grain(subjectId), metricKey: "comments", value: null },
      { ...grain(subjectId), metricKey: "shares", value: 2 },
    ]);
    expect(written).toBe(2);
    const rows = await listMetricsForSubject(db, workspaceId, "publication", subjectId);
    expect(rows.map((r) => r.metricKey).sort()).toEqual(["likes", "shares"]);
  });
});
