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

function deliveryWorkspace(db: Db, deliveryId: string): string | null {
  const row = db
    .select({ workspaceId: emailDeliveries.workspaceId })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.id, deliveryId))
    .get();
  return row?.workspaceId ?? null;
}

export function recordOpen(db: Db, deliveryId: string, nowMs: number): void {
  const workspaceId = deliveryWorkspace(db, deliveryId);
  if (!workspaceId) return;
  db.update(emailDeliveries)
    .set({
      openCount: sql`${emailDeliveries.openCount} + 1`,
      openedAt: sql`COALESCE(${emailDeliveries.openedAt}, ${nowMs})`,
      updatedAt: nowMs,
    })
    .where(eq(emailDeliveries.id, deliveryId))
    .run();
  db.insert(outreachTrackingEvents)
    .values({
      id: randomUUID(),
      workspaceId,
      emailDeliveryId: deliveryId,
      type: "open",
      targetUrl: null,
      occurredAt: nowMs,
      createdAt: nowMs,
    })
    .run();
}

export function recordClick(db: Db, deliveryId: string, url: string, nowMs: number): void {
  const workspaceId = deliveryWorkspace(db, deliveryId);
  if (!workspaceId) return;
  db.update(emailDeliveries)
    .set({
      clickCount: sql`${emailDeliveries.clickCount} + 1`,
      firstClickAt: sql`COALESCE(${emailDeliveries.firstClickAt}, ${nowMs})`,
      updatedAt: nowMs,
    })
    .where(eq(emailDeliveries.id, deliveryId))
    .run();
  db.insert(outreachTrackingEvents)
    .values({
      id: randomUUID(),
      workspaceId,
      emailDeliveryId: deliveryId,
      type: "click",
      targetUrl: url,
      occurredAt: nowMs,
      createdAt: nowMs,
    })
    .run();
}
