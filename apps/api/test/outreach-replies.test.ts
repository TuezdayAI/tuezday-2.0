import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  connections,
  emailRecipientPermissions,
  emailSuppressions,
  inboxItems,
  notificationChannels,
  outreachEnrollments,
} from "../src/db/schema";
import { type LlmGateway } from "../src/llm/gateway";
import type {
  GmailMailboxProvider,
  GmailMessage,
  GmailSendInput,
  GmailSendResult,
} from "../src/outbound-email/gmail";
import type { Mailer, MailMessage } from "../src/mail/mailer";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";
import { parseOooResumeAt } from "../src/services/outreach-engine";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      const to = /To: ([^\n]+)/.exec(prompt)?.[1] ?? "you";
      return { text: `Subject: For ${to}\n\nHello.`, model: "fake", provider: "fake", durationMs: 1 };
    },
  };
}

class FakeGmailProvider implements GmailMailboxProvider {
  address = "sales@gmail.com";
  sends: GmailSendInput[] = [];
  sendEmail = vi.fn(async (_c: string, input: GmailSendInput): Promise<GmailSendResult> => {
    this.sends.push(input);
    return { messageId: `msg_${randomUUID()}`, threadId: input.threadId ?? `thread_${randomUUID()}` };
  });
  async listInboundSince() {
    return [];
  }
  async getMessage(): Promise<GmailMessage> {
    throw new Error("unused");
  }
  async getProfile() {
    return { emailAddress: this.address };
  }
}

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  send = vi.fn(async (message: MailMessage) => {
    this.sent.push(message);
    return { delivered: true, id: `m_${randomUUID()}`, detail: "ok" };
  });
}

