import type { Fetcher } from "../discovery/adapters";

// Plain-fetch website scraping (Sprint 36.2). Deliberately no headless
// browser and no HTML-parser dependency — same regex approach as the
// discovery adapters' cleanText. JS-only sites are a documented limitation.

const USER_AGENT = "tuezday-scraper/0.1 (+https://tuezday.com)";
const MAX_CORPUS_CHARS = 20_000;
const MAX_SUBPAGES = 4;

/** Same-origin paths worth reading for brand context. */
const ABOUT_ISH = /about|product|pricing|service|company|mission|team|features/i;

/** Strip an HTML document to readable text: drop script/style blocks, tags,
 * decode common entities, collapse whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull same-origin, about-ish links out of a page. */
function extractLinks(html: string, base: URL): string[] {
  const hrefs = [...html.matchAll(/<a[^>]+href=["']([^"'#?]+)["']/gi)].map((m) => m[1]!);
  const out: string[] = [];
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    if (!ABOUT_ISH.test(url.pathname)) continue;
    const normalized = url.origin + url.pathname;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_SUBPAGES) break;
  }
  return out;
}

export interface ScrapeResult {
  corpus: string;
  pagesFetched: string[];
}

async function fetchPage(url: string, fetcher: Fetcher): Promise<string> {
  const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Fetch the site root plus up to four same-origin "about-ish" pages and
 * return a capped text corpus. The root page failing throws; subpage
 * failures are tolerated (best-effort).
 */
export async function scrapeWebsite(websiteUrl: string, fetcher: Fetcher): Promise<ScrapeResult> {
  const base = new URL(websiteUrl);
  const rootUrl = base.origin + (base.pathname === "" ? "/" : base.pathname);
  const rootHtml = await fetchPage(rootUrl, fetcher);
  const pagesFetched = [rootUrl];
  const sections = [`# ${rootUrl}\n${stripHtml(rootHtml)}`];

  for (const link of extractLinks(rootHtml, base)) {
    if (link === rootUrl) continue;
    try {
      const html = await fetchPage(link, fetcher);
      pagesFetched.push(link);
      sections.push(`# ${link}\n${stripHtml(html)}`);
    } catch {
      // best-effort: a missing /about must not sink the run
    }
  }

  return { corpus: sections.join("\n\n").slice(0, MAX_CORPUS_CHARS), pagesFetched };
}
