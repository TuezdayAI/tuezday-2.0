import type { Connection, DiscoverySource, DiscoverySourceConfig } from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { RawDiscoveredItem } from "./adapters";

/**
 * Connected discovery adapters (Sprint 46): fetch external posts through the
 * workspace's own OAuth connections via the Nango proxy. This is a separate
 * seam from `SocialAdapter` (publishing/engagement on our own posts) because
 * "listen for other people's posts" is a different provider contract.
 * Official APIs only — no scraping.
 */

export class PermissionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionRequiredError";
  }
}

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** A tracked account the source references, pre-resolved by the caller. */
export interface ResolvedTrackedAccount {
  handle: string;
  /** Provider-side id (e.g. a LinkedIn author URN) when known. */
  externalId: string | null;
}

export interface ConnectedDiscoveryInput {
  source: DiscoverySource;
  connection: Connection;
  fabric: ConnectorFabric;
  trackedAccounts?: ResolvedTrackedAccount[];
}

const MAX_ITEMS = 25;
const TITLE_MAX = 90;
const USER_AGENT = "tuezday-discovery/0.1 (GTM signal tracking; contact: ops@tuezday.app)";

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

/** Every handle the source targets: inline config plus tracked accounts. */
function targetHandles(
  config: DiscoverySourceConfig,
  trackedAccounts: ResolvedTrackedAccount[] | undefined,
): string[] {
  const raw = [
    ...(config.handle ? [config.handle] : []),
    ...(config.handles ?? []),
    ...(trackedAccounts ?? []).map((a) => a.handle),
  ];
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const value of raw) {
    const handle = value.trim().replace(/^@+/, "");
    if (!handle || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    handles.push(handle);
  }
  return handles;
}

interface ProxyOpts {
  baseUrl: string;
  headers?: Record<string, string>;
  /** What the founder should do when the provider refuses access. */
  permissionMessage: string;
  /** Meta reports missing permissions as 400 OAuthException, not 403. */
  permissionOn400?: boolean;
}

async function getJson(input: ConnectedDiscoveryInput, path: string, opts: ProxyOpts): Promise<unknown> {
  const res = await input.fabric.proxyJson(
    "GET",
    path,
    input.connection.nangoConnectionId,
    `tuezday-${input.connection.providerKey}`,
    { baseUrlOverride: opts.baseUrl, headers: opts.headers },
  );
  if (res.status === 429) {
    throw new RateLimitedError(`${input.source.type} rate limit hit (HTTP 429).`);
  }
  if (res.status === 401 || res.status === 403 || (opts.permissionOn400 && res.status === 400)) {
    const detail =
      typeof res.json === "object" && res.json !== null
        ? JSON.stringify(res.json).slice(0, 200)
        : `HTTP ${res.status}`;
    throw new PermissionRequiredError(`${opts.permissionMessage} (${detail})`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${input.source.type} fetch returned HTTP ${res.status} for ${path}`);
  }
  return res.json;
}

// ---------------------------------------------------------------------------
// X (API v2): recent search, account timelines, list timelines
// ---------------------------------------------------------------------------

const X_BASE = "https://api.twitter.com";
const X_TWEET_PARAMS =
  "max_results=25&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username,name";
const X_PERMISSION =
  "X rejected the request — reconnect the X account (missing scope or revoked access)";
const X_LIST_PERMISSION =
  "X list access needs the list.read scope — reconnect the X account to grant it";

interface XTweet {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
}
interface XTweetsResponse {
  data?: XTweet[];
  includes?: { users?: Array<{ id?: string; username?: string }> };
}
interface XUserResponse {
  data?: { id?: string; username?: string };
}

function xItems(json: XTweetsResponse, fallbackUsername?: string): RawDiscoveredItem[] {
  const usernames = new Map<string, string>();
  for (const user of json.includes?.users ?? []) {
    if (user.id && user.username) usernames.set(user.id, user.username);
  }
  return (json.data ?? [])
    .filter((t) => t.id && t.text)
    .slice(0, MAX_ITEMS)
    .map((t) => {
      const username = (t.author_id && usernames.get(t.author_id)) || fallbackUsername;
      const m = t.public_metrics;
      const metrics = m
        ? ` — ${m.like_count ?? 0} likes · ${m.retweet_count ?? 0} reposts · ${m.reply_count ?? 0} replies`
        : "";
      return {
        externalId: `x:${t.id}`,
        title: clip(t.text!, TITLE_MAX),
        url: username
          ? `https://x.com/${username}/status/${t.id}`
          : `https://x.com/i/web/status/${t.id}`,
        summary: `${t.text!.trim()}${metrics}`,
        publishedAt: parseDate(t.created_at),
      };
    });
}

