import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outreachSequenceSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  connections,
  drafts,
  emailRecipientPermissions,
  emailSuppressions,
  inboxItems,
  outreachEnrollments,
  outreachMessages,
} from "../src/db/schema";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import type {
  GmailMailboxProvider,
  GmailMessage,
  GmailSendInput,
  GmailSendResult,
} from "../src/outbound-email/gmail";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const WORKER_TOKEN = "outreach-worker-token";

let generateFails = false;

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      if (generateFails) throw new GatewayError("provider_error", "boom");
      const to = /To: ([^\n]+)/.exec(prompt)?.[1] ?? "you";
      // Follow-up prompts include prior bodies + a "do not repeat" instruction.
      const followup = /follow|do not repeat|previous/i.test(prompt) ? " (follow-up)" : "";
      return {
        text: `Subject: For ${to}${followup}\n\nHello there.${followup}`,
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
}

class FakeGmailProvider implements GmailMailboxProvider {
  address = "sales@gmail.com";
  sends: GmailSendInput[] = [];
  sendEmail = vi.fn(async (_c: string, input: GmailSendInput): Promise<GmailSendResult> => {
    this.sends.push(input);
    return {
      messageId: `msg_${randomUUID()}`,
      threadId: input.threadId ?? `thread_${randomUUID()}`,
    };
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

describe("outreach sequences (Sprint 48)", () => {
  let app: TuezdayApp;
  let db: Db;
  let gmail: FakeGmailProvider;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    generateFails = false;
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "unsub");
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    db = createTestDb();
    gmail = new FakeGmailProvider();
    app = await buildAuthedApp({ db, llm: fakeGateway(), gmail, workerToken: WORKER_TOKEN });
    workspaceId = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "WS" } })).json().id;
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/brain/soul`, payload: { content: "We ship." } });
    // scheduled_auto so the campaign-scoped send policy permits autonomous
    // dispatch — outreach sends are governed by the campaign policy too.
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Q3", objective: "Demos", automationMode: "scheduled_auto" },
      })
    ).json().id;
    personaId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/personas`, payload: { name: "CEO" } })
    ).json().id;
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  function seedMailboxConnection(): string {
    const id = randomUUID();
    const now = Date.now();
    db.insert(connections).values({
      id,
      workspaceId,
      providerKey: "gmail",
      nangoConnectionId: `nango_${id}`,
      configJson: "{}",
      displayName: "Gmail",
      status: "connected",
      contentProfileJson: "{}",
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  async function createMailbox(address: string): Promise<string> {
    gmail.address = address;
    const connectionId = seedMailboxConnection();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/mailboxes`,
      payload: { connectionId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createLead(email: string, name = "Lead"): Promise<string> {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name, email, company: "Acme", role: "VP" },
      })
    ).json().id;
  }

  async function staticAudience(leadIds: string[]): Promise<string> {
    const audienceId = (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/audiences`, payload: { name: "A", kind: "static" } })
    ).json().id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`,
      payload: { members: leadIds.map((id) => ({ type: "lead", id })) },
    });
    return audienceId;
  }

  function allowRecipient(email: string): void {
    db.insert(emailRecipientPermissions).values({
      id: randomUUID(),
      workspaceId,
      normalizedEmail: email.toLowerCase(),
      status: "allowed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();
  }

  async function makeSequence(opts: {
    audienceId: string;
    mailboxIds: string[];
    steps?: { stepNumber: number; instruction: string; delayHours: number }[];
    automationMode?: string;
    activate?: boolean;
  }): Promise<string> {
    const seqId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outreach-sequences`,
        payload: {
          campaignId,
          personaId,
          audienceId: opts.audienceId,
          name: "Seq",
          automationMode: opts.automationMode ?? "scheduled_auto",
        },
      })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/steps`,
      payload: { steps: opts.steps ?? [{ stepNumber: 1, instruction: "", delayHours: 0 }] },
    });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`,
      payload: { mailboxIds: opts.mailboxIds },
    });
    if (opts.activate !== false) {
      const act = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
      expect(act.statusCode).toBe(200);
    }
    return seqId;
  }

  async function run() {
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach/run` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  function enrollmentsFor(seqId: string) {
    return db.select().from(outreachEnrollments).where(eq(outreachEnrollments.sequenceId, seqId)).all();
  }

  // --- CRUD & activation ----------------------------------------------------

  it("creates a sequence and validates activation", async () => {
    const seqId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outreach-sequences`,
        payload: { campaignId, personaId, audienceId: await staticAudience([]), name: "Seq" },
      })
    ).json().id;
    const seq = (await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}` })).json();
    expect(outreachSequenceSchema.safeParse(seq).success).toBe(true);

    // No steps, no mailbox → activation blocked.
    const noSteps = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
    expect(noSteps.statusCode).toBe(409);
  });

  it("rejects a mailbox pool with a non-connected mailbox", async () => {
    const audienceId = await staticAudience([]);
    const seqId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outreach-sequences`,
        payload: { campaignId, personaId, audienceId, name: "Seq" },
      })
    ).json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`,
      payload: { mailboxIds: [randomUUID()] },
    });
    expect(res.statusCode).toBe(409);
  });

  // --- Enrollment + guardrails ---------------------------------------------

  it("auto-enrolls segment members and assigns a pooled mailbox", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId] });

    const result = await run();
    expect(result.enrolled).toBe(1);
    const [enr] = enrollmentsFor(seqId);
    expect(enr!.recipientEmail).toBe("a@acme.io");
    expect(enr!.mailboxId).toBe(mailboxId);
  });

  it("skips suppressed, globally-locked, and over-cap members", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const a = await createLead("a@acme.io");
    const b = await createLead("b@acme.io");
    allowRecipient("a@acme.io");
    // b is suppressed
    db.insert(emailSuppressions).values({ id: randomUUID(), workspaceId, normalizedEmail: "b@acme.io", reason: "unsubscribe", createdAt: Date.now() }).run();

    // Manual sequences hold enrollments active so the global lock is observable.
    const seq1 = await makeSequence({ audienceId: await staticAudience([a, b]), mailboxIds: [mailboxId], automationMode: "manual" });
    const r1 = await run();
    expect(r1.enrolled).toBe(1); // a only (b suppressed)
    expect(enrollmentsFor(seq1)).toHaveLength(1);

    const seq2 = await makeSequence({ audienceId: await staticAudience([a]), mailboxIds: [mailboxId], automationMode: "manual" });
    await run();
    expect(enrollmentsFor(seq2)).toHaveLength(0); // a is already active elsewhere
  });

  it("honors the per-sequence daily enrollment cap", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leads = [];
    for (let i = 0; i < 3; i++) {
      const id = await createLead(`c${i}@acme.io`);
      allowRecipient(`c${i}@acme.io`);
      leads.push(id);
    }
    const seqId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outreach-sequences`,
        payload: { campaignId, personaId, audienceId: await staticAudience(leads), name: "Capped", automationMode: "manual", dailyEnrollmentCap: 2 },
      })
    ).json().id;
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/steps`, payload: { steps: [{ stepNumber: 1, instruction: "", delayHours: 0 }] } });
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`, payload: { mailboxIds: [mailboxId] } });
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });

    const result = await run();
    expect(result.enrolled).toBe(2); // capped
    expect(enrollmentsFor(seqId)).toHaveLength(2);
  });

  // --- Dispatch by automation mode -----------------------------------------

  it("scheduled_auto generates, auto-approves, and sends from the mailbox", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId] });

    const result = await run();
    expect(result.dispatched).toBe(1);
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    expect(enrollmentsFor(seqId)[0]!.lastThreadId).toBeTruthy(); // threaded on send
    await run(); // completion is finalized on the tick after the last send
    expect(enrollmentsFor(seqId)[0]!.status).toBe("completed");
  });

  it("human_in_the_loop waits for approval before sending", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId], automationMode: "human_in_the_loop" });

    await run();
    expect(gmail.sendEmail).not.toHaveBeenCalled(); // pending review
    const msg = db.select().from(outreachMessages).where(eq(outreachMessages.workspaceId, workspaceId)).get();
    expect(msg!.status).toBe("pending");

    // Approve the draft, then a second run dispatches it.
    await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/drafts/${msg!.draftId}/approve` });
    await run();
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    void seqId;
  });

  it("manual mode enrolls but never sends", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId], automationMode: "manual" });

    const result = await run();
    expect(result.enrolled).toBe(1);
    expect(result.generated).toBe(0);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    expect(enrollmentsFor(seqId)[0]!.status).toBe("active");
  });

  // --- Follow-ups + stop-on-reply ------------------------------------------

  it("fires a follow-up on delay, threaded, without repeating", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({
      audienceId: await staticAudience([leadId]),
      mailboxIds: [mailboxId],
      steps: [
        { stepNumber: 1, instruction: "", delayHours: 0 },
        { stepNumber: 2, instruction: "bump it", delayHours: 0 },
      ],
    });

    await run(); // step 1 sends
    await run(); // step 2 due (delay 0) → sends, threaded into step 1
    expect(gmail.sendEmail).toHaveBeenCalledTimes(2);
    expect(gmail.sends[1]!.threadId).toBeTruthy();
    await run(); // completion tick
    expect(enrollmentsFor(seqId)[0]!.status).toBe("completed");
  });

  it("stops the chain when the recipient replies", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({
      audienceId: await staticAudience([leadId]),
      mailboxIds: [mailboxId],
      steps: [
        { stepNumber: 1, instruction: "", delayHours: 0 },
        { stepNumber: 2, instruction: "bump", delayHours: 0 },
      ],
    });
    await run(); // step 1 sends
    const enr = enrollmentsFor(seqId)[0]!;
    // Seed an inbound email reply from the recipient after the send.
    db.insert(inboxItems).values({
      id: randomUUID(),
      workspaceId,
      connectionId: seedMailboxConnection(),
      providerKey: "gmail",
      kind: "email",
      channel: "email",
      externalId: `in_${randomUUID()}`,
      authorHandle: "a@acme.io",
      authorName: "A",
      content: "interested!",
      status: "unread",
      externalCreatedAt: (enr.lastSentAt ?? Date.now()) + 1000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();

    await run(); // should detect the reply and stop
    const after = enrollmentsFor(seqId)[0]!;
    expect(after.status).toBe("replied");
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1); // step 2 never sent
  });

  it("lets a leaver finish the chain (removed from segment mid-sequence)", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const audienceId = await staticAudience([leadId]);
    const seqId = await makeSequence({
      audienceId,
      mailboxIds: [mailboxId],
      steps: [
        { stepNumber: 1, instruction: "", delayHours: 0 },
        { stepNumber: 2, instruction: "bump", delayHours: 0 },
      ],
    });
    await run(); // step 1 sends, enrolled
    // Remove from the segment.
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/audiences/${audienceId}/members`, payload: { members: [] } });
    await run(); // step 2 still fires despite the leave
    expect(gmail.sendEmail).toHaveBeenCalledTimes(2);
    await run(); // completion tick
    expect(enrollmentsFor(seqId)[0]!.status).toBe("completed");
  });

  // --- Manual stop + Gmail-only + worker -----------------------------------

  it("manual stop halts an active enrollment", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({
      audienceId: await staticAudience([leadId]),
      mailboxIds: [mailboxId],
      automationMode: "manual",
    });
    await run();
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/stop`, payload: { all: true } });
    expect(res.json().stopped).toBe(1);
    expect(enrollmentsFor(seqId)[0]!.status).toBe("stopped");
  });

  it("sends for a Gmail-only workspace (no Resend sender row)", async () => {
    // No workspaceEmailSenders row is ever inserted here — the mailbox presence
    // enables email (decision 4). Recipient permission is still required.
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId] });
    const result = await run();
    expect(result.dispatched).toBe(1);
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("runs the outreach tick as the system actor (worker token)", async () => {
    const res = await (app as TuezdayApp).inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outreach/run`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ranAt).toBeTruthy();
  });

  it("leaves items unsent when generation fails, without aborting the run", async () => {
    const mailboxId = await createMailbox("sales@gmail.com");
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId] });
    generateFails = true;
    const result = await run();
    expect(result.enrolled).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(gmail.sendEmail).not.toHaveBeenCalled();
    // The enrollment survives for the next tick.
    expect(enrollmentsFor(seqId)[0]!.status).toBe("active");
  });
});
