import type { EmailDnsRecord } from "@tuezday/contracts";

export interface OutboundEmailMessage {
  from: string;
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  idempotencyKey: string;
}

export interface OutboundEmailDomain {
  provider: "resend";
  id: string;
  name: string;
  status: string;
  dnsRecords: EmailDnsRecord[];
  sendingEnabled: boolean;
}

export interface OutboundEmailSendResult {
  provider: "resend";
  messageId: string;
  acceptedAt: number;
}

export interface OutboundEmailProvider {
  createDomain(domain: string): Promise<OutboundEmailDomain>;
  verifyDomain(domainId: string): Promise<void>;
  getDomain(domainId: string): Promise<OutboundEmailDomain>;
  send(message: OutboundEmailMessage): Promise<OutboundEmailSendResult>;
}

export class OutboundEmailProviderError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status: number | null; code: string; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OutboundEmailProviderError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}
