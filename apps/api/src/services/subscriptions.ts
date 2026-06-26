import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { subscriptions, type SubscriptionRow } from "../db/schema";
import { randomUUID } from "node:crypto";

export function getSubscription(db: Db, workspaceId: string): SubscriptionRow | undefined {
  return db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)).get();
}

export function upsertFromStripe(
  db: Db,
  workspaceId: string,
  data: { plan: string; status: string; stripeCustomerId?: string; stripeSubscriptionId?: string; currentPeriodEnd?: number }
): SubscriptionRow {
  const existing = getSubscription(db, workspaceId);
  const now = Date.now();

  if (existing) {
    return db
      .update(subscriptions)
      .set({
        plan: data.plan,
        status: data.status,
        stripeCustomerId: data.stripeCustomerId ?? existing.stripeCustomerId,
        stripeSubscriptionId: data.stripeSubscriptionId ?? existing.stripeSubscriptionId,
        currentPeriodEnd: data.currentPeriodEnd ?? existing.currentPeriodEnd,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(subscriptions)
    .values({
      id: randomUUID(),
      workspaceId,
      plan: data.plan,
      status: data.status,
      stripeCustomerId: data.stripeCustomerId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      currentPeriodEnd: data.currentPeriodEnd,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}
