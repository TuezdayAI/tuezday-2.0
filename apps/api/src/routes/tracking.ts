import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import { verifyTrackingToken } from "../outbound-email/tracking";
import { recordClick, recordOpen } from "../services/tracking";

/**
 * Public open/click tracking endpoints (Sprint 50). Both are in the auth
 * guard's PUBLIC_ROUTES allowlist — a recipient's mail client hits them with no
 * bearer token. A bad/tampered token records nothing and returns an error.
 */

// A 1×1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

export function registerTrackingRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { token: string } }>("/t/o/:token", async (request, reply) => {
    const verified = verifyTrackingToken(request.params.token);
    if (!verified.ok) return reply.status(400).send({ error: verified.error });
    recordOpen(db, verified.value.deliveryId, Date.now());
    return reply
      .header("content-type", "image/gif")
      .header("cache-control", "no-store")
      .send(PIXEL);
  });

  app.get<{ Params: { token: string } }>("/t/c/:token", async (request, reply) => {
    const verified = verifyTrackingToken(request.params.token);
    if (!verified.ok || !verified.value.url) {
      return reply.status(400).send({ error: "invalid_token" });
    }
    recordClick(db, verified.value.deliveryId, verified.value.url, Date.now());
    return reply.redirect(verified.value.url);
  });
}
