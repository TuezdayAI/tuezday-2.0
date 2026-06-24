import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNELS, CHANNEL_GUIDANCE_DEFAULTS, type ChannelGuidance } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { LlmGateway } from "../src/llm/gateway";
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

describe("channel guidance API (Sprint 21)", () => {
  let app: TuezdayApp;
  let workspaceId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway() });
    const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Guide" } });
    workspaceId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  function list() {
    return app.inject({ method: "GET", url: `/workspaces/${workspaceId}/guidance` });
  }
  function put(channel: string, content: string) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/guidance/${channel}`,
      payload: { content },
    });
  }
  function del(channel: string) {
    return app.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/guidance/${channel}` });
  }

  describe("GET /guidance", () => {
    it("returns a default row for every channel on a fresh workspace", async () => {
      const res = await list();
      expect(res.statusCode).toBe(200);
      const rows: ChannelGuidance[] = res.json();
      expect(rows.map((r) => r.channel).sort()).toEqual([...CHANNELS].sort());
      for (const row of rows) {
        expect(row.source).toBe("default");
        expect(row.updatedAt).toBeNull();
        expect(row.content).toBe(CHANNEL_GUIDANCE_DEFAULTS[row.channel]);
      }
    });
  });

  describe("PUT /guidance/:channel", () => {
    it("creates an override and surfaces it on the next read", async () => {
      const override = "Channel: LinkedIn. Always open with a contrarian one-liner.";
      const res = await put("linkedin", override);
      expect(res.statusCode).toBe(200);
      const saved: ChannelGuidance = res.json();
      expect(saved).toMatchObject({ channel: "linkedin", content: override, source: "workspace" });
      expect(saved.updatedAt).toBeGreaterThan(0);

      const rows: ChannelGuidance[] = (await list()).json();
      const linkedin = rows.find((r) => r.channel === "linkedin")!;
      expect(linkedin.source).toBe("workspace");
      expect(linkedin.content).toBe(override);
      // Other channels stay on the default.
      expect(rows.find((r) => r.channel === "email")!.source).toBe("default");
    });

    it("updates an existing override in place (one row per channel)", async () => {
      await put("linkedin", "First version.");
      await put("linkedin", "Second version.");
      const rows: ChannelGuidance[] = (await list()).json();
      const linkedin = rows.filter((r) => r.channel === "linkedin");
      expect(linkedin).toHaveLength(1);
      expect(linkedin[0]!.content).toBe("Second version.");
    });

    it("rejects an unknown channel with 400", async () => {
      const res = await put("tiktok", "Dance.");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_channel");
    });

    it("rejects empty content with 400", async () => {
      const res = await put("linkedin", "   ");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_input");
    });
  });

  describe("DELETE /guidance/:channel", () => {
    it("resets an overridden channel back to the built-in default", async () => {
      await put("linkedin", "Override to be removed.");
      const res = await del("linkedin");
      expect(res.statusCode).toBe(200);
      const reset: ChannelGuidance = res.json();
      expect(reset).toMatchObject({
        channel: "linkedin",
        source: "default",
        content: CHANNEL_GUIDANCE_DEFAULTS.linkedin,
        updatedAt: null,
      });
    });

    it("is idempotent when no override exists", async () => {
      const res = await del("email");
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe("default");
    });

    it("rejects an unknown channel with 400", async () => {
      const res = await del("tiktok");
      expect(res.statusCode).toBe(400);
    });
  });

  it("returns 404 for an unknown workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/guidance",
    });
    expect(res.statusCode).toBe(404);
  });

  describe("integration: overrides flow into generation", () => {
    it("a workspace override reaches the prompt and is labelled in the trace", async () => {
      const override = "Channel: LinkedIn. Always open with a contrarian one-liner about GTM.";
      await put("linkedin", override);

      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();

      expect(gen.prompt).toContain(override);
      const channel = gen.sections.find((s: { key: string }) => s.key === "channel");
      expect(channel.content).toBe(override);
      expect(channel.reason).toMatch(/workspace override/i);
    });

    it("falls back to the built-in default when no override is set", async () => {
      const gen = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      const channel = gen.sections.find((s: { key: string }) => s.key === "channel");
      expect(channel.content).toBe(CHANNEL_GUIDANCE_DEFAULTS.linkedin);
      expect(channel.reason).toMatch(/built-in default/i);
    });
  });
});
