import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers";
import { mintActionToken, verifyAndBurn } from "../src/notifications/tokens";
import type { Db } from "../src/db";

describe("approval action tokens", () => {
  let db: Db;
  const WS = "ws-1";
  const DRAFT = "draft-1";

  beforeEach(() => {
    db = createTestDb();
  });

  it("mintActionToken returns a raw token string", () => {
    const raw = mintActionToken(db, WS, DRAFT, "approve");
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(10);
  });

  it("verifyAndBurn accepts a fresh token once", () => {
    const raw = mintActionToken(db, WS, DRAFT, "approve");
    const result = verifyAndBurn(db, raw);
    expect(result).toEqual({
      ok: true,
      workspaceId: WS,
      draftId: DRAFT,
      action: "approve",
    });
  });

  it("rejects a token on second use", () => {
    const raw = mintActionToken(db, WS, DRAFT, "reject");
    verifyAndBurn(db, raw);
    const result = verifyAndBurn(db, raw);
    expect(result).toEqual({ ok: false, error: "used" });
  });

  it("rejects an expired token", () => {
    // Mint with negative TTL so it's already expired
    const raw = mintActionToken(db, WS, DRAFT, "approve", -1);
    const result = verifyAndBurn(db, raw);
    expect(result).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a tampered token", () => {
    const raw = mintActionToken(db, WS, DRAFT, "approve");
    const tampered = raw.slice(0, -2) + "XX";
    const result = verifyAndBurn(db, tampered);
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects a completely unknown token", () => {
    const result = verifyAndBurn(db, "bm90LWEtcmVhbC10b2tlbg");
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("mints separate approve and reject tokens for the same draft", () => {
    const approveToken = mintActionToken(db, WS, DRAFT, "approve");
    const rejectToken = mintActionToken(db, WS, DRAFT, "reject");
    expect(approveToken).not.toBe(rejectToken);

    const r1 = verifyAndBurn(db, approveToken);
    expect(r1).toMatchObject({ ok: true, action: "approve" });

    const r2 = verifyAndBurn(db, rejectToken);
    expect(r2).toMatchObject({ ok: true, action: "reject" });
  });
});
