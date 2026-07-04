import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  type CreateDiscoverySourceInput,
  type DiscoveredItem,
  type DiscoveredItemMatch,
  type DiscoveredItemStatus,
  type DiscoverySource,
  type DiscoverySourceConfig,
  type DiscoverySourceStatus,
  type DiscoverySourceType,
  type Signal,
  type SignalSource,
  type UpdateDiscoverySourceInput,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db } from "../db";
import {
  discoveredItems,
  discoveryJobs,
  discoverySources,
  type DiscoveredItemRow,
  type DiscoverySourceRow,
} from "../db/schema";
import {
  fetchSourceItems,
  isLiveSourceType,
  type Fetcher,
  type RawDiscoveredItem,
} from "../discovery/adapters";
import {
  PermissionRequiredError,
  RateLimitedError,
  fetchConnectedSourceItems,
} from "../discovery/connected-adapters";
import type { IntentProvider } from "../discovery/intent";
import type { LlmGateway } from "../llm/gateway";
import { getConnection } from "./connections";
import { resolveTrackedAccounts } from "./tracked-social-accounts";
import {
  DISCOVERY_JOB_BATCH_SIZE,
  claimDiscoveryJobs,
  completeDiscoveryJob,
  enqueueDueDiscoveryJobs,
  failDiscoveryJob,
  releaseStaleDiscoveryJobs,
} from "./discovery-jobs";
import {
  brainDigest,
  buildMatchingContext,
  buildMatchingPrompt,
  clampScore,
  getMatchingConfigVersion,
  insertSignalMatch,
  listItemMatches,
  listItemMatchesForItems,
  listSignalMatches,
  parseEntryMatches,
  parseJsonArray,
  replaceItemMatches,
} from "./matching";
import { listPersonas } from "./personas";
import { createSignal } from "./signals";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function rowToSource(row: DiscoverySourceRow): DiscoverySource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as DiscoverySourceType,
    name: row.name,
    config: JSON.parse(row.configJson) as DiscoverySourceConfig,
    enabled: row.enabled,
    status: row.status as DiscoverySourceStatus,
    lastError: row.lastError,
    lastFetchedAt: row.lastFetchedAt,
    connectionId: row.connectionId,
    cursor: JSON.parse(row.cursorJson) as Record<string, unknown>,
    backoffUntil: row.backoffUntil,
    lastAttemptedAt: row.lastAttemptedAt,
    createdAt: row.createdAt,
  };
}

/** What a connected source targets, for default names ("@rival", "#tag", …). */
function connectedTargetLabel(config: DiscoverySourceConfig): string {
  if (config.query?.trim()) return config.query.trim();
  if (config.handle?.trim()) return `@${config.handle.trim().replace(/^@+/, "")}`;
  if (config.handles?.length) return `${config.handles.length} accounts`;
  if (config.hashtag?.trim()) return `#${config.hashtag.trim().replace(/^#/, "")}`;
  if (config.listId?.trim()) return `list ${config.listId.trim()}`;
  if (config.trackedAccountId || config.trackedAccountIds?.length) return "tracked accounts";
  return "connected account";
}

function defaultSourceName(input: CreateDiscoverySourceInput): string {
  switch (input.type) {
    case "rss":
      return `RSS: ${input.config.feedUrl}`;
    case "google_news":
      return `Google News: ${input.config.query}`;
    case "reddit":
      return input.config.subreddit
        ? `Reddit: r/${input.config.subreddit}${input.config.query ? ` (${input.config.query})` : ""}`
        : `Reddit: ${input.config.query}`;
    case "hacker_news":
      return `Hacker News: ${input.config.query}`;
    case "youtube":
      return `YouTube: ${input.config.channelId}`;
    case "podcast":
      return `Podcast: ${input.config.feedUrl}`;
    case "google_trends":
      return `Google Trends: ${input.config.geo ?? "US"}`;
    case "funding_news":
      return `Funding news: ${input.config.query}`;
    case "g2":
      return `G2 reviews: ${input.config.query}`;
    case "capterra":
      return `Capterra reviews: ${input.config.query}`;
    case "intent":
      return `Intent: ${input.config.query}`;
    case "x":
      return `X: ${connectedTargetLabel(input.config)}`;
    case "linkedin":
      return `LinkedIn: ${connectedTargetLabel(input.config)}`;
    case "instagram":
      return `Instagram: ${connectedTargetLabel(input.config)}`;
  }
}

