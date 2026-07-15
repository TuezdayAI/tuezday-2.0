import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import {
  drafts,
  emailDeliveries,
  emailRecipientPermissions,
  launchMessages,
  launches,
  workspaceEmailSenders,
} from "../src/db/schema";
import type {
  OutboundEmailDomain,
  OutboundEmailMessage,
  OutboundEmailProvider,
} from "../src/outbound-email/provider";
import { OutboundEmailProviderError } from "../src/outbound-email/provider";
import type { ConnectorFabric } from "../src/connectors/fabric";
import {
  prepareEmailAction,
} from "../src/services/external-action-email";
import { createExternalActionAdapters } from "../src/services/external-action-adapters";
import {
  createExternalActionRuntime,
  StaleExternalActionError,
} from "../src/services/external-action-coordinator";
import { getExternalActionPayload, transitionExternalAction } from "../src/services/external-actions";
import { applyDraftAction, submitDraft } from "../src/services/drafts";
import { createWorkspace } from "../src/services/workspaces";
import { createTestDb } from "./helpers";

const actor = { userId: null, label: "Founder" };

class FakeProvider implements OutboundEmailProvider {
  send = vi.fn(async (_message: OutboundEmailMessage) => ({
    provider: "resend" as const,
    messageId: "email_123",
    acceptedAt: Date.now(),
  }));
  async createDomain(): Promise<OutboundEmailDomain> { throw new Error("unused"); }
  async verifyDomain(): Promise<void> { throw new Error("unused"); }
  async getDomain(): Promise<OutboundEmailDomain> { throw new Error("unused"); }
}

