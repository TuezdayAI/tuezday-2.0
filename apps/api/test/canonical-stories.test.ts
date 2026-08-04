import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  canonicalStorySchema,
  listStoriesResponseSchema,
  storyBackfillResultSchema,
  storyDetailSchema,
} from "@tuezday/contracts";
import type { TuezdayApp } from "../src/app";
import type { Db } from "../src/db";
import {
  canonicalExternalStories,
  canonicalStoryKeys,
  discoveredItems,
  discoverySourceOccurrences,
  discoverySources,
  storyEnrichments,
  storyOccurrences,
  workspaces,
} from "../src/db/schema";
import type { LlmGateway } from "../src/llm/gateway";
import type { SafeFetchService } from "../src/safe-fetch";
import {
  backfillCanonicalStories,
  recordOccurrenceAndResolve,
} from "../src/services/canonical-stories";
import { asUser, buildAuthedApp, createTestDb, registerUser } from "./helpers";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";

// Two items with distinct guid/url/content — the base feed.
const FEED_A = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed A</title>
<item><title>Buyers hate generic AI output</title><link>https://example.com/a</link><guid>story-a</guid><description>Thread about generic output.</description></item>
<item><title>GTM teams forget what worked</title><link>https://example.com/b</link><guid>story-b</guid><description>Memory problem discussion.</description></item>
</channel></rss>`;

// Same guid + url as FEED_A's first item, seen from a different source.
const FEED_SAME_GUID = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed B</title>
<item><title>Buyers hate generic AI output (syndicated)</title><link>https://example.com/a</link><guid>story-a</guid><description>Syndicated copy.</description></item>
</channel></rss>`;

// Different guid, same URL (with tracking params) as FEED_A's first item.
const FEED_SAME_URL = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed C</title>
<item><title>Buyers hate generic AI output — mirror</title><link>https://example.com/a?utm_source=mirror</link><guid>mirror-1</guid><description>Mirror copy.</description></item>
</channel></rss>`;

// Different guid and URL, identical title + description (content fingerprint).
const FEED_SAME_CONTENT = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed D</title>
<item><title>Buyers hate generic AI output</title><link>https://elsewhere.example.net/repost</link><guid>repost-9</guid><description>Thread about generic output.</description></item>
</channel></rss>`;

/** Serves a fixed body per feed URL — refetches always see the same page. */
function mapFetcher(bodies: Record<string, string>): SafeFetchService {
  return fixtureSafeFetch((request) => {
    const body = bodies[request.url];
    if (!body) return { contentType: "application/xml", body: "<rss/>" };
    return { body, contentType: "application/xml" };
  });
}

const stubLlm: LlmGateway = {
  async generate() {
    return { text: "[]", model: "fake", provider: "fake", durationMs: 1 };
  },
};