// ---------------------------------------------------------------------------
// Connected-source validation (Sprint 46)
// ---------------------------------------------------------------------------

/** Connector provider key a connected source of this type must read through. */
export function providerForDiscoverySourceType(type: DiscoverySourceType): string | undefined {
  switch (type) {
    case "x":
      return "twitter";
    case "linkedin":
      return "linkedin";
    case "instagram":
      return "instagram";
    case "reddit":
      return "reddit";
    default:
      return undefined;
  }
}

/**
 * Whether this type+config combination can only run through a connection.
 * Instagram has no keyless path; x/linkedin with a mode are connected
 * sources (without one they stay legacy keyless `needs_api_key` rows).
 */
function requiresConnection(type: DiscoverySourceType, config: DiscoverySourceConfig): boolean {
  if (type === "instagram") return true;
  return (type === "x" || type === "linkedin") && config.mode !== undefined;
}

export class DiscoverySourceConnectionError extends Error {
  constructor(
    public readonly code: "connection_required" | "wrong_provider" | "connection_disconnected",
    message: string,
  ) {
    super(message);
    this.name = "DiscoverySourceConnectionError";
  }
}

function validateSourceConnection(
  db: Db,
  workspaceId: string,
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
  connectionId: string | null,
): void {
  const provider = providerForDiscoverySourceType(type);
  if (!connectionId) {
    if (requiresConnection(type, config)) {
      throw new DiscoverySourceConnectionError(
        "connection_required",
        `A connected ${type} source needs a ${provider} connection.`,
      );
    }
    return;
  }
  if (!provider) {
    throw new DiscoverySourceConnectionError(
      "wrong_provider",
      `${type} sources are keyless and cannot use a connection.`,
    );
  }
  const connection = getConnection(db, workspaceId, connectionId);
  if (!connection) {
    throw new DiscoverySourceConnectionError(
      "connection_required",
      "That connection does not exist in this workspace.",
    );
  }
  if (connection.providerKey !== provider) {
    throw new DiscoverySourceConnectionError(
      "wrong_provider",
      `A ${type} source needs a ${provider} connection, not ${connection.providerKey}.`,
    );
  }
  if (connection.status !== "connected") {
    throw new DiscoverySourceConnectionError(
      "connection_disconnected",
      "That connection is disconnected — reconnect it before using it for discovery.",
    );
  }
}

export function createDiscoverySource(
  db: Db,
  workspaceId: string,
  input: CreateDiscoverySourceInput,
): DiscoverySource {
  const connectionId = input.connectionId ?? null;
  validateSourceConnection(db, workspaceId, input.type, input.config, connectionId);
  const row: DiscoverySourceRow = {
    id: randomUUID(),
    workspaceId,
    type: input.type,
    name: input.name ?? defaultSourceName(input),
    configJson: JSON.stringify(input.config),
    enabled: true,
    // A validated connection makes any source type live; keyless x/linkedin
    // stay parked until credentials exist.
    status: connectionId || isLiveSourceType(input.type) ? "active" : "needs_api_key",
    lastError: null,
    lastFetchedAt: null,
    connectionId,
    cursorJson: "{}",
    backoffUntil: null,
    lastAttemptedAt: null,
    createdAt: Date.now(),
  };
  db.insert(discoverySources).values(row).run();
  return rowToSource(row);
}

export function listDiscoverySources(db: Db, workspaceId: string): DiscoverySource[] {
  return db
    .select()
    .from(discoverySources)
    .where(eq(discoverySources.workspaceId, workspaceId))
    .orderBy(desc(discoverySources.createdAt))
    .all()
    .map(rowToSource);
}

export function getDiscoverySource(
  db: Db,
  workspaceId: string,
  sourceId: string,
): DiscoverySource | undefined {
  const row = db
    .select()
    .from(discoverySources)
    .where(and(eq(discoverySources.workspaceId, workspaceId), eq(discoverySources.id, sourceId)))
    .get();
  return row ? rowToSource(row) : undefined;
}

