import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { emailDeliveries, outreachTrackingEvents } from "../db/schema";

/**
 * Record open/click engagement on a sent outreach email (Sprint 50). Each hit
 * bumps a denormalized counter on `email_deliveries` and appends an append-only
 * detail row to `outreach_tracking_events`. No-op if the delivery is missing
 * (a tampered-but-well-signed token, or a deleted delivery) — a tracking hit
 * must never create rows out of thin air.
 */

async function deliveryWorkspace(db: Db, deliveryId: string): Promise<string | null> {
  const row = (await db
    .select({ workspaceId: emailDeliveries.workspaceId })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.id, deliveryId)))[0];
  return row?.workspaceId ?? null;
}

export async function recordOpen(db: Db, deliveryId: string, nowMs: number): Promise<void> {
  const workspaceId = await deliveryWorkspace(db, deliveryId);
  if (!workspaceId) return;
  await db.update(emailDeliveries)
    .set({
      openCount: sql`${emailDeliveries.openCount} + 1`,
      openedAt: sql`COALESCE(${emailDeliveries.openedAt}, ${nowMs})`,
      updatedAt: nowMs,
    })
    .where(eq(emailDeliveries.id, deliveryId));
  await db.insert(outreachTrackingEvents)
    .values({
      id: randomUUID(),
      workspaceId,
      emailDeliveryId: deliveryId,
      type: "open",
      targetUrl: null,
      occurredAt: nowMs,
      createdAt: nowMs,
    });
}

export async function recordClick(db: Db, deliveryId: string, url: string, nowMs: number): Promise<void> {
  const workspaceId = await deliveryWorkspace(db, deliveryId);
  if (!workspaceId) return;
  await db.update(emailDeliveries)
    .set({
      clickCount: sql`${emailDeliveries.clickCount} + 1`,
      firstClickAt: sql`COALESCE(${emailDeliveries.firstClickAt}, ${nowMs})`,
      updatedAt: nowMs,
    })
    .where(eq(emailDeliveries.id, deliveryId));
  await db.insert(outreachTrackingEvents)
    .values({
      id: randomUUID(),
      workspaceId,
      emailDeliveryId: deliveryId,
      type: "click",
      targetUrl: url,
      occurredAt: nowMs,
      createdAt: nowMs,
    });
}
