import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverySourceSchema, discoveredItemSchema } from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Fetcher } from "../src/discovery/adapters";
import type { LlmGateway } from "../src/llm/gateway";
import { buildAuthedApp, createTestDb } from "./helpers";

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Buyers hate generic AI output</title><link>https://example.com/a</link><guid>item-a</guid><description>Thread about generic output.</description></item>
<item><title>GTM teams forget what worked</title><link>https://example.com/b</link><guid>item-b</guid><description>Memory problem discussion.</description></item>
</channel></rss>`;

const RSS_FIXTURE_V2 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Buyers hate generic AI output</title><link>https://example.com/a</link><guid>item-a</guid><description>Thread about generic output.</description></item>
<item><title>Fresh third item</title><link>https://example.com/c</link><guid>item-c</guid><description>Newly published.</description></item>
</channel></rss>`;

/** Serves RSS fixtures; second run serves v2 to test dedupe. Failing URLs 500. */
function makeFetcher(): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("failing.example.com")) return new Response("boom", { status: 500 });
    const timesFetched = calls.filter((c) => c === u).length;
    return new Response(timesFetched > 1 ? RSS_FIXTURE_V2 : RSS_FIXTURE, { status: 200 });
  }) as Fetcher;
  return { fetcher, calls };
}

/** Scores every item 0-100 by position; suggests the first persona + campaign for item index 0. */
function scoringGateway(
  personaIdRef: { id: string | null },
  campaignIdRef: { id: string | null },
): LlmGateway {
  return {
    async generate({ prompt }) {
      if (prompt.includes("propose discovery sources")) {
        return {
          text: JSON.stringify([
            {
              type: "google_news",
              name: "News: GTM memory",
              config: { query: "GTM memory layer" },
              reason: "Matches the soul doc positioning.",
            },
            {
              type: "reddit",
              name: "r/SaaS founders",
              config: { subreddit: "SaaS" },
              reason: "ICP hangs out here.",
            },
          ]),
          model: "fake",
          provider: "fake",
          durationMs: 3,
        };
      }
      // scoring call: count ITEM markers, emit one entry per item
      const count = (prompt.match(/ITEM \d+:/g) ?? []).length;
      const scores = Array.from({ length: count }, (_, i) => ({
        index: i,
        score: 90 - i * 10,
        personaId: i === 0 ? personaIdRef.id : null,
        campaignId: i === 0 ? campaignIdRef.id : null,
        reason: `Relevant because reason ${i}.`,
      }));
      return { text: JSON.stringify(scores), model: "fake", provider: "fake", durationMs: 3 };
    },
  };
}

