import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANNELS,
  CHANNEL_GUIDANCE_DEFAULTS,
  type ChannelGuidance,
  type GuidanceOverride,
} from "@tuezday/contracts";
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

describe("scoped guidance (Sprint 44)", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let personaId: string;
  let campaignId: string;

  beforeEach(async () => {
    app = await buildAuthedApp({ db: createTestDb(), llm: fakeGateway() });
    const ws = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Scoped" } });
    workspaceId = ws.json().id;
    const persona = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "Field CTO" },
    });
    personaId = persona.json().id;
    const campaign = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: "Memory push" },
    });
    campaignId = campaign.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  function put(channel: string, content: string, scope?: { personaId?: string; campaignId?: string }) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/guidance/${channel}`,
      payload: { content, ...scope },
    });
  }
  function del(channel: string, query = "") {
    return app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/guidance/${channel}${query}`,
    });
  }
  async function effective(channel: string, query = "") {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/guidance/${channel}/effective${query}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }
  async function overrides(): Promise<GuidanceOverride[]> {
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/guidance/overrides` });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  describe("scoped CRUD", () => {
    it("creates a scoped row without touching the workspace-level list", async () => {
      const res = await put("linkedin", "Persona voice rules.", { personaId });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        channel: "linkedin",
        content: "Persona voice rules.",
        source: "workspace",
        personaId,
        campaignId: null,
      });

      // The workspace-level GET still shows one default row per channel.
      const rows: ChannelGuidance[] = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/guidance` })
      ).json();
      expect(rows).toHaveLength(CHANNELS.length);
      expect(rows.find((r) => r.channel === "linkedin")!.source).toBe("default");

      const scoped = await overrides();
      expect(scoped).toHaveLength(1);
      expect(scoped[0]).toMatchObject({
        channel: "linkedin",
        personaId,
        personaName: "Field CTO",
        campaignId: null,
        campaignName: null,
      });
    });

    it("upserts in place at the same scope", async () => {
      await put("linkedin", "First.", { personaId });
      await put("linkedin", "Second.", { personaId });
      const scoped = await overrides();
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.content).toBe("Second.");
    });

    it("404s on an unknown persona or campaign", async () => {
      const missing = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      const p = await put("linkedin", "Ghost.", { personaId: missing });
      expect(p.statusCode).toBe(404);
      expect(p.json().error).toBe("persona_not_found");
      const c = await put("linkedin", "Ghost.", { campaignId: missing });
      expect(c.statusCode).toBe(404);
      expect(c.json().error).toBe("campaign_not_found");
    });

    it("deletes only the row at that exact scope", async () => {
      await put("linkedin", "Workspace text.");
      await put("linkedin", "Persona text.", { personaId });
      const res = await del("linkedin", `?personaId=${personaId}`);
      expect(res.statusCode).toBe(200);
      // The persona scope now falls back to the surviving workspace override.
      expect(res.json()).toMatchObject({ content: "Workspace text.", personaId: null });
      expect(await overrides()).toHaveLength(0);
      const rows: ChannelGuidance[] = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/guidance` })
      ).json();
      expect(rows.find((r) => r.channel === "linkedin")!.content).toBe("Workspace text.");
    });
  });

  describe("precedence via /effective", () => {
    it("picks persona+campaign > persona > campaign > workspace > default", async () => {
      await put("linkedin", "Workspace text.");
      await put("linkedin", "Campaign text.", { campaignId });
      await put("linkedin", "Persona text.", { personaId });
      await put("linkedin", "Both text.", { personaId, campaignId });

      const both = await effective("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      expect(both.content).toBe("Both text.");
      expect(both.scopeLabel).toBe('persona "Field CTO" + campaign "Memory push"');

      await del("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      const persona = await effective("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      expect(persona.content).toBe("Persona text.");
      expect(persona.scopeLabel).toBe('persona "Field CTO"');

      await del("linkedin", `?personaId=${personaId}`);
      const campaign = await effective("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      expect(campaign.content).toBe("Campaign text.");
      expect(campaign.scopeLabel).toBe('campaign "Memory push"');

      await del("linkedin", `?campaignId=${campaignId}`);
      const workspace = await effective("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      expect(workspace.content).toBe("Workspace text.");
      expect(workspace.scopeLabel).toBeNull();

      await del("linkedin");
      const fallback = await effective("linkedin", `?personaId=${personaId}&campaignId=${campaignId}`);
      expect(fallback.content).toBe(CHANNEL_GUIDANCE_DEFAULTS.linkedin);
      expect(fallback.source).toBe("default");
    });

    it("a campaign-only override does not apply to a bare persona scope", async () => {
      await put("linkedin", "Campaign text.", { campaignId });
      const res = await effective("linkedin", `?personaId=${personaId}`);
      expect(res.source).toBe("default");
    });
  });

  it("deleting the persona removes its scoped guidance rows", async () => {
    await put("linkedin", "Persona text.", { personaId });
    await put("x", "Persona text for X.", { personaId });
    await put("email", "Campaign text.", { campaignId });
    const delRes = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/personas/${personaId}`,
    });
    expect(delRes.statusCode).toBe(204);
    const remaining = await overrides();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.campaignId).toBe(campaignId);
  });

  describe("integration: scoped guidance flows into generation", () => {
    it("a persona-scoped override wins for that persona and names the scope in the trace", async () => {
      await put("linkedin", "Workspace text.");
      await put("linkedin", "Persona text.", { personaId });

      const withPersona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin", personaId },
        })
      ).json();
      const channel = withPersona.sections.find((s: { key: string }) => s.key === "channel");
      expect(channel.content).toBe("Persona text.");
      expect(channel.reason).toBe(
        'Channel guidance for linkedin (tier 1, keyed — workspace override, scoped: persona "Field CTO").',
      );

      const withoutPersona = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/generate`,
          payload: { taskType: "linkedin_post", channel: "linkedin" },
        })
      ).json();
      const plain = withoutPersona.sections.find((s: { key: string }) => s.key === "channel");
      expect(plain.content).toBe("Workspace text.");
      expect(plain.reason).toBe(
        "Channel guidance for linkedin (tier 1, keyed — workspace override).",
      );
    });
  });
});
