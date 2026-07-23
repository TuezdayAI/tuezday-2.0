import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outreachFunnelSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  connections,
  emailDeliveries,
  emailRecipientPermissions,
  inboxItems,
  outreachEnrollments,
  outreachTrackingEvents,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import { buildRfc2822, type GmailMailboxProvider, type GmailMessage, type GmailSendInput, type GmailSendResult } from "../src/outbound-email/gmail";
import { createClickToken, createOpenToken, verifyTrackingToken } from "../src/outbound-email/tracking";
import { composeGmailBody } from "../src/services/external-action-email";
import { buildAuthedApp, createTestDb, putActionPolicy } from "./helpers";

const WORKER_TOKEN = "tracking-worker-token";
const LINK = "https://example.com/demo";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      const to = /To: ([^\n]+)/.exec(prompt)?.[1] ?? "you";
      return {
        text: `Subject: For ${to}\n\nHello there. Book a demo: ${LINK}`,
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

// ---------------------------------------------------------------------------
// Pure units: token + body composition (no app, no network)
// ---------------------------------------------------------------------------

describe("tracking tokens (Sprint 50)", () => {
  beforeEach(() => vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "secret"));
  afterEach(() => vi.unstubAllEnvs());

  const ws = randomUUID();
  const deliveryId = randomUUID();

  it("round-trips an open token (deliveryId, no url)", () => {
    const token = createOpenToken(ws, deliveryId);
    const verified = verifyTrackingToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value).toEqual({ workspaceId: ws, deliveryId });
      expect(verified.value.url).toBeUndefined();
    }
  });

  it("round-trips a click token with the url inside the signed payload", () => {
    const token = createClickToken(ws, deliveryId, LINK);
    const verified = verifyTrackingToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value).toEqual({ workspaceId: ws, deliveryId, url: LINK });
  });

  it("is deterministic — identical inputs yield identical tokens (retry-safe)", () => {
    expect(createOpenToken(ws, deliveryId)).toBe(createOpenToken(ws, deliveryId));
    expect(createClickToken(ws, deliveryId, LINK)).toBe(createClickToken(ws, deliveryId, LINK));
  });

  it("rejects a tampered signature", () => {
    const token = createOpenToken(ws, deliveryId);
    const tampered = `${token.slice(0, -1)}${token.at(-1) === "A" ? "B" : "A"}`;
    expect(verifyTrackingToken(tampered).ok).toBe(false);
    expect(verifyTrackingToken("not.a.token").ok).toBe(false);
    expect(verifyTrackingToken("garbage").ok).toBe(false);
  });
});

describe("composeGmailBody (Sprint 50)", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "secret");
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    vi.stubEnv("TRACKING_BASE_URL", "https://track.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  const ws = randomUUID();
  const payload = { to: "a@acme.io", text: `Hello. Book a demo: ${LINK}` };

  it("returns plain text with null html when tracking is off (byte-identical)", () => {
    const plain = composeGmailBody(ws, payload, "Sig", "Acme, 1 Market St");
    expect(plain.html).toBeNull();
    const trackingOff = composeGmailBody(ws, payload, "Sig", "Acme, 1 Market St", {
      deliveryId: randomUUID(),
      trackOpens: false,
      trackClicks: false,
    });
    expect(trackingOff.html).toBeNull();
    // Byte-identical body whether tracking config is absent or fully off.
    expect(trackingOff.text).toBe(plain.text);
    expect(plain.text).toContain(LINK); // plain text keeps the real link
    expect(plain.text).toContain("Unsubscribe:");
  });

  it("emits a tracked HTML alternative (pixel + rewritten link) but leaves the text part untouched", () => {
    const deliveryId = randomUUID();
    const plain = composeGmailBody(ws, payload, "Sig", "");
    const tracked = composeGmailBody(ws, payload, "Sig", "", {
      deliveryId,
      trackOpens: true,
      trackClicks: true,
    });
    // The authorized/stored text body never changes.
    expect(tracked.text).toBe(plain.text);
    expect(tracked.html).not.toBeNull();
    expect(tracked.html!).toContain("https://track.test/t/o/"); // open pixel
    expect(tracked.html!).toContain("https://track.test/t/c/"); // rewritten link
    expect(tracked.html!).toContain("<img");
    expect(tracked.html!).toContain("<a href=");
    // The raw link is not left as a bare, un-rewritten href.
    expect(tracked.html!).not.toContain(`href="${LINK}"`);
  });

  it("with only trackClicks, rewrites links but adds no pixel", () => {
    const tracked = composeGmailBody(ws, payload, "", "", {
      deliveryId: randomUUID(),
      trackOpens: false,
      trackClicks: true,
    });
    expect(tracked.html!).toContain("/t/c/");
    expect(tracked.html!).not.toContain("/t/o/");
  });
});

