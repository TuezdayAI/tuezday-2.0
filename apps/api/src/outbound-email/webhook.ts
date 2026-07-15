import { Webhook } from "svix";

export interface ResendWebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export interface ResendWebhookVerifier {
  verify(rawBody: string, headers: ResendWebhookHeaders): unknown;
}

export class SvixResendWebhookVerifier implements ResendWebhookVerifier {
  private readonly webhook: Webhook;

  constructor(secret: string) {
    this.webhook = new Webhook(secret);
  }

  verify(rawBody: string, headers: ResendWebhookHeaders): unknown {
    return this.webhook.verify(rawBody, {
      "svix-id": headers.id,
      "svix-timestamp": headers.timestamp,
      "svix-signature": headers.signature,
    });
  }
}

export function createResendWebhookVerifierFromEnv(): ResendWebhookVerifier | undefined {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  return secret ? new SvixResendWebhookVerifier(secret) : undefined;
}