describe("canonical stories (Sprint 60)", () => {
  let app: TuezdayApp;
  let db: Db;
  let workspaceId: string;
  const feeds: Record<string, string> = {};

  beforeEach(async () => {
    for (const key of Object.keys(feeds)) delete feeds[key];
    feeds["https://feeds.example.com/a.xml"] = FEED_A;
    db = createTestDb();
    app = await buildAuthedApp({ db, llm: stubLlm, safeFetch: mapFetcher(feeds) });
    workspaceId = (
      await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Stories" } })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  async function addRssSource(feedUrl: string) {
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/discovery/sources`,
      payload: { type: "rss", config: { feedUrl } },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /**
   * One /discovery/run pass is deadline-bounded and can leave sources
   * unprocessed under full-suite load, so run until every source in the
   * workspace has been fetched at least once.
   */
  async function run() {
    let summary: unknown;
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/discovery/run`,
      });
      expect(res.statusCode).toBe(200);
      summary = res.json();
      const unfetched = db
        .select()
        .from(discoverySources)
        .where(eq(discoverySources.workspaceId, workspaceId))
        .all()
        .filter((source) => source.lastFetchedAt === null);
      if (unfetched.length === 0) return summary;
    }
    throw new Error("discovery scheduler did not drain in 10 passes");
  }

  async function listStoriesHttp(qs = "") {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/stories${qs}`,
    });
    expect(res.statusCode).toBe(200);
    return listStoriesResponseSchema.parse(res.json());
  }

  async function storyDetailHttp(storyId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/stories/${storyId}`,
    });
    expect(res.statusCode).toBe(200);
    return storyDetailSchema.parse(res.json());
  }

  it("records one immutable occurrence per fetched item inside the ingest transaction", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();

    const occurrences = db.select().from(discoverySourceOccurrences).all();
    expect(occurrences).toHaveLength(2);
    for (const occurrence of occurrences) {
      expect(occurrence.workspaceId).toBe(workspaceId);
      expect(occurrence.sourceType).toBe("rss");
      expect(occurrence.sourceName).toBeTruthy();
      expect(occurrence.fetchRunId).not.toBeNull();
      expect(occurrence.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }

    const { stories, total } = await listStoriesHttp();
    expect(total).toBe(2);
    for (const story of stories) {
      canonicalStorySchema.parse(story);
      expect(story.occurrenceCount).toBe(1);
      expect(story.corroborationCount).toBe(1);
      expect(story.status).toBe("active");
    }

    const memberships = db.select().from(storyOccurrences).all();
    expect(memberships).toHaveLength(2);
    for (const membership of memberships) {
      expect(membership.relationshipKind).toBe("exact");
      expect(membership.confidence).toBe(100);
      expect(membership.detachedAt).toBeNull();
      expect(membership.attachedByUserId).toBeNull();
    }
  });

  it("re-running the same fetch creates no new occurrences, stories, or enrichments", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const before = {
      occurrences: db.select().from(discoverySourceOccurrences).all().length,
      stories: db.select().from(canonicalExternalStories).all().length,
      memberships: db.select().from(storyOccurrences).all().length,
      enrichments: db.select().from(storyEnrichments).all().length,
    };
    await run();
    expect(db.select().from(discoverySourceOccurrences).all()).toHaveLength(before.occurrences);
    expect(db.select().from(canonicalExternalStories).all()).toHaveLength(before.stories);
    expect(db.select().from(storyOccurrences).all()).toHaveLength(before.memberships);
    expect(db.select().from(storyEnrichments).all()).toHaveLength(before.enrichments);
  });

  it("converges cross-source copies into one story with provenance-typed memberships", async () => {
    // The original is fetched first; the three copies arrive later. (If a
    // partial copy were seen first, keys could land on different stories —
    // which stay separate by design: exact identity never auto-merges
    // ambiguous clusters. This test pins the common, deterministic order.)
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    feeds["https://feeds.example.com/same-guid.xml"] = FEED_SAME_GUID;
    feeds["https://feeds.example.com/same-url.xml"] = FEED_SAME_URL;
    feeds["https://feeds.example.com/same-content.xml"] = FEED_SAME_CONTENT;
    await addRssSource("https://feeds.example.com/same-guid.xml");
    await addRssSource("https://feeds.example.com/same-url.xml");
    await addRssSource("https://feeds.example.com/same-content.xml");
    await run();

    // 5 occurrences total; the four copies of story A converge, story B stands
    // alone — exact identity, zero false merges.
    expect(db.select().from(discoverySourceOccurrences).all()).toHaveLength(5);
    const { stories, total } = await listStoriesHttp();
    expect(total).toBe(2);
    const storyA = stories.find((s) => s.occurrenceCount === 4)!;
    expect(storyA).toBeDefined();
    expect(storyA.corroborationCount).toBe(4);

    const detail = await storyDetailHttp(storyA.id);
    const kinds = detail.occurrences.map((o) => o.relationship.kind).sort();
    // founding exact + guid-matched provider + url-matched exact + content-matched similarity
    expect(kinds).toEqual(["exact", "exact", "provider", "similarity"]);
    const similarity = detail.occurrences.find((o) => o.relationship.kind === "similarity")!;
    expect(similarity.relationship.confidence).toBe(90);
    expect(detail.enrichment).not.toBeNull();
    expect(detail.enrichment!.corroborationCount).toBe(4);
    expect(detail.enrichment!.payload.occurrenceCount).toBe(4);
  });

  it("keeps occurrences, stories, and source snapshots when the source is deleted", async () => {
    feeds["https://feeds.example.com/same-guid.xml"] = FEED_SAME_GUID;
    await addRssSource("https://feeds.example.com/a.xml");
    const second = await addRssSource("https://feeds.example.com/same-guid.xml");
    await run();

    const deleted = await app.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/discovery/sources/${second.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    // The discovered_items of the deleted source cascade away (legacy P1.9
    // behavior) — the shadow layer must not.
    const occurrences = db
      .select()
      .from(discoverySourceOccurrences)
      .where(eq(discoverySourceOccurrences.sourceId, second.id))
      .all();
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.sourceName).toBeTruthy();
    expect(occurrences[0]!.sourceType).toBe("rss");

    const { total } = await listStoriesHttp();
    expect(total).toBe(2);
  });

  it("merges manually with attribution and splits back — nothing deleted either way", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const { stories } = await listStoriesHttp();
    const [first, second] = stories as [
      (typeof stories)[number],
      (typeof stories)[number],
    ];

    const merged = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/${first.id}/merge`,
      payload: { intoStoryId: second.id, reason: "Same launch covered twice" },
    });
    expect(merged.statusCode).toBe(200);
    const mergedDetail = storyDetailSchema.parse(merged.json());
    expect(mergedDetail.story.id).toBe(second.id);
    expect(mergedDetail.story.occurrenceCount).toBe(2);
    const manual = mergedDetail.occurrences.find((o) => o.relationship.kind === "manual")!;
    expect(manual.relationship.attachedByUserId).not.toBeNull();
    expect(manual.relationship.attachReason).toBe("Same launch covered twice");

    const fromRow = db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, first.id))
      .get()!;
    expect(fromRow.status).toBe("archived");
    expect(fromRow.mergedIntoStoryId).toBe(second.id);

    // The closed membership survives as history.
    const closed = db.select().from(storyOccurrences).all().filter((m) => m.detachedAt !== null);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.detachReason).toBe("Same launch covered twice");

    // Split the moved occurrence back out into a fresh story.
    const split = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/occurrences/${manual.id}/split`,
      payload: { reason: "Actually distinct" },
    });
    expect(split.statusCode).toBe(200);
    const splitDetail = storyDetailSchema.parse(split.json());
    expect(splitDetail.story.id).not.toBe(second.id);
    expect(splitDetail.story.occurrenceCount).toBe(1);
    expect(splitDetail.occurrences[0]!.relationship.kind).toBe("manual");

    // Membership rows only ever accumulate: 2 founding + 1 merge + 1 split.
    expect(db.select().from(storyOccurrences).all()).toHaveLength(4);
    // Occurrences were never touched.
    expect(db.select().from(discoverySourceOccurrences).all()).toHaveLength(2);
  });

  it("appends immutable enrichment rows as membership changes", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const { stories } = await listStoriesHttp();
    const [first, second] = stories as [
      (typeof stories)[number],
      (typeof stories)[number],
    ];
    const enrichedBefore = db
      .select()
      .from(storyEnrichments)
      .where(eq(storyEnrichments.storyId, second.id))
      .all();
    expect(enrichedBefore).toHaveLength(1);

    await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/${first.id}/merge`,
      payload: { intoStoryId: second.id, reason: "combine" },
    });

    const enrichedAfter = db
      .select()
      .from(storyEnrichments)
      .where(eq(storyEnrichments.storyId, second.id))
      .all();
    // Old row retained, new fingerprint appended.
    expect(enrichedAfter).toHaveLength(2);
    expect(new Set(enrichedAfter.map((e) => e.storyFingerprint)).size).toBe(2);
    const storyRow = db
      .select()
      .from(canonicalExternalStories)
      .where(eq(canonicalExternalStories.id, second.id))
      .get()!;
    expect(storyRow.currentEnrichmentVersion).toBe(1);
  });

  it("archives and unarchives a story", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const { stories } = await listStoriesHttp();
    const target = stories[0]!;

    const archived = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/stories/${target.id}`,
      payload: { status: "archived" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");
    expect((await listStoriesHttp("?status=active")).total).toBe(1);

    const restored = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/stories/${target.id}`,
      payload: { status: "active" },
    });
    expect(restored.statusCode).toBe(200);
    expect((await listStoriesHttp("?status=active")).total).toBe(2);
  });

  it.each(["limit=not-a-number", "offset=1.5"])(
    "rejects an invalid story-list pagination query: %s",
    async (query) => {
      const response = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/stories?${query}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_input" });
    },
  );

  it("rejects self-merge and merge into an archived story", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const { stories } = await listStoriesHttp();
    const [first, second] = stories as [
      (typeof stories)[number],
      (typeof stories)[number],
    ];

    const self = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/${first.id}/merge`,
      payload: { intoStoryId: first.id, reason: "oops" },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ error: "merge_self" });

    await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/stories/${second.id}`,
      payload: { status: "archived" },
    });
    const intoArchived = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/${first.id}/merge`,
      payload: { intoStoryId: second.id, reason: "nope" },
    });
    expect(intoArchived.statusCode).toBe(409);
    expect(intoArchived.json()).toMatchObject({ error: "story_archived" });
  });

  it("backfills existing discovered items idempotently through the route", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    // Simulate pre-Sprint-60 history: wipe the shadow layer, keep the items.
    db.delete(storyEnrichments).run();
    db.delete(storyOccurrences).run();
    db.delete(canonicalStoryKeys).run();
    db.delete(canonicalExternalStories).run();
    db.delete(discoverySourceOccurrences).run();

    const first = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/stories/backfill`,
    });
    expect(first.statusCode).toBe(200);
    const result = storyBackfillResultSchema.parse(first.json());
    expect(result).toMatchObject({
      scanned: 2,
      occurrencesCreated: 2,
      storiesCreated: 2,
      membershipsCreated: 2,
    });
    // Backfilled occurrences carry the item's original observation time.
    const item = db.select().from(discoveredItems).all()[0]!;
    const occurrence = db
      .select()
      .from(discoverySourceOccurrences)
      .where(eq(discoverySourceOccurrences.providerExternalId, item.externalId))
      .get()!;
    expect(occurrence.observedAt).toBe(item.createdAt);
    expect(occurrence.fetchRunId).toBeNull();

    const again = storyBackfillResultSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/stories/backfill`,
        })
      ).json(),
    );
    expect(again).toMatchObject({
      scanned: 2,
      occurrencesCreated: 0,
      storiesCreated: 0,
      membershipsCreated: 0,
    });
  });

  it("denies story routes to non-members", async () => {
    await addRssSource("https://feeds.example.com/a.xml");
    await run();
    const outsider = await registerUser(app, "outsider@test.dev", "Outsider");
    const stranger = asUser(app, outsider.token);
    const res = await stranger.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/stories`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("canonical stories service (pure db)", () => {
  function seedWorkspace(db: Db, id: string) {
    db.insert(workspaces)
      .values({ id, name: id, createdAt: 1, updatedAt: 1 })
      .run();
    db.insert(discoverySources)
      .values({
        id: `${id}-source`,
        workspaceId: id,
        type: "rss",
        name: "Seed feed",
        configJson: JSON.stringify({ feedUrl: "https://feeds.example.com/a.xml" }),
        enabled: true,
        status: "active",
        lastError: null,
        lastFetchedAt: null,
        connectionId: null,
        cursorJson: "{}",
        backoffUntil: null,
        lastAttemptedAt: null,
        executionVersion: 1,
        createdAt: 1,
      })
      .run();
  }

  function seedItem(
    db: Db,
    workspaceId: string,
    input: {
      id: string;
      externalId: string;
      title: string;
      url: string;
      summary?: string;
      status?: string;
      duplicateOfId?: string | null;
      createdAt?: number;
    },
  ) {
    db.insert(discoveredItems)
      .values({
        id: input.id,
        workspaceId,
        sourceId: `${workspaceId}-source`,
        externalId: input.externalId,
        title: input.title,
        url: input.url,
        summary: input.summary ?? "",
        publishedAt: null,
        score: null,
        suggestedPersonaId: null,
        suggestedCampaignId: null,
        scoreReason: null,
        status: input.status ?? "new",
        signalId: null,
        scoredAt: null,
        urlHash: null,
        contentHash: "",
        duplicateOfId: input.duplicateOfId ?? null,
        createdAt: input.createdAt ?? 1_000,
      })
      .run();
  }

  it("converges legacy duplicate groups — including dangling ones — via identity keys", () => {
    const db = createTestDb();
    seedWorkspace(db, "ws-backfill");
    seedItem(db, "ws-backfill", {
      id: "item-canonical",
      externalId: "guid-1",
      title: "Original coverage",
      url: "https://example.com/story",
      createdAt: 1_000,
    });
    // A legacy duplicate pointing at the canonical row...
    seedItem(db, "ws-backfill", {
      id: "item-dupe",
      externalId: "guid-2",
      title: "Original coverage",
      url: "https://example.com/story?utm_source=x",
      status: "duplicate",
      duplicateOfId: "item-canonical",
      createdAt: 2_000,
    });
    // ...and a dangling duplicate whose canonical was deleted (P1.9).
    seedItem(db, "ws-backfill", {
      id: "item-dangling",
      externalId: "guid-3",
      title: "Original coverage",
      url: "https://example.com/story",
      status: "duplicate",
      duplicateOfId: "item-deleted-long-ago",
      createdAt: 3_000,
    });

    const result = backfillCanonicalStories(db, "ws-backfill");
    expect(result).toMatchObject({
      scanned: 3,
      occurrencesCreated: 3,
      storiesCreated: 1,
      membershipsCreated: 3,
    });
    const story = db.select().from(canonicalExternalStories).all();
    expect(story).toHaveLength(1);
    expect(story[0]!.firstObservedAt).toBe(1_000);
    expect(story[0]!.lastObservedAt).toBe(3_000);
  });

  it("scopes identity keys per workspace — the same URL makes two stories", () => {
    const db = createTestDb();
    seedWorkspace(db, "ws-one");
    seedWorkspace(db, "ws-two");
    for (const workspaceId of ["ws-one", "ws-two"]) {
      recordOccurrenceAndResolve(db, {
        workspaceId,
        source: { id: `${workspaceId}-source`, type: "rss", name: "Seed feed" },
        fetchRunId: null,
        item: {
          externalId: "guid-1",
          title: "Shared headline",
          url: "https://example.com/shared",
          summary: "Same story either way.",
          publishedAt: null,
        },
        observedAt: 5_000,
      });
    }
    const stories = db.select().from(canonicalExternalStories).all();
    expect(stories).toHaveLength(2);
    expect(new Set(stories.map((s) => s.workspaceId)).size).toBe(2);
  });
});