describe("buildRfc2822 (Sprint 50)", () => {
  const base: GmailSendInput = {
    from: "sales@gmail.com",
    fromName: "Sales",
    to: "a@acme.io",
    subject: "Hi",
    text: "plain body",
    replyTo: null,
  };

  it("stays text/plain and byte-identical when no html is supplied", () => {
    const raw = buildRfc2822(base);
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).not.toContain("multipart/alternative");
    expect(raw.endsWith("plain body")).toBe(true);
  });

  it("emits multipart/alternative with both parts when html is set", () => {
    const raw = buildRfc2822({ ...base, html: "<p>rich</p>" });
    expect(raw).toContain("Content-Type: multipart/alternative; boundary=");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw).toContain("plain body");
    expect(raw).toContain("<p>rich</p>");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: send → track → funnel (fakes, zero network)
// ---------------------------------------------------------------------------

describe("outreach tracking, funnel & outcomes (Sprint 50)", () => {
  let app: TuezdayApp;
  let db: Db;
  let gmail: FakeGmailProvider;
  let workspaceId: string;
  let campaignId: string;
  let personaId: string;

  beforeEach(async () => {
    vi.stubEnv("EMAIL_UNSUBSCRIBE_SECRET", "secret");
    vi.stubEnv("APP_BASE_URL", "https://app.test");
    vi.stubEnv("TRACKING_BASE_URL", "https://track.test");
    db = createTestDb();
    gmail = new FakeGmailProvider();
    app = await buildAuthedApp({ db, llm: fakeGateway(), gmail, workerToken: WORKER_TOKEN });
    workspaceId = (await app.inject({ method: "POST", url: "/workspaces", payload: { name: "WS" } })).json().id;
    await app.inject({ method: "PUT", url: `/workspaces/${workspaceId}/brain/soul`, payload: { content: "We ship." } });
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Q3", objective: "Demos", automationMode: "scheduled_auto" },
      })
    ).json().id;
    personaId = (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/personas`, payload: { name: "CEO" } })).json().id;
    await putActionPolicy(app, workspaceId, "workspace", workspaceId, { send: "autonomous" });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/compliance`,
      payload: { postalAddress: "Acme Inc, 1 Market St, SF CA 94105" },
    });
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

  async function createMailbox(): Promise<string> {
    const connectionId = seedMailboxConnection();
    const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/mailboxes`, payload: { connectionId } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createLead(email: string): Promise<string> {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/leads`,
        payload: { name: "Lead", email, company: "Acme", role: "VP" },
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

  async function makeSequence(opts: { audienceId: string; mailboxIds: string[]; trackOpens?: boolean; trackClicks?: boolean }): Promise<string> {
    const seqId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/outreach-sequences`,
        payload: {
          campaignId,
          personaId,
          audienceId: opts.audienceId,
          name: "Seq",
          automationMode: "scheduled_auto",
          trackOpens: opts.trackOpens ?? false,
          trackClicks: opts.trackClicks ?? false,
        },
      })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/steps`,
      payload: { steps: [{ stepNumber: 1, instruction: "", delayHours: 0 }] },
    });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/mailboxes`,
      payload: { mailboxIds: opts.mailboxIds },
    });
    const act = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/activate` });
    expect(act.statusCode).toBe(200);
    return seqId;
  }

  async function sendOneStep(track: { trackOpens: boolean; trackClicks: boolean }): Promise<{ seqId: string; deliveryId: string; enrollmentId: string }> {
    const mailboxId = await createMailbox();
    const leadId = await createLead("a@acme.io");
    allowRecipient("a@acme.io");
    const seqId = await makeSequence({ audienceId: await staticAudience([leadId]), mailboxIds: [mailboxId], ...track });
    const run = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/outreach/run` });
    expect(run.statusCode).toBe(200);
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1);
    const delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.origin, "outreach_step")).get()!;
    const enrollment = db.select().from(outreachEnrollments).where(eq(outreachEnrollments.sequenceId, seqId)).get()!;
    return { seqId, deliveryId: delivery.id, enrollmentId: enrollment.id };
  }

  it("tracking-on send carries a multipart HTML part with pixel + rewritten links", async () => {
    await sendOneStep({ trackOpens: true, trackClicks: true });
    const sent = gmail.sends[0]!;
    expect(sent.html).toBeTruthy();
    expect(sent.html!).toContain("https://track.test/t/o/");
    expect(sent.html!).toContain("https://track.test/t/c/");
    // The plain-text part keeps the real link (deliverability fallback).
    expect(sent.text).toContain(LINK);
  });

  it("tracking-off send stays plain text (no html part)", async () => {
    await sendOneStep({ trackOpens: false, trackClicks: false });
    const sent = gmail.sends[0]!;
    expect(sent.html).toBeUndefined();
    expect(sent.text).toContain(LINK);
    expect(sent.text).not.toContain("<img");
  });

  it("GET /t/o records an open (counter + event) and returns a 1x1 gif", async () => {
    const { deliveryId } = await sendOneStep({ trackOpens: true, trackClicks: false });
    const token = createOpenToken(workspaceId, deliveryId);
    const res = await app.inject({ method: "GET", url: `/t/o/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(res.headers["cache-control"]).toBe("no-store");
    const delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).get()!;
    expect(delivery.openCount).toBe(1);
    expect(delivery.openedAt).toBeTruthy();
    const events = db.select().from(outreachTrackingEvents).where(eq(outreachTrackingEvents.emailDeliveryId, deliveryId)).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("open");
  });

  it("GET /t/c records a click and 302-redirects to the signed url", async () => {
    const { deliveryId } = await sendOneStep({ trackOpens: false, trackClicks: true });
    const token = createClickToken(workspaceId, deliveryId, LINK);
    const res = await app.inject({ method: "GET", url: `/t/c/${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(LINK);
    const delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).get()!;
    expect(delivery.clickCount).toBe(1);
    expect(delivery.firstClickAt).toBeTruthy();
    const events = db.select().from(outreachTrackingEvents).where(eq(outreachTrackingEvents.type, "click")).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.targetUrl).toBe(LINK);
  });

  it("rejects an open token pointed at /t/c (no open-redirect) and a bad token (no DB write)", async () => {
    const { deliveryId } = await sendOneStep({ trackOpens: true, trackClicks: true });
    // An open token (no url) cannot drive a click redirect.
    const openToken = createOpenToken(workspaceId, deliveryId);
    const noRedirect = await app.inject({ method: "GET", url: `/t/c/${openToken}` });
    expect(noRedirect.statusCode).toBe(400);
    // A garbage token records nothing.
    const bad = await app.inject({ method: "GET", url: `/t/o/not-a-real-token` });
    expect(bad.statusCode).toBe(400);
    const delivery = db.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).get()!;
    expect(delivery.openCount).toBe(0);
    expect(delivery.clickCount).toBe(0);
    expect(db.select().from(outreachTrackingEvents).all()).toHaveLength(0);
  });

  it("assembles the funnel: sent/opened/clicked/replied/positive + manual outcome", async () => {
    const { seqId, deliveryId, enrollmentId } = await sendOneStep({ trackOpens: true, trackClicks: true });

    // Register an open + a click.
    await app.inject({ method: "GET", url: `/t/o/${createOpenToken(workspaceId, deliveryId)}` });
    await app.inject({ method: "GET", url: `/t/c/${createClickToken(workspaceId, deliveryId, LINK)}` });

    // Seed a positive email reply on the delivery.
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
      content: "very interested!",
      status: "unread",
      emailDeliveryId: deliveryId,
      replyLabel: "positive",
      externalCreatedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();

    // Mark the enrollment a meeting through the route.
    const outcome = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/enrollments/${enrollmentId}/outcome`,
      payload: { outcome: "meeting" },
    });
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json().outcome).toBe("meeting");

    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/outreach-sequences/${seqId}/funnel` });
    expect(res.statusCode).toBe(200);
    const funnel = res.json();
    expect(outreachFunnelSchema.safeParse(funnel).success).toBe(true);
    expect(funnel.sent).toBe(1);
    expect(funnel.opened).toBe(1);
    expect(funnel.clicked).toBe(1);
    expect(funnel.replied).toBe(1);
    expect(funnel.positive).toBe(1);
    expect(funnel.meetings).toBe(1);
    expect(funnel.won).toBe(0);
    expect(funnel.openRate).toBe(1);
    expect(funnel.replyRate).toBe(1);
    // Attribution: one step, one persona.
    expect(funnel.attribution.byStep).toHaveLength(1);
    expect(funnel.attribution.byStep[0].sent).toBe(1);
    expect(funnel.attribution.byPersona).toHaveLength(1);
    expect(funnel.attribution.byPersona[0].meetings).toBe(1);
  });

  it("returns 404 for an unknown sequence funnel and outcome target", async () => {
    const funnel = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/outreach-sequences/${randomUUID()}/funnel` });
    expect(funnel.statusCode).toBe(404);
    const outcome = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/outreach-sequences/${randomUUID()}/enrollments/${randomUUID()}/outcome`,
      payload: { outcome: "won" },
    });
    expect(outcome.statusCode).toBe(404);
  });
});
