import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SOURCE_STATUSES,
  isReservedDiscoverySourceType,
} from "@tuezday/contracts";
import { NeedsApiKeyError, fetchSourceItems } from "../src/discovery/adapters";
import {
  safeFetchError,
  type SafeFetchRequest,
  type SafeFetchService,
} from "../src/safe-fetch";
import { fixtureSafeFetch } from "./safe-fetch-fixtures";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <item>
      <title>AI content all sounds the same</title>
      <link>https://example.com/posts/ai-content</link>
      <guid>https://example.com/posts/ai-content</guid>
      <description><![CDATA[<p>Why most AI marketing output is <b>generic</b> slop.</p>]]></description>
      <pubDate>Tue, 09 Jun 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/second</link>
      <description>Short summary here.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom entry title</title>
    <link href="https://example.com/atom/1"/>
    <id>tag:example.com,2026:1</id>
    <summary>Atom summary text.</summary>
    <updated>2026-06-09T10:00:00Z</updated>
  </entry>
</feed>`;

// Reddit serves listings as Atom feeds at .rss (the JSON endpoints 403 for
// unauthenticated server traffic).
const REDDIT_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>newest submissions : SaaS</title>
  <entry>
    <title>Every AI marketing tool produces the same slop</title>
    <link href="https://www.reddit.com/r/SaaS/comments/abc123/every_ai_tool/"/>
    <id>t3_abc123</id>
    <content type="html">&lt;p&gt;None of them know anything about my company.&lt;/p&gt;</content>
    <updated>2026-06-09T12:00:00+00:00</updated>
  </entry>
  <entry>
    <title>Link-only post</title>
    <link href="https://www.reddit.com/r/SaaS/comments/def456/link_only/"/>
    <id>t3_def456</id>
    <updated>2026-06-09T13:00:00+00:00</updated>
  </entry>
</feed>`;

function fixtureFetcher(
  body: string,
  contentType = "application/xml",
): SafeFetchService {
  return fixtureSafeFetch(() => ({ body, contentType }));
}

function capturingFetcher(
  body: string,
  contentType = "application/xml",
): { fetcher: SafeFetchService; requests: SafeFetchRequest[] } {
  const requests: SafeFetchRequest[] = [];
  const fetcher = fixtureSafeFetch((request) => {
    requests.push(request);
    return { body, contentType };
  });
  return { fetcher, requests };
}

describe("rss adapter", () => {
  it("parses RSS 2.0 items with guid, html-stripped summary, and pubDate", async () => {
    const items = await fetchSourceItems(
      "rss",
      { feedUrl: "https://example.com/feed.xml" },
      fixtureFetcher(RSS_FIXTURE),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "https://example.com/posts/ai-content",
      title: "AI content all sounds the same",
      url: "https://example.com/posts/ai-content",
    });
    expect(items[0]!.summary).toBe("Why most AI marketing output is generic slop.");
    expect(items[0]!.publishedAt).toBe(Date.parse("Tue, 09 Jun 2026 08:00:00 GMT"));
    // falls back to link when guid missing, null date when missing
    expect(items[1]!.externalId).toBe("https://example.com/posts/second");
    expect(items[1]!.publishedAt).toBeNull();
  });

  it("parses Atom feeds", async () => {
    const items = await fetchSourceItems(
      "rss",
      { feedUrl: "https://example.com/atom.xml" },
      fixtureFetcher(ATOM_FIXTURE),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: "tag:example.com,2026:1",
      title: "Atom entry title",
      url: "https://example.com/atom/1",
      summary: "Atom summary text.",
    });
  });

  it("throws a readable error on a non-200 response", async () => {
    const fetcher = fixtureSafeFetch(() => ({
      contentType: "application/xml",
      error: safeFetchError("upstream_status"),
    }));
    await expect(
      await fetchSourceItems("rss", { feedUrl: "https://example.com/feed.xml" }, fetcher),
    ).rejects.toMatchObject({ code: "upstream_status" });
  });
});

describe("google_news adapter", () => {
  it("builds a Google News RSS search url from the query and parses the feed", async () => {
    const { fetcher, requests } = capturingFetcher(RSS_FIXTURE);
    const items = await fetchSourceItems("google_news", { query: "GTM orchestration" }, fetcher);
    expect(requests[0]).toMatchObject({ profile: "feed" });
    expect(requests[0]?.url).toContain("news.google.com/rss/search");
    expect(requests[0]?.url).toContain(encodeURIComponent("GTM orchestration"));
    expect(items).toHaveLength(2);
  });
});

describe("reddit adapter", () => {
  it("searches within a subreddit via the .rss endpoint", async () => {
    const { fetcher, requests } = capturingFetcher(REDDIT_FIXTURE);
    const items = await fetchSourceItems(
      "reddit",
      { subreddit: "SaaS", query: "AI marketing" },
      fetcher,
    );
    expect(requests[0]).toMatchObject({ profile: "feed" });
    expect(requests[0]?.url).toContain("/r/SaaS/search.rss");
    expect(requests[0]?.url).toContain("restrict_sr=1");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "t3_abc123",
      title: "Every AI marketing tool produces the same slop",
      url: "https://www.reddit.com/r/SaaS/comments/abc123/every_ai_tool/",
    });
    expect(items[0]!.summary).toBe("None of them know anything about my company.");
    expect(items[0]!.publishedAt).toBe(Date.parse("2026-06-09T12:00:00+00:00"));
  });

  it("lists new posts when only a subreddit is given", async () => {
    const { fetcher, requests } = capturingFetcher(REDDIT_FIXTURE);
    await fetchSourceItems("reddit", { subreddit: "SaaS" }, fetcher);
    expect(requests[0]?.url).toContain("/r/SaaS/new.rss");
  });

  it("searches site-wide when only a query is given", async () => {
    const { fetcher, requests } = capturingFetcher(REDDIT_FIXTURE);
    await fetchSourceItems("reddit", { query: "GTM brain" }, fetcher);
    expect(requests[0]?.url).toContain("reddit.com/search.rss");
  });
});

