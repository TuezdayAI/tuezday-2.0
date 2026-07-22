import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxWithUsageSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  connections,
  emailDeliveries,
  emailRecipientPermissions,
  emailSuppressions,
  inboxItems,
  mailboxes,
  workspaceEmailSenders,
} from "../src/db/schema";
import { eq } from "drizzle-orm";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import type {
  GmailMailboxProvider,
  GmailMessage,
  GmailSendInput,
  GmailSendResult,
} from "../src/outbound-email/gmail";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const MAILBOX_ADDRESS = "founder@gmail.com";
const WORKER_TOKEN = "test-worker-token";

/** Flipped by the classifier-failure test without rebuilding the app. */
let classifyShouldFail = false;

/** LLM that drafts outbound emails and labels replies; can be told to fail. */
function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      // Reply classification prompt → JSON array of labels.
      if (prompt.includes("You label inbound email replies")) {
        if (classifyShouldFail) throw new GatewayError("provider_error", "classify boom");
        const count = (prompt.match(/^ITEM \d+/gm) ?? []).length;
        const entries = Array.from({ length: count }, (_, index) => {
          // Body drives the label so tests can assert specific outcomes.
          const bodyMatch = new RegExp(`ITEM ${index}[\\s\\S]*?Body:\\n([\\s\\S]*?)(?:\\n\\nITEM |$)`).exec(prompt);
          const body = (bodyMatch?.[1] ?? "").toLowerCase();
          const label = body.includes("unsubscribe")
            ? "unsubscribe_request"
            : body.includes("interested")
              ? "positive"
              : "other";
          return { index, label };
        });
        return { text: JSON.stringify(entries), model: "fake", provider: "fake", durationMs: 1 };
      }
      // Outbound draft generation.
      const leadMatch = /To: ([^\n]+)/.exec(prompt);
      return {
        text: `Subject: For ${leadMatch?.[1] ?? "you"}\n\nPersonalized email body.`,
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
}

/** In-memory Gmail: records sends, serves scripted inbound messages by thread. */
class FakeGmailProvider implements GmailMailboxProvider {
  address = MAILBOX_ADDRESS;
  inbound: GmailMessage[] = [];
  profileFails = false;
  sendEmail = vi.fn(async (_connectionId: string, input: GmailSendInput): Promise<GmailSendResult> => {
    this.lastSendInput = input;
    const messageId = `msg_${randomUUID()}`;
    const threadId = input.threadId ?? `thread_${randomUUID()}`;
    return { messageId, threadId };
  });
  lastSendInput: GmailSendInput | null = null;

  async listInboundSince(_connectionId: string, _sinceMs: number, _max: number) {
    return this.inbound.map((m) => ({ id: m.id, threadId: m.threadId }));
  }
  async getMessage(_connectionId: string, messageId: string): Promise<GmailMessage> {
    const found = this.inbound.find((m) => m.id === messageId);
    if (!found) throw new Error(`no scripted message ${messageId}`);
    return found;
  }
  async getProfile() {
    if (this.profileFails) throw new Error("profile boom");
    return { emailAddress: this.address };
  }
}

