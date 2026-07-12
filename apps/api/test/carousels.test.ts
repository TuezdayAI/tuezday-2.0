import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSchema, PLANS, TASK_TYPES, type Draft } from "@tuezday/contracts";
import { randomUUID } from "node:crypto";
import type { TuezdayApp } from "../src/app";
import type { ConnectorFabric, ProxyJsonResult } from "../src/connectors/fabric";
import type { Db } from "../src/db";
import { generations } from "../src/db/schema";
import type { AuthorTemplateInput, DesignProvider } from "../src/design/provider";
import type { RenderInput } from "../src/design/render";
import type { AssetStorage } from "../src/design/storage";
import type { LlmGateway } from "../src/llm/gateway";
import { splitIntoSlides } from "../src/services/carousels";
import { buildAuthedApp, createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let nextLlmText = "Generated post text.";
const fakeLlm: LlmGateway = {
  async generate() {
    return { text: nextLlmText, model: "fake", provider: "fake", durationMs: 3 };
  },
};

const TEMPLATE_HTML = `<div><h1>{{title}}</h1><p>{{body}}</p><span>{{page}}</span></div>`;

function fakeDesign(): DesignProvider & { calls: AuthorTemplateInput[] } {
  const calls: AuthorTemplateInput[] = [];
  return {
    calls,
    async authorTemplate(input) {
      calls.push(input);
      return { html: TEMPLATE_HTML, css: ".x{}", placeholders: ["title", "body", "page"] };
    },
  };
}

function fakeStorage(options?: { failAfter?: number }): AssetStorage & { puts: number } {
  const state = { puts: 0 };
  return {
    get puts() {
      return state.puts;
    },
    async put(bytes: Uint8Array) {
      if (options?.failAfter !== undefined && state.puts >= options.failAfter) {
        const { StorageError } = await import("../src/design/storage");
        throw new StorageError("bucket exploded mid-upload");
      }
      state.puts += 1;
      const hash = Buffer.from(bytes).toString("hex").slice(0, 8);
      return { url: `https://cdn.test/design/${state.puts}-${hash}.png` };
    },
  };
}

function fakeRender(): ((input: RenderInput) => Promise<Uint8Array>) & { values: Array<Record<string, string>> } {
  const values: Array<Record<string, string>> = [];
  const fn = async (input: RenderInput) => {
    for (const name of input.template.placeholders) {
      if (input.values[name] === undefined) throw new Error(`missing placeholder ${name}`);
    }
    values.push(input.values);
    return new TextEncoder().encode(`png:${input.values.page}:${input.values.title}`);
  };
  fn.values = values;
  return fn;
}

// Minimal Instagram-only fabric fake (same Graph API emulation the launch
// tests use) so the publish wiring can be asserted end to end.
interface IgState {
  connections: Map<string, { providerConfigKey: string; credentials: unknown }>;
  igContainers: number;
  igPublished: number;
  calls: Array<{ method: string; path: string; opts?: unknown }>;
}

function igState(): IgState {
  return { connections: new Map(), igContainers: 0, igPublished: 0, calls: [] };
}

function handleInstagram(state: IgState, method: string, path: string, opts: unknown): ProxyJsonResult {
  const p = path.split("?")[0]!;
  state.calls.push({ method, path, opts });
  if (p.endsWith("/media_publish")) {
    state.igPublished += 1;
    return { status: 200, json: { id: `ig-media-${state.igPublished}` } };
  }
  if (p.endsWith("/media")) {
    state.igContainers += 1;
    return { status: 200, json: { id: `ig-container-${state.igContainers}` } };
  }
  if (p.includes("/me/accounts")) {
    return { status: 200, json: { data: [{ instagram_business_account: { id: "ig-1" } }] } };
  }
  if (p.startsWith("/v23.0/ig-container-")) return { status: 200, json: { status_code: "FINISHED" } };
  if (p.startsWith("/v23.0/ig-media-")) {
    return { status: 200, json: { permalink: "https://www.instagram.com/p/abc/" } };
  }
  return { status: 404, json: { error: { message: `no endpoint for ${p}` } } };
}

function fakeFabric(state: IgState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "session-token" };
    },
    async importConnection(providerConfigKey, connectionId, credentials) {
      state.connections.set(connectionId, { providerConfigKey, credentials });
    },
    async connectionExists(connectionId) {
      return state.connections.has(connectionId);
    },
    async deleteConnection(connectionId) {
      state.connections.delete(connectionId);
    },
    async proxyGet() {
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _connectionId, _providerConfigKey, opts) {
      return handleInstagram(state, method, path, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("carousel pipeline (Sprint 41 Part 4)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let design: ReturnType<typeof fakeDesign>;
  let storage: ReturnType<typeof fakeStorage>;
  let render: ReturnType<typeof fakeRender>;
  let ig: IgState;

  beforeEach(async () => {
    nextLlmText = "Generated post text.";
    db = createTestDb();
    design = fakeDesign();
    storage = fakeStorage();
    render = fakeRender();
    ig = igState();
    app = await buildAuthedApp({
      db,
      llm: fakeLlm,
      design,
      assetStorage: storage,
      render,
      connectors: fakeFabric(ig),
    });
    const ws = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Carousel" } });
    workspaceId = ws.json().id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  /** Generate -> submit -> approve a source draft whose content we control. */
  async function approvedSourceDraft(content: string): Promise<Draft> {
    nextLlmText = content;
    const gen = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generate`,
      payload: { taskType: "instagram_post", channel: "instagram" },
    });
    expect(gen.statusCode).toBe(201);
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/generations/${gen.json().id}/submit`,
    });
    expect(submit.statusCode).toBe(201);
    const draftId = submit.json().id;
    const approve = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/approve`,
    });
    expect(approve.statusCode).toBe(200);
    return approve.json();
  }

  function generateCarousel(draftId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${draftId}/carousel`,
    });
  }

  const CONTENT = [
    "Five hard lessons from our GTM rebuild.",
    "Lesson one: talk to users before writing a single prompt.",
    "Lesson two: the approval gate is the product, not a checkbox.",
    "Lesson three: cache the expensive step and render the rest.",
  ].join("\n\n");

  it("contracts: instagram_carousel is a first-class task type", () => {
    expect(TASK_TYPES).toContain("instagram_carousel");
  });

  describe("splitIntoSlides", () => {
    it("produces hook -> middles -> cta with archetypes and word budgets", () => {
      const slides = splitIntoSlides(CONTENT);
      expect(slides[0]!.archetype).toBe("hook");
      expect(slides.at(-1)!.archetype).toBe("cta");
      expect(slides).toHaveLength(5);
      expect(slides[1]!.archetype).toBe("list_item"); // 3+ middles read as a list
      expect(slides[0]!.title.split(/\s+/).length).toBeLessThanOrEqual(8);
    });

    it("respects an explicit --- break override", () => {
      const slides = splitIntoSlides("Intro line\n\n---\n\nOnly middle chunk\nwith detail");
      expect(slides).toHaveLength(3);
      expect(slides[1]!.archetype).toBe("body");
      expect(slides[1]!.title).toContain("Only middle chunk");
    });

    it("clamps oversized content into Instagram's 10-slide ceiling", () => {
      const long = Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} with a few words.`).join("\n\n");
      const slides = splitIntoSlides(long);
      expect(slides.length).toBeLessThanOrEqual(10);
      expect(slides.length).toBeGreaterThanOrEqual(2);
    });

    it("tiny content still yields a valid 2+ slide deck", () => {
      const slides = splitIntoSlides("One short line.");
      expect(slides.length).toBeGreaterThanOrEqual(2);
      expect(slides[0]!.archetype).toBe("hook");
      expect(slides.at(-1)!.archetype).toBe("cta");
    });
  });

  describe("POST /drafts/:draftId/carousel", () => {
    it("creates a media-carrying carousel draft in the approval gate", async () => {
      const source = await approvedSourceDraft(CONTENT);
      const res = await generateCarousel(source.id);
      expect(res.statusCode).toBe(201);

      const draft = draftSchema.parse(res.json());
      expect(draft.taskType).toBe("instagram_carousel");
      expect(draft.channel).toBe("instagram");
      expect(draft.state).toBe("pending_review");
      expect(draft.media).toHaveLength(5);
      for (const item of draft.media!) {
        expect(item.type).toBe("image");
        expect(item.url).toMatch(/^https:\/\/cdn\.test\/design\//);
      }
      expect(draft.content).toContain("Slide 1/5 [hook]");
      expect(draft.content).toContain("[cta]");

      // Slide counters flowed into the renderer.
      expect(render.values.map((v) => v.page)).toEqual(["1/5", "2/5", "3/5", "4/5", "5/5"]);

      // It moves through the existing approval endpoints untouched.
      const approve = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${draft.id}/approve`,
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().state).toBe("approved");
      expect(approve.json().media).toHaveLength(5);
    });

    it("authors templates once per archetype, then repeat runs are pure cache hits", async () => {
      const source = await approvedSourceDraft(CONTENT);
      await generateCarousel(source.id);
      const callsAfterFirst = design.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0); // hook + list_item + cta

      const second = await approvedSourceDraft(`${CONTENT}\n\nOne more angle on the same idea.`);
      const res = await generateCarousel(second.id);
      expect(res.statusCode).toBe(201);
      expect(design.calls.length).toBe(callsAfterFirst); // zero new authoring calls
    });

    it("refuses a source draft that is not approved", async () => {
      nextLlmText = CONTENT;
      const gen = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generate`,
        payload: { taskType: "instagram_post", channel: "instagram" },
      });
      const submit = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/generations/${gen.json().id}/submit`,
      });
      const res = await generateCarousel(submit.json().id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("source_not_approved");
    });

    it("404s on a missing draft or workspace", async () => {
      expect((await generateCarousel(randomUUID())).statusCode).toBe(404);
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${randomUUID()}/drafts/${randomUUID()}/carousel`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("a mid-upload storage failure creates no draft and burns no credit", async () => {
      const source = await approvedSourceDraft(CONTENT);
      const failing = fakeStorage({ failAfter: 2 });
      const app2 = await buildAuthedApp({
        db: createTestDb(),
        llm: fakeLlm,
        design: fakeDesign(),
        assetStorage: failing,
        render: fakeRender(),
      });
      const ws2 = await app2.inject({ method: "POST", url: "/workspaces", payload: { name: "W2" } });
      const source2 = await (async () => {
        nextLlmText = CONTENT;
        const gen = await app2.inject({
          method: "POST",
          url: `/workspaces/${ws2.json().id}/generate`,
          payload: { taskType: "instagram_post", channel: "instagram" },
        });
        const submit = await app2.inject({
          method: "POST",
          url: `/workspaces/${ws2.json().id}/generations/${gen.json().id}/submit`,
        });
        await app2.inject({
          method: "POST",
          url: `/workspaces/${ws2.json().id}/drafts/${submit.json().id}/approve`,
        });
        return submit.json();
      })();

      const before = await app2
        .inject({ method: "GET", url: `/workspaces/${ws2.json().id}/drafts` })
        .then((r) => r.json());
      const res = await app2.inject({
        method: "POST",
        url: `/workspaces/${ws2.json().id}/drafts/${source2.id}/carousel`,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("asset_storage_failed");
      const after = await app2
        .inject({ method: "GET", url: `/workspaces/${ws2.json().id}/drafts` })
        .then((r) => r.json());
      expect(after).toHaveLength(before.length); // no partial draft
      await app2.close();
      void source; // first workspace's draft unused past setup
    });

    it("gates on the plan's monthlyGenerations and returns the standard upgrade shape", async () => {
      vi.stubEnv("TEST_BILLING_GATING", "1");
      const source = await approvedSourceDraft(CONTENT);

      // Fill the free plan's included generations to the brim.
      const limit = PLANS.free.entitlements.monthlyGenerations;
      const now = Date.now();
      for (let i = 0; i < limit; i++) {
        db.insert(generations)
          .values({
            id: randomUUID(),
            workspaceId,
            taskType: "linkedin_post",
            channel: "linkedin",
            personaId: null,
            campaignId: null,
            leadId: null,
            mediaContactId: null,
            prompt: "x",
            sectionsJson: "[]",
            output: "x",
            model: "fake",
            provider: "fake",
            durationMs: 1,
            rating: null,
            ratedAt: null,
            reviewJson: null,
            createdAt: now,
          })
          .run();
      }

      const res = await generateCarousel(source.id);
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: "upgrade_required", key: "monthlyGenerations" });
    });

    it("a successful run draws down exactly one generation", async () => {
      const source = await approvedSourceDraft(CONTENT);
      const count = () =>
        db.select().from(generations).all().filter((g) => g.workspaceId === workspaceId).length;
      const before = count();
      await generateCarousel(source.id);
      expect(count()).toBe(before + 1);
      const recorded = db
        .select()
        .from(generations)
        .all()
        .filter((g) => g.workspaceId === workspaceId)
        .at(-1)!;
      expect(recorded.taskType).toBe("instagram_carousel");
      expect(recorded.provider).toBe("design-pipeline");
    });
  });

  describe("Instagram publish wiring", () => {
    it("an approved carousel draft's media reaches the Graph API carousel flow unchanged", async () => {
      vi.stubEnv("INSTAGRAM_CLIENT_ID", "cid");
      vi.stubEnv("INSTAGRAM_CLIENT_SECRET", "csecret");

      // Connect Instagram through the real oauth session/complete routes.
      const session = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/instagram/oauth/session`,
      });
      expect(session.statusCode).toBe(200);
      ig.connections.set("nango-ig-1", {
        providerConfigKey: "tuezday-instagram",
        credentials: { type: "OAUTH2" },
      });
      const complete = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/instagram/oauth/complete`,
        payload: { connectionId: "nango-ig-1" },
      });
      expect(complete.statusCode).toBe(201);
      const connectionId = complete.json().id;

      const source = await approvedSourceDraft(CONTENT);
      const carousel = draftSchema.parse((await generateCarousel(source.id)).json());
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${carousel.id}/approve`,
      });

      const publish = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/drafts/${carousel.id}/publish`,
        payload: { connectionId, target: "feed", title: "Carousel" },
      });
      expect(publish.statusCode).toBe(201);
      expect(publish.json().status).toBe("published");

      // 5 child containers + 1 parent container, then one publish.
      expect(ig.igContainers).toBe(carousel.media!.length + 1);
      expect(ig.igPublished).toBe(1);
      const mediaCalls = ig.calls.filter((c) => c.path.split("?")[0]!.endsWith("/media"));
      const childUrls = mediaCalls
        .map((c) => (c.opts as { form?: { image_url?: string } })?.form?.image_url)
        .filter(Boolean);
      expect(childUrls).toEqual(carousel.media!.map((m) => m.url));
    });
  });
});
