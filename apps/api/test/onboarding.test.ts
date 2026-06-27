import { describe, expect, test } from "vitest";
import { getOnboarding, dismissOnboarding } from "../src/services/onboarding";
import { createTestDb } from "./helpers";
import { createWorkspace } from "../src/services/workspaces";
import { registerAccount } from "../src/services/auth";
import { updateBrainDoc } from "../src/services/brain";
import { connections, generations, drafts } from "../src/db/schema";
import { randomUUID } from "node:crypto";

describe("onboarding service", () => {
  test("derives onboarding state correctly", async () => {
    const db = createTestDb();
    const { user } = await registerAccount(db, { email: "founder@example.com", password: "password123", name: "Founder" });
    const ws = await createWorkspace(db, { name: "Test WS" }, user.id);

    // Initial state: workspace done, everything else false
    let state = getOnboarding(db, ws.id, user.id);
    expect(state.dismissed).toBe(false);
    expect(state.steps.find((s) => s.key === "workspace")?.done).toBe(true);
    expect(state.steps.find((s) => s.key === "brain")?.done).toBe(false);
    expect(state.steps.find((s) => s.key === "connect")?.done).toBe(false);
    expect(state.steps.find((s) => s.key === "generate")?.done).toBe(false);
    expect(state.steps.find((s) => s.key === "approve")?.done).toBe(false);

    // 2. Brain: update a doc
    updateBrainDoc(db, ws.id, "soul", "w ".repeat(40));
    state = getOnboarding(db, ws.id, user.id);
    expect(state.steps.find((s) => s.key === "brain")?.done).toBe(true);

    // 3. Connect: add a connection
    const now = Date.now();
    db.insert(connections).values({
      id: randomUUID(),
      workspaceId: ws.id,
      providerKey: "reddit",
      nangoConnectionId: "test-conn",
      configJson: "{}",
      status: "connected",
      createdAt: now,
    }).run();
    state = getOnboarding(db, ws.id, user.id);
    expect(state.steps.find((s) => s.key === "connect")?.done).toBe(true);

    // 4. Generate
    db.insert(generations).values({
      id: randomUUID(),
      workspaceId: ws.id,
      taskType: "linkedin_post",
      channel: "linkedin",
      prompt: "test",
      sectionsJson: "[]",
      output: "output",
      model: "gpt-4",
      provider: "openai",
      durationMs: 100,
      createdAt: now,
    }).run();
    state = getOnboarding(db, ws.id, user.id);
    expect(state.steps.find((s) => s.key === "generate")?.done).toBe(true);

    // 5. Approve
    db.insert(drafts).values({
      id: randomUUID(),
      workspaceId: ws.id,
      taskType: "linkedin_post",
      channel: "linkedin",
      originalContent: "test",
      content: "test",
      state: "approved",
      createdAt: now,
      updatedAt: now,
    }).run();
    state = getOnboarding(db, ws.id, user.id);
    expect(state.steps.find((s) => s.key === "approve")?.done).toBe(true);

    // Dismissal
    dismissOnboarding(db, ws.id, user.id);
    state = getOnboarding(db, ws.id, user.id);
    expect(state.dismissed).toBe(true);
  });
});

import { buildAuthedApp } from "./helpers";

describe("onboarding routes", () => {
  test("GET /workspaces/:id/onboarding", async () => {
    const db = createTestDb();
    const app = await buildAuthedApp({ db });

    // Use app.inject to create the workspace so the test user owns it
    const createRes = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Test WS" },
    });
    const wsId = createRes.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/onboarding`,
    });
    
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dismissed).toBe(false);
    expect(body.steps).toBeInstanceOf(Array);
  });

  test("PUT /workspaces/:id/onboarding/dismiss", async () => {
    const db = createTestDb();
    const app = await buildAuthedApp({ db });

    const createRes = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Test WS 2" },
    });
    const wsId = createRes.json().id;

    const res = await app.inject({
      method: "PUT",
      url: `/workspaces/${wsId}/onboarding/dismiss`,
    });
    
    expect(res.statusCode).toBe(204);

    const getRes = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/onboarding`,
    });
    expect(getRes.json().dismissed).toBe(true);
  });

  test("GET /brain/templates", async () => {
    const db = createTestDb();
    const app = await buildAuthedApp({ db });

    const res = await app.inject({
      method: "GET",
      url: `/brain/templates`,
    });
    
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].id).toBeDefined();
  });
});
