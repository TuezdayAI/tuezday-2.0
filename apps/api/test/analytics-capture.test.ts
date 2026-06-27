import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { AnalyticsSink, AnalyticsEventInput } from "../src/analytics/sink";
import type { LlmGateway } from "../src/llm/gateway";
import { asUser, registerUser, createTestDb } from "./helpers";

const fakeLlm: LlmGateway = {
  async generate() {
    return { text: "Body.", model: "fake", provider: "fake", durationMs: 1 };
  },
};

function setup() {
  const captured: AnalyticsEventInput[] = [];
  const analytics: AnalyticsSink = { capture: (i) => captured.push(i) };
  return { db: createTestDb(), analytics, captured };
}

describe("analytics funnel capture", () => {
  it("captures user.registered on POST /auth/register", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    await registerUser(app);
    const ev = captured.find((c) => c.event === "user.registered");
    expect(ev).toBeDefined();
    // PII guard: no email/name on the lifecycle event.
    expect(JSON.stringify(captured)).not.toContain("@test.dev");
  });

  it("captures generation.created on a successful generate", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    const user = await registerUser(app);
    const authed = asUser(app, user.token);
    const ws = (await authed.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    const res = await authed.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/generate`,
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(201);
    const ev = captured.find((c) => c.event === "generation.created");
    expect(ev).toMatchObject({ distinctId: user.id, workspaceId: ws.id });
    expect(ev?.properties).toMatchObject({ taskType: "linkedin_post", channel: "linkedin" });
    expect(JSON.stringify(ev)).not.toContain("Body."); // never ship content
  });

  it("respects the workspace opt-out", async () => {
    const { db, analytics, captured } = setup();
    const app = await buildApp({ db, llm: fakeLlm, analytics });
    const user = await registerUser(app);
    const authed = asUser(app, user.token);
    const ws = (await authed.inject({ method: "POST", url: "/workspaces", payload: { name: "Acme" } })).json();
    await authed.inject({ method: "PUT", url: `/workspaces/${ws.id}/analytics-optout`, payload: { optOut: true } });
    captured.length = 0;
    await authed.inject({ method: "POST", url: `/workspaces/${ws.id}/generate`, payload: { taskType: "linkedin_post", channel: "linkedin" } });
    expect(captured.find((c) => c.event === "generation.created")).toBeUndefined();
  });
});