describe("discovery API", () => {
  let app: TuezdayApp;
  let workspaceId: string;
  let personaRef: { id: string | null };
  let campaignRef: { id: string | null };

  beforeEach(async () => {
    personaRef = { id: null };
    campaignRef = { id: null };
    const { fetcher } = makeFetcher();
    app = await buildAuthedApp({
      db: createTestDb(),
      llm: scoringGateway(personaRef, campaignRef),
      fetcher,
    });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Disco" } })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/brain/soul`,
      payload: { content: "We exist to end GTM amnesia." },
    });
    const persona = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/personas`,
        payload: { name: "CEO" },
      })
    ).json();
    personaRef.id = persona.id;
    const campaign = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win fintech VPs" },
      })
    ).json();
    campaignRef.id = campaign.id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function addRssSource(feedUrl = "https://feeds.example.com/blog.xml") {
    return (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: { type: "rss", config: { feedUrl } },
      })
    ).json();
  }

  async function run() {
    return (
      await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/discovery/run` })
    ).json();
  }

  async function items(status?: string) {
    const qs = status ? `?status=${status}` : "";
    return (
      await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/discovery/items${qs}` })
    ).json();
  }

  describe("sources", () => {
    it("creates a live rss source as active", async () => {
      const source = await addRssSource();
      expect(discoverySourceSchema.safeParse(source).success).toBe(true);
      expect(source.status).toBe("active");
      expect(source.enabled).toBe(true);
      expect(source.name.length).toBeGreaterThan(0);
    });

    it("creates an x source as needs_api_key", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: { type: "x", config: { query: "GTM memory" } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("needs_api_key");
    });

    it("rejects an rss source without a feed url", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: { type: "rss", config: {} },
      });
      expect(res.statusCode).toBe(400);
    });

    it("can disable a source", async () => {
      const source = await addRssSource();
      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { enabled: false },
      });
      expect(res.json().enabled).toBe(false);
    });

    it("deletes a source", async () => {
      const source = await addRssSource();
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
      });
      expect(res.statusCode).toBe(204);
      const list = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/discovery/sources` })
      ).json();
      expect(list).toEqual([]);
    });
  });

  describe("run pipeline", () => {
    it("fetches, stores, and brain-scores items", async () => {
      await addRssSource();
      const result = await run();
      expect(result.sources[0]).toMatchObject({ fetched: 2, new: 2 });
      expect(result.scored).toBe(2);

      const list = await items();
      expect(list).toHaveLength(2);
      for (const item of list) {
        expect(discoveredItemSchema.safeParse(item).success).toBe(true);
        expect(item.status).toBe("new");
      }
      // sorted by score desc; first item got the persona suggestion
      expect(list[0].score).toBe(90);
      expect(list[0].suggestedPersonaId).toBe(personaRef.id);
      expect(list[0].suggestedCampaignId).toBe(campaignRef.id);
      expect(list[0].scoreReason).toContain("Relevant because");
      expect(list[1].score).toBe(80);
    });

    it("dedupes already-seen items on the next run", async () => {
      await addRssSource();
      await run();
      const second = await run(); // fixture v2: item-a (dupe) + item-c (new)
      expect(second.sources[0]).toMatchObject({ fetched: 2, new: 1 });
      const list = await items();
      expect(list).toHaveLength(3);
    });

    it("marks a failing source as error without failing the run", async () => {
      await addRssSource();
      const bad = await addRssSource("https://failing.example.com/feed.xml");
      const result = await run();
      const badResult = result.sources.find((s: { sourceId: string }) => s.sourceId === bad.id);
      expect(badResult.error).toContain("500");
      const sources = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/discovery/sources` })
      ).json();
      const badSource = sources.find((s: { id: string }) => s.id === bad.id);
      expect(badSource.status).toBe("error");
      expect(badSource.lastError).toContain("500");
      // the healthy source still produced items
      expect((await items()).length).toBeGreaterThan(0);
    });

    it("skips disabled and needs_api_key sources", async () => {
      const source = await addRssSource();
      await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { enabled: false },
      });
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: { type: "x", config: { query: "GTM" } },
      });
      const result = await run();
      expect(result.sources).toEqual([]);
      expect(await items()).toEqual([]);
    });
  });

  describe("provider-gated sources (Sprint 31)", () => {
    it("registers intent/g2/capterra as needs_api_key and skips them without a provider", async () => {
      for (const type of ["intent", "g2", "capterra"] as const) {
        const res = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: { type, config: { query: "acme" } },
        });
        expect(res.json().status).toBe("needs_api_key");
      }
      const result = await run();
      expect(result.sources).toEqual([]); // all inert, nothing fetched
      expect(await items()).toEqual([]);
    });

    it("fetches intent items through a configured IntentProvider", async () => {
      const { fetcher } = makeFetcher();
      const intent = {
        isConfigured: () => true,
        fetchSignals: async () => [
          {
            externalId: "funding-1",
            title: "Acme raised a $20M Series B",
            url: "https://example.com/acme",
            summary: "Funding round closed.",
            publishedAt: Date.now(),
          },
        ],
      };
      const localApp = await buildAuthedApp({
        db: createTestDb(),
        llm: scoringGateway({ id: null }, { id: null }),
        fetcher,
        intent,
      });
      const ws = (
        await localApp.inject({ method: "POST", url: "/workspaces", payload: { name: "Intent" } })
      ).json().id;
      await localApp.inject({
        method: "POST",
        url: `/workspaces/${ws}/discovery/sources`,
        payload: { type: "intent", config: { query: "acme.com" } },
      });
      const result = (
        await localApp.inject({ method: "POST", url: `/workspaces/${ws}/discovery/run` })
      ).json();
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].new).toBe(1);
      const list = (
        await localApp.inject({ method: "GET", url: `/workspaces/${ws}/discovery/items` })
      ).json();
      expect(list[0].title).toContain("Acme raised");
      await localApp.close();
    });
  });

  describe("triage", () => {
    it("accepting an item creates a linked signal with mapped source", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });
      expect(res.statusCode).toBe(200);
      const { item, signal } = res.json();
      expect(item.status).toBe("accepted");
      expect(item.signalId).toBe(signal.id);
      expect(signal.source).toBe("rss");
      expect(signal.content).toContain(top.title);
      expect(signal.sourceUrl).toBe(top.url);
      // the campaign/persona mapping is carried onto the signal for the draft
      expect(signal.suggestedPersonaId).toBe(top.suggestedPersonaId);
      expect(signal.suggestedCampaignId).toBe(top.suggestedCampaignId);

      // it shows up in the Sprint 6 signal inbox
      const signals = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/signals` })
      ).json();
      expect(signals.some((s: { id: string }) => s.id === signal.id)).toBe(true);
    });

    it("refuses double-accept with 409", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });
      expect(res.statusCode).toBe(409);
    });

    it("skips an item", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/skip`,
      });
      expect(res.json().status).toBe("skipped");
      const remaining = await items("new");
      expect(remaining.some((i: { id: string }) => i.id === top.id)).toBe(false);
    });

    it("returns 404 for an unknown item", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/7c9e6679-7425-40de-944b-e07fc1f90ae7/accept`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("suggest", () => {
    it("proposes brain-derived sources without persisting them", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/suggest`,
      });
      expect(res.statusCode).toBe(200);
      const proposals = res.json();
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0]).toMatchObject({ type: "google_news" });
      expect(proposals[0].reason.length).toBeGreaterThan(0);
      const sources = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/discovery/sources` })
      ).json();
      expect(sources).toEqual([]);
    });
  });
});
