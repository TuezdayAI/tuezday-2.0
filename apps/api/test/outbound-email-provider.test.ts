import { afterEach, describe, expect, it } from "vitest";
import {
  OutboundEmailProviderError,
  type OutboundEmailMessage,
} from "../src/outbound-email/provider";
import {
  ResendOutboundEmailProvider,
  createOutboundEmailProviderFromEnv,
} from "../src/outbound-email/resend";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetcher(
  responses: Array<{ status: number; body?: unknown }>,
): { calls: RecordedCall[]; fetcher: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected provider request");
    return new Response(response.body === undefined ? undefined : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

function message(overrides: Partial<OutboundEmailMessage> = {}): OutboundEmailMessage {
  return {
    from: "Acme <hello@example.com>",
    replyTo: "founder@example.com",
    to: "lead@buyer.com",
    subject: "A useful introduction",
    text: "Hello from Acme.",
    html: "<p>Hello from Acme.</p>",
    idempotencyKey: "send/action-id",
    ...overrides,
  };
}

describe("ResendOutboundEmailProvider", () => {
  const originalApiKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
  });

  it("creates a domain and projects only its public verification state", async () => {
    const { calls, fetcher } = recordingFetcher([
      {
        status: 201,
        body: {
          id: "domain_123",
          name: "example.com",
          status: "not_started",
          records: [
            {
              record: "SPF",
              name: "send.example.com",
              type: "TXT",
              value: "v=spf1 include:amazonses.com ~all",
              priority: null,
              status: "pending",
              ttl: "Auto",
            },
          ],
          capabilities: { sending: "disabled", receiving: "disabled" },
          secret: "must-not-escape",
        },
      },
    ]);

    const domain = await new ResendOutboundEmailProvider("re_platform", fetcher).createDomain(
      "example.com",
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.resend.com/domains",
    });
    expect(calls[0]!.headers.Authorization).toBe("Bearer re_platform");
    expect(JSON.parse(calls[0]!.body)).toEqual({ name: "example.com" });
    expect(domain).toEqual({
      provider: "resend",
      id: "domain_123",
      name: "example.com",
      status: "not_started",
      dnsRecords: [
        {
          name: "send.example.com",
          type: "TXT",
          value: "v=spf1 include:amazonses.com ~all",
          priority: null,
          status: "pending",
        },
      ],
      sendingEnabled: false,
    });
  });

  it("starts verification and reads the current domain state", async () => {
    const { calls, fetcher } = recordingFetcher([
      { status: 200, body: { id: "domain_123" } },
      {
        status: 200,
        body: {
          id: "domain_123",
          name: "example.com",
          status: "verified",
          records: [],
          capabilities: { sending: "enabled" },
        },
      },
    ]);
    const provider = new ResendOutboundEmailProvider("re_platform", fetcher);

    await provider.verifyDomain("domain_123");
    const domain = await provider.getDomain("domain_123");

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.resend.com/domains/domain_123/verify",
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: "https://api.resend.com/domains/domain_123",
    });
    expect(domain).toMatchObject({ status: "verified", sendingEnabled: true });
  });

  it("sends governed email with an action-derived idempotency key", async () => {
    const { calls, fetcher } = recordingFetcher([
      { status: 200, body: { id: "email_123" } },
    ]);
    const result = await new ResendOutboundEmailProvider("re_platform", fetcher).send(message());

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.resend.com/emails",
    });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("send/action-id");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      from: "Acme <hello@example.com>",
      to: ["lead@buyer.com"],
      reply_to: "founder@example.com",
      subject: "A useful introduction",
      text: "Hello from Acme.",
      html: "<p>Hello from Acme.</p>",
    });
    expect(result).toMatchObject({ provider: "resend", messageId: "email_123" });
    expect(result.acceptedAt).toBeGreaterThan(0);
  });

  it("omits nullable provider fields instead of sending null", async () => {
    const { calls, fetcher } = recordingFetcher([
      { status: 200, body: { id: "email_text_only" } },
    ]);

    await new ResendOutboundEmailProvider("re_platform", fetcher).send(
      message({ replyTo: null, html: null }),
    );

    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("reply_to");
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("html");
  });

  it("rejects idempotency keys beyond Resend's limit before making a request", async () => {
    const { calls, fetcher } = recordingFetcher([]);
    const provider = new ResendOutboundEmailProvider("re_platform", fetcher);

    await expect(provider.send(message({ idempotencyKey: "x".repeat(257) }))).rejects.toMatchObject({
      name: "OutboundEmailProviderError",
      status: 400,
      code: "invalid_idempotency_key",
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["concurrent_idempotent_requests", true],
    ["invalid_idempotent_request", false],
  ])("maps Resend's %s conflict with retryable=%s", async (code, retryable) => {
    const { fetcher } = recordingFetcher([
      { status: 409, body: { name: code, message: "Idempotency conflict" } },
    ]);

    await expect(
      new ResendOutboundEmailProvider("re_platform", fetcher).send(message()),
    ).rejects.toMatchObject({
      name: "OutboundEmailProviderError",
      status: 409,
      code,
      retryable,
    });
  });

  it("requires a provider message id even when Resend returns 2xx", async () => {
    const { fetcher } = recordingFetcher([{ status: 200, body: {} }]);

    await expect(
      new ResendOutboundEmailProvider("re_platform", fetcher).send(message()),
    ).rejects.toMatchObject({
      name: "OutboundEmailProviderError",
      status: 200,
      code: "missing_message_id",
      retryable: false,
    });
  });

  it("creates the provider from the platform environment only when configured", () => {
    const { fetcher } = recordingFetcher([]);
    delete process.env.RESEND_API_KEY;
    expect(createOutboundEmailProviderFromEnv(fetcher)).toBeUndefined();

    process.env.RESEND_API_KEY = " re_platform ";
    expect(createOutboundEmailProviderFromEnv(fetcher)).toBeInstanceOf(
      ResendOutboundEmailProvider,
    );
  });

  it("exposes typed provider errors to coordinators", () => {
    const error = new OutboundEmailProviderError("Provider failed", {
      status: 503,
      code: "provider_unavailable",
      retryable: true,
    });
    expect(error).toMatchObject({
      name: "OutboundEmailProviderError",
      status: 503,
      code: "provider_unavailable",
      retryable: true,
    });
  });
});