describe("credential-gated adapters", () => {
  it("refuses x, linkedin, g2, capterra, intent until API keys exist", async () => {
    for (const type of ["x", "linkedin", "g2", "capterra", "intent"] as const) {
      await expect(
        await fetchSourceItems(type, { query: "anything" }, fixtureFetcher("{}")),
      ).rejects.toThrow(NeedsApiKeyError);
    }
  });
});

// --- Sprint 31: keyless source expansion ----------------------------------

const HN_FIXTURE = JSON.stringify({
  hits: [
    {
      objectID: "40000001",
      title: "Show HN: a GTM memory layer",
      url: "https://example.com/gtm-memory",
      story_text: "We built a brain for go-to-market.",
      points: 120,
      num_comments: 45,
      created_at_i: 1_749_465_600,
    },
    {
      objectID: "40000002",
      title: "Ask HN: how do you remember what worked?",
      url: null,
      points: 8,
      num_comments: 3,
      created_at_i: 1_749_469_200,
    },
  ],
});

const YOUTUBE_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Channel</title>
  <entry>
    <title>How GTM teams lose their memory</title>
    <link href="https://www.youtube.com/watch?v=abc123"/>
    <id>yt:video:abc123</id>
    <summary>Talk about GTM amnesia.</summary>
    <updated>2026-06-09T10:00:00Z</updated>
  </entry>
</feed>`;

describe("hacker_news adapter", () => {
  it("queries the Algolia API and maps hits (HN link + points-summary fallbacks)", async () => {
    const { fetcher, requests } = capturingFetcher(HN_FIXTURE, "application/json");
    const items = await fetchSourceItems("hacker_news", { query: "GTM memory" }, fetcher);
    expect(requests[0]).toMatchObject({ profile: "json" });
    expect(requests[0]?.url).toContain("hn.algolia.com/api/v1/search_by_date");
    expect(requests[0]?.url).toContain("tags=story");
    expect(requests[0]?.url).toContain(encodeURIComponent("GTM memory"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "hn-40000001",
      title: "Show HN: a GTM memory layer",
      url: "https://example.com/gtm-memory",
    });
    expect(items[0]!.publishedAt).toBe(1_749_465_600 * 1000);
    // no url -> HN item link; no story_text -> points/comments summary
    expect(items[1]!.url).toBe("https://news.ycombinator.com/item?id=40000002");
    expect(items[1]!.summary).toContain("8 points");
  });

  it("needs a query", async () => {
    await expect(await fetchSourceItems("hacker_news", {}, fixtureFetcher(HN_FIXTURE))).rejects.toThrow(
      /query/,
    );
  });
});

describe("youtube adapter", () => {
  it("builds the channel feed url and parses entries", async () => {
    const { fetcher, requests } = capturingFetcher(YOUTUBE_FIXTURE);
    const items = await fetchSourceItems("youtube", { channelId: "UC_test" }, fetcher);
    expect(requests[0]?.url).toContain("youtube.com/feeds/videos.xml?channel_id=UC_test");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "How GTM teams lose their memory" });
  });
});

describe("podcast adapter", () => {
  it("fetches the feed url and parses RSS items", async () => {
    const { fetcher, requests } = capturingFetcher(RSS_FIXTURE);
    const items = await fetchSourceItems(
      "podcast",
      { feedUrl: "https://feeds.example.com/show.xml" },
      fetcher,
    );
    expect(requests[0]).toMatchObject({
      url: "https://feeds.example.com/show.xml",
      profile: "feed",
    });
    expect(items).toHaveLength(2);
  });
});

describe("google_trends adapter", () => {
  it("is reserved and never calls the retired daily-trends RSS surface", async () => {
    const { fetcher, requests } = capturingFetcher(RSS_FIXTURE);
    expect(DISCOVERY_SOURCE_STATUSES).toContain("reserved");
    expect(isReservedDiscoverySourceType("google_trends")).toBe(true);
    await expect(
      await fetchSourceItems("google_trends", { geo: "us" }, fetcher),
    ).rejects.toBeInstanceOf(NeedsApiKeyError);
    expect(requests).toEqual([]);
  });
});

describe("funding_news adapter", () => {
  it("builds a funding-scoped Google News query", async () => {
    const { fetcher, requests } = capturingFetcher(RSS_FIXTURE);
    const items = await fetchSourceItems(
      "funding_news",
      { query: "fintech", sector: "payments" },
      fetcher,
    );
    expect(requests[0]?.url).toContain("news.google.com/rss/search");
    const decoded = decodeURIComponent(requests[0]!.url);
    expect(decoded).toContain("fintech payments");
    expect(decoded).toMatch(/funding|raises|Series/);
    expect(items).toHaveLength(2);
  });
});
