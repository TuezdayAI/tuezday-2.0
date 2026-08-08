import { createHmac, randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import type {
  CreateWebhookInput,
  EventType,
  TuezdayEvent,
  WebhookSubscription,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  events,
  webhookDeliveries,
  webhookSubscriptions,
  type WebhookSubscriptionRow,
} from "../db/schema";

type Fetcher = typeof fetch;

function rowToSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  return { ...row, eventTypes: JSON.parse(row.eventTypesJson) as EventType[] };
}

export async function createWebhook(
  db: Db,
  workspaceId: string,
  input: CreateWebhookInput,
): Promise<WebhookSubscription> {
  const row: WebhookSubscriptionRow = {
    id: randomUUID(),
    workspaceId,
    url: input.url,
    secret: input.secret ?? randomUUID(),
    eventTypesJson: JSON.stringify(input.eventTypes),
    enabled: true,
    createdAt: Date.now(),
  };
  await db.insert(webhookSubscriptions).values(row);
  return rowToSubscription(row);
}

export async function listWebhooks(db: Db, workspaceId: string): Promise<WebhookSubscription[]> {
  return (await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.workspaceId, workspaceId))
    .orderBy(desc(webhookSubscriptions.createdAt)))
    .map(rowToSubscription);
}

export async function getWebhook(
  db: Db,
  workspaceId: string,
  webhookId: string,
): Promise<WebhookSubscription | undefined> {
  const row = (await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, webhookId)))[0];
  return row && row.workspaceId === workspaceId ? rowToSubscription(row) : undefined;
}

export async function setWebhookEnabled(db: Db, webhookId: string, enabled: boolean): Promise<void> {
  await db.update(webhookSubscriptions)
    .set({ enabled })
    .where(eq(webhookSubscriptions.id, webhookId));
}

export async function deleteWebhook(db: Db, webhookId: string): Promise<void> {
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, webhookId));
}

/**
 * Emit a domain event: append to the event log and deliver to every enabled
 * subscription that wants this type, with an HMAC-SHA256 signature. Never
 * throws — a dead webhook endpoint must not break an approval.
 */
export async function emitEvent(
  db: Db,
  fetcher: Fetcher,
  workspaceId: string,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<TuezdayEvent> {
  const event = {
    id: randomUUID(),
    workspaceId,
    type,
    payloadJson: JSON.stringify(payload),
    createdAt: Date.now(),
  };
  await db.insert(events).values(event);

  const subscriptions = (await listWebhooks(db, workspaceId)).filter(
    (s) =>
      s.enabled &&
      (s.eventTypes.includes(type) ||
        // A ping always reaches the webhook it targets, whatever its filters.
        (type === "webhook.ping" && payload.webhookId === s.id)),
  );
  for (const subscription of subscriptions) {
    const body = JSON.stringify({
      id: event.id,
      type,
      workspaceId,
      payload,
      createdAt: event.createdAt,
    });
    const signature = createHmac("sha256", subscription.secret).update(body).digest("hex");
    let status: "delivered" | "failed" = "failed";
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetcher(subscription.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tuezday-Signature": `sha256=${signature}`,
          "X-Tuezday-Event": type,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      httpStatus = res.status;
      status = res.ok ? "delivered" : "failed";
      if (!res.ok) error = `Endpoint returned ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
    await db.insert(webhookDeliveries)
      .values({
        id: randomUUID(),
        subscriptionId: subscription.id,
        eventId: event.id,
        status,
        httpStatus,
        error,
        createdAt: Date.now(),
      });
  }
  return event;
}

export interface EventWithDeliveries extends TuezdayEvent {
  deliveries: Array<{ subscriptionId: string; status: string; httpStatus: number | null; error: string | null }>;
}

export async function listEvents(db: Db, workspaceId: string, limit = 50): Promise<EventWithDeliveries[]> {
  const eventRows = await db
    .select()
    .from(events)
    .where(eq(events.workspaceId, workspaceId))
    .orderBy(desc(events.createdAt))
    .limit(limit);
  if (eventRows.length === 0) return [];

  const deliveryRows = await db
    .select()
    .from(webhookDeliveries)
    .where(
      inArray(
        webhookDeliveries.eventId,
        eventRows.map((e) => e.id),
      ),
    );

  return eventRows.map((e) => ({
    ...e,
    type: e.type as EventType,
    deliveries: deliveryRows
      .filter((d) => d.eventId === e.id)
      .map((d) => ({
        subscriptionId: d.subscriptionId,
        status: d.status,
        httpStatus: d.httpStatus,
        error: d.error,
      })),
  }));
}
