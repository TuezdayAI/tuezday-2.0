import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { ResendWebhookVerifier } from "../outbound-email/webhook";
import { recordVerifiedEmailEvent } from "../services/email-deliveries";

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function registerResendWebhookRoute(
  app: FastifyInstance,
  db: Db,
  verifier: ResendWebhookVerifier | undefined,
): void {
  app.post("/webhooks/resend", { config: { rawBody: true } }, async (request, reply) => {
    if (!verifier) return reply.status(503).send({ error: "webhook_not_configured" });
    const id = stringField(request.headers["svix-id"]);
    const timestamp = stringField(request.headers["svix-timestamp"]);
    const signature = stringField(request.headers["svix-signature"]);
    const rawBody = (request as typeof request & { rawBody?: string }).rawBody;
    if (!id || !timestamp || !signature || !rawBody) {
      return reply.status(400).send({ error: "invalid_webhook" });
    }

    let verified: unknown;
    try {
      verified = verifier.verify(rawBody, { id, timestamp, signature });
    } catch {
      return reply.status(400).send({ error: "invalid_signature" });
    }

    const root = verified && typeof verified === "object" ? verified as Record<string, unknown> : null;
    const data = root?.data && typeof root.data === "object"
      ? root.data as Record<string, unknown>
      : null;
    const eventType = stringField(root?.type);
    const providerMessageId = stringField(data?.email_id);
    if (!root || !eventType || !providerMessageId) {
      return reply.status(400).send({ error: "invalid_event" });
    }
    const parsedTime = Date.parse(stringField(root.created_at) ?? "");
    const result = recordVerifiedEmailEvent(db, {
      providerEventId: id,
      eventType,
      providerMessageId,
      occurredAt: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
      payload: root,
    });
    return { received: true, duplicate: result.duplicate, deliveryFound: result.deliveryFound };
  });
}
