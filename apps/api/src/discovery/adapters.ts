import { XMLParser } from "fast-xml-parser";
import type {
  DiscoverySource,
  DiscoverySourceConfig,
  DiscoverySourceType,
} from "@tuezday/contracts";
import type { SafeFetchService } from "../safe-fetch";
import type {
  DiscoveryPage,
  DiscoveryTarget,
  DiscoveryTargetCheckpoint,
} from "./paging";

/**
 * Source adapters. Each turns a source config into a normalized item list.
 * Safe-fetch is injectable so tests run on fixtures, never the network.
 * Credential-gated types (x, linkedin) are registered here but refuse to
 * fetch until API keys exist — flipping them live only touches this file.
 */

export interface RawDiscoveredItem {
  externalId: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: number | null;
}

export class NeedsApiKeyError extends Error {
  constructor(type: string) {
    super(`The ${type} source needs API credentials before it can fetch.`);
    this.name = "NeedsApiKeyError";
  }
}

const USER_AGENT = "tuezday-discovery/0.1 (GTM signal tracking; contact: ops@tuezday.app)";
const MAX_SUMMARY_CHARS = 600;
const MAX_ITEMS = 25;

function cleanText(value: unknown): string {
  // fast-xml-parser yields { "#text": ..., "@_attr": ... } for nodes with
  // attributes (e.g. Atom <content type="html">).
  if (typeof value === "object" && value !== null && "#text" in value) {
    value = (value as Record<string, unknown>)["#text"];
  }
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function fetchFeedText(
  url: string,
  safeFetch: SafeFetchService,
): Promise<string> {
  const result = await safeFetch.fetch({
    url,
    profile: "feed",
    headers: { "user-agent": USER_AGENT },
  });
  return result.text();
}

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function parseFeed(xml: string): RawDiscoveredItem[] {
  const doc = xmlParser.parse(xml);

  // RSS 2.0
  const rssItems = asArray(doc?.rss?.channel?.item);
  if (rssItems.length > 0) {
    return rssItems.slice(0, MAX_ITEMS).map((item: Record<string, unknown>) => {
      const link = cleanText(item.link) || String(item.link ?? "");
      const guid =
        typeof item.guid === "object" && item.guid !== null
          ? String((item.guid as Record<string, unknown>)["#text"] ?? "")
          : cleanText(item.guid);
      return {
        externalId: guid || link,
        title: cleanText(item.title),
        url: link,
        summary: cleanText(item.description ?? item["content:encoded"]),
        publishedAt: parseDate(item.pubDate as string),
      };
    });
  }

  // Atom
  const atomEntries = asArray(doc?.feed?.entry);
  return atomEntries.slice(0, MAX_ITEMS).map((entry: Record<string, unknown>) => {
    const links = asArray(entry.link as Record<string, unknown> | Record<string, unknown>[]);
    const href = String(
      (links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0])?.["@_href"] ?? "",
    );
    return {
      externalId: cleanText(entry.id) || href,
      title: cleanText(entry.title),
      url: href,
      summary: cleanText(entry.summary ?? entry.content),
      publishedAt: parseDate((entry.updated ?? entry.published) as string),
    };
  });
}

async function fetchRss(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  if (!config.feedUrl) throw new Error("RSS source has no feedUrl configured.");
  return parseFeed(await fetchFeedText(config.feedUrl, safeFetch));
}

async function fetchGoogleNews(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  if (!config.query?.trim()) throw new Error("Google News source has no query configured.");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(config.query.trim())}&hl=en-US&gl=US&ceid=US:en`;
  return parseFeed(await fetchFeedText(url, safeFetch));
}

// ---------------------------------------------------------------------------
// Reddit. The unauthenticated JSON endpoints are blocked (403) for server
// traffic, but the same listings are served as Atom feeds at .rss — no key
// needed. Switching to the official OAuth API later only changes this
// function.
// ---------------------------------------------------------------------------

async function fetchReddit(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  const subreddit = config.subreddit?.trim().replace(/^r\//, "");
  const query = config.query?.trim();
  let url: string;
  if (subreddit && query) {
    url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=${MAX_ITEMS}`;
  } else if (subreddit) {
    url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.rss?limit=${MAX_ITEMS}`;
  } else if (query) {
    url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&limit=${MAX_ITEMS}`;
  } else {
    throw new Error("Reddit source has neither query nor subreddit configured.");
  }
  return parseFeed(await fetchFeedText(url, safeFetch));
}

