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

async function seedWorkspace(db: Db, name = "Email Lab"): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(workspaces)
    .values({
      id,
      name,
      analyticsOptOut: false,
      websiteUrl: null,
      onboardingStep: null,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function seedAction(db: Db, workspaceId: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(externalActions)
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
    });
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
  it("declares exactly the five email tables and safe sender defaults", async () => {
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

    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    await db.insert(workspaceEmailSenders).values(senderRow(workspaceId));
    expect((await db.select().from(workspaceEmailSenders))[0]).toMatchObject({
      workspaceId,
      killSwitch: true,
      dailyCap: 100,
    });
    await expect((async () => await db.insert(workspaceEmailSenders).values(senderRow(workspaceId)))()).rejects.toThrow();
  });

  it("enforces one normalized permission and suppression per workspace", async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    const otherWorkspaceId = await seedWorkspace(db, "Other Email Lab");

    const permission = permissionRow(workspaceId);
    await db.insert(emailRecipientPermissions).values(permission);
    await expect((async () =>
      await db.insert(emailRecipientPermissions)
        .values({ ...permissionRow(workspaceId), normalizedEmail: permission.normalizedEmail }))(),
    ).rejects.toThrow();
    expect(async () =>
      await db.insert(emailRecipientPermissions)
        .values(permissionRow(otherWorkspaceId, permission.normalizedEmail)),
    ).not.toThrow();

    const suppression = suppressionRow(workspaceId);
    await db.insert(emailSuppressions).values(suppression);
    expect((await db.select().from(emailSuppressions))[0]).toMatchObject({
      reason: "unsubscribe",
      createdAt: 1_800_000_000_000,
    });
    await expect((async () =>
      await db.insert(emailSuppressions)
        .values({ ...suppressionRow(workspaceId), normalizedEmail: suppression.normalizedEmail }))(),
    ).rejects.toThrow();
  });

  it("links deliveries to actions and preserves immutable message snapshots", async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    const actionId = await seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId, {
      idempotencyKey: "send/action-1",
      providerMessageId: "email_123",
    });

    await expect((async () =>
      await db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, randomUUID())))(),
    ).rejects.toThrow();
    await db.insert(emailDeliveries).values(delivery);
    await db.update(emailDeliveries)
      .set({ status: "accepted", acceptedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 })
      .where(eq(emailDeliveries.id, delivery.id));
    expect((await db.select().from(emailDeliveries))[0]).toMatchObject({
      externalActionId: actionId,
      subject: delivery.subject,
      text: delivery.text,
      html: delivery.html,
      normalizedRecipient: delivery.normalizedRecipient,
      senderAddress: delivery.senderAddress,
      replyTo: delivery.replyTo,
      status: "accepted",
    });

    await expect((async () =>
      await db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, actionId, { idempotencyKey: delivery.idempotencyKey })))(),
    ).rejects.toThrow();
    await expect((async () =>
      await db.insert(emailDeliveries)
        .values(deliveryRow(workspaceId, actionId, { providerMessageId: "email_123" })))(),
    ).rejects.toThrow();
    expect(async () =>
      await db.insert(emailDeliveries).values(deliveryRow(workspaceId, actionId)),
    ).not.toThrow();
    expect(async () =>
      await db.insert(emailDeliveries).values(deliveryRow(workspaceId, actionId)),
    ).not.toThrow();
  });

  it("deduplicates immutable provider events and bounds their raw JSON payload", async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    const actionId = await seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId);
    await db.insert(emailDeliveries).values(delivery);
    const event = eventRow(workspaceId, delivery.id);
    await db.insert(emailDeliveryEvents).values(event);

    expect((await db.select().from(emailDeliveryEvents))[0]).toEqual(event);
    await expect((async () =>
      await db.insert(emailDeliveryEvents)
        .values({ ...eventRow(workspaceId, delivery.id, event.providerEventId), id: randomUUID() }))(),
    ).rejects.toThrow();
    await expect((async () =>
      await db.insert(emailDeliveryEvents)
        .values({
          ...eventRow(workspaceId, delivery.id, "event_too_large"),
          payloadJson: JSON.stringify({ data: "x".repeat(MAX_EVENT_PAYLOAD_CHARS) }),
        }))(),
    ).rejects.toThrow();
  });

  it("cascades every governed email record when its workspace is deleted", async () => {
    const db = await createTestDb();
    const workspaceId = await seedWorkspace(db);
    const actionId = await seedAction(db, workspaceId);
    const delivery = deliveryRow(workspaceId, actionId);
    await db.insert(workspaceEmailSenders).values(senderRow(workspaceId));
    await db.insert(emailRecipientPermissions).values(permissionRow(workspaceId));
    await db.insert(emailSuppressions).values(suppressionRow(workspaceId));
    await db.insert(emailDeliveries).values(delivery);
    await db.insert(emailDeliveryEvents).values(eventRow(workspaceId, delivery.id));

    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    expect(await db.select().from(workspaceEmailSenders)).toEqual([]);
    expect(await db.select().from(emailRecipientPermissions)).toEqual([]);
    expect(await db.select().from(emailSuppressions)).toEqual([]);
    expect(await db.select().from(emailDeliveries)).toEqual([]);
    expect(await db.select().from(emailDeliveryEvents)).toEqual([]);
  });
});
