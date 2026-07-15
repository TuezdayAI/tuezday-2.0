import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSchema } from "@tuezday/contracts";
import { randomUUID } from "node:crypto";
import type { TuezdayApp } from "../src/app";
import { ConnectorFabricError, type ConnectorFabric, type ProxyJsonResult } from "../src/connectors/fabric";
import { MetaAdsAdapter } from "../src/connectors/ads/meta";
import type { AuthorTemplateInput, DesignProvider } from "../src/design/provider";
import type { RenderInput } from "../src/design/render";
import { StorageError, type AssetStorage } from "../src/design/storage";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

// ---------------------------------------------------------------------------
// Fakes (mirrors the ads-execution harness, plus the Sprint 41 design fakes)
// ---------------------------------------------------------------------------

function fakeGateway(): LlmGateway {
  return {
    async generate({ prompt }) {
      const match = /Write (\d+) distinct Meta ad/.exec(prompt);
      const n = match ? Number(match[1]) : 1;
      const text = Array.from(
        { length: n },
        (_, i) =>
          `Primary text: Angle ${i + 1} for the offer.\nHeadline: Headline ${i + 1}\nDescription: Desc ${i + 1}`,
      ).join("\n---\n");
      return { text, model: "fake", provider: "fake", durationMs: 5 };
    },
  };
}

interface GraphState {
  nextId: number;
  creativePosts: Array<Record<string, unknown>>;
  adImagePosts: Array<Record<string, unknown>>;
  calls: string[];
}

function graphState(): GraphState {
  return { nextId: 1, creativePosts: [], adImagePosts: [], calls: [] };
}

function handleGraph(state: GraphState, method: string, path: string, body: unknown): ProxyJsonResult {
  state.calls.push(`${method} ${path.split("?")[0]}`);
  if (method === "GET") {
    if (path.startsWith("/v23.0/me/adaccounts")) {
      return { status: 200, json: { data: [{ id: "act_111", name: "Main", currency: "USD" }] } };
    }
    if (/insights|campaigns/.test(path)) return { status: 200, json: { data: [] } };
    return { status: 404, json: { error: { message: "no such endpoint" } } };
  }
  if (/^\/v23\.0\/act_\d+\/adimages$/.test(path)) {
    state.adImagePosts.push((body ?? {}) as Record<string, unknown>);
    return { status: 200, json: { images: { bytes: { hash: `imghash_${state.adImagePosts.length}` } } } };
  }
  if (/^\/v23\.0\/act_\d+\/campaigns$/.test(path)) return { status: 200, json: { id: `cmp_${state.nextId++}` } };
  if (/^\/v23\.0\/act_\d+\/adsets$/.test(path)) return { status: 200, json: { id: `as_${state.nextId++}` } };
  if (/^\/v23\.0\/act_\d+\/adcreatives$/.test(path)) {
    state.creativePosts.push((body ?? {}) as Record<string, unknown>);
    return { status: 200, json: { id: `crv_${state.nextId++}` } };
  }
  if (/^\/v23\.0\/act_\d+\/ads$/.test(path)) return { status: 200, json: { id: `ad_${state.nextId++}` } };
  if (/^\/v23\.0\/cmp_\d+$/.test(path)) return { status: 200, json: { success: true } };
  return { status: 404, json: { error: { message: "no such endpoint" } } };
}

function fakeFabric(state: GraphState): ConnectorFabric {
  return {
    async health() {
      return { healthy: true };
    },
    async ensureIntegration() {},
    async createConnectSession() {
      return { token: "t" };
    },
    async importConnection() {},
    async connectionExists() {
      return true;
    },
    async deleteConnection() {},
    async proxyGet() {
      return { status: 200, bodySnippet: '{"ok":true}' };
    },
    async proxyJson(method, path, _c, _k, opts) {
      return handleGraph(state, method, path, opts?.body);
    },
  };
}

const AD_TEMPLATE_HTML = `<div class="ad"><h1>{{title}}</h1><p>{{body}}</p></div>`;

function fakeDesign(): DesignProvider & { calls: AuthorTemplateInput[] } {
  const calls: AuthorTemplateInput[] = [];
  return {
    calls,
    async authorTemplate(input) {
      calls.push(input);
      return { html: AD_TEMPLATE_HTML, css: ".ad{}", placeholders: ["title", "body"] };
    },
  };
}

