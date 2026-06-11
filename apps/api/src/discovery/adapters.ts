import { XMLParser } from "fast-xml-parser";
import type { DiscoverySourceConfig, DiscoverySourceType } from "@tuezday/contracts";

/**
 * Source adapters. Each turns a source config into a normalized item list.
 * The fetcher is injectable so tests run on fixtures, never the network.
 * Credential-gated types (x, linkedin) are registered here but refuse to
 * fetch until API keys exist — flipping them live only touches this file.
 */

export type Fetcher = typeof fetch;

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

async function fetchText(url: string, fetcher: Fetcher): Promise<string> {
  const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Fetch failed with HTTP ${res.status} for ${url}`);
  }
  return res.text();
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

async function fetchRss(config: DiscoverySourceConfig, fetcher: Fetcher) {
  if (!config.feedUrl) throw new Error("RSS source has no feedUrl configured.");
  return parseFeed(await fetchText(config.feedUrl, fetcher));
}

async function fetchGoogleNews(config: DiscoverySourceConfig, fetcher: Fetcher) {
  if (!config.query?.trim()) throw new Error("Google News source has no query configured.");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(config.query.trim())}&hl=en-US&gl=US&ceid=US:en`;
  return parseFeed(await fetchText(url, fetcher));
}

// ---------------------------------------------------------------------------
// Reddit. The unauthenticated JSON endpoints are blocked (403) for server
// traffic, but the same listings are served as Atom feeds at .rss — no key
// needed. Switching to the official OAuth API later only changes this
// function.
// ---------------------------------------------------------------------------

async function fetchReddit(config: DiscoverySourceConfig, fetcher: Fetcher) {
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
  return parseFeed(await fetchText(url, fetcher));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function fetchSourceItems(
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
  fetcher: Fetcher = fetch,
): Promise<RawDiscoveredItem[]> {
  switch (type) {
    case "rss":
      return fetchRss(config, fetcher);
    case "google_news":
      return fetchGoogleNews(config, fetcher);
    case "reddit":
      return fetchReddit(config, fetcher);
    case "x":
    case "linkedin":
      throw new NeedsApiKeyError(type);
  }
}

/** Whether a source type can fetch today (no credentials required). */
export function isLiveSourceType(type: DiscoverySourceType): boolean {
  return type === "rss" || type === "google_news" || type === "reddit";
}
