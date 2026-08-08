import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  DISCOVERY_MAX_MATCHES_PER_ITEM,
  RESERVED_DISCOVERY_SOURCE_TYPES,
  discoverySourceSchema,
  discoveredItemSchema,
  isReservedDiscoverySourceType,
  signalSchema,
} from "@tuezday/contracts";
import { isLiveSourceType } from "../src/discovery/adapters";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  campaigns,
  discoveredItemMatches,
  discoveredItems,
  discoveryJobs,
  discoverySources,
  signalMatches,
  signals,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import {
  safeFetchError,
  safeFetchPublicMessage,
  type SafeFetchService,
} from "../src/safe-fetch";
import {
  MatchingNotReadyError,
  acceptDiscoveredItem,
} from "../src/services/discovery";
import { enqueueDueDiscoveryJobs } from "../src/services/discovery-jobs";
import { buildAuthedApp, createTestDb } from "./helpers";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";

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
function makeFetcher(): { fetcher: SafeFetchService; calls: string[] } {
  const calls: string[] = [];
  const fetcher = fixtureSafeFetch((request) => {
    const u = request.url;
    calls.push(u);
    if (
      u.includes("failing.example.com") ||
      u.includes("169.254.169.254")
    ) {
      return {
        contentType: "application/xml",
        error: safeFetchError(
          u.includes("169.254.169.254")
            ? "destination_blocked"
            : "upstream_status",
        ),
      };
    }
    if (u.includes("hostile.example.com")) {
      return {
        contentType: "application/xml",
        error: new Error(
          "parser saw <html>private</html> from db.internal at 169.254.169.254",
        ),
      };
    }
    const timesFetched = calls.filter((c) => c === u).length;
    return {
      body: timesFetched > 1 ? RSS_FIXTURE_V2 : RSS_FIXTURE,
      contentType: "application/xml",
    };
  });
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
        reason: `Relevant because reason ${i}.`,
        matches:
          i === 0 && (personaIdRef.id || campaignIdRef.id)
            ? [
                {
                  personaId: personaIdRef.id,
                  campaignId: campaignIdRef.id,
                  score: 90 - i * 10,
                  reason: `Relevant because reason ${i}.`,
                },
              ]
            : [],
      }));
      return { text: JSON.stringify(scores), model: "fake", provider: "fake", durationMs: 3 };
    },
  };
}

