import {
  OutboundEmailProviderError,
  type OutboundEmailDomain,
  type OutboundEmailMessage,
  type OutboundEmailProvider,
  type OutboundEmailSendResult,
} from "./provider";

type Fetcher = typeof fetch;

const RESEND_API_BASE = "https://api.resend.com";
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

interface ProviderResponse {
  status: number;
  body: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerErrorCode(body: unknown, status: number): string {
  const root = objectValue(body);
  const nested = objectValue(root?.error);
  return (
    stringValue(root?.name) ??
    stringValue(root?.code) ??
    stringValue(nested?.code) ??
    `http_${status}`
  );
}

function providerErrorMessage(body: unknown, status: number): string {
  const root = objectValue(body);
  const nested = objectValue(root?.error);
  return (
    stringValue(root?.message) ??
    stringValue(nested?.message) ??
    `Resend returned HTTP ${status}`
  );
}

function isRetryable(status: number, code: string): boolean {
  if (status === 409 && code === "concurrent_idempotent_requests") return true;
  if (status === 409 && code === "invalid_idempotent_request") return false;
  return status === 408 || status === 429 || status >= 500;
}

function projectDomain(body: unknown, status: number): OutboundEmailDomain {
  const domain = objectValue(body);
  const id = stringValue(domain?.id);
  const name = stringValue(domain?.name);
  if (!domain || !id || !name) {
    throw new OutboundEmailProviderError("Resend returned an invalid domain response", {
      status,
      code: "invalid_domain_response",
      retryable: false,
    });
  }

  const records = Array.isArray(domain.records) ? domain.records : [];
  const dnsRecords = records.flatMap((candidate) => {
    const record = objectValue(candidate);
    const recordName = stringValue(record?.name);
    const type = stringValue(record?.type);
    const value = stringValue(record?.value);
    if (!record || !recordName || !type || !value) return [];
    return [
      {
        name: recordName,
        type,
        value,
        priority:
          typeof record.priority === "number" && Number.isInteger(record.priority)
            ? record.priority
            : null,
        status: stringValue(record.status) ?? "pending",
      },
    ];
  });
  const capabilities = objectValue(domain.capabilities);

  return {
    provider: "resend",
    id,
    name,
    status: stringValue(domain.status) ?? "unknown",
    dnsRecords,
    sendingEnabled: capabilities?.sending === "enabled" || capabilities?.sending === true,
  };
}

export class ResendOutboundEmailProvider implements OutboundEmailProvider {
  private readonly apiKey: string;

  constructor(apiKey: string, private readonly fetcher: Fetcher = fetch) {
    this.apiKey = apiKey.trim();
    if (!this.apiKey) {
      throw new OutboundEmailProviderError("A Resend API key is required", {
        status: null,
        code: "missing_api_key",
        retryable: false,
      });
    }
  }

  private async request(path: string, init: RequestInit): Promise<ProviderResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${RESEND_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new OutboundEmailProviderError("Could not reach Resend", {
        status: null,
        code: "network_error",
        retryable: true,
        cause,
      });
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const code = providerErrorCode(body, response.status);
      throw new OutboundEmailProviderError(providerErrorMessage(body, response.status), {
        status: response.status,
        code,
        retryable: isRetryable(response.status, code),
      });
    }
    return { status: response.status, body };
  }

  async createDomain(domain: string): Promise<OutboundEmailDomain> {
    const response = await this.request("/domains", {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
    return projectDomain(response.body, response.status);
  }

  async verifyDomain(domainId: string): Promise<void> {
    await this.request(`/domains/${encodeURIComponent(domainId)}/verify`, { method: "POST" });
  }

  async getDomain(domainId: string): Promise<OutboundEmailDomain> {
    const response = await this.request(`/domains/${encodeURIComponent(domainId)}`, {
      method: "GET",
    });
    return projectDomain(response.body, response.status);
  }

  async send(message: OutboundEmailMessage): Promise<OutboundEmailSendResult> {
    if (
      message.idempotencyKey.length === 0 ||
      message.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new OutboundEmailProviderError(
        `Idempotency keys must contain 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        {
          status: 400,
          code: "invalid_idempotency_key",
          retryable: false,
        },
      );
    }

    const response = await this.request("/emails", {
      method: "POST",
      headers: { "Idempotency-Key": message.idempotencyKey },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html === null ? {} : { html: message.html }),
        ...(message.replyTo === null ? {} : { reply_to: message.replyTo }),
      }),
    });
    const messageId = stringValue(objectValue(response.body)?.id);
    if (!messageId) {
      throw new OutboundEmailProviderError("Resend accepted the email without a message id", {
        status: response.status,
        code: "missing_message_id",
        retryable: false,
      });
    }

    return { provider: "resend", messageId, acceptedAt: Date.now() };
  }
}

export function createOutboundEmailProviderFromEnv(
  fetcher: Fetcher = fetch,
): OutboundEmailProvider | undefined {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  return apiKey ? new ResendOutboundEmailProvider(apiKey, fetcher) : undefined;
}
