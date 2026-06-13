import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generationSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import { GatewayError, type LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      return {
        text: `FAKE OUTPUT (prompt was ${prompt.length} chars)`,
        model: "fake-model",
        provider: "fake",
        durationMs: 5,
      };
    },
  };
}

function failingGateway(): LlmGateway {
  return {
    async generate() {
      throw new GatewayError("provider_error", "fake upstream 500");
    },
  };
}

describe("generations API", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway() });
    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Genny" },
    });
    workspaceId = res.json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function generate(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generate`,
      payload: { taskType: "linkedin_post", channel: "linkedin", ...payload },
    });
  }

  describe("POST /workspaces/:id/generate", () => {
    it("generates, stores, and returns a generation", async () => {
      const res = await generate();
      expect(res.statusCode).toBe(201);
      const gen = res.json();
      expect(generationSchema.safeParse(gen).success).toBe(true);
      expect(gen.output).toContain("FAKE OUTPUT");
      expect(gen.model).toBe("fake-model");
      expect(gen.provider).toBe("fake");
      expect(gen.rating).toBeNull();
    });

    it("sends the resolved brain context to the model", async () => {
      const res = await generate();
      const gen = res.json();
      expect(gen.prompt).toContain("We exist to end GTM amnesia.");
      expect(gen.prompt).toContain("Task:");
    });

    it("returns the resolved section trace", async () => {
      const res = await generate();
      const gen = res.json();
      expect(gen.sections.map((s: { key: string }) => s.key)).toContain("org:soul");
      expect(gen.sections.map((s: { key: string }) => s.key)).toContain("task");
    });

    it("includes the persona overlay in the prompt", async () => {
      const persona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/personas`,
          payload: { name: "CEO", overlay: "Write as the founder." },
        })
      ).json();
      const res = await generate({ personaId: persona.id });
      const gen = res.json();
      expect(gen.prompt).toContain("Write as the founder.");
      expect(gen.personaId).toBe(persona.id);
    });

    it("returns 502 and stores nothing when the provider fails", async () => {
      const failApp = await buildAuthedApp({ db: createTestDb(), llm: failingGateway() });
      const ws = (
        await failApp.inject({ method: "POST", url: "/workspaces", payload: { name: "X" } })
      ).json();
      const res = await failApp.inject({
        method: "POST",
        url: `/workspaces/${ws.id}/generate`,
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("generation_failed");
      const list = await failApp.inject({ method: "GET", url: `/workspaces/${ws.id}/generations` });
      expect(list.json()).toEqual([]);
      await failApp.close();
    });

    it("rejects an invalid task type with 400", async () => {
      const res = await generate({ taskType: "tiktok_dance" });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown persona", async () => {
      const res = await generate({ personaId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for an unknown workspace", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/generate",
        payload: { taskType: "linkedin_post", channel: "linkedin" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("rating", () => {
    it("rates a generation and sets ratedAt", async () => {
      const gen = (await generate()).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/rating`,
        payload: { rating: "accepted" },
      });
      expect(res.statusCode).toBe(200);
      const rated = res.json();
      expect(rated.rating).toBe("accepted");
      expect(rated.ratedAt).toBeGreaterThan(0);
    });

    it("overwrites a previous rating", async () => {
      const gen = (await generate()).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/rating`,
        payload: { rating: "accepted" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/rating`,
        payload: { rating: "rejected" },
      });
      expect(res.json().rating).toBe("rejected");
    });

    it("rejects an invalid rating with 400", async () => {
      const gen = (await generate()).json();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.id}/rating`,
        payload: { rating: "meh" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown generation", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/7c9e6679-7425-40de-944b-e07fc1f90ae7/rating`,
        payload: { rating: "accepted" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /workspaces/:id/generations", () => {
    it("lists generations newest first with ratings", async () => {
      const first = (await generate()).json();
      const second = (await generate({ taskType: "cold_email_opener" })).json();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${first.id}/rating`,
        payload: { rating: "needs_edit" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/generations`,
      });
      const list = res.json();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(second.id);
      expect(list[1].rating).toBe("needs_edit");
    });

    it("returns an empty list for a fresh workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/generations`,
      });
      expect(res.json()).toEqual([]);
    });
  });
});
