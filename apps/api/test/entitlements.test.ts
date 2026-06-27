import { describe, expect, test } from "vitest";
process.env.TEST_BILLING_GATING = "1";
import { getPlan, getEntitlements, getUsage, assertWithinLimit, EntitlementError } from "../src/services/entitlements";
import { createTestDb } from "./helpers";
import { registerAccount } from "../src/services/auth";
import { createWorkspace } from "../src/services/workspaces";
import { connections, generations, subscriptions } from "../src/db/schema";
import { randomUUID } from "node:crypto";
import { addMember } from "../src/services/teams";

describe("entitlements service", () => {
  test("a workspace with no subscription resolves to free", async () => {
    const db = createTestDb();
    const { user } = await registerAccount(db, { email: "founder@example.com", password: "password123", name: "Founder" });
    const ws = await createWorkspace(db, { name: "Test WS" }, user.id);

    expect(getPlan(db, ws.id)).toBe("free");
    expect(getEntitlements(db, ws.id).seats).toBe(1);
  });

  test("getUsage counts seats, connectors, and monthlyGenerations", async () => {
    const db = createTestDb();
    const { user: u1 } = await registerAccount(db, { email: "u1@test.com", password: "pwd", name: "u1" });
    const { user: u2 } = await registerAccount(db, { email: "u2@test.com", password: "pwd", name: "u2" });
    const ws = await createWorkspace(db, { name: "Test WS" }, u1.id);

    addMember(db, ws.id, u2.id, "member");

    db.insert(connections).values({
      id: randomUUID(),
      workspaceId: ws.id,
      providerKey: "reddit",
      nangoConnectionId: "test-conn",
      configJson: "{}",
      status: "connected",
      createdAt: Date.now(),
    }).run();

    db.insert(generations).values({
      id: randomUUID(),
      workspaceId: ws.id,
      taskType: "linkedin_post",
      channel: "linkedin",
      prompt: "test",
      sectionsJson: "[]",
      output: "out",
      model: "gpt-4",
      provider: "openai",
      durationMs: 100,
      createdAt: Date.now(),
    }).run();

    const usage = getUsage(db, ws.id);
    expect(usage.seats).toBe(2);
    expect(usage.connectors).toBe(1);
    expect(usage.monthlyGenerations).toBe(1);
  });

  test("assertWithinLimit throws EntitlementError at the cap, passes under it", async () => {
    const db = createTestDb();
    const { user } = await registerAccount(db, { email: "u3@test.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "Test WS" }, user.id);

    // Free plan has limit of 1 for seats
    assertWithinLimit(db, ws.id, "seats", 0); // under limit

    expect(() => assertWithinLimit(db, ws.id, "seats", 1)).toThrowError(EntitlementError);
    expect(() => assertWithinLimit(db, ws.id, "seats", 1)).toThrowError("Plan limit reached for seats (limit 1).");
  });

  test("unlimited (-1) never throws", async () => {
    const db = createTestDb();
    const { user } = await registerAccount(db, { email: "u4@test.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "Test WS" }, user.id);

    db.insert(subscriptions).values({
      id: randomUUID(),
      workspaceId: ws.id,
      plan: "scale",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();

    // Scale plan has unlimited seats (-1)
    assertWithinLimit(db, ws.id, "seats", 9999);
  });

  test("BILLING_ENFORCED=false disables throwing", async () => {
    const db = createTestDb();
    const { user } = await registerAccount(db, { email: "u5@test.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "Test WS" }, user.id);

    process.env.BILLING_ENFORCED = "false";
    assertWithinLimit(db, ws.id, "seats", 5);
    process.env.BILLING_ENFORCED = "true";
  });
});