function fakeStorage(options?: { fail?: boolean }): AssetStorage {
  let n = 0;
  return {
    async put() {
      if (options?.fail) throw new StorageError("bucket exploded");
      n += 1;
      return { url: `https://cdn.test/design/ad-${n}.png` };
    },
  };
}

const fakeRender = async (input: RenderInput): Promise<Uint8Array> => {
  for (const name of input.template.placeholders) {
    if (input.values[name] === undefined) throw new Error(`missing placeholder ${name}`);
  }
  return new TextEncoder().encode(`png:${input.values.title}`);
};

/** Records what bytes the adapter downloaded for the upload. */
function imageFetcher(downloads: string[]): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    downloads.push(String(url));
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Meta ad image (Sprint 41 Part 5)", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let state: GraphState;
  let design: ReturnType<typeof fakeDesign>;
  let downloads: string[];
  let accountId: string;
  let approvedDraftId: string;
  let campaignId: string;

  beforeEach(async () => {
    state = graphState();
    design = fakeDesign();
    downloads = [];
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: fakeGateway(),
      connectors: fakeFabric(state),
      fetcher: imageFetcher(downloads),
      design,
      assetStorage: fakeStorage(),
      render: fakeRender,
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Ad images" } })
    ).json().id;
    campaignId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win" },
      })
    ).json().id;
    // Launch wiring here exercises the provider chain, so the paid-launch
    // action runs autonomously; the authorization queue is covered in
    // external-action-paid-launch.test.ts.
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/external-action-policies`,
      payload: {
        scope: "campaign",
        scopeId: campaignId,
        rules: [{ actionKind: "paid_launch", rule: "autonomous" }],
      },
    });
    const connection = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/connectors/meta_ads/connect`,
        payload: { accessToken: "EAAB-token" },
      })
    ).json();
    accountId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/accounts/import`,
        payload: { connectionId: connection.id },
      })
    ).json().accounts[0].id;
    const generated = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ad-creatives/generate`,
        payload: { taskType: "meta_ad_creative", campaignId },
      })
    ).json();
    approvedDraftId = generated.drafts[0].id;
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/drafts/${approvedDraftId}/approve`,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function generateImage(draftId: string) {
    return app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/ad-creatives/${draftId}/image`,
    });
  }

  async function launchWith(creativeDraftId: string) {
    const launch = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/launches`,
        payload: {
          adAccountId: accountId,
          creativeDraftId,
          name: "June push",
          objective: "OUTCOME_TRAFFIC",
          pageId: "123456789",
          linkUrl: "https://tuezday.app",
          dailyBudgetCents: 500,
          countries: ["US"],
        },
      })
    ).json();
    for (const action of ["submit", "approve", "launch"]) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/ads/launches/${launch.id}/${action}`,
      });
      // launch proposes an autonomous external action → 201 with a submission.
      expect(res.statusCode, `${action} failed: ${res.body}`).toBe(action === "launch" ? 201 : 200);
    }
    return app
      .inject({ method: "GET", url: `/workspaces/${workspaceId}/ads/launches/${launch.id}` })
      .then((r) => r.json());
  }

  describe("POST /ad-creatives/:draftId/image", () => {
    it("attaches a rendered 1080x1080 image to the approved creative draft", async () => {
      const res = await generateImage(approvedDraftId);
      expect(res.statusCode).toBe(201);
      const draft = draftSchema.parse(res.json());
      expect(draft.id).toBe(approvedDraftId); // same draft, media attached
      expect(draft.media).toEqual([
        { url: "https://cdn.test/design/ad-1.png", type: "image" },
      ]);
      expect(draft.state).toBe("approved"); // approval flow untouched
      expect(design.calls).toHaveLength(1);
      expect(design.calls[0]!.slideShape).toBe("ad-1080x1080");
    });

    it("second generation is a template cache hit; a non-approved draft is refused", async () => {
      await generateImage(approvedDraftId);
      await generateImage(approvedDraftId);
      expect(design.calls).toHaveLength(1); // authored once

      const gen2 = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/ad-creatives/generate`,
          payload: { taskType: "meta_ad_creative", campaignId },
        })
      ).json();
      const pending = gen2.drafts[0].id; // fresh drafts land pending_review
      const res = await generateImage(pending);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("source_not_eligible");
    });

    it("404s on a missing draft; storage failure writes no media", async () => {
      expect((await generateImage(randomUUID())).statusCode).toBe(404);

      const failingApp = await buildAuthedApp({
        db: createTestDb(),
        llm: fakeGateway(),
        connectors: fakeFabric(graphState()),
        fetcher: imageFetcher([]),
        design: fakeDesign(),
        assetStorage: fakeStorage({ fail: true }),
        render: fakeRender,
      });
      const ws = (
        await failingApp.inject({ method: "POST", url: "/workspaces", payload: { name: "F" } })
      ).json().id;
      const failCampaign = (
        await failingApp.inject({
          method: "POST",
          url: `/workspaces/${ws}/campaigns`,
          payload: { name: "Fail", objective: "Test" },
        })
      ).json().id;
      const gen = (
        await failingApp.inject({
          method: "POST",
          url: `/workspaces/${ws}/ad-creatives/generate`,
          payload: { taskType: "meta_ad_creative", campaignId: failCampaign },
        })
      ).json();
      const draftId = gen.drafts[0].id;
      await failingApp.inject({ method: "POST", url: `/workspaces/${ws}/drafts/${draftId}/approve` });

      const res = await failingApp.inject({
        method: "POST",
        url: `/workspaces/${ws}/ad-creatives/${draftId}/image`,
      });
      expect(res.statusCode).toBe(502);
      const after = await failingApp
        .inject({ method: "GET", url: `/workspaces/${ws}/drafts/${draftId}` })
        .then((r) => r.json());
      expect(after.media ?? null).toBeNull();
      await failingApp.close();
    });
  });

  describe("launch wiring", () => {
    it("uploads the draft's image, persists the hash, and attaches it to the creative", async () => {
      const withImage = draftSchema.parse((await generateImage(approvedDraftId)).json());
      const launched = await launchWith(approvedDraftId);

      // The adapter downloaded exactly the draft's hosted image.
      expect(downloads).toEqual([withImage.media![0]!.url]);
      // One adimages upload, base64 bytes present.
      expect(state.adImagePosts).toHaveLength(1);
      expect(String(state.adImagePosts[0]!.bytes ?? "")).not.toHaveLength(0);
      // Hash persisted on the launch and attached to the creative.
      expect(launched.metaImageHash).toBe("imghash_1");
      const linkData = (state.creativePosts[0]!.object_story_spec as any).link_data;
      expect(linkData.image_hash).toBe("imghash_1");
    });

    it("a text-only creative launches exactly as before — no upload call", async () => {
      const launched = await launchWith(approvedDraftId);
      expect(state.adImagePosts).toHaveLength(0);
      expect(downloads).toHaveLength(0);
      expect(launched.metaImageHash).toBeNull();
      const linkData = (state.creativePosts[0]!.object_story_spec as any).link_data;
      expect(linkData.image_hash).toBeUndefined();
      expect(launched.status).toBe("launched");
    });
  });

  describe("MetaAdsAdapter.uploadAdImage", () => {
    const opts = { nangoConnectionId: "c1", integrationKey: "tuezday-meta_ads" };

    it("posts base64 bytes to /adimages and returns the hash", async () => {
      const s = graphState();
      const adapter = new MetaAdsAdapter(fakeFabric(s), opts, imageFetcher([]));
      const result = await adapter.uploadAdImage("act_111", { bytes: new Uint8Array([9, 9]) });
      expect(result.imageHash).toBe("imghash_1");
      expect(s.adImagePosts[0]!.bytes).toBe(Buffer.from([9, 9]).toString("base64"));
    });

    it("wraps download failures and Graph errors in ConnectorFabricError", async () => {
      const s = graphState();
      const failingFetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
      const adapter = new MetaAdsAdapter(fakeFabric(s), opts, failingFetch);
      await expect(
        adapter.uploadAdImage("act_111", { url: "https://cdn.test/missing.png" }),
      ).rejects.toBeInstanceOf(ConnectorFabricError);

      const badGraph: ConnectorFabric = {
        ...fakeFabric(s),
        async proxyJson() {
          return { status: 400, json: { error: { message: "bad image" } } };
        },
      };
      const adapter2 = new MetaAdsAdapter(badGraph, opts, imageFetcher([]));
      await expect(
        adapter2.uploadAdImage("act_111", { bytes: new Uint8Array([1]) }),
      ).rejects.toBeInstanceOf(ConnectorFabricError);
    });
  });
});