// ---------------------------------------------------------------------------
// Hacker News, YouTube, podcasts, Google Trends, funding news (Sprint 31).
// All keyless: HN via the official Algolia API; the rest reuse parseFeed.
// ---------------------------------------------------------------------------

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string | null;
  story_text?: string | null;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
}

async function fetchHackerNews(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  const query = config.query?.trim();
  if (!query) throw new Error("Hacker News source has no query configured.");
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${MAX_ITEMS}`;
  const result = await safeFetch.fetch({
    url,
    profile: "json",
    headers: { "user-agent": USER_AGENT },
  });
  const body = result.json<{ hits?: HnHit[] }>();
  return (body.hits ?? [])
    .filter((h) => h.objectID && h.title)
    .map((h) => ({
      externalId: `hn-${h.objectID}`,
      title: cleanText(h.title),
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      summary:
        cleanText(h.story_text) ||
        `${h.points ?? 0} points · ${h.num_comments ?? 0} comments on Hacker News`,
      publishedAt: typeof h.created_at_i === "number" ? h.created_at_i * 1000 : null,
    }));
}

async function fetchYoutube(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  const channelId = config.channelId?.trim();
  if (!channelId) throw new Error("YouTube source has no channelId configured.");
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  return parseFeed(await fetchFeedText(url, safeFetch));
}

async function fetchPodcast(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  if (!config.feedUrl) throw new Error("Podcast source has no feedUrl configured.");
  return parseFeed(await fetchFeedText(config.feedUrl, safeFetch));
}

async function fetchFundingNews(config: DiscoverySourceConfig, safeFetch: SafeFetchService) {
  const query = config.query?.trim();
  if (!query) throw new Error("Funding-news source has no query configured.");
  const scoped = config.sector?.trim() ? `${query} ${config.sector.trim()}` : query;
  const fundingQuery = `${scoped} (funding OR raises OR "Series A" OR "Series B" OR seed OR round)`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(fundingQuery)}&hl=en-US&gl=US&ceid=US:en`;
  return parseFeed(await fetchFeedText(url, safeFetch));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function fetchSourceItems(
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
  safeFetch: SafeFetchService,
): Promise<RawDiscoveredItem[]> {
  switch (type) {
    case "rss":
      return await fetchRss(config, safeFetch);
    case "google_news":
      return await fetchGoogleNews(config, safeFetch);
    case "reddit":
      return await fetchReddit(config, safeFetch);
    case "hacker_news":
      return await fetchHackerNews(config, safeFetch);
    case "youtube":
      return await fetchYoutube(config, safeFetch);
    case "podcast":
      return await fetchPodcast(config, safeFetch);
    case "funding_news":
      return await fetchFundingNews(config, safeFetch);
    case "google_trends":
    case "x":
    case "linkedin":
    case "instagram":
    case "g2":
    case "capterra":
    case "intent":
      throw new NeedsApiKeyError(type);
  }
}

export async function fetchSourcePage(input: {
  source: DiscoverySource;
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  signal: AbortSignal;
  maxItems: number;
  maxResponseBytes: number;
  safeFetch: SafeFetchService;
}): Promise<DiscoveryPage> {
  let callsUsed = 0;
  let decodedBytes = 0;
  const boundedSafeFetch: SafeFetchService = {
    validateUrl(url) {
      return input.safeFetch.validateUrl(url);
    },
    async fetch(request) {
      callsUsed += 1;
      const result = await input.safeFetch.fetch({
        ...request,
        signal: input.signal,
        limits: {
          maxCompressedBytes: Math.min(
            request.limits?.maxCompressedBytes ?? Number.POSITIVE_INFINITY,
            input.maxResponseBytes,
            2 * 1024 * 1024,
          ),
          maxDecodedBytes: Math.min(
            request.limits?.maxDecodedBytes ?? Number.POSITIVE_INFINITY,
            input.maxResponseBytes,
            5 * 1024 * 1024,
          ),
        },
      });
      decodedBytes += result.bytes.byteLength;
      return result;
    },
  };
  const items = await fetchSourceItems(
    input.source.type,
    input.source.config,
    boundedSafeFetch,
  );
  return {
    targetKey: input.target.key,
    items: items.slice(0, input.maxItems),
    nextToken: null,
    reachedBoundary: false,
    exhausted: true,
    callsUsed,
    decodedBytes,
  };
}

/** Whether a source type can fetch today (no credentials required). */
export function isLiveSourceType(type: DiscoverySourceType): boolean {
  return (
    type === "rss" ||
    type === "google_news" ||
    type === "reddit" ||
    type === "hacker_news" ||
    type === "youtube" ||
    type === "podcast" ||
    type === "funding_news"
  );
}