describe("discovery API", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  let personaRef: { id: string | null };
  let campaignRef: { id: string | null };

  beforeEach(async () => {
    personaRef = { id: null };
    campaignRef = { id: null };
    const { fetcher } = makeFetcher();
    db = await createTestDb();
    app = await buildAuthedApp({
      db,
      llm: scoringGateway(personaRef, campaignRef),
      safeFetch: fetcher,
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
    // The persona must be assigned to the campaign: Sprint 45 scoring drops a
    // suggested persona the campaign doesn't allow.
    const campaign = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/campaigns`,
        payload: { name: "Launch", objective: "Win fintech VPs", personaIds: [persona.id] },
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
    it("rejects Google Trends creation and activation as reserved", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: {
          type: "google_trends",
          config: { geo: "US" },
        },
      });
      expect(created.statusCode).toBe(409);
      expect(created.json()).toMatchObject({ error: "source_reserved" });

      const sourceId = "11111111-1111-4111-8111-111111111111";
      await db.insert(discoverySources)
        .values({
          id: sourceId,
          workspaceId,
          type: "google_trends",
          name: "Legacy Trends",
          configJson: JSON.stringify({ geo: "US" }),
          enabled: false,
          status: "reserved",
          lastError: "source_reserved",
          lastFetchedAt: null,
          connectionId: null,
          cursorJson: "{}",
          backoffUntil: null,
          lastAttemptedAt: null,
          executionVersion: 1,
          createdAt: 1,
        });

      const activated = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${sourceId}`,
        payload: { enabled: true },
      });
      expect(activated.statusCode).toBe(409);
      expect(activated.json()).toMatchObject({ error: "source_reserved" });

      const renamed = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${sourceId}`,
        payload: { name: "Archived Trends" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        name: "Archived Trends",
        status: "reserved",
        enabled: false,
      });
    });

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

    it("rejects a metadata feed URL at creation with only a safe failure", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/sources`,
        payload: {
          type: "rss",
          config: { feedUrl: "http://169.254.169.254/latest/meta-data" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        code: "destination_blocked",
        message: safeFetchPublicMessage("destination_blocked"),
      });
    });

    it("blocks a pre-existing unsafe feed row during fetch and persists only the safe class", async () => {
      const source = await addRssSource();
      await db.update(discoverySources)
        .set({
          configJson: JSON.stringify({
            feedUrl: "http://169.254.169.254/latest/meta-data",
          }),
        })
        .where(eq(discoverySources.id, source.id));

      const result = await run();
      expect(result.sources[0]?.error).toBe(
        `destination_blocked: ${safeFetchPublicMessage("destination_blocked")}`,
      );
      const stored = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/discovery/sources`,
        })
      )
        .json()
        .find((candidate: { id: string }) => candidate.id === source.id);
      expect(stored.lastError).toBe(
        `destination_blocked: ${safeFetchPublicMessage("destination_blocked")}`,
      );
      expect(stored.lastError).not.toContain("169.254.169.254");
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

    it("rejects an invalid complete RSS config and preserves the stored source", async () => {
      const source = await addRssSource();

      const update = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: { config: {} },
      });

      expect(update.statusCode).toBe(400);
      expect(update.json()).toEqual({
        error: "invalid_input",
        message: "An RSS source needs a feedUrl",
      });
      expect(JSON.stringify(update.json())).not.toContain(
        "https://feeds.example.com/blog.xml",
      );
      const stored = ((await db
        .select()
        .from(discoverySources)
        .where(eq(discoverySources.id, source.id)))[0])!;
      expect(JSON.parse(stored.configJson)).toEqual(source.config);
    });

    it("derives healthy runtime state after a valid material config change", async () => {
      const source = await addRssSource();
      await db.update(discoverySources)
        .set({
          status: "error",
          lastError: "transport_failed: stale failure",
          backoffUntil: Date.now() + 60_000,
        })
        .where(eq(discoverySources.id, source.id));

      const update = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${source.id}`,
        payload: {
          config: { feedUrl: "https://feeds.example.com/recovered.xml" },
        },
      });

      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({
        status: "active",
        lastError: null,
        backoffUntil: null,
        config: { feedUrl: "https://feeds.example.com/recovered.xml" },
      });
    });

    it("cancels queued work when disabling or materially changing a source", async () => {
      const disabledSource = await addRssSource(
        "https://feeds.example.com/disable.xml",
      );
      const changedSource = await addRssSource(
        "https://feeds.example.com/change.xml",
      );
      expect(
        await enqueueDueDiscoveryJobs(
          db,
          workspaceId,
          [disabledSource, changedSource],
          Date.now(),
        ),
      ).toBe(2);

      const disabled = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${disabledSource.id}`,
        payload: { enabled: false },
      });
      const changed = await app.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/discovery/sources/${changedSource.id}`,
        payload: {
          config: { feedUrl: "https://feeds.example.com/changed.xml" },
        },
      });

      expect(disabled.statusCode).toBe(200);
      expect(changed.statusCode).toBe(200);
      const cancelled = await db
        .select()
        .from(discoveryJobs)
        .where(eq(discoveryJobs.workspaceId, workspaceId));
      expect(cancelled).toHaveLength(2);
      expect(
        cancelled.map((job) => ({
          status: job.status,
          error: job.error,
          hasFinishedAt: job.finishedAt !== null,
        })),
      ).toEqual([
        {
          status: "skipped",
          error: "source_version_changed",
          hasFinishedAt: true,
        },
        {
          status: "skipped",
          error: "source_version_changed",
          hasFinishedAt: true,
        },
      ]);
    });

    it.each(["rss", "podcast"] as const)(
      "rejects an unsafe %s feed update without changing the source",
      async (type) => {
        const originalFeedUrl = "https://feeds.example.com/original.xml";
        const created = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: { type, config: { feedUrl: originalFeedUrl } },
        });
        expect(created.statusCode).toBe(201);

        const update = await app.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/discovery/sources/${created.json().id}`,
          payload: {
            config: {
              feedUrl: "http://169.254.169.254/latest/meta-data",
            },
          },
        });
        expect(update.statusCode).toBe(400);
        expect(update.json()).toEqual({
          code: "destination_blocked",
          message: safeFetchPublicMessage("destination_blocked"),
        });

        const stored = (
          await app.inject({
            method: "GET",
            url: `/workspaces/${workspaceId}/discovery/sources`,
          })
        )
          .json()
          .find((candidate: { id: string }) => candidate.id === created.json().id);
        expect(stored.config.feedUrl).toBe(originalFeedUrl);
      },
    );

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
      // Sprint 46: the run reports its job ledger activity
      expect(result.queued).toBe(1);
      expect(result.processed).toBe(1);
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
      expect(badResult.error).toBe(
        `upstream_status: ${safeFetchPublicMessage("upstream_status")}`,
      );
      const sources = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/discovery/sources` })
      ).json();
      const badSource = sources.find((s: { id: string }) => s.id === bad.id);
      expect(badSource.status).toBe("error");
      expect(badSource.lastError).toBe(
        `upstream_status: ${safeFetchPublicMessage("upstream_status")}`,
      );
      // the healthy source still produced items
      expect((await items()).length).toBeGreaterThan(0);
    });

    it("redacts an unexpected keyless adapter failure before persistence", async () => {
      const bad = await addRssSource("https://hostile.example.com/feed.xml");
      const result = await run();
      const failure = result.sources.find(
        (source: { sourceId: string }) => source.sourceId === bad.id,
      );
      expect(failure.error).toBe(
        `transport_failed: ${safeFetchPublicMessage("transport_failed")}`,
      );
      expect(failure.error).not.toContain("db.internal");
      expect(failure.error).not.toContain("169.254.169.254");
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
      expect(result.queued).toBe(0);
      expect(result.processed).toBe(0);
      expect(result.sources).toEqual([]);
      expect(await items()).toEqual([]);
    });
  });

  describe("reserved provider vocabulary", () => {
    it("keeps unsupported commercial source types visible but blocked", async () => {
      expect(RESERVED_DISCOVERY_SOURCE_TYPES).toEqual([
        "google_trends",
        "g2",
        "capterra",
        "intent",
      ]);
      for (const type of ["intent", "g2", "capterra"] as const) {
        expect(isReservedDiscoverySourceType(type)).toBe(true);
        expect(isLiveSourceType(type)).toBe(false);
        const res = await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: { type, config: { query: "acme" } },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("source_reserved");
      }
      const result = await run();
      expect(result.sources).toEqual([]);
      expect(await items()).toEqual([]);
    });
  });

  describe("triage", () => {
    it("returns a stable 409 while matching is not ready", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      await db.update(discoveredItems)
        .set({
          matchingState: "pending",
          matchingError: null,
        })
        .where(eq(discoveredItems.id, top.id));

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "matching_not_ready",
        message: "Scoring has not completed for this item yet.",
      });
      expect(
        await db
          .select()
          .from(signals)
          .where(eq(signals.workspaceId, workspaceId)),
      ).toEqual([]);
    });

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
      // the item's routing is carried onto the signal as real match rows, and
      // both sides project the same top match (Sprint 53)
      expect(signal.matches[0]).toMatchObject({
        personaId: personaRef.id,
        campaignId: campaignRef.id,
      });
      expect(signal.suggestedPersonaId).toBe(personaRef.id);
      expect(signal.suggestedCampaignId).toBe(campaignRef.id);
      expect(top.suggestedPersonaId).toBe(personaRef.id);
      expect(top.suggestedCampaignId).toBe(campaignRef.id);

      // it shows up in the Sprint 6 signal inbox
      const signals = (
        await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/signals` })
      ).json();
      expect(signals.some((s: { id: string }) => s.id === signal.id)).toBe(true);
    });

    // Sprint 53: Task 7 will null the legacy columns for real. Prove the accept
    // path routes from the item's match rows and never reads those columns.
    it("accepting routes from the item's matches, not the legacy columns", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      await db.update(discoveredItems)
        .set({ suggestedPersonaId: null, suggestedCampaignId: null })
        .where(eq(discoveredItems.id, top.id));

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(res.statusCode).toBe(200);
      const { item, signal } = res.json();
      expect(item.suggestedPersonaId).toBe(personaRef.id);
      expect(item.suggestedCampaignId).toBe(campaignRef.id);
      expect(signal.suggestedPersonaId).toBe(personaRef.id);
      expect(signal.suggestedCampaignId).toBe(campaignRef.id);
      expect(signal.matches[0]).toMatchObject({
        personaId: personaRef.id,
        campaignId: campaignRef.id,
      });
      const stored = ((await db.select().from(signals).where(eq(signals.id, signal.id)))[0])!;
      expect(stored.suggestedPersonaId).toBeNull();
      expect(stored.suggestedCampaignId).toBeNull();
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

    it("invalidates a stale related reference before it can be accepted", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      expect(top.suggestedPersonaId).toBe(personaRef.id);
      const deleted = await app.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/personas/${personaRef.id}`,
      });
      expect(deleted.statusCode).toBe(204);

      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(accepted.statusCode).toBe(409);
      expect(accepted.json()).toEqual({
        error: "matching_not_ready",
        message: "Scoring has not completed for this item yet.",
      });
      const storedItem = (await items()).find(
        (candidate: { id: string }) => candidate.id === top.id,
      );
      expect(storedItem).toMatchObject({
        status: "new",
        signalId: null,
        matchingState: "pending",
      });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, workspaceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(signalMatches)
          .where(eq(signalMatches.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });

    it("rolls back signal creation when acceptance faults after the signal insert", async () => {
      await addRssSource();
      await run();
      const [top] = await items();

      await expect((async () =>
        await acceptDiscoveredItem(db, workspaceId, top.id, {
          afterSignalInsert() {
            throw new Error("fault_after_accept_signal");
          },
        }))(),
      ).rejects.toThrow("fault_after_accept_signal");

      const storedItem = (await items()).find(
        (candidate: { id: string }) => candidate.id === top.id,
      );
      expect(storedItem).toMatchObject({ status: "new", signalId: null });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, workspaceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(signalMatches)
          .where(eq(signalMatches.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });

    it("returns 404 when accepting an item through a different workspace", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Other Triage Workspace" },
        })
      ).json().id as string;

      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${otherWorkspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(accepted.statusCode).toBe(404);
      expect(accepted.json()).toEqual({ error: "item_not_found" });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, otherWorkspaceId)),
      ).toHaveLength(0);
    });

    it("rejects an item whose source belongs to another workspace", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Item Source Workspace" },
        })
      ).json().id as string;
      const foreignSource = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${otherWorkspaceId}/discovery/sources`,
          payload: {
            type: "rss",
            config: { feedUrl: "https://feeds.example.com/foreign.xml" },
          },
        })
      ).json();
      await db.update(discoveredItems)
        .set({ sourceId: foreignSource.id })
        .where(eq(discoveredItems.id, top.id));

      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(accepted.statusCode).toBe(404);
      expect(accepted.json()).toEqual({ error: "related_object_not_found" });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });

    it("rejects a foreign copied match without partially accepting the item", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Match Workspace" },
        })
      ).json().id as string;
      const foreignPersonaId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${otherWorkspaceId}/personas`,
          payload: { name: "Foreign Match Persona" },
        })
      ).json().id as string;
      await db.update(discoveredItemMatches)
        .set({ personaId: foreignPersonaId })
        .where(eq(discoveredItemMatches.itemId, top.id));
      const visibleItem = (await items()).find(
        (candidate: { id: string }) => candidate.id === top.id,
      );
      expect(visibleItem.matches).toEqual([]);
      expect(JSON.stringify(visibleItem)).not.toContain(foreignPersonaId);

      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(accepted.statusCode).toBe(404);
      expect(accepted.json()).toEqual({ error: "related_object_not_found" });
      const storedItem = (await items()).find(
        (candidate: { id: string }) => candidate.id === top.id,
      );
      expect(storedItem).toMatchObject({ status: "new", signalId: null });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, workspaceId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(signalMatches)
          .where(eq(signalMatches.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });

    it("rejects an item-match row assigned to a different workspace", async () => {
      await addRssSource();
      await run();
      const [top] = await items();
      const otherWorkspaceId = (
        await app.inject({
          method: "POST",
          url: "/workspaces",
          payload: { name: "Foreign Match Row Workspace" },
        })
      ).json().id as string;
      await db.update(discoveredItemMatches)
        .set({ workspaceId: otherWorkspaceId })
        .where(eq(discoveredItemMatches.itemId, top.id));
      const visibleItem = (await items()).find(
        (candidate: { id: string }) => candidate.id === top.id,
      );
      expect(visibleItem.matches).toEqual([]);

      const accepted = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/items/${top.id}/accept`,
      });

      expect(accepted.statusCode).toBe(404);
      expect(accepted.json()).toEqual({ error: "related_object_not_found" });
      const storedItem = (await db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.id, top.id)))[0];
      expect(storedItem).toMatchObject({ status: "new", signalId: null });
      expect(
        await db.select().from(signals).where(eq(signals.workspaceId, workspaceId)),
      ).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Sprint 45+49 — multi-candidate scoring, targeted re-score, cross-source dedup
// ---------------------------------------------------------------------------

/** Serves a fixed XML body per feed URL; unknown URLs 404. */
function fixtureFetcher(feeds: Record<string, string>): SafeFetchService {
  return fixtureSafeFetch((request) => {
    const body = feeds[request.url];
    return body
      ? { body, contentType: "application/xml" }
      : {
          contentType: "application/xml",
          error: safeFetchError("upstream_status"),
        };
  });
}

interface MatchingHarness {
  app: TuezdayApp;
  db: Db;
  workspaceId: string;
  /** Every scoring prompt the gateway saw, in order. */
  scoringPrompts: string[];
  setResponder(fn: (prompt: string) => unknown): void;
  /** Persona with Sprint 44 topics, assigned to campaignA. */
  fieldCto: string;
  /** Persona without topics, assigned to campaignB. */
  communityLead: string;
  campaignA: string;
  campaignB: string;
  addSource(feedUrl?: string): Promise<{ id: string; name: string }>;
  run(): Promise<{ sources: unknown[]; scored: number }>;
  items(status?: string): Promise<Record<string, any>[]>;
}

/**
 * Workspace with two personas and two active campaigns (each persona assigned
 * to its own campaign), driven by a scriptable scoring gateway.
 */
async function buildMatchingHarness(fetcher?: SafeFetchService): Promise<MatchingHarness> {
  const db = await createTestDb();
  const scoringPrompts: string[] = [];
  let responder: (prompt: string) => unknown | Promise<unknown> = () => [];
  const llm: LlmGateway = {
    async generate({ prompt }) {
      scoringPrompts.push(prompt);
      return {
        text: JSON.stringify(await responder(prompt)),
        model: "fake",
        provider: "fake",
        durationMs: 1,
      };
    },
  };
  const app = await buildAuthedApp({
    db,
    llm,
    safeFetch: fetcher ?? makeFetcher().fetcher,
  });
  const workspaceId = (
    await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Match Co" } })
  ).json().id;
  const fieldCto = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "Field CTO", topics: ["agentic coding", "evals"] },
    })
  ).json().id;
  const communityLead = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/personas`,
      payload: { name: "Community Lead" },
    })
  ).json().id;
  const campaignA = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: "Product Launch", objective: "Launch the agent", personaIds: [fieldCto] },
    })
  ).json().id;
  const campaignB = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: "Community", objective: "Grow the community", personaIds: [communityLead] },
    })
  ).json().id;

  return {
    app,
    db,
    workspaceId,
    scoringPrompts,
    setResponder: (fn) => {
      responder = fn;
    },
    fieldCto,
    communityLead,
    campaignA,
    campaignB,
    addSource: async (feedUrl = "https://feeds.example.com/blog.xml") =>
      (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/discovery/sources`,
          payload: { type: "rss", config: { feedUrl } },
        })
      ).json(),
    run: async () =>
      (await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/discovery/run` })).json(),
    items: async (status?: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/discovery/items${status ? `?status=${status}` : ""}`,
        })
      ).json(),
  };
}

describe("multi-candidate scoring (Sprint 45)", () => {
  let h: MatchingHarness;

  beforeEach(async () => {
    h = await buildMatchingHarness();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("stores one row per candidate and mirrors the best onto the item", async () => {
    // Best candidate deliberately second: selection is by score, not order.
    h.setResponder(() => [
      {
        index: 0,
        score: 88,
        matches: [
          { personaId: h.communityLead, campaignId: h.campaignB, score: 60, reason: "Community angle." },
          { personaId: h.fieldCto, campaignId: h.campaignA, score: 90, reason: "Fits the launch." },
        ],
      },
      { index: 1, score: 40, matches: [] },
    ]);
    await h.addSource();
    const result = await h.run();
    expect(result.scored).toBe(2);

    const list = await h.items();
    const top = list.find((i) => i.score === 88)!;
    expect(discoveredItemSchema.safeParse(top).success).toBe(true);
    expect(top.matches).toHaveLength(2);
    expect(top.matches[0]).toMatchObject({
      personaId: h.fieldCto,
      personaName: "Field CTO",
      campaignId: h.campaignA,
      campaignName: "Product Launch",
      score: 90,
      reason: "Fits the launch.",
    });
    expect(top.matches[1]).toMatchObject({ personaId: h.communityLead, campaignId: h.campaignB, score: 60 });
    // convenience fields = overall relevance + best-scoring match
    expect(top.suggestedPersonaId).toBe(h.fieldCto);
    expect(top.suggestedCampaignId).toBe(h.campaignA);
    expect(top.scoreReason).toBe("Fits the launch.");
    const rows = await h.db
      .select()
      .from(discoveredItemMatches)
      .where(eq(discoveredItemMatches.itemId, top.id as string));
    expect(rows).toHaveLength(2);

    const other = list.find((i) => i.score === 40)!;
    expect(other.matches).toEqual([]);
    expect(other.suggestedPersonaId).toBeNull();
    expect(other.suggestedCampaignId).toBeNull();

    // prompt shape: Sprint 44 topics line, no-topics fallback line, and the
    // campaign line naming its assigned personas
    expect(h.scoringPrompts[0]).toContain(`- ${h.fieldCto}: Field CTO — topics: agentic coding, evals`);
    expect(h.scoringPrompts[0]).toContain(`- ${h.communityLead}: Community Lead`);
    expect(h.scoringPrompts[0]).toContain(`personas: [${h.fieldCto}: Field CTO]`);
  });

  it("drops a campaign that leaves the workspace while scoring is in flight", async () => {
    const otherWorkspaceId = (
      await h.app.inject({
        method: "POST",
        url: "/workspaces",
        payload: { name: "Scoring Race Workspace" },
      })
    ).json().id as string;
    h.setResponder(async () => {
      await h.db
        .update(campaigns)
        .set({ workspaceId: otherWorkspaceId })
        .where(eq(campaigns.id, h.campaignA));
      return [
        {
          index: 0,
          score: 88,
          matches: [
            {
              personaId: null,
              campaignId: h.campaignA,
              score: 90,
              reason: "Stale campaign.",
            },
          ],
        },
      ];
    });

    await h.addSource();
    await h.run();

    const target = (await h.items("new"))[0]!;
    expect(target.suggestedCampaignId).toBeNull();
    expect(target.matches).toEqual([]);
    expect(
      await h.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.itemId, target.id as string)),
    ).toEqual([]);
  });

  it("blocks acceptance while matching is in flight", async () => {
    let rejection: unknown;
    h.setResponder(async () => {
      const item = ((await h.db
        .select()
        .from(discoveredItems)
        .where(eq(discoveredItems.workspaceId, h.workspaceId)))[0])!;
      try {
        await acceptDiscoveredItem(h.db, h.workspaceId, item.id);
      } catch (error) {
        rejection = error;
      }
      return [
        {
          index: 0,
          score: 88,
          matches: [
            {
              personaId: h.fieldCto,
              campaignId: h.campaignA,
              score: 90,
              reason: "Too late.",
            },
          ],
        },
      ];
    });

    await h.addSource();
    await h.run();

    expect(rejection).toBeInstanceOf(MatchingNotReadyError);
    const [ready] = await h.items();
    expect(ready).toMatchObject({
      status: "new",
      matchingState: "ready",
      score: 88,
    });
    expect(
      await h.db
        .select()
        .from(signals)
        .where(eq(signals.workspaceId, h.workspaceId)),
    ).toEqual([]);
  });

  it("rolls back match replacement when one scoring write fails", async () => {
    h.setResponder(() => [
      {
        index: 0,
        score: 88,
        matches: [
          {
            personaId: h.fieldCto,
            campaignId: h.campaignA,
            score: 90,
            reason: "Original judgment.",
          },
        ],
      },
    ]);
    await h.addSource();
    await h.run();
    const target = (await h.items()).find((item) => item.score === 88)!;
    const before = await h.db
      .select()
      .from(discoveredItemMatches)
      .where(eq(discoveredItemMatches.itemId, target.id as string));

    const bumped = await h.app.inject({
      method: "PUT",
      url: `/workspaces/${h.workspaceId}/personas/${h.fieldCto}`,
      payload: {
        name: "Field CTO",
        topics: ["post-training", "evals"],
      },
    });
    expect(bumped.statusCode).toBe(200);
    await h.db.execute(sql.raw(`
      CREATE FUNCTION reject_fault_scoring_match() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fault_after_first_match'; END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_fault_scoring_match
      BEFORE INSERT ON discovered_item_matches
      FOR EACH ROW
      WHEN (NEW.reason = 'fault_after_first_match')
      EXECUTE FUNCTION reject_fault_scoring_match();
    `));
    h.setResponder((prompt) => {
      const targetIndex = prompt
        .split("ITEM ")
        .slice(1)
        .findIndex((block) => block.includes(target.title as string));
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      return [
        {
          index: targetIndex,
          score: 42,
          matches: [
            {
              personaId: h.fieldCto,
              campaignId: h.campaignA,
              score: 90,
              reason: "Replacement judgment.",
            },
            {
              personaId: null,
              campaignId: h.campaignB,
              score: 80,
              reason: "fault_after_first_match",
            },
          ],
        },
      ];
    });

    await h.run();

    expect(
      await h.db
        .select()
        .from(discoveredItemMatches)
        .where(eq(discoveredItemMatches.itemId, target.id as string)),
    ).toEqual(before);
    expect((await h.items()).find((item) => item.id === target.id)).toMatchObject({
      score: 88,
      scoreReason: "Original judgment.",
    });
  });

  it("keeps only the top-scoring five when the model over-suggests", async () => {
    h.setResponder(() => [
      {
        index: 0,
        score: 70,
        matches: Array.from({ length: 7 }, (_, i) => ({
          personaId: null,
          campaignId: i % 2 === 0 ? h.campaignA : h.campaignB,
          score: 20 + i * 10,
          reason: `candidate ${i}`,
        })),
      },
    ]);
    await h.addSource();
    await h.run();
    const top = (await h.items()).find((i) => i.score === 70)!;
    expect(top.matches).toHaveLength(DISCOVERY_MAX_MATCHES_PER_ITEM);
    expect(top.matches.map((m: { score: number }) => m.score)).toEqual([80, 70, 60, 50, 40]);
  });

  it("drops a persona the campaign doesn't allow but keeps the campaign match", async () => {
    // communityLead is not in campaignA's personaIds
    h.setResponder(() => [
      {
        index: 0,
        score: 65,
        matches: [{ personaId: h.communityLead, campaignId: h.campaignA, score: 75, reason: "Wrong speaker." }],
      },
    ]);
    await h.addSource();
    await h.run();
    const top = (await h.items()).find((i) => i.score === 65)!;
    expect(top.matches).toHaveLength(1);
    expect(top.matches[0]).toMatchObject({
      personaId: null,
      personaName: null,
      campaignId: h.campaignA,
      campaignName: "Product Launch",
      score: 75,
    });
    expect(top.suggestedPersonaId).toBeNull();
    expect(top.suggestedCampaignId).toBe(h.campaignA);
  });

  // Sprint 58: the pre-58 legacy top-level shape (no `matches` key) is no
  // longer parsed — schema validation fails, the repair retry gets the same
  // garbage, and the item lands in a *typed* retryable state instead of being
  // silently scored without candidates.
  it("marks items retryable when the response fails schema validation after repair", async () => {
    h.setResponder(() => [
      { index: 0, score: 77, personaId: h.fieldCto, campaignId: h.campaignA, reason: "Legacy shape." },
    ]);
    await h.addSource();
    await h.run();
    const rows = await h.db.select().from(discoveredItems);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.matchingState).toBe("retryable_error");
      expect(row.matchingError).toBe("matching_malformed_response");
      expect(row.score).toBeNull();
    }
  });

  it("accept copies every candidate onto the new signal", async () => {
    h.setResponder(() => [
      {
        index: 0,
        score: 88,
        matches: [
          { personaId: h.fieldCto, campaignId: h.campaignA, score: 90, reason: "Fits the launch." },
          { personaId: h.communityLead, campaignId: h.campaignB, score: 60, reason: "Community angle." },
        ],
      },
      { index: 1, score: 40, matches: [] },
    ]);
    await h.addSource();
    await h.run();
    const top = (await h.items()).find((i) => i.score === 88)!;

    const res = await h.app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/discovery/items/${top.id}/accept`,
    });
    expect(res.statusCode).toBe(200);
    const { signal } = res.json();
    expect(signalSchema.safeParse(signal).success).toBe(true);
    expect(signal.matches).toHaveLength(2);
    expect(signal.matches[0]).toMatchObject({ personaId: h.fieldCto, campaignId: h.campaignA, score: 90 });
    const rows = await h.db
      .select()
      .from(signalMatches)
      .where(eq(signalMatches.signalId, signal.id));
    expect(rows).toHaveLength(2);

    // the signal inbox serializes them too
    const signals = (
      await h.app.inject({ method: "GET", url: `/workspaces/${h.workspaceId}/signals` })
    ).json();
    const listed = signals.find((s: { id: string }) => s.id === signal.id);
    expect(listed.matches).toHaveLength(2);
  });
});

