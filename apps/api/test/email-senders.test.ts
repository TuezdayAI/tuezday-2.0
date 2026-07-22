import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuezdayApp } from "../src/app";
import {
  OutboundEmailProviderError,
  type OutboundEmailDomain,
  type OutboundEmailMessage,
  type OutboundEmailProvider,
  type OutboundEmailSendResult,
} from "../src/outbound-email/provider";
import { buildAuthedApp, createTestDb } from "./helpers";

function providerDomain(
  id: string,
  name: string,
  overrides: Partial<OutboundEmailDomain> = {},
): OutboundEmailDomain {
  return {
    provider: "resend",
    id,
    name,
    status: "not_started",
    dnsRecords: [
      {
        name: `send.${name}`,
        type: "TXT",
        value: "resend-verification=public-value",
        priority: null,
        status: "pending",
      },
    ],
    sendingEnabled: false,
    ...overrides,
  };
}

class FakeOutboundEmailProvider implements OutboundEmailProvider {
  readonly created: string[] = [];
  readonly verified: string[] = [];
  current = providerDomain("domain_1", "example.com");
  getError: OutboundEmailProviderError | null = null;

  async createDomain(domain: string): Promise<OutboundEmailDomain> {
    this.created.push(domain);
    this.current = providerDomain(`domain_${this.created.length}`, domain);
    return this.current;
  }

  async verifyDomain(domainId: string): Promise<void> {
    this.verified.push(domainId);
  }

  async getDomain(): Promise<OutboundEmailDomain> {
    if (this.getError) throw this.getError;
    return this.current;
  }

  async send(_message: OutboundEmailMessage): Promise<OutboundEmailSendResult> {
    throw new Error("Not used in sender lifecycle tests");
  }
}

describe("workspace email sender domains", () => {
  let app: TuezdayApp;
  let provider: FakeOutboundEmailProvider;
  let workspaceId: string;

  beforeEach(async () => {
    provider = new FakeOutboundEmailProvider();
    app = await buildAuthedApp({ db: createTestDb(), outboundEmail: provider });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function putSender(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/email-sender`,
      payload: {
        domain: "example.com",
        fromLocalPart: "hello",
        fromName: "Acme",
        replyTo: "founder@example.com",
        ...overrides,
      },
    });
  }

  it("returns null before a sender has been configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/email-sender`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("creates a pending provider domain and stores only public DNS records", async () => {
    const response = await putSender();
    expect(response.statusCode).toBe(200);
    expect(provider.created).toEqual(["example.com"]);
    expect(response.json()).toMatchObject({
      workspaceId,
      domain: "example.com",
      fromAddress: "hello@example.com",
      replyTo: "founder@example.com",
      status: "pending",
      provider: "resend",
      providerDomainId: "domain_1",
      killSwitch: true,
      dailyCap: 100,
      dnsRecords: [
        {
          name: "send.example.com",
          type: "TXT",
          value: "resend-verification=public-value",
          status: "pending",
        },
      ],
    });
    expect(response.body).not.toContain("secret");
  });

  it("verifies, refreshes, and retains verification for edits on the same domain", async () => {
    expect((await putSender()).json().status).toBe("pending");

    const verification = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/email-sender/verify`,
    });
    expect(verification.statusCode).toBe(200);
    expect(verification.json().status).toBe("pending");
    expect(provider.verified).toEqual(["domain_1"]);

    provider.current = providerDomain("domain_1", "example.com", {
      status: "verified",
      sendingEnabled: true,
      dnsRecords: [],
    });
    const refreshed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/email-sender/refresh`,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().status).toBe("verified");

    const edited = await putSender({
      fromLocalPart: "updates",
      fromName: "Acme Team",
      replyTo: null,
    });
    expect(edited.json()).toMatchObject({
      status: "verified",
      providerDomainId: "domain_1",
      fromAddress: "updates@example.com",
      fromName: "Acme Team",
      replyTo: null,
    });
    expect(provider.created).toEqual(["example.com"]);

    const replaced = await putSender({ domain: "news.example.com" });
    expect(replaced.json()).toMatchObject({
      domain: "news.example.com",
      status: "pending",
      providerDomainId: "domain_2",
    });
    expect(provider.created).toEqual(["example.com", "news.example.com"]);
  });

  it("does not mark a provider-verified domain ready until sending is enabled", async () => {
    await putSender();
    provider.current = providerDomain("domain_1", "example.com", {
      status: "verified",
      sendingEnabled: false,
    });

    const response = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/email-sender/refresh`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("pending");
  });

  it("persists refresh failures and can recover on the next provider check", async () => {
    await putSender();
    provider.getError = new OutboundEmailProviderError("Provider temporarily unavailable", {
      status: 503,
      code: "provider_unavailable",
      retryable: true,
    });

    const failed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/email-sender/refresh`,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: "provider_unavailable", retryable: true });

    const storedFailure = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/email-sender`,
    });
    expect(storedFailure.json()).toMatchObject({
      status: "failed",
      lastError: "Provider temporarily unavailable",
    });

    provider.getError = null;
    provider.current = providerDomain("domain_1", "example.com", {
      status: "verified",
      sendingEnabled: true,
    });
    const recovered = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/email-sender/refresh`,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ status: "verified", lastError: null });
  });

  it("validates sender input before calling the provider", async () => {
    const response = await putSender({ domain: "https://example.com", fromLocalPart: "x@y" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_input");
    expect(provider.created).toHaveLength(0);
  });
});
