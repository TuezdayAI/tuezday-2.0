import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  emailDeliveries,
  emailDeliveryEvents,
  emailSuppressions,
  externalActions,
  workspaces,
} from "../src/db/schema";
import type { ResendWebhookVerifier } from "../src/outbound-email/webhook";
import { createTestDb } from "./helpers";

const MESSAGE_ID = "email_123";
const RECIPIENT = "lead@buyer.com";

function seedDelivery(db: Db): { workspaceId: string; deliveryId: string } {
  const workspaceId = randomUUID();
  const actionId = randomUUID();
  const deliveryId = randomUUID();
  const now = Date.now();
  db.insert(workspaces).values({
    id: workspaceId,
    name: "Acme",
    websiteUrl: null,
    onboardingStep: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(externalActions).values({
    id: actionId,
    workspaceId,
    kind: "send",
    status: "completed",
    subjectKind: "launch_message",
    subjectId: randomUUID(),
    draftId: null,
    campaignId: null,
    personaId: null,
    connectionId: null,
    laneRevisionId: null,
    payloadJson: "{}",
    subjectSnapshotJson: "{}",
    requestedFor: null,
    idempotencyKey: `send/${actionId}`,
    fingerprint: "a".repeat(64),
    policySnapshotJson: "{}",
    blockerCode: null,
    blockerDetail: null,
    blockerRetryable: null,
    supersedesActionId: null,
    supersededByActionId: null,
    executionKind: "email_delivery",
    executionId: deliveryId,
    executionReceiptJson: null,
    proposedByUserId: null,
    proposedByLabel: "Founder",
    createdAt: now,
    updatedAt: now,
    authorizedAt: now,
    dispatchedAt: now,
    completedAt: now,
  }).run();
  db.insert(emailDeliveries).values({
    id: deliveryId,
    workspaceId,
    externalActionId: actionId,
    origin: "launch_message",
    originId: randomUUID(),
    normalizedRecipient: RECIPIENT,
    senderAddress: "hello@example.com",
    replyTo: null,
    subject: "Hello",
    text: "Useful note",
    html: null,
    idempotencyKey: `send/${actionId}`,
    provider: "resend",
    providerMessageId: MESSAGE_ID,
    status: "accepted",
    acceptedAt: now,
    completedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  return { workspaceId, deliveryId };
}

function payload(type: string): string {
  return JSON.stringify({
    type,
    created_at: "2026-07-16T12:00:00.000Z",
    data: { email_id: MESSAGE_ID, to: [RECIPIENT] },
  });
}

describe("Resend webhooks", () => {
  let db: Db;
  let app: TuezdayApp;
  let verify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = createTestDb();
    seedDelivery(db);
    verify = vi.fn((rawBody: string) => JSON.parse(rawBody));
    const verifier: ResendWebhookVerifier = { verify };
    app = await buildApp({ db, resendWebhookVerifier: verifier });
  });

  afterEach(async () => {
    await app.close();
  });

  async function post(rawBody: string, id = "msg_1") {
    return app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": "123",
        "svix-signature": "v1,sig",
      },
      payload: rawBody,
    });
  }

  it("verifies the untouched raw body and normalized signature headers", async () => {
    const rawBody = payload("email.bounced");
    const response = await post(rawBody);
    expect(response.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledWith(rawBody, {
      id: "msg_1",
      timestamp: "123",
      signature: "v1,sig",
    });
  });

  it("rejects invalid signatures before recording an event", async () => {
    verify.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    const invalid = await post(payload("email.delivered"));
    expect(invalid.statusCode).toBe(400);
    expect(db.select().from(emailDeliveryEvents).all()).toHaveLength(0);
  });

  it("projects bounce outcomes and suppresses the recipient transactionally", async () => {
    await post(payload("email.bounced"));
    expect(db.select().from(emailDeliveries).get()).toMatchObject({ status: "bounced" });
    expect(db.select().from(emailSuppressions).get()).toMatchObject({
      normalizedEmail: RECIPIENT,
      reason: "bounce",
    });
  });

  it("deduplicates provider event ids", async () => {
    expect((await post(payload("email.delivered"))).statusCode).toBe(200);
    const duplicate = await post(payload("email.delivered"));
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ received: true, duplicate: true });
    expect(db.select().from(emailDeliveryEvents).all()).toHaveLength(1);
  });

  it("stores late verified events without reversing terminal outcomes", async () => {
    await post(payload("email.bounced"), "msg_bounce");
    await post(payload("email.delivered"), "msg_late_delivered");
    expect(db.select().from(emailDeliveries).get()?.status).toBe("bounced");
    expect(db.select().from(emailDeliveryEvents).all()).toHaveLength(2);
  });

  it("acknowledges and stores unknown verified types without changing delivery", async () => {
    const before = db.select().from(emailDeliveries).get()?.status;
    const response = await post(payload("email.opened"), "msg_opened");
    expect(response.statusCode).toBe(200);
    expect(db.select().from(emailDeliveries).get()?.status).toBe(before);
    expect(
      db.select().from(emailDeliveryEvents).where(eq(emailDeliveryEvents.providerEventId, "msg_opened")).get(),
    ).toMatchObject({ eventType: "email.opened" });
  });
});
