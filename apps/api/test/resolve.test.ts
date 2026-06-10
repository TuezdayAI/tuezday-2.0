import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type TuezdayApp } from "../src/app";
import { createTestDb } from "./helpers";

describe("resolve API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildApp({ db: createTestDb() });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Resolvable" },
    });
    workspaceId = res.json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/voice`,
      payload: { content: "Direct, technical, never corporate." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("resolves a bundle with ordered sections and a trace", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    expect(bundle.sections.map((s: { key: string }) => s.key)).toEqual([
      "org:soul",
      "org:icp",
      "org:voice",
      "org:history",
      "org:now",
      "channel",
      "campaign",
      "persona",
      "task",
    ]);
    expect(bundle.prompt).toContain("We exist to end GTM amnesia.");
    expect(bundle.includedTokens).toBeGreaterThan(0);
    expect(bundle.overBudget).toBe(false);
    // empty docs excluded with reasons
    const icp = bundle.sections.find((s: { key: string }) => s.key === "org:icp");
    expect(icp.included).toBe(false);
  });

  it("includes the persona overlay when personaId is given", async () => {
    const persona = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO", overlay: "Write as the founder, first person." },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", personaId: persona.id },
    });
    expect(res.statusCode).toBe(200);
    const section = res.json().sections.find((s: { key: string }) => s.key === "persona");
    expect(section.included).toBe(true);
    expect(section.content).toContain("Write as the founder");
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: {
        taskType: "linkedin_post",
        channel: "linkedin",
        personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("persona_not_found");
  });

  it("rejects an invalid task type with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "tiktok_dance", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/resolve",
      payload: { taskType: "linkedin_post", channel: "linkedin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("honors a custom token budget", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/resolve`,
      payload: { taskType: "linkedin_post", channel: "linkedin", tokenBudget: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenBudget).toBe(500);
  });
});
