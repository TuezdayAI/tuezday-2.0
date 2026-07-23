import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed, deterministic open/click tracking tokens (Sprint 50). Cloned from
 * `unsubscribe.ts`: base64url(JSON payload) + "." + HMAC-SHA256(base64url)
 * signature, verified with `timingSafeEqual`. Reuses `EMAIL_UNSUBSCRIBE_SECRET`.
 *
 * Two invariants that matter:
 * - **Deterministic** — the HMAC is over a stable payload with no nonce, so an
 *   idempotent resend recomposes a byte-identical body (the S47 contract).
 * - **The click URL lives inside the signed token**, never as a query param, so
 *   the redirect target can't be tampered with (no open-redirect).
 */

interface TrackingPayload {
  workspaceId: string;
  deliveryId: string;
  /** Present only on click tokens — the signed redirect target. */
  url?: string;
}

const trackingPayloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    url: z.string().url().optional(),
  })
  .strict();

function signingSecret(): string {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (!secret) throw new Error("EMAIL_UNSUBSCRIBE_SECRET is required for tracking links");
  return secret;
}

function signature(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

function encode(payload: TrackingPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body)}`;
}

export function createOpenToken(workspaceId: string, deliveryId: string): string {
  return encode({ workspaceId, deliveryId });
}

export function createClickToken(workspaceId: string, deliveryId: string, url: string): string {
  return encode({ workspaceId, deliveryId, url });
}

export function verifyTrackingToken(token: string):
  | { ok: true; value: TrackingPayload }
  | { ok: false; error: "invalid_token" } {
  const [payload, providedSignature, ...extra] = token.split(".");
  if (!payload || !providedSignature || extra.length > 0) return { ok: false, error: "invalid_token" };

  const expected = Buffer.from(signature(payload));
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, error: "invalid_token" };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const parsed = trackingPayloadSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, error: "invalid_token" };
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false, error: "invalid_token" };
  }
}
