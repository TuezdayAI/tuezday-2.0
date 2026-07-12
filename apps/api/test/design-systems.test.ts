import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_SYSTEM_CONTENT,
  designOverlaySchema,
  designSystemSchema,
  resolvedDesignSystemSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import type { LlmGateway } from "../src/llm/gateway";
import {
  createDesignSystem,
  ensureDefaultDesignSystem,
  listDesignSystems,
  resolveDesignSystem,
  setDefaultDesignSystem,
  upsertDesignOverlay,
} from "../src/services/design-systems";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";

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

describe("design systems (Sprint 41 Part 2)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let personaId: string;
  let campaignId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: fakeGateway() });
    const ws = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Design" } });
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

  function getSystem() {
    return app.inject({ method: "GET", url: `/workspaces/${workspaceId}/design-system` });
  }
  function putSystem(content: string) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/design-system`,
      payload: { content },
    });
  }
  function putOverlay(payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/design-system/overlays`,
      payload,
    });
  }
  async function listOverlaysHttp() {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/design-system/overlays`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }
  async function resolveHttp(query: string) {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/design-system/resolve?${query}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  describe("seeding", () => {
    it("workspace creation seeds exactly one org-level default system", () => {
      const systems = listDesignSystems(db, workspaceId);
      expect(systems).toHaveLength(1);
      expect(systems[0]!.name).toBe("Default");
      expect(systems[0]!.isDefault).toBe(true);
      expect(systems[0]!.content).toBe(DEFAULT_DESIGN_SYSTEM_CONTENT);
    });

    it("repeat reads and ensure calls never duplicate the default", async () => {
      ensureDefaultDesignSystem(db, workspaceId);
      ensureDefaultDesignSystem(db, workspaceId);
      await getSystem();
      await getSystem();
      expect(listDesignSystems(db, workspaceId)).toHaveLength(1);
    });

    it("GET /design-system returns the seeded default validating against contracts", async () => {
      const res = await getSystem();
      expect(res.statusCode).toBe(200);
      const system = designSystemSchema.parse(res.json());
      expect(system.isDefault).toBe(true);
      expect(system.content).toContain("Palette");
    });
  });

  describe("system CRUD", () => {
    it("PUT /design-system updates content and bumps updatedAt", async () => {
      const before = designSystemSchema.parse((await getSystem()).json());
      const res = await putSystem("# My brand\n\n- primary: #FF0000");
      expect(res.statusCode).toBe(200);
      const updated = designSystemSchema.parse(res.json());
      expect(updated.content).toContain("#FF0000");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
      const roundTrip = designSystemSchema.parse((await getSystem()).json());
      expect(roundTrip.content).toContain("#FF0000");
    });

    it("rejects empty content with 400", async () => {
      const res = await putSystem("   ");
      expect(res.statusCode).toBe(400);
    });
  });

  describe("overlay CRUD", () => {
    it("upserts a channel-only overlay and lists it with scope fields", async () => {
      const res = await putOverlay({ channel: "instagram", content: "Use dark palette" });
      expect(res.statusCode).toBe(200);
      const overlays = await listOverlaysHttp();
      expect(overlays).toHaveLength(1);
      const overlay = designOverlaySchema.parse(overlays[0]);
      expect(overlay.channel).toBe("instagram");
      expect(overlay.personaId).toBeNull();
      expect(overlay.campaignId).toBeNull();
    });

    it("upserting the same scope updates in place; a new scope adds a row", async () => {
      await putOverlay({ channel: "instagram", content: "v1" });
      await putOverlay({ channel: "instagram", content: "v2" });
      let overlays = await listOverlaysHttp();
      expect(overlays).toHaveLength(1);
      expect(overlays[0].content).toBe("v2");

      await putOverlay({ channel: "instagram", content: "campaign look", campaignId });
      overlays = await listOverlaysHttp();
      expect(overlays).toHaveLength(2);
    });

    it("rejects an unknown channel with 400 and unknown persona/campaign with 404", async () => {
      expect((await putOverlay({ channel: "tiktok", content: "x" })).statusCode).toBe(400);
      expect(
        (
          await putOverlay({
            channel: "instagram",
            content: "x",
            personaId: "00000000-0000-4000-8000-000000000000",
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await putOverlay({
            channel: "instagram",
            content: "x",
            campaignId: "00000000-0000-4000-8000-000000000000",
          })
        ).statusCode,
      ).toBe(404);
    });

    it("deletes an overlay by id; unknown id 404s", async () => {
      await putOverlay({ channel: "instagram", content: "temp" });
      const [overlay] = await listOverlaysHttp();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/design-system/overlays/${overlay.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(await listOverlaysHttp()).toHaveLength(0);
      const missing = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/design-system/overlays/${overlay.id}`,
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("resolveDesignSystem precedence", () => {
    it("base: no overlays -> system content with a base trace", async () => {
      const resolved = resolvedDesignSystemSchema.parse(await resolveHttp("channel=instagram"));
      expect(resolved.content).toBe(DEFAULT_DESIGN_SYSTEM_CONTENT);
      expect(resolved.trace.source).toBe("base");
      expect(resolved.trace.overlayId).toBeNull();
    });

    it("channel-only overlay appends to base with a channel trace", async () => {
      await putOverlay({ channel: "instagram", content: "IG addendum" });
      const resolved = resolvedDesignSystemSchema.parse(await resolveHttp("channel=instagram"));
      expect(resolved.content).toContain(DEFAULT_DESIGN_SYSTEM_CONTENT);
      expect(resolved.content).toContain("IG addendum");
      expect(resolved.content.indexOf("IG addendum")).toBeGreaterThan(
        resolved.content.indexOf("Palette"),
      );
      expect(resolved.trace.source).toBe("channel");
      expect(resolved.trace.overlayId).toBeTruthy();
    });

    it("campaign beats channel-only; persona beats campaign; persona+campaign beats persona", async () => {
      await putOverlay({ channel: "instagram", content: "channel look" });
      await putOverlay({ channel: "instagram", content: "campaign look", campaignId });
      await putOverlay({ channel: "instagram", content: "persona look", personaId });
      await putOverlay({
        channel: "instagram",
        content: "persona+campaign look",
        personaId,
        campaignId,
      });

      const campaignRes = await resolveHttp(`channel=instagram&campaignId=${campaignId}`);
      expect(campaignRes.trace.source).toBe("campaign");
      expect(campaignRes.content).toContain("campaign look");

      const personaRes = await resolveHttp(`channel=instagram&personaId=${personaId}`);
      expect(personaRes.trace.source).toBe("persona");
      expect(personaRes.content).toContain("persona look");

      const bothRes = await resolveHttp(
        `channel=instagram&personaId=${personaId}&campaignId=${campaignId}`,
      );
      expect(bothRes.trace.source).toBe("persona+campaign");
      expect(bothRes.content).toContain("persona+campaign look");

      const bare = await resolveHttp("channel=instagram");
      expect(bare.trace.source).toBe("channel");
      expect(bare.content).toContain("channel look");
    });

    it("a scoped overlay never leaks into an unscoped or different-channel resolution", async () => {
      await putOverlay({ channel: "instagram", content: "campaign look", campaignId });
      const unscoped = await resolveHttp("channel=instagram");
      expect(unscoped.trace.source).toBe("base");
      const otherChannel = await resolveHttp(`channel=linkedin&campaignId=${campaignId}`);
      expect(otherChannel.trace.source).toBe("base");
    });

    it("rejects an unknown channel with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/design-system/resolve?channel=tiktok`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("multi-system readiness (service level)", () => {
    it("a second system's overlays never affect default resolution; explicit id selects it", () => {
      const second = createDesignSystem(db, workspaceId, { name: "Alt", content: "# Alt look" });
      expect(second.isDefault).toBe(false);
      upsertDesignOverlay(db, workspaceId, {
        designSystemId: second.id,
        channel: "instagram",
        content: "alt addendum",
      });

      const viaDefault = resolveDesignSystem(db, workspaceId, { channel: "instagram" });
      expect(viaDefault.trace.source).toBe("base");
      expect(viaDefault.content).not.toContain("alt addendum");

      const viaSecond = resolveDesignSystem(db, workspaceId, {
        channel: "instagram",
        designSystemId: second.id,
      });
      expect(viaSecond.trace.source).toBe("channel");
      expect(viaSecond.content).toContain("# Alt look");
      expect(viaSecond.content).toContain("alt addendum");
      expect(viaSecond.trace.designSystemId).toBe(second.id);
    });

    it("names are unique per workspace and exactly one default survives a flip", () => {
      expect(() => createDesignSystem(db, workspaceId, { name: "Default" })).toThrow();
      const second = createDesignSystem(db, workspaceId, { name: "Alt" });
      setDefaultDesignSystem(db, workspaceId, second.id);
      const systems = listDesignSystems(db, workspaceId);
      expect(systems.filter((s) => s.isDefault)).toHaveLength(1);
      expect(systems.find((s) => s.isDefault)?.id).toBe(second.id);
    });
  });

  describe("auth", () => {
    it("a non-member gets 403 on every design-system route", async () => {
      const outsider = await registerUser(app, "outsider@test.dev", "outsider");
      const outsiderApp = asUser(app, outsider.token);
      const routes = [
        { method: "GET" as const, url: `/workspaces/${workspaceId}/design-system` },
        {
          method: "PUT" as const,
          url: `/workspaces/${workspaceId}/design-system`,
          payload: { content: "hack" },
        },
        { method: "GET" as const, url: `/workspaces/${workspaceId}/design-system/overlays` },
        {
          method: "PUT" as const,
          url: `/workspaces/${workspaceId}/design-system/overlays`,
          payload: { channel: "instagram", content: "hack" },
        },
        {
          method: "GET" as const,
          url: `/workspaces/${workspaceId}/design-system/resolve?channel=instagram`,
        },
      ];
      for (const route of routes) {
        const res = await outsiderApp.inject(route);
        expect(res.statusCode).toBe(403);
      }
    });
  });
});
