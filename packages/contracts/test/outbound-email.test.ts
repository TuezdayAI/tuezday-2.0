import { describe, expect, it } from "vitest";
import {
  EMAIL_DELIVERY_ORIGINS,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_PERMISSION_STATUSES,
  EMAIL_SENDER_STATUSES,
  EXTERNAL_ACTION_EXECUTION_KINDS,
  canTransitionEmailDelivery,
  emailDeliveryEventSchema,
  emailDeliverySchema,
  emailDnsRecordSchema,
  emailRecipientPermissionSchema,
  emailSenderSchema,
  emailSuppressionSchema,
  updateEmailPermissionInputSchema,
  updateEmailSenderInputSchema,
} from "../src/index";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const originId = "44444444-4444-4444-8444-444444444444";

function deliveryFixture() {
  return {
    id: deliveryId,
    workspaceId,
    externalActionId: actionId,
    origin: "launch_message",
    originId,
    normalizedRecipient: "lead@buyer.com",
    senderAddress: "hello@example.com",
    replyTo: "founder@example.com",
    subject: "A useful introduction",
    text: "Hello from Acme.",
    html: null,
    idempotencyKey: "send/action-id",
    provider: "resend",
    providerMessageId: "email_123",
    status: "accepted",
    acceptedAt: 1_800_000_000_000,
    completedAt: null,
    lastError: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
}

describe("governed outbound email contracts", () => {
  it("owns the sender, permission, delivery, and origin vocabularies", () => {
    expect(EMAIL_SENDER_STATUSES).toEqual([
      "not_configured",
      "pending",
      "verified",
      "failed",
    ]);
    expect(EMAIL_PERMISSION_STATUSES).toEqual(["unknown", "allowed", "suppressed"]);
    expect(EMAIL_DELIVERY_STATUSES).toEqual([
      "queued",
      "accepted",
      "delivered",
      "bounced",
      "complained",
      "failed",
    ]);
    expect(EMAIL_DELIVERY_ORIGINS).toEqual([
      "launch_message",
      "outbound_draft",
      "pr_draft",
    ]);
    expect(EXTERNAL_ACTION_EXECUTION_KINDS).toContain("email_delivery");
  });

  it("normalizes sender inputs while keeping the local part domain-free", () => {
    expect(
      updateEmailSenderInputSchema.parse({
        domain: " EXAMPLE.COM ",
        fromLocalPart: "hello",
        fromName: " Acme ",
        replyTo: " FOUNDER@EXAMPLE.COM ",
      }),
    ).toEqual({
      domain: "example.com",
      fromLocalPart: "hello",
      fromName: "Acme",
      replyTo: "founder@example.com",
    });
    expect(
      updateEmailSenderInputSchema.parse({
        domain: "example.com",
        fromLocalPart: "updates",
        fromName: "Acme",
        replyTo: null,
      }).replyTo,
    ).toBeNull();
    expect(
      updateEmailSenderInputSchema.safeParse({
        domain: "example.com",
        fromLocalPart: "hello@example.com",
        fromName: "Acme",
        replyTo: null,
      }).success,
    ).toBe(false);
    expect(
      updateEmailSenderInputSchema.safeParse({
        domain: "https://example.com",
        fromLocalPart: "hello",
        fromName: "Acme",
        replyTo: null,
      }).success,
    ).toBe(false);
  });

  it("projects only public DNS records and workspace sender safety settings", () => {
    const dnsRecord = {
      name: "send.example.com",
      type: "TXT",
      value: "resend-verification=public-value",
      priority: null,
      status: "pending",
    };
    expect(emailDnsRecordSchema.parse(dnsRecord)).toEqual(dnsRecord);
    expect(emailDnsRecordSchema.safeParse({ ...dnsRecord, secret: "never-public" }).success).toBe(
      false,
    );

    expect(
      emailSenderSchema.parse({
        workspaceId,
        domain: "example.com",
        fromLocalPart: "hello",
        fromName: "Acme",
        fromAddress: "hello@example.com",
        replyTo: null,
        status: "verified",
        provider: "resend",
        providerDomainId: "domain_123",
        dnsRecords: [dnsRecord],
        killSwitch: false,
        dailyCap: 200,
        lastCheckedAt: 1_800_000_000_000,
        lastError: null,
        createdAt: 1_799_000_000_000,
        updatedAt: 1_800_000_000_000,
      }),
    ).toMatchObject({ status: "verified", killSwitch: false, dailyCap: 200 });
  });

  it("normalizes recipient permission and suppression addresses", () => {
    expect(
      emailRecipientPermissionSchema.parse({
        workspaceId,
        normalizedEmail: " LEAD@BUYER.COM ",
        status: "allowed",
        createdAt: 100,
        updatedAt: 100,
      }).normalizedEmail,
    ).toBe("lead@buyer.com");
    expect(
      emailSuppressionSchema.parse({
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId,
        normalizedEmail: " LEAD@BUYER.COM ",
        reason: "unsubscribe",
        createdAt: 100,
      }).normalizedEmail,
    ).toBe("lead@buyer.com");
    expect(updateEmailPermissionInputSchema.parse({ status: "suppressed" })).toEqual({
      status: "suppressed",
    });
    expect(updateEmailPermissionInputSchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  it("parses delivery snapshots and normalizes every email address", () => {
    expect(
      emailDeliverySchema.parse({
        ...deliveryFixture(),
        normalizedRecipient: " LEAD@BUYER.COM ",
        senderAddress: " HELLO@EXAMPLE.COM ",
        replyTo: " FOUNDER@EXAMPLE.COM ",
      }),
    ).toMatchObject({
      status: "accepted",
      origin: "launch_message",
      normalizedRecipient: "lead@buyer.com",
      senderAddress: "hello@example.com",
      replyTo: "founder@example.com",
    });
  });

  it("accepts immutable public delivery events without provider secrets", () => {
    const event = {
      id: "66666666-6666-4666-8666-666666666666",
      workspaceId,
      deliveryId,
      provider: "resend",
      providerEventId: "event_123",
      eventType: "email.delivered",
      payload: { type: "email.delivered", data: { email_id: "email_123" } },
      occurredAt: 1_800_000_000_100,
      createdAt: 1_800_000_000_200,
    };
    expect(emailDeliveryEventSchema.parse(event)).toEqual(event);
    expect(
      emailDeliveryEventSchema.safeParse({ ...event, webhookSecret: "never-persist" }).success,
    ).toBe(false);
    expect(emailDeliveryEventSchema.safeParse({ ...event, updatedAt: event.createdAt }).success).toBe(
      false,
    );
  });

  it("allows only forward delivery transitions", () => {
    expect(canTransitionEmailDelivery("queued", "accepted")).toBe(true);
    expect(canTransitionEmailDelivery("queued", "failed")).toBe(true);
    expect(canTransitionEmailDelivery("accepted", "delivered")).toBe(true);
    expect(canTransitionEmailDelivery("accepted", "bounced")).toBe(true);
    expect(canTransitionEmailDelivery("accepted", "complained")).toBe(true);
    expect(canTransitionEmailDelivery("accepted", "failed")).toBe(true);
    expect(canTransitionEmailDelivery("queued", "delivered")).toBe(false);
    expect(canTransitionEmailDelivery("delivered", "bounced")).toBe(false);
    expect(canTransitionEmailDelivery("bounced", "delivered")).toBe(false);
    expect(canTransitionEmailDelivery("accepted", "accepted")).toBe(false);
  });
});
