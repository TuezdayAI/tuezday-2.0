import type { Connection, DiscoverySource } from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import { linkedinRestHeaders } from "../connectors/provider-config";
import type { RawDiscoveredItem } from "./adapters";
import type {
  DiscoveryPage,
  DiscoveryTarget,
  DiscoveryTargetCheckpoint,
} from "./paging";
import { resolveLinkedInOrganizationUrn } from "./provider-account-resolvers";
import { ProviderCapabilityError } from "./provider-errors";

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

export class CursorInvalidError extends Error {
  constructor() {
    super("cursor_invalid");
    this.name = "CursorInvalidError";
  }
}

export class ConnectedDiscoveryBudgetError extends Error {
  constructor(
    public readonly code:
      | "call_budget_exhausted"
      | "source_byte_budget_exhausted",
  ) {
    super(code);
    this.name = "ConnectedDiscoveryBudgetError";
  }
}

export interface ConnectedDiscoveryErrorMetrics {
  callsUsed: number;
  decodedBytes: number;
}

const connectedDiscoveryErrorMetrics = new WeakMap<
  object,
  ConnectedDiscoveryErrorMetrics
>();

export function getConnectedDiscoveryErrorMetrics(
  error: unknown,
): ConnectedDiscoveryErrorMetrics {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) {
    return { callsUsed: 0, decodedBytes: 0 };
  }
  return (
    connectedDiscoveryErrorMetrics.get(error as object) ?? {
      callsUsed: 0,
      decodedBytes: 0,
    }
  );
}

/** A tracked account the source references, pre-resolved by the caller. */
export interface ResolvedTrackedAccount {
  id: string;
  handle: string;
  /** Provider-side id (e.g. a LinkedIn author URN) when known. */
  externalId: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface ConnectedDiscoveryInput {
  source: DiscoverySource;
  connection: Connection;
  fabric: ConnectorFabric;
  trackedAccounts?: ResolvedTrackedAccount[];
  signal?: AbortSignal;
  maxResponseBytes?: number;
  maxCalls?: number;
  maxBytes?: number;
  metrics?: { calls: number; bytes: number };
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

interface ProxyOpts {
  baseUrl: string;
  headers?: Record<string, string>;
  /** What the founder should do when the provider refuses access. */
  permissionMessage: string;
  /** Meta reports missing permissions as 400 OAuthException, not 403. */
  permissionOn400?: boolean;
  /** This request includes a provider-issued continuation token. */
  cursorRequested?: boolean;
}

function invalidCursorResponse(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value).toLowerCase();
  } catch {
    return false;
  }
  return [
    "invalid_cursor",
    "invalid cursor",
    "pagination_token",
    "paging token",
    "expired token",
  ].some((marker) => serialized.includes(marker));
}