export function updateDiscoverySource(
  db: Db,
  workspaceId: string,
  sourceId: string,
  input: UpdateDiscoverySourceInput,
): DiscoverySource | undefined {
  const existing = getDiscoverySource(db, workspaceId, sourceId);
  if (!existing) return undefined;
  const nextConfig = input.config ?? existing.config;
  // undefined keeps the current connection; null detaches it.
  const nextConnectionId =
    input.connectionId === undefined ? existing.connectionId : input.connectionId;
  validateSourceConnection(db, workspaceId, existing.type, nextConfig, nextConnectionId);
  const updated = {
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    configJson: JSON.stringify(nextConfig),
    connectionId: nextConnectionId,
  };
  db.update(discoverySources).set(updated).where(eq(discoverySources.id, sourceId)).run();
  return getDiscoverySource(db, workspaceId, sourceId);
}

export function deleteDiscoverySource(db: Db, workspaceId: string, sourceId: string): boolean {
  if (!getDiscoverySource(db, workspaceId, sourceId)) return false;
  db.delete(discoverySources).where(eq(discoverySources.id, sourceId)).run();
  return true;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function rowToItem(
  row: DiscoveredItemRow,
  matches: DiscoveredItemMatch[],
  duplicateCount: number,
): DiscoveredItem {
  return {
    ...row,
    status: row.status as DiscoveredItemStatus,
    matches,
    duplicateCount,
  };
}

/** duplicateOfId -> linked-duplicate count, one grouped query per list call. */
function countDuplicatesByCanonical(db: Db, workspaceId: string): Map<string, number> {
  const rows = db
    .select({ duplicateOfId: discoveredItems.duplicateOfId, count: sql<number>`COUNT(*)` })
    .from(discoveredItems)
    .where(
      and(eq(discoveredItems.workspaceId, workspaceId), isNotNull(discoveredItems.duplicateOfId)),
    )
    .groupBy(discoveredItems.duplicateOfId)
    .all();
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.duplicateOfId) map.set(row.duplicateOfId, row.count);
  }
  return map;
}

export function listDiscoveredItems(
  db: Db,
  workspaceId: string,
  status?: DiscoveredItemStatus,
): DiscoveredItem[] {
  const where = status
    ? and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.status, status))
    : eq(discoveredItems.workspaceId, workspaceId);
  const rows = db
    .select()
    .from(discoveredItems)
    .where(where)
    .orderBy(sql`${discoveredItems.score} DESC NULLS LAST`, desc(discoveredItems.createdAt))
    .all();
  const matchesByItem = listItemMatchesForItems(
    db,
    rows.map((r) => r.id),
  );
  const duplicateCounts = countDuplicatesByCanonical(db, workspaceId);
  return rows.map((row) =>
    rowToItem(row, matchesByItem.get(row.id) ?? [], duplicateCounts.get(row.id) ?? 0),
  );
}

export function getDiscoveredItem(
  db: Db,
  workspaceId: string,
  itemId: string,
): DiscoveredItem | undefined {
  const row = db
    .select()
    .from(discoveredItems)
    .where(and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.id, itemId)))
    .get();
  if (!row) return undefined;
  const duplicateCount =
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(discoveredItems)
      .where(eq(discoveredItems.duplicateOfId, itemId))
      .get()?.count ?? 0;
  return rowToItem(row, listItemMatches(db, itemId), duplicateCount);
}

export interface DuplicateItemRef {
  id: string;
  sourceId: string;
  sourceName: string;
  createdAt: number;
}

/** The rows linked to a canonical item — the "seen via N sources" expansion. */
export function listItemDuplicates(db: Db, workspaceId: string, itemId: string): DuplicateItemRef[] {
  return db
    .select({
      id: discoveredItems.id,
      sourceId: discoveredItems.sourceId,
      sourceName: discoverySources.name,
      createdAt: discoveredItems.createdAt,
    })
    .from(discoveredItems)
    .innerJoin(discoverySources, eq(discoveredItems.sourceId, discoverySources.id))
    .where(
      and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.duplicateOfId, itemId)),
    )
    .orderBy(asc(discoveredItems.createdAt))
    .all();
}

