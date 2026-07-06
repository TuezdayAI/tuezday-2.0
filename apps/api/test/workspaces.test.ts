import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { buildAuthedApp, createTestDb } from "./helpers";

describe("workspaces API", () => {
  let app: TuezdayApp;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a workspace and returns the full record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Hexalog" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(workspaceSchema.safeParse(body).success).toBe(true);
    expect(body.name).toBe("Hexalog");
  });

  it("trims the workspace name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "  Padded  " },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("Padded");
  });

  it("rejects an empty name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });

  it("rejects a missing name with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a name over 100 chars with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "x".repeat(101) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists workspaces newest first", async () => {
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "First" } });
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Second" } });

    const res = await app.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list.map((w: { name: string }) => w.name)).toContain("First");
    expect(list.map((w: { name: string }) => w.name)).toContain("Second");
    // newest first
    expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
  });

  it("returns an empty list when no workspaces exist", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("gets a workspace by id", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Solo" } })
    ).json();

    const res = await app.inject({ method: "GET", url: `/workspaces/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it("returns 404 for an unknown workspace id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("workspace_not_found");
  });
  it("persists websiteUrl and defaults onboardingStep to null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Hexalog", websiteUrl: "https://hexalog.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(workspaceSchema.safeParse(body).success).toBe(true);
    expect(body.websiteUrl).toBe("https://hexalog.com");
    expect(body.onboardingStep).toBeNull();

    const got = await app.inject({ method: "GET", url: `/workspaces/${body.id}` });
    expect(got.json().websiteUrl).toBe("https://hexalog.com");
  });

  it("accepts an onboardingStep cursor at create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Cursored", websiteUrl: "https://a.co", onboardingStep: "connect" },
    });
    expect(res.json().onboardingStep).toBe("connect");
  });

  it("rejects a bad websiteUrl with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Bad", websiteUrl: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });

  it("advances the onboarding cursor", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Flow" } })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${created.id}/onboarding`,
      payload: { step: "verify" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboardingStep).toBe("verify");
  });

  it("rejects an unknown onboarding step with 400", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Flow2" } })
    ).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${created.id}/onboarding`,
      payload: { step: "banana" },
    });
    expect(res.statusCode).toBe(400);
  });
});
