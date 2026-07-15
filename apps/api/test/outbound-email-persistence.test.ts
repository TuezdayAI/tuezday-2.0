import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import {
  emailDeliveries,
  emailDeliveryEvents,
  emailRecipientPermissions,
  emailSuppressions,
  externalActions,
  workspaceEmailSenders,
  workspaces,
} from "../src/db/schema";
import { createTestDb } from "./helpers";

const MAX_EVENT_PAYLOAD_CHARS = 1_000_000;

function seedWorkspace(db: Db, name = "Email Lab"): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(workspaces)
    .values({
      id,
      name,
      analyticsOptOut: false,
      websiteUrl: null,
      onboardingStep: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function seedAction(db: Db, workspaceId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(externalActions)
    .values({
      id,
      workspaceId,
      kind: "send",
      status: "authorization_required",
      subjectKind: "launch_message",
      subjectId: randomUUID(),
      draftId: null,
      campaignId: null,
      personaId: null,
      connectionId: null,
      laneRevisionId: null,
      payloadJson: JSON.stringify({ channel: "email" }),
      subjectSnapshotJson: JSON.stringify({ subject: "Hello", text: "Useful note" }),
      requestedFor: null,
      idempotencyKey: `send:${id}`,
      fingerprint: "a".repeat(64),
      policySnapshotJson: JSON.stringify({
        effective: "human_required",
        contributingRules: [],
      }),
      blockerCode: null,
      blockerDetail: null,
      blockerRetryable: null,
      supersedesActionId: null,
      supersededByActionId: null,
      executionKind: null,
      executionId: null,
      executionReceiptJson: null,
      proposedByUserId: null,
      proposedByLabel: "Founder",
      createdAt: now,
      updatedAt: now,
      authorizedAt: null,
      dispatchedAt: null,
      completedAt: null,
    })
    .run();
  return id;
}

function senderRow(workspaceId: string) {
  const now = Date.now();
  return {
    workspaceId,
    domain: "example.com",
    fromLocalPart: "hello",
    fromName: "Acme",
    fromAddress: "hello@example.com",
    replyTo: "founder@example.com",
    status: "pending",
    provider: "resend",
    providerDomainId: "domain_123",
    dnsRecordsJson: JSON.stringify([
      { name: "send.example.com", type: "TXT", value: "public", priority: null, status: "pending" },
    ]),
    lastCheckedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function permissionRow(workspaceId: string, normalizedEmail = "lead@buyer.com") {
  const now = Date.now();
  return {
    id: randomUUID(),
    workspaceId,
    normalizedEmail,
    status: "allowed",
    createdAt: now,
    updatedAt: now,
  };
}

function suppressionRow(workspaceId: string, normalizedEmail = "blocked@buyer.com") {
  return {
    id: randomUUID(),
    workspaceId,
    normalizedEmail,
    reason: "unsubscribe",
    createdAt: 1_800_000_000_000,
  };
}

function deliveryRow(
  workspaceId: string,
  externalActionId: string,
  overrides: Partial<{
    idempotencyKey: string;
    providerMessageId: string | null;
    normalizedRecipient: string;
  }> = {},
) {
  const now = Date.now();
  return {
    id: randomUUID(),
    workspaceId,
    externalActionId,
    origin: "launch_message",
    originId: randomUUID(),
    normalizedRecipient: overrides.normalizedRecipient ?? "lead@buyer.com",
    senderAddress: "hello@example.com",
    replyTo: "founder@example.com",
    subject: "A useful introduction",
    text: "Hello from Acme.",
    html: "<p>Hello from Acme.</p>",
    idempotencyKey: overrides.idempotencyKey ?? `send/${randomUUID()}`,
    provider: "resend",
    providerMessageId: overrides.providerMessageId ?? null,
    status: "queued",
    acceptedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function eventRow(workspaceId: string, deliveryId: string, providerEventId = "event_123") {
  const payloadJson = JSON.stringify({ type: "email.delivered", data: { email_id: "email_123" } });
  return {
    id: randomUUID(),
    workspaceId,
    deliveryId,
    provider: "resend",
    providerEventId,
    eventType: "email.delivered",
    payloadJson,
    occurredAt: 1_800_000_000_100,
    createdAt: 1_800_000_000_200,
  };
}

describe("governed outbound email persistence", () => {
  it("declares exactly the five email tables and safe sender defaults", () => {
    expect([
      workspaceEmailSenders,
      emailRecipientPermissions,
      emailSuppressions,
      emailDeliveries,
      emailDeliveryEvents,
    ].map((table) => getTableConfig(table).name)).toEqual([
      "workspace_email_senders",
      "email_recipient_permissions",
      "email_suppressions",
      "email_deliveries",
      "email_delivery_events",
    ]);

    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    db.insert(workspaceEmailSenders).values(senderRow(workspaceId)).run();
    expect(db.select().from(workspaceEmailSenders).get()).toMatchObject({
      workspaceId,
      killSwitch: true,
      dailyCap: 100,
    });
    expect(() => db.insert(workspaceEmailSenders).values(senderRow(workspaceId)).run()).toThrow();
  });

  it("enforces one normalized permission and suppression per workspace", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const otherWorkspaceId = seedWorkspace(db, "Other Email Lab");

    const permission = permissionRow(workspaceId);
    db.insert(emailRecipientPermissions).values(permission).run();
    expect(() =>
      db.insert(emailRecipientPermissions)
        .values({ ...permissionRow(workspaceId), normalizedEmail: permission.normalizedEmail })
        .run(),
    ).toThrow();
    expect(() =>
      db.insert(emailRecipientPermissions)
        .values(permissionRow(otherWorkspaceId, permission.normalizedEmail))
        .run(),
    ).not.toThrow();

    const suppression = suppressionRow(workspaceId);
    db.insert(emailSuppressions).values(suppression).run();
    expect(db.select().from(emailSuppressions).get()).toMatchObject({
      reason: "unsubscribe",
      createdAt: 1_800_000_000_000,
    });
    expect(() =>
      db.insert(emailSuppressions)
        .values({ ...suppressionRow(workspaceId), normalizedEmail: suppression.normalizedEmail })
        .run(),
    ).toThrow();
  });

  it("links deliveries to actions and preserves immutable message snapshots", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId, {
      idempotencyKey: "send/action-1",
      providerMessageId: "email_123",
    });

    expect(() =>
      db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, randomUUID()))
        .run(),
    ).toThrow();
    db.insert(emailDeliveries).values(delivery).run();
    db.update(emailDeliveries)
      .set({ status: "accepted", acceptedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 })
      .where(eq(emailDeliveries.id, delivery.id))
      .run();
    expect(db.select().from(emailDeliveries).get()).toMatchObject({
      externalActionId: actionId,
      subject: delivery.subject,
      text: delivery.text,
      html: delivery.html,
      normalizedRecipient: delivery.normalizedRecipient,
      senderAddress: delivery.senderAddress,
      replyTo: delivery.replyTo,
      status: "accepted",
    });

    expect(() =>
      db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, actionId, { idempotencyKey: delivery.idempotencyKey }))
        .run(),
    ).toThrow();
    expect(() =>
      db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, actionId, { providerMessageId: "email_123" }))
        .run(),
    ).toThrow();
    expect(() =>
      db.insert(emailDeliveries).values(deliveryRow(workspaceId, actionId)).run(),
    ).not.toThrow();
    expect(() =>
      db.insert(emailDeliveries).values(deliveryRow(workspaceId, actionId)).run(),
    ).not.toThrow();
  });

  it("deduplicates immutable provider events and bounds their raw JSON payload", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId);
    db.insert(emailDeliveries).values(delivery).run();
    const event = eventRow(workspaceId, delivery.id);
    db.insert(emailDeliveryEvents).values(event).run();

    expect(db.select().from(emailDeliveryEvents).get()).toEqual(event);
    expect(() =>
      db.insert(emailDeliveryEvents)
        .values({ ...eventRow(workspaceId, delivery.id, event.providerEventId), id: randomUUID() })
        .run(),
    ).toThrow();
    expect(() =>
      db.insert(emailDeliveryEvents)
        .values({
          ...eventRow(workspaceId, delivery.id, "event_too_large"),
          payloadJson: JSON.stringify({ data: "x".repeat(MAX_EVENT_PAYLOAD_CHARS) }),
        })
        .run(),
    ).toThrow();
  });

  it("cascades every governed email record when its workspace is deleted", () => {
    const db = createTestDb();
    const workspaceId = seedWorkspace(db);
    const actionId = seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId);
    db.insert(workspaceEmailSenders).values(senderRow(workspaceId)).run();
    db.insert(emailRecipientPermissions).values(permissionRow(workspaceId)).run();
    db.insert(emailSuppressions).values(suppressionRow(workspaceId)).run();
    db.insert(emailDeliveries).values(delivery).run();
    db.insert(emailDeliveryEvents).values(eventRow(workspaceId, delivery.id)).run();

    db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
    expect(db.select().from(workspaceEmailSenders).all()).toEqual([]);
    expect(db.select().from(emailRecipientPermissions).all()).toEqual([]);
    expect(db.select().from(emailSuppressions).all()).toEqual([]);
    expect(db.select().from(emailDeliveries).all()).toEqual([]);
    expect(db.select().from(emailDeliveryEvents).all()).toEqual([]);
  });
});