describe("outreach reply-driven actions + compliance (Sprint 49)", () => {
  let app: TuezdayApp;
  let db: Db;
  let gmail: FakeGmailProvider;
  let mailer: FakeMailer;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "unsub");
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    db = createTestDb();
    gmail = new FakeGmailProvider();
    mailer = new FakeMailer();
    app = await buildAuthedApp({ db, llm: fakeGateway(), gmail, mailer, workerToken: "wt" });
    workspaceId = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "WS" } })).json().id;
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/brain/soul`, payload: { content: "We ship." } });
    campaignId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/campaigns`, payload: { name: "Q3", objective: "Demos", automationMode: "scheduled_auto" } })
    ).json().id;
    personaId = (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/personas`, payload: { name: "CEO" } })).json().id;
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  function setCompliance(address = "Acme, 1 Market St, SF CA"): Promise<unknown> {
    return app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/compliance`, payload: { postalAddress: address } });
  }

  function seedGmailConnection(): string {
    const id = randomUUID();
    const now = Date.now();
    db.insert(connections).values({
      id, workspaceId, providerKey: "gmail", nangoConnectionId: `nango_${id}`, configJson: "{}",
      displayName: "Gmail", status: "connected", contentProfileJson: "{}", createdAt: now, updatedAt: now,
    }).run();
    return id;
  }

  async function createMailbox(): Promise<string> {
    const connectionId = seedGmailConnection();
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/mailboxes`, payload: { connectionId } });
    return res.json().id as string;
  }

  function allow(email: string): void {
    db.insert(emailRecipientPermissions).values({
      id: randomUUID(), workspaceId, normalizedEmail: email.toLowerCase(), status: "allowed", createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
  }

  async function activeSequence(email: string, steps = 2): Promise<{ seqId: string; enrollmentId: string }> {
    const mailboxId = await createMailbox();
    const leadId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/leads`, payload: { name: "Lead", email, company: "Acme", role: "VP" } })
    ).json().id;
    const audienceId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences`, payload: { name: "A", kind: "static" } })
    ).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`, payload: { members: [{ type: "lead", id: leadId }] } });
    allow(email);
    await setCompliance();
    const seqId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences`, payload: { campaignId, personaId, audienceId, name: "Seq", automationMode: "scheduled_auto" } })
    ).json().id;
    const stepDefs = Array.from({ length: steps }, (_, i) => ({ stepNumber: i + 1, instruction: i ? "bump" : "", delayHours: 0 }));
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/steps`, payload: { steps: stepDefs } });
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`, payload: { mailboxIds: [mailboxId] } });
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
    await run(); // step 1 sends → enrollment active
    const enr = db.select().from(outreachEnrollments).where(eq(outreachEnrollments.sequenceId, seqId)).get()!;
    return { seqId, enrollmentId: enr.id };
  }

  async function run() {
    return (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach/run` })).json();
  }

  function seedReply(email: string, label: string | null, sinceMs: number, body = "hi"): void {
    db.insert(inboxItems).values({
      id: randomUUID(), workspaceId, connectionId: seedGmailConnection(), providerKey: "gmail",
      kind: "email", channel: "email", externalId: `in_${randomUUID()}`, authorHandle: email, authorName: "R",
      content: body, status: "unread", replyLabel: label, replyLabeledAt: label ? Date.now() : null,
      externalCreatedAt: sinceMs + 1000, createdAt: Date.now(), updatedAt: Date.now(),
    }).run();
  }

  function enrollment(seqId: string) {
    return db.select().from(outreachEnrollments).where(eq(outreachEnrollments.sequenceId, seqId)).get()!;
  }

  // --- Compliance -----------------------------------------------------------

  it("blocks activation without a postal address, then allows it once set", async () => {
    const mailboxId = await createMailbox();
    const leadId = (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/leads`, payload: { name: "L", email: "a@acme.io" } })).json().id;
    const audienceId = (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences`, payload: { name: "A", kind: "static" } })).json().id;
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`, payload: { members: [{ type: "lead", id: leadId }] } });
    const seqId = (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences`, payload: { campaignId, personaId, audienceId, name: "S" } })).json().id;
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/steps`, payload: { steps: [{ stepNumber: 1, instruction: "", delayHours: 0 }] } });
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`, payload: { mailboxIds: [mailboxId] } });

    const blocked = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("compliance_address_missing");

    await setCompliance();
    const ok = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
    expect(ok.statusCode).toBe(200);
  });

  it("puts the postal address + unsubscribe link in the send body", async () => {
    await activeSequence("a@acme.io", 1);
    const body = gmail.sends[0]!.text;
    expect(body).toContain("Unsubscribe: https://app.test/u/");
    expect(body).toContain("Acme, 1 Market St, SF CA");
  });

  // --- Reply-driven actions -------------------------------------------------

  it("unsubscribe reply → suppresses + stops", async () => {
    const { seqId } = await activeSequence("a@acme.io");
    seedReply("a@acme.io", "unsubscribe_request", enrollment(seqId).lastSentAt!);
    const result = await run();
    expect(result.stopped).toBe(1);
    expect(enrollment(seqId).status).toBe("stopped");
    expect(enrollment(seqId).stoppedReason).toBe("unsubscribed");
    const sup = db.select().from(emailSuppressions).where(eq(emailSuppressions.workspaceId, workspaceId)).all();
    expect(sup.some((s) => s.normalizedEmail === "a@acme.io")).toBe(true);
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1); // step 2 never sent
  });

  it("bounce reply → suppresses + fails the enrollment", async () => {
    const { seqId } = await activeSequence("a@acme.io");
    seedReply("a@acme.io", "bounce", enrollment(seqId).lastSentAt!);
    await run();
    expect(enrollment(seqId).status).toBe("failed");
    expect(enrollment(seqId).stoppedReason).toBe("bounced");
    const sup = db.select().from(emailSuppressions).where(eq(emailSuppressions.workspaceId, workspaceId)).all();
    expect(sup.some((s) => s.normalizedEmail === "a@acme.io" && s.reason === "bounce")).toBe(true);
  });

  it("positive reply → stops + notifies (email channel)", async () => {
    // Configure an email notification channel.
    db.insert(notificationChannels).values({ id: randomUUID(), workspaceId, type: "email", target: "founder@me.io", enabled: true, createdAt: Date.now() }).run();
    const { seqId } = await activeSequence("a@acme.io");
    seedReply("a@acme.io", "positive", enrollment(seqId).lastSentAt!, "Very interested, let's talk!");
    await run();
    expect(enrollment(seqId).status).toBe("replied");
    expect(mailer.send).toHaveBeenCalled();
    expect(mailer.sent.some((m) => m.to === "founder@me.io" && /positive reply/i.test(m.subject))).toBe(true);
  });

  it("out-of-office reply → pauses (not stopped) and resumes when no newer reply", async () => {
    const { seqId } = await activeSequence("a@acme.io");
    const sentAt = enrollment(seqId).lastSentAt!;
    seedReply("a@acme.io", "out_of_office", sentAt, "I am out of office until next week.");
    await run();
    const paused = enrollment(seqId);
    expect(paused.status).toBe("active"); // NOT stopped
    expect(paused.nextDueAt!).toBeGreaterThan(Date.now()); // parked in the future
    expect(paused.lastReplyHandledAt).toBeTruthy();
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1); // step 2 not sent during the pause
  });

  it("unclassified reply still stops the chain (safe default)", async () => {
    const { seqId } = await activeSequence("a@acme.io");
    seedReply("a@acme.io", null, enrollment(seqId).lastSentAt!);
    await run();
    expect(enrollment(seqId).status).toBe("replied");
  });

  // --- Suppression import ---------------------------------------------------

  it("imports a suppression list, dedupes, and blocks a later send", async () => {
    await setCompliance();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/suppressions/import`,
      payload: { emails: ["Blocked@Acme.io", "blocked@acme.io", "not-an-email"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(1); // one unique valid; dup + invalid skipped
    expect(res.json().skipped).toBe(2);
    const list = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/suppressions` })).json();
    expect(list.some((s: { normalizedEmail: string }) => s.normalizedEmail === "blocked@acme.io")).toBe(true);
  });

  // --- OOO date parsing -----------------------------------------------------

  it("parseOooResumeAt honors a stated return date, else falls back", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const withDate = parseOooResumeAt("I'll be back on 2026-03-10, contact ops meanwhile.", now);
    expect(withDate).toBeGreaterThan(Date.parse("2026-03-09T00:00:00Z"));
    const noDate = parseOooResumeAt("Away from my desk.", now);
    expect(noDate).toBe(now + 72 * 60 * 60 * 1000);
  });
});
