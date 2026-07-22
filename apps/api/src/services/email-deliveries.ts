import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canTransitionEmailDelivery, type EmailDeliveryStatus } from "@tuezday/contracts";
import type { Db } from "../db";
import { emailDeliveries, emailDeliveryEvents, emailSuppressions } from "../db/schema";

export interface VerifiedEmailEvent {
  providerEventId: string;
  eventType: string;
  providerMessageId: string;
  occurredAt: number;
  payload: Record<string, unknown>;
}

export interface RecordedEmailEvent {
  duplicate: boolean;
  deliveryFound: boolean;
}

const EVENT_STATUS: Record<string, EmailDeliveryStatus | undefined> = {
  "email.sent": "accepted",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

export function recordVerifiedEmailEvent(db: Db, event: VerifiedEmailEvent): RecordedEmailEvent {
  const duplicate = db
    .select({ id: emailDeliveryEvents.id })
    .from(emailDeliveryEvents)
    .where(
      and(
        eq(emailDeliveryEvents.provider, "resend"),
        eq(emailDeliveryEvents.providerEventId, event.providerEventId),
      ),
    )
    .get();
  if (duplicate) return { duplicate: true, deliveryFound: true };

  const delivery = db
    .select()
    .from(emailDeliveries)
    .where(
      and(
        eq(emailDeliveries.provider, "resend"),
        eq(emailDeliveries.providerMessageId, event.providerMessageId),
      ),
    )
    .get();
  if (!delivery) return { duplicate: false, deliveryFound: false };

  db.transaction((tx) => {
    tx.insert(emailDeliveryEvents)
      .values({
        id: randomUUID(),
        workspaceId: delivery.workspaceId,
        deliveryId: delivery.id,
        provider: "resend",
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        payloadJson: JSON.stringify(event.payload),
        occurredAt: event.occurredAt,
        createdAt: Date.now(),
      })
      .run();

    const nextStatus = EVENT_STATUS[event.eventType];
    const currentStatus = delivery.status as EmailDeliveryStatus;
    if (nextStatus && canTransitionEmailDelivery(currentStatus, nextStatus)) {
      const terminal = ["delivered", "bounced", "complained", "failed"].includes(nextStatus);
      tx.update(emailDeliveries)
        .set({
          status: nextStatus,
          acceptedAt: nextStatus === "accepted" ? event.occurredAt : delivery.acceptedAt,
          completedAt: terminal ? event.occurredAt : delivery.completedAt,
          lastError: nextStatus === "failed" ? "Resend reported delivery failure" : null,
          updatedAt: Date.now(),
        })
        .where(eq(emailDeliveries.id, delivery.id))
        .run();
    }

    if (event.eventType === "email.bounced" || event.eventType === "email.complained") {
      tx.insert(emailSuppressions)
        .values({
          id: randomUUID(),
          workspaceId: delivery.workspaceId,
          normalizedEmail: delivery.normalizedRecipient,
          reason: event.eventType === "email.bounced" ? "bounce" : "complaint",
          createdAt: event.occurredAt,
        })
        .onConflictDoNothing({
          target: [emailSuppressions.workspaceId, emailSuppressions.normalizedEmail],
        })
        .run();
    }
  });
  return { duplicate: false, deliveryFound: true };
}
