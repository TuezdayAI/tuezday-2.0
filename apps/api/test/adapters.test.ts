import { describe, expect, it } from "vitest";
import { NeedsApiKeyError, fetchSourceItems, type Fetcher } from "../src/discovery/adapters";

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

function fixtureFetcher(body: string, contentType = "application/xml"): Fetcher {
  return (async (url: Parameters<typeof fetch>[0]) =>
    new Response(body, { status: 200, headers: { "content-type": contentType } })) as Fetcher;
}

function capturingFetcher(body: string): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
    urls.push(String(url));
    return new Response(body, { status: 200 });
  }) as Fetcher;
  return { fetcher, urls };
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
    const fetcher = (async () => new Response("nope", { status: 404 })) as Fetcher;
    await expect(
      fetchSourceItems("rss", { feedUrl: "https://example.com/feed.xml" }, fetcher),
    ).rejects.toThrow(/404/);
  });
});

describe("google_news adapter", () => {
  it("builds a Google News RSS search url from the query and parses the feed", async () => {
    const { fetcher, urls } = capturingFetcher(RSS_FIXTURE);
    const items = await fetchSourceItems("google_news", { query: "GTM orchestration" }, fetcher);
    expect(urls[0]).toContain("news.google.com/rss/search");
    expect(urls[0]).toContain(encodeURIComponent("GTM orchestration"));
    expect(items).toHaveLength(2);
  });
});

describe("reddit adapter", () => {
  it("searches within a subreddit via the .rss endpoint", async () => {
    const { fetcher, urls } = capturingFetcher(REDDIT_FIXTURE);
    const items = await fetchSourceItems(
      "reddit",
      { subreddit: "SaaS", query: "AI marketing" },
      fetcher,
    );
    expect(urls[0]).toContain("/r/SaaS/search.rss");
    expect(urls[0]).toContain("restrict_sr=1");
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
    const { fetcher, urls } = capturingFetcher(REDDIT_FIXTURE);
    await fetchSourceItems("reddit", { subreddit: "SaaS" }, fetcher);
    expect(urls[0]).toContain("/r/SaaS/new.rss");
  });

  it("searches site-wide when only a query is given", async () => {
    const { fetcher, urls } = capturingFetcher(REDDIT_FIXTURE);
    await fetchSourceItems("reddit", { query: "GTM brain" }, fetcher);
    expect(urls[0]).toContain("reddit.com/search.rss");
  });
});

describe("credential-gated adapters", () => {
  it("refuses x and linkedin until API keys exist", async () => {
    for (const type of ["x", "linkedin"] as const) {
      await expect(
        fetchSourceItems(type, { query: "anything" }, fixtureFetcher("{}")),
      ).rejects.toThrow(NeedsApiKeyError);
    }
  });
});
