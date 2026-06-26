// Signed, one-time-use approval action tokens (Sprint 39).
//
// Each approve/reject button/link carries a raw token: base64url of
// `${id}.${draftId}.${action}.${exp}.${hmac}`. We persist the sha256 of the
// raw token and burn it on first use (`usedAt`).

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { approvalActionTokens } from "../db/schema";

const SIGNING_KEY = () =>
  process.env.NOTIFY_SIGNING_SECRET || "dev-signing-secret-change-me";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Mint a signed, one-time action token for a draft action (approve/reject).
 * Returns the raw token string. The sha256 is persisted for lookup.
 */
export function mintActionToken(
  db: Db,
  workspaceId: string,
  draftId: string,
  action: "approve" | "reject",
  ttlMs = 7 * 24 * 60 * 60 * 1000,
): string {
  const id = randomUUID();
  const exp = Date.now() + ttlMs;
  const payload = `${id}.${draftId}.${action}.${exp}`;
  const hmac = createHmac("sha256", SIGNING_KEY()).update(payload).digest("base64url");
  const raw = Buffer.from(`${payload}.${hmac}`).toString("base64url");
  const tokenHash = sha256(raw);

  db.insert(approvalActionTokens)
    .values({
      id,
      tokenHash,
      workspaceId,
      draftId,
      action,
      expiresAt: exp,
      createdAt: Date.now(),
    })
    .run();

  return raw;
}

export type VerifyResult =
  | { ok: true; workspaceId: string; draftId: string; action: "approve" | "reject" }
  | { ok: false; error: "invalid" | "expired" | "used" };

/**
 * Verify and burn a raw action token. Returns the action payload on success,
 * or an error reason. A token can only be used once.
 */
export function verifyAndBurn(db: Db, raw: string): VerifyResult {
  // Decode and verify HMAC
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: "invalid" };
  }

  const parts = decoded.split(".");
  if (parts.length !== 5) return { ok: false, error: "invalid" };

  const [id, draftId, action, expStr, hmac] = parts;
  const payload = `${id}.${draftId}.${action}.${expStr}`;
  const expectedHmac = createHmac("sha256", SIGNING_KEY()).update(payload).digest("base64url");
  if (hmac !== expectedHmac) return { ok: false, error: "invalid" };

  // Look up by hash
  const tokenHash = sha256(raw);
  const row = db
    .select()
    .from(approvalActionTokens)
    .where(eq(approvalActionTokens.tokenHash, tokenHash))
    .get();

  if (!row) return { ok: false, error: "invalid" };
  if (row.usedAt) return { ok: false, error: "used" };
  if (Date.now() > row.expiresAt) return { ok: false, error: "expired" };

  // Burn: mark as used
  db.update(approvalActionTokens)
    .set({ usedAt: Date.now() })
    .where(eq(approvalActionTokens.id, row.id))
    .run();

  return {
    ok: true,
    workspaceId: row.workspaceId,
    draftId: row.draftId,
    action: row.action as "approve" | "reject",
  };
}