async function getJson(input: ConnectedDiscoveryInput, path: string, opts: ProxyOpts): Promise<unknown> {
  const metrics = input.metrics;
  if (
    metrics &&
    input.maxCalls !== undefined &&
    metrics.calls >= input.maxCalls
  ) {
    throw new ConnectedDiscoveryBudgetError("call_budget_exhausted");
  }
  if (metrics) metrics.calls += 1;
  const res = await input.fabric.proxyJson(
    "GET",
    path,
    input.connection.nangoConnectionId,
    `tuezday-${input.connection.providerKey}`,
    {
      baseUrlOverride: opts.baseUrl,
      headers: opts.headers,
      signal: input.signal,
      maxResponseBytes: input.maxResponseBytes,
    },
  );
  if (metrics) {
    metrics.bytes += res.decodedBytes ?? 0;
    if (
      input.maxBytes !== undefined &&
      metrics.bytes > input.maxBytes
    ) {
      throw new ConnectedDiscoveryBudgetError(
        "source_byte_budget_exhausted",
      );
    }
  }
  if (res.status === 429) {
    throw new RateLimitedError(`${input.source.type} rate limit hit (HTTP 429).`);
  }
  if (
    res.status === 400 &&
    opts.cursorRequested &&
    invalidCursorResponse(res.json)
  ) {
    throw new CursorInvalidError();
  }
  if (res.status === 401 || res.status === 403 || (opts.permissionOn400 && res.status === 400)) {
    throw new PermissionRequiredError(opts.permissionMessage);
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
  meta?: { next_token?: string };
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
  data?: { children?: RedditChild[]; after?: string | null };
}

// ---------------------------------------------------------------------------
// LinkedIn (Posts API): known-author sources only — the API has no public
// keyword search. Read scopes (r_member_social / r_organization_social) are
// approval-gated, so a 403 surfaces as a per-source permission error.
// ---------------------------------------------------------------------------

const LINKEDIN_BASE = "https://api.linkedin.com";
const LINKEDIN_PERMISSION = "LinkedIn read scope or author role required";

interface LinkedInPostsResponse {
  elements?: Array<{
    id?: string;
    commentary?: string;
    createdAt?: number;
    publishedAt?: number;
  }>;
  paging?: {
    start?: number;
    count?: number;
    total?: number;
  };
}
// ---------------------------------------------------------------------------
// Direct Instagram Login can read only the connected professional account's
// own media. It does not expose competitor Business Discovery or hashtags.
// ---------------------------------------------------------------------------

const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com";
const INSTAGRAM_PERMISSION = "Instagram professional account access required";

interface IgMedia {
  id?: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}
interface IgMediaListResponse {
  data?: IgMedia[];
  paging?: { cursors?: { after?: string } };
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

interface ConnectedProviderPageInput extends ConnectedDiscoveryInput {
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  maxItems: number;
}

interface ProviderPageResult {
  items: RawDiscoveredItem[];
  nextToken: string | null;
}

function providerToken(input: ConnectedProviderPageInput): string | null {
  return input.checkpoint.continuation?.providerToken ?? null;
}

function appendQuery(
  path: string,
  key: string,
  value: string | null,
): string {
  if (!value) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

function pageSize(input: ConnectedProviderPageInput): number {
  return Math.max(1, Math.min(MAX_ITEMS, input.maxItems));
}

async function fetchXPage(
  input: ConnectedProviderPageInput,
): Promise<ProviderPageResult> {
  const { config } = input.source;
  const token = providerToken(input);
  const opts: ProxyOpts = {
    baseUrl: X_BASE,
    permissionMessage: X_PERMISSION,
    cursorRequested: Boolean(token),
  };
  const params =
    `max_results=${pageSize(input)}` +
    "&tweet.fields=created_at,author_id,public_metrics" +
    "&expansions=author_id&user.fields=username,name";
  const mode = config.mode ?? "query";
  let json: XTweetsResponse;
  let fallbackUsername: string | undefined;

  if (mode === "query") {
    const query = config.query?.trim();
    if (!query) throw new Error("X query source has no query configured.");
    const path = appendQuery(
      `/2/tweets/search/recent?query=${encodeURIComponent(query)}&${params}`,
      "pagination_token",
      token,
    );
    json = (await getJson(input, path, opts)) as XTweetsResponse;
  } else if (mode === "account_timeline") {
    const handle = input.target.handle?.trim().replace(/^@+/, "");
    if (!handle) {
      throw new Error("X account source has no handle configured.");
    }
    let userId = input.target.externalId?.trim() || null;
    fallbackUsername = handle;
    if (!userId) {
      const user = (await getJson(
        input,
        `/2/users/by/username/${encodeURIComponent(handle)}`,
        {
          ...opts,
          cursorRequested: false,
        },
      )) as XUserResponse;
      if (!user.data?.id) {
        return { items: [], nextToken: null };
      }
      userId = user.data.id;
      fallbackUsername = user.data.username ?? handle;
    }
    const path = appendQuery(
      `/2/users/${encodeURIComponent(userId)}/tweets?${params}`,
      "pagination_token",
      token,
    );
    json = (await getJson(input, path, opts)) as XTweetsResponse;
  } else if (mode === "list_timeline") {
    const listId = config.listId?.trim();
    if (!listId) throw new Error("X list source has no listId configured.");
    const path = appendQuery(
      `/2/lists/${encodeURIComponent(listId)}/tweets?${params}`,
      "pagination_token",
      token,
    );
    json = (await getJson(input, path, {
      ...opts,
      permissionMessage: X_LIST_PERMISSION,
    })) as XTweetsResponse;
  } else {
    throw new Error(`X sources do not support mode "${mode}".`);
  }

  return {
    items: xItems(json, fallbackUsername),
    nextToken: json.meta?.next_token?.trim() || null,
  };
}

async function fetchRedditPage(
  input: ConnectedProviderPageInput,
): Promise<ProviderPageResult> {
  const { config } = input.source;
  const subreddit = config.subreddit?.trim().replace(/^r\//, "");
  const query = config.query?.trim();
  const limit = pageSize(input);
  let path: string;
  if (subreddit && query) {
    path =
      `/r/${encodeURIComponent(subreddit)}/search` +
      `?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=${limit}`;
  } else if (subreddit) {
    path = `/r/${encodeURIComponent(subreddit)}/new?limit=${limit}`;
  } else if (query) {
    path =
      `/search?q=${encodeURIComponent(query)}&sort=new&limit=${limit}`;
  } else {
    throw new Error(
      "Reddit source has neither query nor subreddit configured.",
    );
  }
  const token = providerToken(input);
  path = appendQuery(path, "after", token);
  const json = (await getJson(input, path, {
    baseUrl: REDDIT_BASE,
    headers: { "User-Agent": USER_AGENT },
    permissionMessage: REDDIT_PERMISSION,
    cursorRequested: Boolean(token),
  })) as RedditListing;
  const items = (json.data?.children ?? [])
    .filter((child) => child.data?.title && (child.data.name || child.data.id))
    .slice(0, limit)
    .map((child) => {
      const data = child.data!;
      return {
        externalId: data.name ?? `${child.kind ?? "t3"}_${data.id}`,
        title: data.title!.trim(),
        url: data.permalink
          ? `https://www.reddit.com${data.permalink}`
          : (data.url ?? ""),
        summary: data.selftext?.trim() || data.url || "",
        publishedAt:
          typeof data.created_utc === "number"
            ? data.created_utc * 1000
            : null,
      };
    });
  return {
    items,
    nextToken: json.data?.after?.trim() || null,
  };
}

async function fetchLinkedInPage(
  input: ConnectedProviderPageInput,
): Promise<ProviderPageResult> {
  const { config } = input.source;
  if ((config.mode ?? "account_timeline") !== "account_timeline") {
    throw new Error(
      `LinkedIn sources do not support mode "${config.mode}".`,
    );
  }
  const token = providerToken(input);
  const parsedStart = token === null ? 0 : Number.parseInt(token, 10);
  if (
    !Number.isSafeInteger(parsedStart) ||
    parsedStart < 0 ||
    (token !== null && String(parsedStart) !== token)
  ) {
    throw new CursorInvalidError();
  }
  const opts: ProxyOpts = {
    baseUrl: LINKEDIN_BASE,
    headers: linkedinRestHeaders(),
    permissionMessage: LINKEDIN_PERMISSION,
    cursorRequested: Boolean(token),
  };
  const explicitTarget =
    input.target.externalId?.trim() ||
    input.target.handle?.trim() ||
    config.handle?.trim() ||
    "";
  const author = await resolveLinkedInOrganizationUrn({
    target: explicitTarget,
    async get(path) {
      return {
        status: 200,
        json: await getJson(input, path, {
          ...opts,
          cursorRequested: false,
        }),
      };
    },
  });

  const count = pageSize(input);
  const json = (await getJson(
    input,
    `/rest/posts?author=${encodeURIComponent(author)}` +
      `&q=author&count=${count}&start=${parsedStart}` +
      "&sortBy=LAST_MODIFIED",
    opts,
  )) as LinkedInPostsResponse;
  const items = (json.elements ?? [])
    .filter((post) => post.id)
    .slice(0, count)
    .map((post) => ({
      externalId: post.id!,
      title: post.commentary
        ? clip(post.commentary, TITLE_MAX)
        : "LinkedIn post",
      url: `https://www.linkedin.com/feed/update/${post.id}`,
      summary: post.commentary?.trim() ?? "",
      publishedAt: post.publishedAt ?? post.createdAt ?? null,
    }));
  const pagingStart = json.paging?.start ?? parsedStart;
  const pagingCount = json.paging?.count ?? count;
  const nextStart = pagingStart + pagingCount;
  const hasNext =
    json.paging?.total !== undefined
      ? nextStart < json.paging.total
      : items.length >= count;
  return {
    items,
    nextToken: hasNext ? String(nextStart) : null,
  };
}

async function fetchInstagramPage(
  input: ConnectedProviderPageInput,
): Promise<ProviderPageResult> {
  const { config } = input.source;
  if (input.connection.config.authArchitecture !== "instagram_login") {
    throw new ProviderCapabilityError(
      "reconnect_required",
      "Reconnect Instagram with direct Instagram Login.",
    );
  }
  if (config.mode === "hashtag") {
    throw new ProviderCapabilityError(
      "unsupported_mode",
      "Instagram Login does not support hashtag discovery.",
    );
  }
  if (config.mode !== "account_timeline") {
    throw new ProviderCapabilityError(
      "unsupported_mode",
      `Instagram sources do not support mode "${String(config.mode)}".`,
    );
  }
  const requested = input.target.handle
    ?.trim()
    .replace(/^@+/, "")
    .toLowerCase();
  const connected = input.connection.externalAccountHandle
    ?.trim()
    .replace(/^@+/, "")
    .toLowerCase();
  const accountId = input.connection.externalAccountId?.trim();
  if (!connected || !accountId) {
    throw new ProviderCapabilityError(
      "reconnect_required",
      "Reconnect Instagram to bind its professional account.",
    );
  }
  if (requested !== connected) {
    throw new ProviderCapabilityError(
      "unsupported_target",
      "Instagram Login can read only the connected account's own media.",
    );
  }

  const token = providerToken(input);
  const opts: ProxyOpts = {
    baseUrl: INSTAGRAM_GRAPH_BASE,
    permissionMessage: INSTAGRAM_PERMISSION,
    permissionOn400: true,
    cursorRequested: Boolean(token),
  };
  const limit = pageSize(input);
  let path =
    `/${accountId}/media` +
    "?fields=id,caption,permalink,timestamp,like_count,comments_count" +
    `&limit=${limit}`;
  path = appendQuery(path, "after", token);
  const media = (await getJson(
    input,
    path,
    opts,
  )) as IgMediaListResponse;
  return {
    items: igItems(media.data ?? [], `@${connected} on Instagram`),
    nextToken: media.paging?.cursors?.after?.trim() || null,
  };
}

async function fetchConnectedProviderPage(
  input: ConnectedProviderPageInput,
): Promise<ProviderPageResult> {
  switch (input.source.type) {
    case "x":
      return fetchXPage(input);
    case "reddit":
      return fetchRedditPage(input);
    case "linkedin":
      return fetchLinkedInPage(input);
    case "instagram":
      return fetchInstagramPage(input);
    default:
      throw new Error(
        `${input.source.type} sources do not support connected fetching.`,
      );
  }
}

function stopAtBoundary(
  result: ProviderPageResult,
  checkpoint: DiscoveryTargetCheckpoint,
): ProviderPageResult & { reachedBoundary: boolean; exhausted: boolean } {
  const boundaryExternalId =
    checkpoint.continuation?.boundaryExternalId ??
    checkpoint.highWatermark?.externalId ??
    null;
  const boundaryIndex = boundaryExternalId
    ? result.items.findIndex(
        (item) => item.externalId === boundaryExternalId,
      )
    : -1;
  if (boundaryIndex >= 0) {
    return {
      items: result.items.slice(0, boundaryIndex),
      nextToken: null,
      reachedBoundary: true,
      exhausted: true,
    };
  }
  return {
    ...result,
    reachedBoundary: false,
    exhausted: result.nextToken === null,
  };
}

export async function fetchConnectedSourcePage(input: {
  source: DiscoverySource;
  connection: Connection;
  fabric: ConnectorFabric;
  trackedAccounts: ResolvedTrackedAccount[];
  target: DiscoveryTarget;
  checkpoint: DiscoveryTargetCheckpoint;
  signal: AbortSignal;
  maxItems: number;
  maxCalls: number;
  maxResponseBytes: number;
  maxBytes: number;
}): Promise<DiscoveryPage> {
  const metrics = { calls: 0, bytes: 0 };
  let result: ProviderPageResult;
  try {
    result = await fetchConnectedProviderPage({
      source: input.source,
      connection: input.connection,
      fabric: input.fabric,
      trackedAccounts: input.trackedAccounts,
      signal: input.signal,
      maxResponseBytes: input.maxResponseBytes,
      maxCalls: input.maxCalls,
      maxBytes: input.maxBytes,
      metrics,
      target: input.target,
      checkpoint: input.checkpoint,
      maxItems: input.maxItems,
    });
  } catch (error) {
    if (
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    ) {
      connectedDiscoveryErrorMetrics.set(error as object, {
        callsUsed: metrics.calls,
        decodedBytes: metrics.bytes,
      });
    }
    throw error;
  }
  const bounded = stopAtBoundary(result, input.checkpoint);
  return {
    targetKey: input.target.key,
    items: bounded.items.slice(0, input.maxItems),
    nextToken: bounded.nextToken,
    reachedBoundary: bounded.reachedBoundary,
    exhausted: bounded.exhausted,
    callsUsed: metrics.calls,
    decodedBytes: metrics.bytes,
  };
}