const SIGNAL_SOURCE_BY_TYPE: Record<DiscoverySourceType, SignalSource> = {
  reddit: "reddit",
  google_news: "news",
  rss: "rss",
  x: "x",
  linkedin: "linkedin",
  instagram: "instagram",
  hacker_news: "hacker_news",
  youtube: "youtube",
  podcast: "podcast",
  google_trends: "google_trends",
  funding_news: "funding",
  g2: "g2",
  capterra: "capterra",
  intent: "intent",
};

export class ItemNotTriagableError extends Error {
  constructor(status: string) {
    super(`This item was already triaged (status "${status}").`);
    this.name = "ItemNotTriagableError";
  }
}

export function acceptDiscoveredItem(
  db: Db,
  workspaceId: string,
  item: DiscoveredItem,
): { item: DiscoveredItem; signal: Signal } {
  if (item.status !== "new") throw new ItemNotTriagableError(item.status);
  const source = getDiscoverySource(db, workspaceId, item.sourceId);
  const signal = createSignal(db, workspaceId, {
    content: item.summary ? `${item.title}\n\n${item.summary}` : item.title,
    source: source ? SIGNAL_SOURCE_BY_TYPE[source.type] : "other",
    sourceUrl: item.url || undefined,
    suggestedPersonaId: item.suggestedPersonaId ?? undefined,
    suggestedCampaignId: item.suggestedCampaignId ?? undefined,
  });
  // Carry the full candidate list forward (Sprint 45): every scored
  // persona×campaign pairing becomes a signal_matches row — no LLM call,
  // automation routes on what discovery already judged.
  for (const match of listItemMatches(db, item.id)) {
    insertSignalMatch(db, workspaceId, signal.id, match);
  }
  db.update(discoveredItems)
    .set({ status: "accepted", signalId: signal.id })
    .where(eq(discoveredItems.id, item.id))
    .run();
  return {
    item: { ...item, status: "accepted", signalId: signal.id },
    signal: { ...signal, matches: listSignalMatches(db, signal.id) },
  };
}

export function skipDiscoveredItem(db: Db, item: DiscoveredItem): DiscoveredItem {
  if (item.status !== "new") throw new ItemNotTriagableError(item.status);
  db.update(discoveredItems).set({ status: "skipped" }).where(eq(discoveredItems.id, item.id)).run();
  return { ...item, status: "skipped" };
}

// ---------------------------------------------------------------------------
// Run pipeline: fetch -> dedupe -> brain-score
// ---------------------------------------------------------------------------

export interface SourceRunResult {
  sourceId: string;
  name: string;
  fetched: number;
  new: number;
  error?: string;
}

export interface DiscoveryRunResult {
  /** Jobs enqueued by this run (sources already queued/running are skipped). */
  queued: number;
  /** Jobs claimed and processed by this run (bounded by the batch size). */
  processed: number;
  sources: SourceRunResult[];
  scored: number;
}

const SCORE_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Cross-source dedup hashing (Sprint 45)
// ---------------------------------------------------------------------------

const TRACKING_PARAM = /^(utm_[^=]*|fbclid|gclid|ref)(=|$)/;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash of the normalized URL: protocol, `www.`, fragment, trailing slash and
 * known tracking params (`utm_*`, `fbclid`, `gclid`, `ref`) stripped. Null
 * when the item has no URL.
 */
export function hashUrl(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  let u = trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const fragmentAt = u.indexOf("#");
  if (fragmentAt !== -1) u = u.slice(0, fragmentAt);
  const queryAt = u.indexOf("?");
  let path = queryAt === -1 ? u : u.slice(0, queryAt);
  path = path.replace(/\/+$/, "");
  const params =
    queryAt === -1
      ? []
      : u
          .slice(queryAt + 1)
          .split("&")
          .filter((p) => p && !TRACKING_PARAM.test(p));
  return sha256(params.length > 0 ? `${path}?${params.join("&")}` : path);
}

/** Hash of the whitespace/case-normalized title + first 300 chars of summary. */
export function hashContent(title: string, summary: string): string {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256(`${normalize(title)}\n${normalize(summary.slice(0, 300))}`);
}

