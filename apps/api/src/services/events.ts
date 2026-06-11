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

export function createWebhook(
  db: Db,
  workspaceId: string,
  input: CreateWebhookInput,
): WebhookSubscription {
  const row: WebhookSubscriptionRow = {
    id: randomUUID(),
    workspaceId,
    url: input.url,
    secret: input.secret ?? randomUUID(),
    eventTypesJson: JSON.stringify(input.eventTypes),
    enabled: true,
    createdAt: Date.now(),
  };
  db.insert(webhookSubscriptions).values(row).run();
  return rowToSubscription(row);
}

export function listWebhooks(db: Db, workspaceId: string): WebhookSubscription[] {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.workspaceId, workspaceId))
    .orderBy(desc(webhookSubscriptions.createdAt))
    .all()
    .map(rowToSubscription);
}

export function getWebhook(
  db: Db,
  workspaceId: string,
  webhookId: string,
): WebhookSubscription | undefined {
  const row = db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, webhookId))
    .get();
  return row && row.workspaceId === workspaceId ? rowToSubscription(row) : undefined;
}

export function setWebhookEnabled(db: Db, webhookId: string, enabled: boolean): void {
  db.update(webhookSubscriptions)
    .set({ enabled })
    .where(eq(webhookSubscriptions.id, webhookId))
    .run();
}

export function deleteWebhook(db: Db, webhookId: string): void {
  db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, webhookId)).run();
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
  db.insert(events).values(event).run();

  const subscriptions = listWebhooks(db, workspaceId).filter(
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
    db.insert(webhookDeliveries)
      .values({
        id: randomUUID(),
        subscriptionId: subscription.id,
        eventId: event.id,
        status,
        httpStatus,
        error,
        createdAt: Date.now(),
      })
      .run();
  }
  return event;
}

export interface EventWithDeliveries extends TuezdayEvent {
  deliveries: Array<{ subscriptionId: string; status: string; httpStatus: number | null; error: string | null }>;
}

export function listEvents(db: Db, workspaceId: string, limit = 50): EventWithDeliveries[] {
  const eventRows = db
    .select()
    .from(events)
    .where(eq(events.workspaceId, workspaceId))
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .all();
  if (eventRows.length === 0) return [];

  const deliveryRows = db
    .select()
    .from(webhookDeliveries)
    .where(
      inArray(
        webhookDeliveries.eventId,
        eventRows.map((e) => e.id),
      ),
    )
    .all();

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
