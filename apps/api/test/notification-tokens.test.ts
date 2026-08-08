import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers";
import { mintActionToken, verifyAndBurn } from "../src/notifications/tokens";
import type { Db } from "../src/db";

describe("approval action tokens", () => {
  let db: Db;
  const WS = "ws-1";
  const DRAFT = "draft-1";

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("mintActionToken returns a raw token string", async () => {
    const raw = await mintActionToken(db, WS, DRAFT, "approve");
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(10);
  });

  it("verifyAndBurn accepts a fresh token once", async () => {
    const raw = await mintActionToken(db, WS, DRAFT, "approve");
    const result = await verifyAndBurn(db, raw);
    expect(result).toEqual({
      ok: true,
      workspaceId: WS,
      draftId: DRAFT,
      action: "approve",
    });
  });

  it("rejects a token on second use", async () => {
    const raw = await mintActionToken(db, WS, DRAFT, "reject");
    await verifyAndBurn(db, raw);
    const result = await verifyAndBurn(db, raw);
    expect(result).toEqual({ ok: false, error: "used" });
  });

  it("rejects an expired token", async () => {
    // Mint with negative TTL so it's already expired
    const raw = await mintActionToken(db, WS, DRAFT, "approve", -1);
    const result = await verifyAndBurn(db, raw);
    expect(result).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a tampered token", async () => {
    const raw = await mintActionToken(db, WS, DRAFT, "approve");
    const tampered = raw.slice(0, -2) + "XX";
    const result = await verifyAndBurn(db, tampered);
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects a completely unknown token", async () => {
    const result = await verifyAndBurn(db, "bm90LWEtcmVhbC10b2tlbg");
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("mints separate approve and reject tokens for the same draft", async () => {
    const approveToken = await mintActionToken(db, WS, DRAFT, "approve");
    const rejectToken = await mintActionToken(db, WS, DRAFT, "reject");
    expect(approveToken).not.toBe(rejectToken);

    const r1 = await verifyAndBurn(db, approveToken);
    expect(r1).toMatchObject({ ok: true, action: "approve" });

    const r2 = await verifyAndBurn(db, rejectToken);
    expect(r2).toMatchObject({ ok: true, action: "reject" });
  });
});
