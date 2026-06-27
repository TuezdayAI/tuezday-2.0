import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
process.env.TEST_BILLING_GATING = "1";
import { buildApp, type TuezdayApp } from "../src/app";
import { createTestDb } from "./helpers";
import { registerAccount } from "../src/services/auth";
import { createWorkspace } from "../src/services/workspaces";
import { workspaces, subscriptions } from "../src/db/schema";
import { eq } from "drizzle-orm";

// We mock stripe so we don't make real requests
vi.mock("stripe", () => {
  return {
    default: class MockStripe {
      checkout = {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: "https://checkout.stripe.com/mock" }),
        },
      };
      webhooks = {
        constructEvent: vi.fn((body) => {
          if (body.includes("dummy")) {
            return {
              type: "checkout.session.completed",
              data: {
                object: {
                  customer: "cus_123",
                  subscription: "sub_123",
                  metadata: {
                    workspaceId: "test-ws",
                    plan: "pro",
                  },
                },
              },
            };
          }
          throw new Error("Invalid signature");
        }),
      };
    },
  };
});

describe("billing routes (Task 5)", () => {
  let app: TuezdayApp;
  let db: any;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp({ db });
    process.env.STRIPE_SECRET_KEY = "test_key";
    process.env.STRIPE_PRICE_PRO = "price_pro";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  test("GET /workspaces/:id/billing returns current plan and usage", async () => {
    const { token, user } = await registerAccount(db, { email: "u@t.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "ws" }, user.id);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${ws.id}/billing`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan: "free",
      entitlements: { seats: 1, connectors: 1, monthlyGenerations: 50 },
      usage: { seats: 1, connectors: 0, monthlyGenerations: 0 },
    });
  });

  test("POST /workspaces/:id/billing/checkout returns URL", async () => {
    const { token, user } = await registerAccount(db, { email: "u@t.com", password: "pwd", name: "u" });
    const ws = await createWorkspace(db, { name: "ws" }, user.id);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/billing/checkout`,
      headers: { authorization: `Bearer ${token}`, origin: "http://localhost:3000" },
      payload: { plan: "pro" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("https://checkout.stripe.com/mock");
  });

  test("POST /webhooks/stripe processes valid webhook", async () => {
    // Just seed a workspace to match the mocked metadata
    db.insert(workspaces).values({
      id: "test-ws",
      name: "Webhook WS",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid-sig", "content-type": "application/json" },
      payload: JSON.stringify({ dummy: "json" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    // Validate the subscription was inserted
    const sub = db.select().from(subscriptions).where(eq(subscriptions.workspaceId, "test-ws")).get();
    expect(sub).toBeDefined();
    expect(sub.plan).toBe("pro");
    expect(sub.status).toBe("active");
  });
});