async function fetchXItems(input: ConnectedDiscoveryInput): Promise<RawDiscoveredItem[]> {
  const { config } = input.source;
  const opts: ProxyOpts = { baseUrl: X_BASE, permissionMessage: X_PERMISSION };
  const mode = config.mode ?? "query";

  if (mode === "query") {
    const query = config.query?.trim();
    if (!query) throw new Error("X query source has no query configured.");
    const json = (await getJson(
      input,
      `/2/tweets/search/recent?query=${encodeURIComponent(query)}&${X_TWEET_PARAMS}`,
      opts,
    )) as XTweetsResponse;
    return xItems(json);
  }

  if (mode === "account_timeline") {
    const handles = targetHandles(config, input.trackedAccounts);
    if (handles.length === 0) throw new Error("X account source has no handle configured.");
    const items: RawDiscoveredItem[] = [];
    for (const handle of handles) {
      const user = (await getJson(
        input,
        `/2/users/by/username/${encodeURIComponent(handle)}`,
        opts,
      )) as XUserResponse;
      // An unknown/renamed handle skips quietly; the other handles still fetch.
      if (!user.data?.id) continue;
      const timeline = (await getJson(
        input,
        `/2/users/${user.data.id}/tweets?${X_TWEET_PARAMS}`,
        opts,
      )) as XTweetsResponse;
      items.push(...xItems(timeline, user.data.username ?? handle));
    }
    return items;
  }

  if (mode === "list_timeline") {
    const listId = config.listId?.trim();
    if (!listId) throw new Error("X list source has no listId configured.");
    const json = (await getJson(input, `/2/lists/${encodeURIComponent(listId)}/tweets?${X_TWEET_PARAMS}`, {
      ...opts,
      permissionMessage: X_LIST_PERMISSION,
    })) as XTweetsResponse;
    return xItems(json);
  }

  throw new Error(`X sources do not support mode "${mode}".`);
}

// ---------------------------------------------------------------------------
// Reddit (OAuth): subreddit new/search and global search via oauth.reddit.com.
// Keyless Reddit sources never reach here — they keep the RSS adapter.
// ---------------------------------------------------------------------------

const REDDIT_BASE = "https://oauth.reddit.com";
const REDDIT_PERMISSION =
  "Reddit read access denied — reconnect the Reddit account to grant the read scope";

interface RedditChild {
  kind?: string;
  data?: {
    id?: string;
    name?: string;
    title?: string;
    selftext?: string;
    url?: string;
    permalink?: string;
    created_utc?: number;
  };
}
interface RedditListing {
  data?: { children?: RedditChild[] };
}