describe("governed email external actions", () => {
  let db: Db;
  let workspaceId: string;
  let draftId: string;
  let messageId: string;
  let provider: FakeProvider;

  beforeEach(() => {
    db = createTestDb();
    workspaceId = createWorkspace(db, { name: "Acme" }).id;
    const submitted = submitDraft(db, {
      workspaceId,
      sourceGenerationId: randomUUID(),
      campaignId: null,
      leadId: null,
      mediaContactId: null,
      taskType: "outbound_email",
      channel: "email",
      personaId: null,
      content: "A useful introduction\nHello from Acme.",
    }, actor);
    draftId = applyDraftAction(db, submitted, "approve", actor).id;
    const launchId = randomUUID();
    messageId = randomUUID();
    const now = Date.now();
    db.insert(launches).values({
      id: launchId,
      workspaceId,
      name: "Launch",
      channelsJson: '["email"]',
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(launchMessages).values({
      id: messageId,
      workspaceId,
      launchId,
      channel: "email",
      kind: "personalized",
      recipientName: "Lead",
      recipientEmail: "lead@buyer.com",
      draftId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(workspaceEmailSenders).values({
      workspaceId,
      domain: "example.com",
      fromLocalPart: "hello",
      fromName: "Acme",
      fromAddress: "hello@example.com",
      replyTo: "founder@example.com",
      status: "verified",
      provider: "resend",
      providerDomainId: "domain_123",
      dnsRecordsJson: "[]",
      killSwitch: false,
      dailyCap: 100,
      lastCheckedAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(emailRecipientPermissions).values({
      id: randomUUID(),
      workspaceId,
      normalizedEmail: "lead@buyer.com",
      status: "allowed",
      createdAt: now,
      updatedAt: now,
    }).run();
    provider = new FakeProvider();
  });

  function command(key = `email/${randomUUID()}`) {
    return prepareEmailAction(db, workspaceId, {
      origin: "launch_message",
      originId: messageId,
      idempotencyKey: key,
    });
  }

  function runtime() {
    return createExternalActionRuntime({
      db,
      adapters: createExternalActionAdapters(db, {} as ConnectorFabric, fetch, provider),
    });
  }

  it("proposes, authorizes, and accepts one durable provider send", async () => {
    const proposed = await runtime().propose(command("email/action-1"), actor);
    expect(proposed.action.kind).toBe("send");
    expect(proposed.action.subject.destination).toBe("lead@buyer.com");
    const sent = await runtime().authorize(proposed.action.id, workspaceId, actor);
    expect(sent.execution).toMatchObject({
      kind: "email_delivery",
      status: "accepted",
      url: null,
      error: null,
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0]?.[0]).toMatchObject({
      from: "Acme <hello@example.com>",
      to: "lead@buyer.com",
      subject: "A useful introduction",
      text: "Hello from Acme.",
      idempotencyKey: `send/${proposed.action.id}`,
    });
    expect(db.select().from(emailDeliveries).get()).toMatchObject({
      externalActionId: proposed.action.id,
      status: "accepted",
      providerMessageId: "email_123",
    });
  });

  it("blocks unverified senders and unknown recipient permission", async () => {
    db.update(workspaceEmailSenders).set({ status: "pending" }).where(eq(workspaceEmailSenders.workspaceId, workspaceId)).run();
    const unverified = await runtime().propose(command(), actor);
    const blockedSender = await runtime().authorize(unverified.action.id, workspaceId, actor);
    expect(blockedSender.action.blocker?.code).toBe("sender_unverified");

    db.update(workspaceEmailSenders).set({ status: "verified" }).where(eq(workspaceEmailSenders.workspaceId, workspaceId)).run();
    db.delete(emailRecipientPermissions).run();
    const unknown = await runtime().propose(command(), actor);
    const blockedRecipient = await runtime().authorize(unknown.action.id, workspaceId, actor);
    expect(blockedRecipient.action.blocker?.code).toBe("permission_unknown");
  });

  it("detects origin edits before authorization", async () => {
    const proposed = await runtime().propose(command(), actor);
    db.update(drafts).set({ content: "Changed subject\nChanged body", updatedAt: Date.now() }).where(eq(drafts.id, draftId)).run();
    await expect(runtime().authorize(proposed.action.id, workspaceId, actor)).rejects.toBeInstanceOf(
      StaleExternalActionError,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("recovers a dispatching action with a stored provider receipt without resending", async () => {
    const proposed = await runtime().propose(command(), actor);
    transitionExternalAction(db, workspaceId, proposed.action.id, "authorized");
    transitionExternalAction(db, workspaceId, proposed.action.id, "dispatching");
    const deliveryId = randomUUID();
    const current = command();
    const payload = current.payload as { to: string; subject: string; text: string; replyTo: string | null; from: string; origin: string; originId: string };
    const now = Date.now();
    db.insert(emailDeliveries).values({
      id: deliveryId,
      workspaceId,
      externalActionId: proposed.action.id,
      origin: payload.origin,
      originId: payload.originId,
      normalizedRecipient: payload.to,
      senderAddress: "hello@example.com",
      replyTo: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
      html: null,
      idempotencyKey: `send/${proposed.action.id}`,
      provider: "resend",
      providerMessageId: "email_recovered",
      status: "queued",
      acceptedAt: now,
      completedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    const [retry] = await runtime().run(workspaceId);
    expect(retry?.execution?.id).toBe(deliveryId);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("retries a thrown provider failure with the same action-derived key", async () => {
    provider.send.mockRejectedValueOnce(
      new OutboundEmailProviderError("Provider unavailable", {
        status: 503,
        code: "provider_unavailable",
        retryable: true,
      }),
    );
    const proposed = await runtime().propose(command(), actor);
    const first = await runtime().authorize(proposed.action.id, workspaceId, actor);
    expect(first.action.status).toBe("dispatching");
    expect(db.select().from(emailDeliveries).get()?.status).toBe("queued");

    const [retried] = await runtime().run(workspaceId);
    expect(retried?.execution?.status).toBe("accepted");
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.send.mock.calls[0]?.[0].idempotencyKey).toBe(`send/${proposed.action.id}`);
    expect(provider.send.mock.calls[1]?.[0].idempotencyKey).toBe(`send/${proposed.action.id}`);
  });
});