/**
 * The oldest canonical (non-duplicate) workspace item sharing this URL or
 * content hash — the row a fresh cross-source copy should link to.
 */
function findCanonicalItem(
  db: Db,
  workspaceId: string,
  urlHash: string | null,
  contentHash: string,
): { id: string } | undefined {
  const hashMatches = [eq(discoveredItems.contentHash, contentHash)];
  if (urlHash) hashMatches.push(eq(discoveredItems.urlHash, urlHash));
  return db
    .select({ id: discoveredItems.id })
    .from(discoveredItems)
    .where(
      and(
        eq(discoveredItems.workspaceId, workspaceId),
        isNull(discoveredItems.duplicateOfId),
        or(...hashMatches),
      ),
    )
    .orderBy(asc(discoveredItems.createdAt))
    .limit(1)
    .get();
}

// ---------------------------------------------------------------------------
// Scoring (Sprint 45: multi-candidate, re-scored on persona/campaign change)
// ---------------------------------------------------------------------------

async function scoreUnscoredItems(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  workspaceName: string,
): Promise<number> {
  // Re-score watermark: a still-new item whose last judgment predates the
  // newest persona/campaign edit gets re-judged; triaged items are frozen.
  const configVersion = getMatchingConfigVersion(db, workspaceId);
  const unscored = db
    .select()
    .from(discoveredItems)
    .where(
      and(
        eq(discoveredItems.workspaceId, workspaceId),
        eq(discoveredItems.status, "new"),
        isNull(discoveredItems.duplicateOfId),
        or(isNull(discoveredItems.scoredAt), lt(discoveredItems.scoredAt, configVersion)),
      ),
    )
    .all();
  if (unscored.length === 0) return 0;

  const digest = brainDigest(db, workspaceId);
  const ctx = buildMatchingContext(db, workspaceId);

  let scoredCount = 0;
  for (let offset = 0; offset < unscored.length; offset += SCORE_BATCH_SIZE) {
    const batch = unscored.slice(offset, offset + SCORE_BATCH_SIZE);
    const itemsBlock = batch
      .map(
        (item, i) =>
          `ITEM ${i}: ${item.title}\n${item.summary ? item.summary.slice(0, 300) : "(no summary)"}`,
      )
      .join("\n\n");
    const prompt = buildMatchingPrompt({ workspaceName, digest, ctx, itemsBlock });

    try {
      const result = await llm.generate({ prompt });
      const entries = parseJsonArray(result.text);
      if (!entries) continue; // scoring assists, never gates: leave unscored
      const scoredAt = Date.now();
      for (const raw of entries) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.index !== "number" || typeof entry.score !== "number") continue;
        const item = batch[entry.index];
        if (!item) continue;
        const matches = parseEntryMatches(entry, ctx);
        const best = matches[0];
        replaceItemMatches(db, workspaceId, item.id, matches);
        db.update(discoveredItems)
          .set({
            // Overall relevance (the model's top-level judgment) drives the
            // triage sort; the convenience fields mirror the best candidate.
            score: clampScore(entry.score),
            suggestedPersonaId: best?.personaId ?? null,
            suggestedCampaignId: best?.campaignId ?? null,
            scoreReason: best
              ? best.reason
              : typeof entry.reason === "string"
                ? entry.reason.slice(0, 500)
                : null,
            scoredAt,
          })
          .where(eq(discoveredItems.id, item.id))
          .run();
        scoredCount += 1;
      }
    } catch {
      // Gateway failure mid-run: items stay unscored and triagable.
      continue;
    }
  }
  return scoredCount;
}

// Rate-limit back-pressure (Sprint 46): consecutive rate_limited failures
// double the source's backoff, so a throttling provider is probed less and
// less often instead of on every run.
export const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;

function rateLimitBackoffMs(db: Db, sourceId: string): number {
  const recent = db
    .select({ status: discoveryJobs.status, error: discoveryJobs.error })
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.sourceId, sourceId), inArray(discoveryJobs.status, ["succeeded", "failed"])))
    .orderBy(desc(discoveryJobs.createdAt))
    .limit(10)
    .all();
  let streak = 0;
  for (const job of recent) {
    if (job.status === "failed" && job.error === "rate_limited") streak += 1;
    else break;
  }
  return Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** streak, RATE_LIMIT_BACKOFF_MAX_MS);
}