describe("targeted re-score on config change (Sprint 49)", () => {
  let h: MatchingHarness;

  beforeEach(async () => {
    h = await buildMatchingHarness();
    // Default responder: score by position, one candidate for every item.
    h.setResponder((prompt) => {
      const count = (prompt.match(/ITEM \d+:/g) ?? []).length;
      return Array.from({ length: count }, (_, i) => ({
        index: i,
        score: 90 - i * 10,
        matches: [{ personaId: h.fieldCto, campaignId: h.campaignA, score: 85, reason: "v1" }],
      }));
    });
  });

  afterEach(async () => {
    await h.app.close();
  });

  async function bumpPersona() {
    const res = await h.app.inject({
      method: "PUT",
      url: `/workspaces/${h.workspaceId}/personas/${h.fieldCto}`,
      payload: { name: "Field CTO", topics: ["post-training", "evals"] },
    });
    expect(res.statusCode).toBe(200);
  }

  it("re-scores a still-new item after a persona edit", async () => {
    await h.addSource();
    await h.run();
    expect(h.scoringPrompts).toHaveLength(1);

    await bumpPersona();
    h.setResponder((prompt) => {
      const count = (prompt.match(/ITEM \d+:/g) ?? []).length;
      return Array.from({ length: count }, (_, i) => ({ index: i, score: 42, matches: [] }));
    });
    await h.run();
    expect(h.scoringPrompts).toHaveLength(2);
    // both original items were re-judged (plus the fresh v2 item)
    expect(h.scoringPrompts[1]).toContain("Buyers hate generic AI output");
    expect(h.scoringPrompts[1]).toContain("GTM teams forget what worked");
    const list = await h.items("new");
    for (const item of list) {
      expect(item.score).toBe(42);
      expect(item.matches).toEqual([]); // stale candidates were replaced, not accumulated
      expect(item.suggestedPersonaId).toBeNull();
    }
  });

  it("does not re-score an already-accepted item", async () => {
    await h.addSource();
    await h.run();
    const top = (await h.items("new")).find((i) => i.score === 90)!;
    await h.app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/discovery/items/${top.id}/accept`,
    });

    await bumpPersona();
    h.setResponder((prompt) => {
      const count = (prompt.match(/ITEM \d+:/g) ?? []).length;
      return Array.from({ length: count }, (_, i) => ({ index: i, score: 42, matches: [] }));
    });
    await h.run();
    expect(h.scoringPrompts).toHaveLength(2);
    // the accepted item (title of the top-scored index-0 item) stayed frozen
    expect(h.scoringPrompts[1]).not.toContain(top.title);
    const accepted = (await h.items()).find((i) => i.id === top.id)!;
    expect(accepted.score).toBe(90);
    expect(accepted.matches).toHaveLength(1);
  });

  it("skips already-scored items when nothing changed", async () => {
    await h.addSource();
    await h.run();
    expect(h.scoringPrompts).toHaveLength(1);

    // Second run: the feed's v2 brings one genuinely new item; the two
    // already-scored items must not be sent back to the gateway.
    await h.run();
    expect(h.scoringPrompts).toHaveLength(2);
    expect(h.scoringPrompts[1]).toContain("Fresh third item");
    expect(h.scoringPrompts[1]).not.toContain("Buyers hate generic AI output");
    expect((h.scoringPrompts[1]!.match(/ITEM \d+:/g) ?? []).length).toBe(1);

    // Third run: nothing new, no config change — the gateway is not invoked.
    await h.run();
    expect(h.scoringPrompts).toHaveLength(2);
  });
});

describe("cross-source dedup (Sprint 45)", () => {
  it("links the same URL seen via two sources instead of duplicating triage", async () => {
    const h = await buildMatchingHarness(
      fixtureFetcher({
        "https://feeds.example.com/one.xml": RSS_FIXTURE,
        "https://feeds.example.com/two.xml": RSS_FIXTURE,
      }),
    );
    const one = await h.addSource("https://feeds.example.com/one.xml");
    const two = await h.addSource("https://feeds.example.com/two.xml");
    await h.run();

    const fresh = await h.items("new");
    expect(fresh).toHaveLength(2); // the triage queue is not doubled
    for (const item of fresh) {
      expect(item.duplicateOfId).toBeNull();
      expect(item.duplicateCount).toBe(1); // "seen via 2 sources"
    }
    const dups = await h.items("duplicate");
    expect(dups).toHaveLength(2);
    const canonicalIds = new Set(fresh.map((i) => i.id));
    for (const dup of dups) {
      expect(discoveredItemSchema.safeParse(dup).success).toBe(true);
      expect(canonicalIds.has(dup.duplicateOfId)).toBe(true);
      expect(dup.duplicateCount).toBe(0);
    }

    // duplicates are never scored: one scoring call covering the 2 canonicals
    expect(h.scoringPrompts).toHaveLength(1);
    expect((h.scoringPrompts[0]!.match(/ITEM \d+:/g) ?? []).length).toBe(2);

    // the expandable "seen via" list names the corroborating source
    const canonical = fresh[0]!;
    const res = await h.app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/discovery/items/${canonical.id}/duplicates`,
    });
    expect(res.statusCode).toBe(200);
    const linked = res.json();
    expect(linked).toHaveLength(1);
    expect(linked[0].sourceName).toMatch(/^RSS: https:\/\/feeds\.example\.com\/(one|two)\.xml$/);
    expect([one.id, two.id]).toContain(linked[0].sourceId);
    expect(linked[0].sourceId).not.toBe(canonical.sourceId);
    expect(typeof linked[0].createdAt).toBe("number");

    await h.app.close();
  });

  it("links tracking-param/protocol/www variants of the same URL", async () => {
    const feedA = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>A</title>
<item><title>Benchmark drops</title><link>https://example.com/bench</link><guid>a-1</guid><description>Original writeup.</description></item>
</channel></rss>`;
    const feedB = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>B</title>
<item><title>Benchmark drops (syndicated)</title><link>http://www.example.com/bench/?utm_source=rss&amp;fbclid=abc&amp;gclid=1</link><guid>b-1</guid><description>Different summary text entirely.</description></item>
</channel></rss>`;
    const h = await buildMatchingHarness(
      fixtureFetcher({
        "https://feeds.example.com/a.xml": feedA,
        "https://feeds.example.com/b.xml": feedB,
      }),
    );
    await h.addSource("https://feeds.example.com/a.xml");
    await h.addSource("https://feeds.example.com/b.xml");
    await h.run();

    expect(await h.items("new")).toHaveLength(1);
    const dups = await h.items("duplicate");
    expect(dups).toHaveLength(1);
    expect(dups[0]!.duplicateOfId).toBe((await h.items("new"))[0]!.id);
    await h.app.close();
  });

  it("links different URLs whose normalized content matches", async () => {
    const feedA = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>A</title>
<item><title>Big Agentic Benchmark Drops</title><link>https://example.com/bench</link><guid>a-1</guid><description>A new benchmark for agentic coding dropped today.</description></item>
</channel></rss>`;
    const feedB = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>B</title>
<item><title>  BIG agentic   benchmark DROPS </title><link>https://mirror.example.net/bench-copy</link><guid>b-1</guid><description>a NEW benchmark   FOR agentic coding dropped today.</description></item>
</channel></rss>`;
    const h = await buildMatchingHarness(
      fixtureFetcher({
        "https://feeds.example.com/a.xml": feedA,
        "https://feeds.example.com/b.xml": feedB,
      }),
    );
    await h.addSource("https://feeds.example.com/a.xml");
    await h.addSource("https://feeds.example.com/b.xml");
    await h.run();

    const fresh = await h.items("new");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.duplicateCount).toBe(1);
    const dups = await h.items("duplicate");
    expect(dups).toHaveLength(1);
    expect(dups[0]!.duplicateOfId).toBe(fresh[0]!.id);
    await h.app.close();
  });
});