describe("outreach mailboxes (Sprint 47)", () => {
  let app: TuezdayApp;
  let db: Db;
  let gmail: FakeGmailProvider;
  let workspaceId: string;

  beforeEach(async () => {
    classifyShouldFail = false;
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "unsub-secret");
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    db = createTestDb();
    gmail = new FakeGmailProvider();
    app = await buildAuthedApp({ db, llm: fakeGateway(), gmail, workerToken: WORKER_TOKEN });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Outreach" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We end GTM amnesia." },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  /** Seed a connected Gmail connector row (tokens would live in Nango). */
  function seedGmailConnection(providerKey = "gmail", status = "connected"): string {
    const id = randomUUID();
    const now = Date.now();
    db.insert(connections)
      .values({
        id,
        workspaceId,
        providerKey,
        nangoConnectionId: `nango_${id}`,
        configJson: "{}",
        displayName: "Gmail",
        status,
        contentProfileJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  async function createMailbox(): Promise<string> {
    const connectionId = seedGmailConnection();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/mailboxes`,
      payload: { connectionId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** Turn off the workspace kill switch and allow a recipient (safety layer). */
  function enableEmail(recipient: string): void {
    const now = Date.now();
    db.insert(workspaceEmailSenders)
      .values({
        workspaceId,
        domain: "example.com",
        fromLocalPart: "hello",
        fromName: "Out",
        fromAddress: "hello@example.com",
        replyTo: null,
        status: "verified",
        provider: "resend",
        providerDomainId: "d1",
        dnsRecordsJson: "[]",
        killSwitch: false,
        dailyCap: 100,
        lastCheckedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    db.insert(emailRecipientPermissions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail: recipient,
        status: "allowed",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  async function approvedDraftForLead(email = "prospect@acme.io"): Promise<string> {
    const lead = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name: "Prospect", email, company: "Acme", role: "VP" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outbound/draft`,
      payload: { leadIds: [lead.id] },
    });
    const draft = (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
    ).json()[0];
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
    });
    return draft.id as string;
  }

  async function sendFromMailbox(draftId: string, mailboxId: string) {
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outbound/drafts/${draftId}/send`,
      payload: { mailboxId },
    });
  }

  // --- Mailbox CRUD ---------------------------------------------------------

  describe("mailbox CRUD", () => {
    it("creates a mailbox from a gmail connection, address from the profile", async () => {
      const connectionId = seedGmailConnection();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailboxes`,
        payload: { connectionId },
      });
      expect(res.statusCode).toBe(201);
      const mailbox = res.json();
      expect(mailboxWithUsageSchema.safeParse(mailbox).success).toBe(true);
      expect(mailbox.address).toBe(MAILBOX_ADDRESS);
      expect(mailbox.dailyCap).toBe(50);
      expect(mailbox.sentToday).toBe(0);
    });

    it("rejects a non-gmail connection", async () => {
      const connectionId = seedGmailConnection("reddit");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailboxes`,
        payload: { connectionId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("connection_not_gmail");
    });

    it("404s an unknown connection", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailboxes`,
        payload: { connectionId: randomUUID() },
      });
      expect(res.statusCode).toBe(404);
    });

    it("lists mailboxes with usage and updates settings", async () => {
      const mailboxId = await createMailbox();
      const patch = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/mailboxes/${mailboxId}`,
        payload: { displayName: "Jane at Acme", signature: "— Jane", dailyCap: 120 },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().dailyCap).toBe(120);

      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/mailboxes` })
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].displayName).toBe("Jane at Acme");
    });

    it("rejects a daily cap over the max", async () => {
      const mailboxId = await createMailbox();
      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/mailboxes/${mailboxId}`,
        payload: { dailyCap: 5000 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("soft-deletes to disconnected", async () => {
      const mailboxId = await createMailbox();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/mailboxes/${mailboxId}`,
      });
      expect(res.statusCode).toBe(204);
      const row = db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
      expect(row?.status).toBe("disconnected");
    });
  });

  // --- Governed send from a mailbox ----------------------------------------

  describe("send from mailbox", () => {
    it("sends via Gmail with signature + unsubscribe footer, stores thread id", async () => {
      const mailboxId = await createMailbox();
      await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/mailboxes/${mailboxId}`,
        payload: { signature: "— Jane" },
      });
      const draftId = await approvedDraftForLead();
      enableEmail("prospect@acme.io");

      const send = await sendFromMailbox(draftId, mailboxId);
      expect(send.statusCode).toBe(200);
      expect(send.json().execution.status).toBe("accepted");
      expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
      expect(gmail.lastSendInput?.from).toBe(MAILBOX_ADDRESS);
      expect(gmail.lastSendInput?.text).toContain("Personalized email body.");
      expect(gmail.lastSendInput?.text).toContain("— Jane");
      expect(gmail.lastSendInput?.text).toContain("Unsubscribe: https://app.test/u/");

      const delivery = db
        .select()
        .from(emailDeliveries)
        .where(eq(emailDeliveries.workspaceId, workspaceId))
        .get();
      expect(delivery?.provider).toBe("gmail");
      expect(delivery?.mailboxId).toBe(mailboxId);
      expect(delivery?.providerThreadId).toBeTruthy();
    });

    it("is idempotent — a duplicate send reuses the action, sends once", async () => {
      const mailboxId = await createMailbox();
      const draftId = await approvedDraftForLead();
      enableEmail("prospect@acme.io");

      const first = await sendFromMailbox(draftId, mailboxId);
      const second = await sendFromMailbox(draftId, mailboxId);
      expect(second.json().action.id).toBe(first.json().action.id);
      expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    });

    it("blocks a suppressed recipient (no send)", async () => {
      const mailboxId = await createMailbox();
      const draftId = await approvedDraftForLead();
      enableEmail("prospect@acme.io");
      db.insert(emailSuppressions)
        .values({
          id: randomUUID(),
          workspaceId,
          normalizedEmail: "prospect@acme.io",
          reason: "unsubscribe",
          createdAt: Date.now(),
        })
        .run();

      const send = await sendFromMailbox(draftId, mailboxId);
      expect(send.json().action.status).toBe("blocked");
      expect(gmail.sendEmail).not.toHaveBeenCalled();
    });

    it("blocks when the workspace kill switch is on", async () => {
      const mailboxId = await createMailbox();
      const draftId = await approvedDraftForLead();
      // No enableEmail(): kill switch defaults on.
      const send = await sendFromMailbox(draftId, mailboxId);
      expect(send.json().action.status).toBe("blocked");
      expect(gmail.sendEmail).not.toHaveBeenCalled();
    });

    it("blocks once the per-mailbox daily cap is reached", async () => {
      const mailboxId = await createMailbox();
      await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/mailboxes/${mailboxId}`,
        payload: { dailyCap: 1 },
      });
      // A real first send consumes the cap of 1 (accepted gmail delivery).
      enableEmail("first@acme.io");
      const firstDraft = await approvedDraftForLead("first@acme.io");
      const first = await sendFromMailbox(firstDraft, mailboxId);
      expect(first.json().execution.status).toBe("accepted");
      expect(gmail.sendEmail).toHaveBeenCalledTimes(1);

      // A second send from the same mailbox is now over cap.
      enableEmail("second@acme.io");
      const secondDraft = await approvedDraftForLead("second@acme.io");
      const second = await sendFromMailbox(secondDraft, mailboxId);
      expect(second.json().action.status).toBe("blocked");
      expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    });

    it("rejects sending an unapproved draft", async () => {
      const mailboxId = await createMailbox();
      const lead = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/leads`,
          payload: { name: "P", email: "p@acme.io" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/draft`,
        payload: { leadIds: [lead.id] },
      });
      const draft = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/drafts` })
      ).json()[0];
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/drafts/${draft.id}/send`,
        payload: { mailboxId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("draft_not_approved");
    });

    it("404s an unknown mailbox", async () => {
      const draftId = await approvedDraftForLead();
      enableEmail("prospect@acme.io");
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outbound/drafts/${draftId}/send`,
        payload: { mailboxId: randomUUID() },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("mailbox_not_found");
    });
  });

  // --- Inbound reply poll ---------------------------------------------------

  describe("mailbox inbox poll", () => {
    async function sendAndGetThread(): Promise<{ mailboxId: string; threadId: string }> {
      const mailboxId = await createMailbox();
      const draftId = await approvedDraftForLead();
      enableEmail("prospect@acme.io");
      await sendFromMailbox(draftId, mailboxId);
      const delivery = db
        .select()
        .from(emailDeliveries)
        .where(eq(emailDeliveries.provider, "gmail"))
        .get();
      return { mailboxId, threadId: delivery!.providerThreadId! };
    }

    function reply(threadId: string, body: string, from = "prospect@acme.io"): GmailMessage {
      return {
        id: `in_${randomUUID()}`,
        threadId,
        fromAddress: from,
        fromName: "Prospect",
        subject: "Re: For Prospect",
        bodyText: body,
        internalDateMs: Date.now(),
      };
    }

    it("ingests only replies on threads we sent — the privacy invariant", async () => {
      const { threadId } = await sendAndGetThread();
      gmail.inbound = [
        reply(threadId, "I am interested, let's talk"),
        reply("unrelated-thread-999", "private personal email"),
      ];

      const run = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailbox-inbox/run`,
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().newItems).toBe(1);

      const items = db.select().from(inboxItems).where(eq(inboxItems.workspaceId, workspaceId)).all();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe("email");
      expect(items[0]!.content).toContain("interested");
    });

    it("dedupes on re-poll and skips the mailbox's own messages", async () => {
      const { threadId } = await sendAndGetThread();
      gmail.inbound = [
        reply(threadId, "interested"),
        reply(threadId, "my own note", MAILBOX_ADDRESS),
      ];

      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/mailbox-inbox/run` });
      const second = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailbox-inbox/run`,
      });
      expect(second.json().newItems).toBe(0);
      const items = db.select().from(inboxItems).where(eq(inboxItems.workspaceId, workspaceId)).all();
      expect(items).toHaveLength(1); // own-address message never ingested
    });

    it("classifies new items and threads them to the delivery", async () => {
      const { threadId } = await sendAndGetThread();
      gmail.inbound = [reply(threadId, "Please unsubscribe me")];

      const run = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailbox-inbox/run`,
      });
      expect(run.json().labeled).toBe(1);
      const item = db.select().from(inboxItems).where(eq(inboxItems.workspaceId, workspaceId)).get();
      expect(item?.replyLabel).toBe("unsubscribe_request");
      expect(item?.emailDeliveryId).toBeTruthy();
    });

    it("keeps items unlabeled when the classifier fails", async () => {
      const { threadId } = await sendAndGetThread();
      gmail.inbound = [reply(threadId, "interested")];
      classifyShouldFail = true;

      const run = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/mailbox-inbox/run`,
      });
      expect(run.json().newItems).toBe(1);
      expect(run.json().labeled).toBe(0);
      const item = db.select().from(inboxItems).where(eq(inboxItems.workspaceId, workspaceId)).get();
      expect(item?.replyLabel ?? null).toBeNull();
    });

    it("advances lastPolledAt", async () => {
      const { mailboxId } = await sendAndGetThread();
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/mailbox-inbox/run` });
      const row = db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
      expect(row?.lastPolledAt).toBeTruthy();
    });

    it("lets an email item get a gated reply draft", async () => {
      const { threadId } = await sendAndGetThread();
      gmail.inbound = [reply(threadId, "interested")];
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/mailbox-inbox/run` });
      const item = db.select().from(inboxItems).where(eq(inboxItems.workspaceId, workspaceId)).get();

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/inbox/${item!.id}/reply`,
      });
      expect(res.statusCode).toBe(200);
      const updated = db.select().from(inboxItems).where(eq(inboxItems.id, item!.id)).get();
      expect(updated?.replyDraftId).toBeTruthy();
    });
  });

  // --- Worker actor ---------------------------------------------------------

  it("runs the mailbox-inbox tick as the system actor (worker token)", async () => {
    const rawApp = app as unknown as { inject: TuezdayApp["inject"] };
    const res = await rawApp.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/mailbox-inbox/run`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ranAt).toBeTruthy();
  });
});