/** Fetch a connected source through its workspace connection (Sprint 46). */
async function fetchViaConnection(
  db: Db,
  fabric: ConnectorFabric,
  workspaceId: string,
  source: DiscoverySource,
): Promise<RawDiscoveredItem[]> {
  const connection = source.connectionId
    ? getConnection(db, workspaceId, source.connectionId)
    : undefined;
  if (!connection || connection.status !== "connected") {
    // The message doubles as the stable lastError value the UI keys on.
    throw new Error("connection_disconnected");
  }
  const trackedIds = [
    ...(source.config.trackedAccountId ? [source.config.trackedAccountId] : []),
    ...(source.config.trackedAccountIds ?? []),
  ];
  const trackedAccounts = resolveTrackedAccounts(db, workspaceId, trackedIds).map((a) => ({
    handle: a.handle,
    externalId: a.externalId,
  }));
  return fetchConnectedSourceItems({ source, connection, fabric, trackedAccounts });
}

export async function runDiscovery(
  db: Db,
  llm: LlmGateway,
  fetcher: Fetcher,
  intentProvider: IntentProvider,
  fabric: ConnectorFabric,
  workspaceId: string,
  workspaceName: string,
): Promise<DiscoveryRunResult> {
  // Job ledger (Sprint 46): enqueue every due source, then process a bounded
  // batch. Leftover jobs stay queued for the next run, so one slow source (or
  // many sources) never serializes the whole workspace in a single call.
  const now = Date.now();
  releaseStaleDiscoveryJobs(db, now);
  const eligible = listDiscoverySources(db, workspaceId).filter(
    (s) =>
      s.enabled &&
      (s.status !== "needs_api_key" ||
        (s.type === "intent" && intentProvider.isConfigured())),
  );
  const queued = enqueueDueDiscoveryJobs(db, workspaceId, eligible, now);
  const claimed = claimDiscoveryJobs(db, workspaceId, DISCOVERY_JOB_BATCH_SIZE, now);

  const results: SourceRunResult[] = [];
  for (const job of claimed) {
    const source = getDiscoverySource(db, workspaceId, job.sourceId);
    if (!source) {
      failDiscoveryJob(db, job.id, "source_missing", Date.now());
      continue;
    }
    try {
      const fetched = source.connectionId
        ? await fetchViaConnection(db, fabric, workspaceId, source)
        : source.type === "intent"
          ? await intentProvider.fetchSignals(source.config)
          : await fetchSourceItems(source.type, source.config, fetcher);
      const existing = new Set(
        fetched.length
          ? db
              .select({ externalId: discoveredItems.externalId })
              .from(discoveredItems)
              .where(
                and(
                  eq(discoveredItems.sourceId, source.id),
                  inArray(
                    discoveredItems.externalId,
                    fetched.map((f) => f.externalId),
                  ),
                ),
              )
              .all()
              .map((r) => r.externalId)
          : [],
      );
      const fresh = fetched.filter((f) => f.externalId && !existing.has(f.externalId));
      const fetchedAt = Date.now();
      for (const item of fresh) {
        // Cross-source dedup (Sprint 45): a story already seen via another
        // source is kept but linked to the canonical item — it never enters
        // triage and is never scored. Inserts are sequential, so two copies in
        // the same batch still resolve (the second sees the first).
        const urlHash = hashUrl(item.url);
        const contentHash = hashContent(item.title, item.summary);
        const canonical = findCanonicalItem(db, workspaceId, urlHash, contentHash);
        db.insert(discoveredItems)
          .values({
            id: randomUUID(),
            workspaceId,
            sourceId: source.id,
            externalId: item.externalId,
            title: item.title,
            url: item.url,
            summary: item.summary,
            publishedAt: item.publishedAt,
            score: null,
            suggestedPersonaId: null,
            suggestedCampaignId: null,
            scoreReason: null,
            status: canonical ? "duplicate" : "new",
            signalId: null,
            scoredAt: null,
            urlHash,
            contentHash,
            duplicateOfId: canonical?.id ?? null,
            createdAt: fetchedAt,
          })
          .run();
      }
      db.update(discoverySources)
        .set({
          status: "active",
          lastError: null,
          lastFetchedAt: fetchedAt,
          lastAttemptedAt: fetchedAt,
          backoffUntil: null,
        })
        .where(eq(discoverySources.id, source.id))
        .run();
      completeDiscoveryJob(
        db,
        job.id,
        { fetchedCount: fetched.length, newCount: fresh.length },
        fetchedAt,
      );
      results.push({ sourceId: source.id, name: source.name, fetched: fetched.length, new: fresh.length });
    } catch (err) {
      const failedAt = Date.now();
      if (err instanceof RateLimitedError) {
        // The source itself is healthy — stay active, just don't probe it
        // again until the (exponential) backoff passes.
        db.update(discoverySources)
          .set({ backoffUntil: failedAt + rateLimitBackoffMs(db, source.id), lastAttemptedAt: failedAt })
          .where(eq(discoverySources.id, source.id))
          .run();
        failDiscoveryJob(db, job.id, "rate_limited", failedAt);
        results.push({ sourceId: source.id, name: source.name, fetched: 0, new: 0, error: "rate_limited" });
        continue;
      }
      // Permission refusals get a stable, founder-actionable prefix; they are
      // source-local and never abort the rest of the run.
      const message =
        err instanceof PermissionRequiredError
          ? `permission_required: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      db.update(discoverySources)
        .set({
          status: "error",
          lastError: message.slice(0, 500),
          lastFetchedAt: failedAt,
          lastAttemptedAt: failedAt,
        })
        .where(eq(discoverySources.id, source.id))
        .run();
      failDiscoveryJob(db, job.id, message, failedAt);
      results.push({ sourceId: source.id, name: source.name, fetched: 0, new: 0, error: message });
    }
  }

  const scored = await scoreUnscoredItems(db, llm, workspaceId, workspaceName);
  return { queued, processed: claimed.length, sources: results, scored };
}

// ---------------------------------------------------------------------------
// Brain-proposed sources
// ---------------------------------------------------------------------------

export interface SourceProposal {
  type: DiscoverySourceType;
  name: string;
  config: DiscoverySourceConfig;
  reason: string;
}

export async function suggestDiscoverySources(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  workspaceName: string,
): Promise<SourceProposal[]> {
  const digest = brainDigest(db, workspaceId);
  const personas = listPersonas(db, workspaceId);
  const personaList = personas.map((p) => `- ${p.name}: ${p.description}`).join("\n") || "(none)";

  const prompt = [
    `You help ${workspaceName} propose discovery sources — places in the outside world where GTM signals for this company appear. Propose concrete, specific sources, not generic ones.`,
    `COMPANY BRAIN DIGEST:\n${digest || "(brain not filled yet)"}`,
    `PERSONAS:\n${personaList}`,
    `Propose 3 to 6 sources. Allowed types: "google_news" (config: {"query": "..."}), "reddit" (config: {"subreddit": "..."} and/or {"query": "..."}), "rss" (config: {"feedUrl": "..."} — only if you are confident the feed URL is real).`,
    `Respond with ONLY a JSON array: [{"type": "...", "name": "<short label>", "config": {...}, "reason": "<why this serves the company/personas>"}]`,
  ].join("\n\n");

  const result = await llm.generate({ prompt });
  const entries = parseJsonArray(result.text) ?? [];
  const valid: SourceProposal[] = [];
  for (const raw of entries.slice(0, 6)) {
    const entry = raw as Partial<SourceProposal>;
    if (
      (entry.type === "google_news" || entry.type === "reddit" || entry.type === "rss") &&
      entry.config &&
      typeof entry.name === "string"
    ) {
      valid.push({
        type: entry.type,
        name: entry.name.slice(0, 200),
        config: {
          feedUrl: typeof entry.config.feedUrl === "string" ? entry.config.feedUrl : undefined,
          query: typeof entry.config.query === "string" ? entry.config.query : undefined,
          subreddit:
            typeof entry.config.subreddit === "string"
              ? entry.config.subreddit.replace(/^r\//, "")
              : undefined,
        },
        reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : "",
      });
    }
  }
  return valid;
}
