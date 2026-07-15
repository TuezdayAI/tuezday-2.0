import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  emailDeliveries,
  emailRecipientPermissions,
  emailSuppressions,
  externalActions,
  workspaceEmailSenders,
} from "../src/db/schema";
import { createUnsubscribeToken } from "../src/outbound-email/unsubscribe";
import { checkEmailRecipientSafety } from "../src/services/email-recipient-safety";
import { asUser, createTestDb, registerUser } from "./helpers";

function senderRow(workspaceId: string, overrides: { killSwitch?: boolean; dailyCap?: number } = {}) {
  const now = Date.now();
  return {
    workspaceId,
    domain: "example.com",
    fromLocalPart: "hello",
    fromName: "Acme",
    fromAddress: "hello@example.com",
    replyTo: null,
    status: "verified",
    provider: "resend",
    providerDomainId: "domain_123",
    dnsRecordsJson: "[]",
    killSwitch: overrides.killSwitch ?? false,
    dailyCap: overrides.dailyCap ?? 100,
    lastCheckedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function seedAction(db: Db, workspaceId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.insert(externalActions)
    .values({
      id,
      workspaceId,
      kind: "send",
      status: "completed",
      subjectKind: "launch_message",
      subjectId: randomUUID(),
      draftId: null,
      campaignId: null,
      personaId: null,
      connectionId: null,
      laneRevisionId: null,
      payloadJson: "{}",
      subjectSnapshotJson: "{}",
      requestedFor: null,
      idempotencyKey: `send/${id}`,
      fingerprint: "a".repeat(64),
      policySnapshotJson: "{}",
      blockerCode: null,
      blockerDetail: null,
      blockerRetryable: null,
      supersedesActionId: null,
      supersededByActionId: null,
      executionKind: "email_delivery",
      executionId: null,
      executionReceiptJson: null,
      proposedByUserId: null,
      proposedByLabel: "Founder",
      createdAt: now,
      updatedAt: now,
      authorizedAt: now,
      dispatchedAt: now,
      completedAt: now,
    })
    .run();
  return id;
}

function seedAcceptedDelivery(
  db: Db,
  workspaceId: string,
  status: "accepted" | "delivered",
  acceptedAt = Date.now(),
): void {
  const actionId = seedAction(db, workspaceId);
  const id = randomUUID();
  db.insert(emailDeliveries)
    .values({
      id,
      workspaceId,
      externalActionId: actionId,
      origin: "launch_message",
      originId: randomUUID(),
      normalizedRecipient: `lead-${id}@buyer.com`,
      senderAddress: "hello@example.com",
      replyTo: null,
      subject: "Hello",
      text: "Useful note",
      html: null,
      idempotencyKey: `send/${id}`,
      provider: "resend",
      providerMessageId: `email_${id}`,
      status,
      acceptedAt,
      completedAt: status === "delivered" ? acceptedAt + 1 : null,
      lastError: null,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    })
    .run();
}

describe("email recipient safety", () => {
  let db: Db;
  let app: TuezdayApp;
  let authed: TuezdayApp;
  let workspaceId: string;
  const originalSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;

  beforeEach(async () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "email-unsubscribe-test-secret";
    db = createTestDb();
    app = await buildApp({ db });
    const user = await registerUser(app);
    authed = asUser(app, user.token);
    workspaceId = (
      await authed.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })
    ).json().id;
    db.insert(workspaceEmailSenders).values(senderRow(workspaceId)).run();
  });

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = originalSecret;
    await app.close();
  });

  async function putPermission(email: string, status: "allowed" | "suppressed") {
    return authed.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/email-permissions/${encodeURIComponent(email)}`,
      payload: { status },
    });
  }

  it("blocks unknown and suppressed recipients while explicit allowed recipients pass", async () => {
    expect(checkEmailRecipientSafety(db, workspaceId, "unknown@example.com")).toMatchObject({
      ok: false,
      code: "permission_unknown",
    });

    expect((await putPermission(" ALLOWED@EXAMPLE.COM ", "allowed")).statusCode).toBe(200);
    expect(checkEmailRecipientSafety(db, workspaceId, "allowed@example.com")).toEqual({
      ok: true,
      normalizedEmail: "allowed@example.com",
    });

    await putPermission("blocked@example.com", "suppressed");
    expect(checkEmailRecipientSafety(db, workspaceId, "blocked@example.com")).toMatchObject({
      ok: false,
      code: "suppressed",
    });
  });

  it("keeps permission and founder suppression decisions transactionally aligned", async () => {
    const suppressed = await putPermission("Lead@Buyer.com", "suppressed");
    expect(suppressed.statusCode).toBe(200);
    expect(suppressed.json()).toMatchObject({
      normalizedEmail: "lead@buyer.com",
      status: "suppressed",
    });
    expect(
      db
        .select()
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, workspaceId),
            eq(emailSuppressions.normalizedEmail, "lead@buyer.com"),
          ),
        )
        .get(),
    ).toMatchObject({ reason: "founder" });

    const allowed = await putPermission("lead@buyer.com", "allowed");
    expect(allowed.json().status).toBe("allowed");
    expect(
      db
        .select()
        .from(emailSuppressions)
        .where(eq(emailSuppressions.normalizedEmail, "lead@buyer.com"))
        .get(),
    ).toBeUndefined();

    const read = await authed.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/email-permissions/LEAD%40BUYER.COM`,
    });
    expect(read.json()).toMatchObject({ normalizedEmail: "lead@buyer.com", status: "allowed" });
  });

  it("keeps unsubscribe suppression even if permission is later marked allowed", async () => {
    const now = Date.now();
    db.insert(emailSuppressions)
      .values({
        id: randomUUID(),
        workspaceId,
        normalizedEmail: "optedout@example.com",
        reason: "unsubscribe",
        createdAt: now,
      })
      .run();
    await putPermission("optedout@example.com", "suppressed");
    await putPermission("optedout@example.com", "allowed");
    expect(checkEmailRecipientSafety(db, workspaceId, "optedout@example.com")).toMatchObject({
      ok: false,
      code: "suppressed",
    });
  });

  it("updates workspace kill switch and cap and applies the kill switch first", async () => {
    const update = await authed.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/email-safety`,
      payload: { killSwitch: true, dailyCap: 2 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ killSwitch: true, dailyCap: 2 });
    expect(checkEmailRecipientSafety(db, workspaceId, "unknown@example.com")).toMatchObject({
      ok: false,
      code: "kill_switch_on",
    });

    const read = await authed.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/email-safety`,
    });
    expect(read.json()).toEqual({ killSwitch: true, dailyCap: 2 });
  });

  it("counts only today's accepted and delivered sends against the UTC cap", async () => {
    await putPermission("allowed@example.com", "allowed");
    await authed.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/email-safety`,
      payload: { killSwitch: false, dailyCap: 2 },
    });
    const utcStart = new Date();
    utcStart.setUTCHours(0, 0, 0, 0);
    seedAcceptedDelivery(db, workspaceId, "accepted");
    seedAcceptedDelivery(db, workspaceId, "delivered");
    seedAcceptedDelivery(db, workspaceId, "delivered", utcStart.getTime() - 1);

    expect(checkEmailRecipientSafety(db, workspaceId, "allowed@example.com")).toMatchObject({
      ok: false,
      code: "daily_cap_reached",
      count: 2,
      cap: 2,
    });
  });

  it("serves idempotent public unsubscribe and rejects tampered tokens", async () => {
    const token = createUnsubscribeToken(workspaceId, "Lead@Buyer.com");
    const confirmation = await app.inject({ method: "GET", url: `/u/${token}` });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.body).toContain("lead@buyer.com");

    const unsubscribe = await app.inject({ method: "POST", url: `/u/${token}` });
    const replay = await app.inject({ method: "POST", url: `/u/${token}` });
    expect(unsubscribe.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);

    expect(
      db
        .select()
        .from(emailSuppressions)
        .where(eq(emailSuppressions.normalizedEmail, "lead@buyer.com"))
        .get(),
    ).toMatchObject({ reason: "unsubscribe" });
    expect(
      db
        .select()
        .from(emailRecipientPermissions)
        .where(eq(emailRecipientPermissions.normalizedEmail, "lead@buyer.com"))
        .get(),
    ).toMatchObject({ status: "suppressed" });

    const tampered = await app.inject({ method: "POST", url: `/u/${token}x` });
    expect(tampered.statusCode).toBe(400);
  });

  it("keeps unrelated workspace routes authenticated", async () => {
    const protectedResponse = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/email-safety`,
    });
    expect(protectedResponse.statusCode).toBe(401);
  });
});
