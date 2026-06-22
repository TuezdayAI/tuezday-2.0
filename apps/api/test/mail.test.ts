import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import { ConsoleMailer, ResendMailer, type Mailer, type MailMessage } from "../src/mail/mailer";
import { buildAuthedApp, createTestDb } from "./helpers";

function recordingMailer(sent: MailMessage[], throws = false): Mailer {
  return {
    async send(message) {
      if (throws) throw new Error("smtp down");
      sent.push(message);
      return { delivered: true, id: "fake-1", detail: "captured" };
    },
  };
}

describe("transactional mail", () => {
  let app: TuezdayApp;
  let sent: MailMessage[];
  let workspaceId: string;

  async function build(mailer: Mailer): Promise<void> {
    app = await buildAuthedApp({ db: createTestDb(), mailer });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Mailers" } })
    ).json().id;
  }

  beforeEach(() => {
    sent = [];
  });

  afterEach(async () => {
    await app.close();
  });

  it("sends a test transactional email through the mailer seam", async () => {
    await build(recordingMailer(sent));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/mail/test`,
      payload: { to: "founder@test.dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "founder@test.dev" });
    expect(sent[0]!.subject).toContain("Mailers");
  });

  it("rejects an invalid test recipient", async () => {
    await build(recordingMailer(sent));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/mail/test`,
      payload: { to: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("emails the invite link when a teammate is invited", async () => {
    await build(recordingMailer(sent));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/invites`,
      payload: { email: "teammate@test.dev" },
    });
    expect(res.statusCode).toBe(201);
    const token = res.json().token;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("teammate@test.dev");
    expect(sent[0]!.subject).toContain("Mailers");
    expect(sent[0]!.text).toContain(`/invites/${token}`);
  });

  it("still creates the invite when the mailer throws (best-effort)", async () => {
    await build(recordingMailer(sent, true));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/invites`,
      payload: { email: "teammate2@test.dev" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe("teammate2@test.dev");
    expect(sent).toHaveLength(0);
  });
});

describe("ConsoleMailer", () => {
  it("reports delivered with no id", async () => {
    const result = await new ConsoleMailer().send({ to: "x@y.z", subject: "Hi", text: "Body" });
    expect(result).toEqual({
      delivered: true,
      id: null,
      detail: expect.stringContaining("console"),
    });
  });
});

describe("ResendMailer", () => {
  interface Recorded {
    url: string;
    headers: Record<string, string>;
    body: string;
  }

  function fetcherFor(recorded: Recorded[], status: number, responseBody: string): typeof fetch {
    return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      recorded.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response(responseBody, { status });
    }) as typeof fetch;
  }

  it("POSTs the message to Resend and returns the id on success", async () => {
    const recorded: Recorded[] = [];
    const mailer = new ResendMailer(
      "re_key",
      "Tuezday <noreply@tuezday.dev>",
      fetcherFor(recorded, 200, JSON.stringify({ id: "re_123" })),
    );
    const result = await mailer.send({ to: "a@b.c", subject: "Subject", text: "Body" });
    expect(result).toMatchObject({ delivered: true, id: "re_123" });
    expect(recorded[0]!.url).toBe("https://api.resend.com/emails");
    expect(recorded[0]!.headers.authorization).toBe("Bearer re_key");
    const body = JSON.parse(recorded[0]!.body);
    expect(body).toMatchObject({
      from: "Tuezday <noreply@tuezday.dev>",
      to: "a@b.c",
      subject: "Subject",
      text: "Body",
    });
  });

  it("reports a non-2xx response as not delivered", async () => {
    const recorded: Recorded[] = [];
    const mailer = new ResendMailer(
      "re_key",
      "Tuezday <noreply@tuezday.dev>",
      fetcherFor(recorded, 422, "invalid sender"),
    );
    const result = await mailer.send({ to: "a@b.c", subject: "S", text: "B" });
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("422");
  });
});
