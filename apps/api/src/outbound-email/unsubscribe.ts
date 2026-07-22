import { createHmac, timingSafeEqual } from "node:crypto";
import { emailRecipientPermissionSchema, normalizedEmailAddressSchema } from "@tuezday/contracts";

interface UnsubscribePayload {
  workspaceId: string;
  normalizedEmail: string;
}

function signingSecret(): string {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (!secret) throw new Error("EMAIL_UNSUBSCRIBE_SECRET is required for unsubscribe links");
  return secret;
}

function signature(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function createUnsubscribeToken(workspaceId: string, email: string): string {
  const normalizedEmail = normalizedEmailAddressSchema.parse(email);
  const validWorkspaceId = emailRecipientPermissionSchema.shape.workspaceId.parse(workspaceId);
  const payload = Buffer.from(
    JSON.stringify({ workspaceId: validWorkspaceId, normalizedEmail } satisfies UnsubscribePayload),
  ).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyUnsubscribeToken(token: string):
  | { ok: true; value: UnsubscribePayload }
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
    const parsed = emailRecipientPermissionSchema.pick({ workspaceId: true, normalizedEmail: true }).safeParse(decoded);
    if (!parsed.success) return { ok: false, error: "invalid_token" };
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false, error: "invalid_token" };
  }
}
