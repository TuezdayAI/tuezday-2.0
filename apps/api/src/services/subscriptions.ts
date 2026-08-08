import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { subscriptions, type SubscriptionRow } from "../db/schema";
import { randomUUID } from "node:crypto";

export async function getSubscription(db: Db, workspaceId: string): Promise<SubscriptionRow | undefined> {
  return (await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)))[0];
}

export async function upsertFromStripe(
  db: Db,
  workspaceId: string,
  data: { plan: string; status: string; stripeCustomerId?: string; stripeSubscriptionId?: string; currentPeriodEnd?: number }
): Promise<SubscriptionRow> {
  const existing = await getSubscription(db, workspaceId);
  const now = Date.now();

  if (existing) {
    return (await db
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
      .returning())[0]!;
  }

  return (await db
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
    .returning())[0]!;
}