async function fetchAuthenticatedRedditItems(
  input: ConnectedDiscoveryInput,
): Promise<RawDiscoveredItem[]> {
  const { config } = input.source;
  const subreddit = config.subreddit?.trim().replace(/^r\//, "");
  const query = config.query?.trim();
  let path: string;
  if (subreddit && query) {
    path = `/r/${encodeURIComponent(subreddit)}/search?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=${MAX_ITEMS}`;
  } else if (subreddit) {
    path = `/r/${encodeURIComponent(subreddit)}/new?limit=${MAX_ITEMS}`;
  } else if (query) {
    path = `/search?q=${encodeURIComponent(query)}&sort=new&limit=${MAX_ITEMS}`;
  } else {
    throw new Error("Reddit source has neither query nor subreddit configured.");
  }

  const json = (await getJson(input, path, {
    baseUrl: REDDIT_BASE,
    headers: { "User-Agent": USER_AGENT },
    permissionMessage: REDDIT_PERMISSION,
  })) as RedditListing;

  return (json.data?.children ?? [])
    .filter((c) => c.data?.title && (c.data.name || c.data.id))
    .slice(0, MAX_ITEMS)
    .map((c) => {
      const data = c.data!;
      return {
        externalId: data.name ?? `${c.kind ?? "t3"}_${data.id}`,
        title: data.title!.trim(),
        url: data.permalink ? `https://www.reddit.com${data.permalink}` : (data.url ?? ""),
        summary: data.selftext?.trim() || data.url || "",
        publishedAt: typeof data.created_utc === "number" ? data.created_utc * 1000 : null,
      };
    });
}

// ---------------------------------------------------------------------------
// LinkedIn (Posts API): known-author sources only — the API has no public
// keyword search. Read scopes (r_member_social / r_organization_social) are
// approval-gated, so a 403 surfaces as a per-source permission error.
// ---------------------------------------------------------------------------

const LINKEDIN_BASE = "https://api.linkedin.com";
const LINKEDIN_HEADERS = {
  "LinkedIn-Version": "202506",
  "X-Restli-Protocol-Version": "2.0.0",
};
const LINKEDIN_PERMISSION = "LinkedIn read scope or author role required";

interface LinkedInPostsResponse {
  elements?: Array<{
    id?: string;
    commentary?: string;
    createdAt?: number;
    publishedAt?: number;
  }>;
}
interface LinkedInUserInfo {
  sub?: string;
}

async function fetchLinkedInItems(input: ConnectedDiscoveryInput): Promise<RawDiscoveredItem[]> {
  const { config } = input.source;
  if ((config.mode ?? "account_timeline") !== "account_timeline") {
    throw new Error(`LinkedIn sources do not support mode "${config.mode}".`);
  }
  const opts: ProxyOpts = {
    baseUrl: LINKEDIN_BASE,
    headers: LINKEDIN_HEADERS,
    permissionMessage: LINKEDIN_PERMISSION,
  };

  // Author URN: tracked account's resolved URN, an URN typed as the handle,
  // else the connected member themself (via OpenID userinfo).
  let author =
    (input.trackedAccounts ?? []).find((a) => a.externalId?.startsWith("urn:"))?.externalId ??
    (config.handle?.trim().startsWith("urn:") ? config.handle.trim() : undefined);
  if (!author) {
    const userinfo = (await getJson(input, "/v2/userinfo", opts)) as LinkedInUserInfo;
    if (!userinfo.sub) throw new PermissionRequiredError(LINKEDIN_PERMISSION);
    author = `urn:li:person:${userinfo.sub}`;
  }

  const json = (await getJson(
    input,
    `/rest/posts?author=${encodeURIComponent(author)}&q=author&count=${MAX_ITEMS}&sortBy=LAST_MODIFIED`,
    opts,
  )) as LinkedInPostsResponse;

  return (json.elements ?? [])
    .filter((p) => p.id)
    .slice(0, MAX_ITEMS)
    .map((p) => ({
      externalId: p.id!,
      title: p.commentary ? clip(p.commentary, TITLE_MAX) : "LinkedIn post",
      url: `https://www.linkedin.com/feed/update/${p.id}`,
      summary: p.commentary?.trim() ?? "",
      publishedAt: p.publishedAt ?? p.createdAt ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Instagram (Graph API): Business Discovery for professional competitor
// accounts and hashtag recent-media — both gated on Meta app review and a
// linked IG Business/Creator account. Missing access is a permission error,
// never fake empty results.
// ---------------------------------------------------------------------------

const GRAPH_BASE = "https://graph.facebook.com";
const GRAPH_V = "v23.0";
const INSTAGRAM_PERMISSION = "Instagram professional account or app review required";

interface IgAccountsResponse {
  data?: Array<{ instagram_business_account?: { id?: string } }>;
}
interface IgMedia {
  id?: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}
interface IgBusinessDiscoveryResponse {
  business_discovery?: { media?: { data?: IgMedia[] } };
}
interface IgHashtagSearchResponse {
  data?: Array<{ id?: string }>;
}
interface IgMediaListResponse {
  data?: IgMedia[];
}

function igItems(media: IgMedia[], fallbackTitle: string): RawDiscoveredItem[] {
  return media
    .filter((m) => m.id)
    .slice(0, MAX_ITEMS)
    .map((m) => {
      const counts =
        m.like_count !== undefined || m.comments_count !== undefined
          ? ` — ${m.like_count ?? 0} likes · ${m.comments_count ?? 0} comments`
          : "";
      return {
        externalId: `ig:${m.id}`,
        title: m.caption ? clip(m.caption, TITLE_MAX) : fallbackTitle,
        url: m.permalink ?? "",
        summary: `${m.caption?.trim() ?? ""}${counts}`.trim(),
        publishedAt: parseDate(m.timestamp),
      };
    });
}

async function fetchInstagramItems(input: ConnectedDiscoveryInput): Promise<RawDiscoveredItem[]> {
  const { config } = input.source;
  const opts: ProxyOpts = {
    baseUrl: GRAPH_BASE,
    permissionMessage: INSTAGRAM_PERMISSION,
    permissionOn400: true,
  };

  // Same IG Business account lookup as the publishing adapter.
  const accounts = (await getJson(
    input,
    `/${GRAPH_V}/me/accounts?fields=instagram_business_account{id}`,
    opts,
  )) as IgAccountsResponse;
  const igUserId = (accounts.data ?? [])
    .map((p) => p.instagram_business_account?.id)
    .find(Boolean);
  if (!igUserId) {
    throw new PermissionRequiredError(
      `${INSTAGRAM_PERMISSION} (no IG Business account is linked to this Facebook login)`,
    );
  }

  if (config.mode === "hashtag") {
    const hashtag = config.hashtag?.trim().replace(/^#/, "");
    if (!hashtag) throw new Error("Instagram hashtag source has no hashtag configured.");
    const search = (await getJson(
      input,
      `/${GRAPH_V}/ig_hashtag_search?user_id=${igUserId}&q=${encodeURIComponent(hashtag)}`,
      opts,
    )) as IgHashtagSearchResponse;
    const hashtagId = search.data?.[0]?.id;
    if (!hashtagId) return [];
    const media = (await getJson(
      input,
      `/${GRAPH_V}/${hashtagId}/recent_media?user_id=${igUserId}&fields=id,caption,permalink,timestamp&limit=${MAX_ITEMS}`,
      opts,
    )) as IgMediaListResponse;
    return igItems(media.data ?? [], `#${hashtag} on Instagram`);
  }

  if (config.mode === "account_timeline") {
    const handles = targetHandles(config, input.trackedAccounts);
    if (handles.length === 0) throw new Error("Instagram account source has no handle configured.");
    const items: RawDiscoveredItem[] = [];
    for (const handle of handles) {
      const fields = `business_discovery.username(${handle}){media{id,caption,permalink,timestamp,like_count,comments_count}}`;
      const json = (await getJson(
        input,
        `/${GRAPH_V}/${igUserId}?fields=${encodeURIComponent(fields)}`,
        opts,
      )) as IgBusinessDiscoveryResponse;
      items.push(...igItems(json.business_discovery?.media?.data ?? [], `@${handle} on Instagram`));
    }
    return items;
  }

  throw new Error(`Instagram sources do not support mode "${config.mode}".`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function fetchConnectedSourceItems(
  input: ConnectedDiscoveryInput,
): Promise<RawDiscoveredItem[]> {
  switch (input.source.type) {
    case "x":
      return fetchXItems(input);
    case "reddit":
      return fetchAuthenticatedRedditItems(input);
    case "linkedin":
      return fetchLinkedInItems(input);
    case "instagram":
      return fetchInstagramItems(input);
    default:
      throw new Error(`${input.source.type} sources do not support connected fetching.`);
  }
}
