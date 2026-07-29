import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  createDiscoverySourceInputSchema,
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
  type TrackedSocialAccount,
  type TrackedSocialPlatform,
  type UpdateDiscoverySourceInput,
} from "@tuezday/contracts";
import type { ConnectorFabric } from "../connectors/fabric";
import type { Db, DbExecutor } from "../db";
import {
  discoveredItems,
  discoveredItemMatches,
  discoveryJobs,
  discoverySources,
  type DiscoveredItemRow,
  type DiscoverySourceRow,
} from "../db/schema";
import {
  fetchSourcePage,
  isLiveSourceType,
  type RawDiscoveredItem,
} from "../discovery/adapters";
import {
  ConnectedDiscoveryBudgetError,
  PermissionRequiredError,
  RateLimitedError,
  fetchConnectedSourcePage,
  getConnectedDiscoveryErrorMetrics,
  type ResolvedTrackedAccount,
} from "../discovery/connected-adapters";
import type { IntentProvider } from "../discovery/intent";
import {
  cursorMode,
  readCursor,
  reconcileTargets,
  safeCursorProgress,
  targetsForSource,
  type DiscoveryCursorV1,
  type DiscoveryPage,
  type DiscoveryPageReader,
} from "../discovery/paging";
import type { LlmGateway } from "../llm/gateway";
import { BoundedJsonError } from "../connectors/bounded-json";
import {
  SafeFetchError,
  serializeSafeFetchError,
  type SafeFetchService,
} from "../safe-fetch";
import { getConnection } from "./connections";
import {
  DiscoveryReferenceNotFoundError,
  requireTrackedAccounts,
} from "./tracked-social-accounts";
import {
  completeDiscoveryJob,
  failDiscoveryJob,
  type DiscoveryJobClaim,
} from "./discovery-jobs";
import { DATABASE_NOW_MS } from "./task-leases";
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
  revalidateSignalMatches,
  replaceItemMatches,
} from "./matching";
import { listPersonas } from "./personas";
import { insertSignalRow, readSignal } from "./signals";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function rowToSource(row: DiscoverySourceRow): DiscoverySource {
  const config = JSON.parse(row.configJson) as DiscoverySourceConfig;
  const sourceForMode = {
    type: row.type as DiscoverySourceType,
    config,
  } as DiscoverySource;
  const cursorState = readCursor(row.cursorJson, cursorMode(sourceForMode));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as DiscoverySourceType,
    name: row.name,
    config,
    enabled: row.enabled,
    status: row.status as DiscoverySourceStatus,
    lastError: row.lastError,
    lastFetchedAt: row.lastFetchedAt,
    connectionId: row.connectionId,
    cursor: safeCursorProgress(cursorState, row.lastFetchedAt),
    backoffUntil: row.backoffUntil,
    lastAttemptedAt: row.lastAttemptedAt,
    createdAt: row.createdAt,
  };
}

export interface DiscoverySourceExecution extends DiscoverySource {
  executionVersion: number;
  cursorState: DiscoveryCursorV1;
}

function rowToSourceExecution(
  row: DiscoverySourceRow,
): DiscoverySourceExecution {
  const source = rowToSource(row);
  return {
    ...source,
    executionVersion: row.executionVersion,
    cursorState: readCursor(row.cursorJson, cursorMode(source)),
  };
}

export function getDiscoverySourceExecution(
  db: DbExecutor,
  workspaceId: string,
  sourceId: string,
): DiscoverySourceExecution | undefined {
  const row = db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.workspaceId, workspaceId),
        eq(discoverySources.id, sourceId),
      ),
    )
    .get();
  return row ? rowToSourceExecution(row) : undefined;
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

function trackedAccountIds(config: DiscoverySourceConfig): string[] {
  return [
    ...(config.trackedAccountId ? [config.trackedAccountId] : []),
    ...(config.trackedAccountIds ?? []),
  ];
}

function trackedPlatformForSource(
  type: DiscoverySourceType,
): TrackedSocialPlatform | undefined {
  switch (type) {
    case "x":
      return "x";
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

function requireSourceTrackedAccounts(
  db: Db,
  workspaceId: string,
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
): TrackedSocialAccount[] {
  const accounts = requireTrackedAccounts(
    db,
    workspaceId,
    trackedAccountIds(config),
  );
  const expectedPlatform = trackedPlatformForSource(type);
  if (
    expectedPlatform &&
    accounts.some((account) => account.platform !== expectedPlatform)
  ) {
    throw new DiscoveryReferenceNotFoundError();
  }
  return accounts;
}

export function createDiscoverySource(
  db: Db,
  workspaceId: string,
  input: CreateDiscoverySourceInput,
): DiscoverySource {
  const connectionId = input.connectionId ?? null;
  validateSourceConnection(db, workspaceId, input.type, input.config, connectionId);
  requireSourceTrackedAccounts(db, workspaceId, input.type, input.config);
  const runtimeState = deriveDiscoverySourceRuntimeState(
    input.type,
    connectionId,
  );
  const row: DiscoverySourceRow = {
    id: randomUUID(),
    workspaceId,
    type: input.type,
    name: input.name ?? defaultSourceName(input),
    configJson: JSON.stringify(input.config),
    enabled: true,
    ...runtimeState,
    lastFetchedAt: null,
    connectionId,
    cursorJson: "{}",
    lastAttemptedAt: null,
    executionVersion: 1,
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
  db: DbExecutor,
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

/**
 * Apply a PATCH to the existing source in memory, then run the canonical
 * create schema over the complete result. This prevents a syntactically valid
 * partial body from producing an invalid stored source.
 */
export function validateDiscoverySourceTransition(
  existing: DiscoverySource,
  patch: UpdateDiscoverySourceInput,
): CreateDiscoverySourceInput {
  return createDiscoverySourceInputSchema.parse({
    type: existing.type,
    name: patch.name ?? existing.name,
    config: patch.config ?? existing.config,
    connectionId:
      patch.connectionId === undefined
        ? existing.connectionId
        : patch.connectionId,
  });
}

/** Runtime state is derived from the validated resulting source, never copied. */
export function deriveDiscoverySourceRuntimeState(
  type: DiscoverySourceType,
  connectionId: string | null,
): Pick<DiscoverySourceRow, "status" | "lastError" | "backoffUntil"> {
  return {
    status: connectionId || isLiveSourceType(type) ? "active" : "needs_api_key",
    lastError: null,
    backoffUntil: null,
  };
}

export function updateDiscoverySource(
  db: Db,
  workspaceId: string,
  sourceId: string,
  input: UpdateDiscoverySourceInput,
): DiscoverySource | undefined {
  const existing = getDiscoverySource(db, workspaceId, sourceId);
  if (!existing) return undefined;
  const transition = validateDiscoverySourceTransition(existing, input);
  const nextConnectionId = transition.connectionId ?? null;
  validateSourceConnection(
    db,
    workspaceId,
    transition.type,
    transition.config,
    nextConnectionId,
  );
  requireSourceTrackedAccounts(
    db,
    workspaceId,
    transition.type,
    transition.config,
  );
  const nextEnabled = input.enabled ?? existing.enabled;
  const materiallyChanged =
    JSON.stringify(transition.config) !== JSON.stringify(existing.config) ||
    nextConnectionId !== existing.connectionId;
  const executionChanged =
    materiallyChanged || nextEnabled !== existing.enabled;
  const updated = {
    name: transition.name ?? existing.name,
    enabled: nextEnabled,
    configJson: JSON.stringify(transition.config),
    connectionId: nextConnectionId,
    ...deriveDiscoverySourceRuntimeState(
      transition.type,
      nextConnectionId,
    ),
  };
  return db.transaction((tx) => {
    tx.update(discoverySources)
      .set(
        executionChanged
          ? {
              ...updated,
              executionVersion: sql`
                ${discoverySources.executionVersion} + 1
              `,
            }
          : updated,
      )
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.id, sourceId),
        ),
      )
      .run();
    if (executionChanged) {
      tx.update(discoveryJobs)
        .set({
          status: "skipped",
          finishedAt: Date.now(),
          error: "source_version_changed",
          lockedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
        .where(
          and(
            eq(discoveryJobs.workspaceId, workspaceId),
            eq(discoveryJobs.sourceId, sourceId),
            inArray(discoveryJobs.status, ["queued", "running"]),
          ),
        )
        .run();
    }
    return getDiscoverySource(tx, workspaceId, sourceId);
  });
}

export function deleteDiscoverySource(db: Db, workspaceId: string, sourceId: string): boolean {
  if (!getDiscoverySource(db, workspaceId, sourceId)) return false;
  db
    .delete(discoverySources)
    .where(
      and(
        eq(discoverySources.workspaceId, workspaceId),
        eq(discoverySources.id, sourceId),
      ),
    )
    .run();
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
    workspaceId,
    rows.map((r) => r.id),
  );
  const duplicateCounts = countDuplicatesByCanonical(db, workspaceId);
  return rows.map((row) =>
    rowToItem(row, matchesByItem.get(row.id) ?? [], duplicateCounts.get(row.id) ?? 0),
  );
}

export function getDiscoveredItem(
  db: DbExecutor,
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
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.duplicateOfId, itemId),
        ),
      )
      .get()?.count ?? 0;
  return rowToItem(
    row,
    listItemMatches(db, workspaceId, itemId),
    duplicateCount,
  );
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

export interface DiscoveryAcceptanceHooks {
  afterSignalInsert?(): void;
  afterMatchInsert?(index: number): void;
  afterItemUpdate?(): void;
}

function requireCurrentMatchReferences(
  db: DbExecutor,
  workspaceId: string,
  matches: Array<{
    personaId: string | null;
    campaignId: string | null;
    score: number;
    reason: string;
  }>,
): void {
  const current = revalidateSignalMatches(db, workspaceId, matches);
  if (
    current.length !== matches.length ||
    current.some(
      (match, index) =>
        match.personaId !== matches[index]?.personaId ||
        match.campaignId !== matches[index]?.campaignId,
    )
  ) {
    throw new DiscoveryReferenceNotFoundError();
  }
}

export function acceptDiscoveredItem(
  db: Db,
  workspaceId: string,
  itemId: string,
  hooks?: DiscoveryAcceptanceHooks,
): { item: DiscoveredItem; signal: Signal } {
  return db.transaction((tx) => {
    const item = getDiscoveredItem(tx, workspaceId, itemId);
    if (!item) throw new DiscoveryReferenceNotFoundError();
    if (item.status !== "new") throw new ItemNotTriagableError(item.status);
    const source = getDiscoverySource(tx, workspaceId, item.sourceId);
    if (!source) throw new DiscoveryReferenceNotFoundError();
    const foreignItemMatch = tx
      .select({ id: discoveredItemMatches.id })
      .from(discoveredItemMatches)
      .where(
        and(
          eq(discoveredItemMatches.itemId, item.id),
          ne(discoveredItemMatches.workspaceId, workspaceId),
        ),
      )
      .get();
    if (foreignItemMatch) throw new DiscoveryReferenceNotFoundError();
    const itemMatches = tx
      .select({
        personaId: discoveredItemMatches.personaId,
        campaignId: discoveredItemMatches.campaignId,
        score: discoveredItemMatches.score,
        reason: discoveredItemMatches.reason,
      })
      .from(discoveredItemMatches)
      .where(
        and(
          eq(discoveredItemMatches.workspaceId, workspaceId),
          eq(discoveredItemMatches.itemId, item.id),
        ),
      )
      .orderBy(
        desc(discoveredItemMatches.score),
        asc(discoveredItemMatches.createdAt),
      )
      .all();
    const references = [...itemMatches];
    if (
      (item.suggestedPersonaId || item.suggestedCampaignId) &&
      !references.some(
        (match) =>
          match.personaId === item.suggestedPersonaId &&
          match.campaignId === item.suggestedCampaignId,
      )
    ) {
      references.push({
        personaId: item.suggestedPersonaId,
        campaignId: item.suggestedCampaignId,
        score: item.score ?? 0,
        reason: item.scoreReason ?? "",
      });
    }
    requireCurrentMatchReferences(tx, workspaceId, references);

    const signalInput = {
      content: item.summary ? `${item.title}\n\n${item.summary}` : item.title,
      source: SIGNAL_SOURCE_BY_TYPE[source.type],
      sourceUrl: item.url || undefined,
      suggestedPersonaId: item.suggestedPersonaId ?? undefined,
      suggestedCampaignId: item.suggestedCampaignId ?? undefined,
    };
    const signalRow = insertSignalRow(tx, workspaceId, signalInput);
    hooks?.afterSignalInsert?.();
    itemMatches.forEach((match, index) => {
      insertSignalMatch(tx, workspaceId, signalRow.id, match);
      hooks?.afterMatchInsert?.(index);
    });
    tx.update(discoveredItems)
      .set({ status: "accepted", signalId: signalRow.id })
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.id, item.id),
          eq(discoveredItems.status, "new"),
        ),
      )
      .run();
    hooks?.afterItemUpdate?.();
    const signal = readSignal(tx, workspaceId, signalRow.id);
    if (!signal) throw new Error("Accepted discovery signal could not be read.");
    return {
      item: {
        ...item,
        matches: signal.matches,
        status: "accepted",
        signalId: signal.id,
      },
      signal,
    };
  });
}

export function skipDiscoveredItem(
  db: Db,
  workspaceId: string,
  item: DiscoveredItem,
): DiscoveredItem {
  if (item.status !== "new") throw new ItemNotTriagableError(item.status);
  db
    .update(discoveredItems)
    .set({ status: "skipped" })
    .where(
      and(
        eq(discoveredItems.workspaceId, workspaceId),
        eq(discoveredItems.id, item.id),
      ),
    )
    .run();
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
  db: DbExecutor,
  workspaceId: string,
  urlHash: string | null,
  contentHash: string,
  excludeId?: string,
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
        excludeId ? ne(discoveredItems.id, excludeId) : undefined,
      ),
    )
    .orderBy(asc(discoveredItems.createdAt))
    .limit(1)
    .get();
}

// ---------------------------------------------------------------------------
// Scoring (Sprint 45: multi-candidate, re-scored on persona/campaign change)
// ---------------------------------------------------------------------------

export async function scoreUnscoredItems(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  workspaceName: string,
  options: {
    maxItems?: number;
    matchingTimeoutMs?: number;
    signal?: AbortSignal;
    onAdmitted?: (count: number) => void;
  } = {},
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
    .all()
    .slice(0, options.maxItems ?? Number.POSITIVE_INFINITY);
  options.onAdmitted?.(unscored.length);
  if (unscored.length === 0) return 0;

  const digest = brainDigest(db, workspaceId);
  const ctx = buildMatchingContext(db, workspaceId);

  let scoredCount = 0;
  for (let offset = 0; offset < unscored.length; offset += SCORE_BATCH_SIZE) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("tick_budget_exhausted");
    }
    const batch = unscored.slice(offset, offset + SCORE_BATCH_SIZE);
    const itemsBlock = batch
      .map(
        (item, i) =>
          `ITEM ${i}: ${item.title}\n${item.summary ? item.summary.slice(0, 300) : "(no summary)"}`,
      )
      .join("\n\n");
    const prompt = buildMatchingPrompt({ workspaceName, digest, ctx, itemsBlock });

    try {
      const matchingSignal = options.matchingTimeoutMs
        ? AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(options.matchingTimeoutMs),
          ])
        : options.signal;
      const result = await llm.generate({ prompt, signal: matchingSignal });
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
        const overallScore = clampScore(entry.score);
        const persisted = db.transaction((tx) => {
          // The model call happens outside the transaction. Re-check both the
          // triage state and every workspace-owned reference at write time so
          // an accepted item or a moved/deleted target cannot be scored from a
          // stale prompt snapshot.
          const currentItem = tx
            .select({ id: discoveredItems.id })
            .from(discoveredItems)
            .where(
              and(
                eq(discoveredItems.workspaceId, workspaceId),
                eq(discoveredItems.id, item.id),
                eq(discoveredItems.status, "new"),
                isNull(discoveredItems.duplicateOfId),
              ),
            )
            .get();
          if (!currentItem) return false;

          const matchesToPersist = revalidateSignalMatches(tx, workspaceId, matches);
          const best = matchesToPersist[0];
          replaceItemMatches(tx, workspaceId, item.id, matchesToPersist);
          tx.update(discoveredItems)
            .set({
              // Overall relevance (the model's top-level judgment) drives the
              // triage sort; the convenience fields mirror the best candidate.
              score: overallScore,
              suggestedPersonaId: best?.personaId ?? null,
              suggestedCampaignId: best?.campaignId ?? null,
              scoreReason: best
                ? best.reason
                : typeof entry.reason === "string"
                  ? entry.reason.slice(0, 500)
                  : null,
              scoredAt,
            })
            .where(
              and(
                eq(discoveredItems.workspaceId, workspaceId),
                eq(discoveredItems.id, item.id),
                eq(discoveredItems.status, "new"),
              ),
            )
            .run();
          return true;
        });
        if (persisted) scoredCount += 1;
      }
    } catch {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("tick_budget_exhausted");
      }
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

export interface SourceBudget {
  deadlineMs: number;
  maxItems: number;
  maxPages: number;
  maxCalls: number;
  maxResponseBytes: number;
  maxBytes: number;
}

export interface DiscoverySourceDependencies {
  db: Db;
  safeFetch: SafeFetchService;
  intentProvider: IntentProvider;
  fabric: ConnectorFabric;
  pageReader?: DiscoveryPageReader;
}

export interface DiscoverySourceMetrics {
  code: string;
  calls: number;
  pages: number;
  bytes: number;
  items: number;
  continuationPending: boolean;
  replay: boolean;
}

const sourceResultMetrics = new WeakMap<
  SourceRunResult,
  DiscoverySourceMetrics
>();

export function getDiscoverySourceMetrics(
  result: SourceRunResult,
): DiscoverySourceMetrics {
  return (
    sourceResultMetrics.get(result) ?? {
      code: result.error ?? "completed",
      calls: 0,
      pages: 0,
      bytes: 0,
      items: result.fetched,
      continuationPending: false,
      replay: false,
    }
  );
}

async function defaultDiscoveryPageReader(
  input: Parameters<DiscoveryPageReader>[0],
) {
  if (input.source.connectionId) {
    const connection = getConnection(
      input.db,
      input.source.workspaceId,
      input.source.connectionId,
    );
    if (!connection || connection.status !== "connected") {
      throw new Error("connection_disconnected");
    }
    return fetchConnectedSourcePage({
      source: input.source,
      connection,
      fabric: input.fabric,
      trackedAccounts: input.trackedAccounts,
      target: input.target,
      checkpoint: input.checkpoint,
      signal: input.signal,
      maxItems: input.maxItems,
      maxCalls: input.maxCalls,
      maxResponseBytes: input.maxResponseBytes,
      maxBytes: input.maxBytes,
    });
  }
  if (input.source.type === "intent") {
    const items = await input.intentProvider.fetchSignals(
      input.source.config,
      input.signal,
    );
    return {
      targetKey: input.target.key,
      items: items.slice(0, input.maxItems),
      nextToken: null,
      reachedBoundary: false,
      exhausted: true,
      callsUsed: 1,
      decodedBytes: 0,
    };
  }
  return fetchSourcePage({
    source: input.source,
    target: input.target,
    checkpoint: input.checkpoint,
    signal: input.signal,
    maxItems: input.maxItems,
    maxResponseBytes: input.maxResponseBytes,
    safeFetch: input.safeFetch,
  });
}

function sourceClaimIsLive(
  db: DbExecutor,
  claim: DiscoveryJobClaim,
): boolean {
  return Boolean(
    db
      .select({ id: discoveryJobs.id })
      .from(discoveryJobs)
      .where(
        and(
          eq(discoveryJobs.id, claim.id),
          eq(discoveryJobs.status, "running"),
          eq(discoveryJobs.leaseOwner, claim.leaseOwner),
          eq(discoveryJobs.leaseVersion, claim.leaseVersion),
          gt(discoveryJobs.leaseExpiresAt, DATABASE_NOW_MS),
        ),
      )
      .get(),
  );
}

function newestItem(items: RawDiscoveredItem[]) {
  return [...items].sort((left, right) => {
    const byDate = (right.publishedAt ?? -1) - (left.publishedAt ?? -1);
    return byDate || right.externalId.localeCompare(left.externalId);
  })[0];
}

export interface DiscoveryCheckpointHooks {
  afterOccurrenceInsert?(index: number): void;
  afterCanonicalization?(): void;
  beforeCursorUpdate?(): void;
}

class DiscoveryCheckpointFenceError extends Error {
  constructor() {
    super("discovery_checkpoint_fence_changed");
    this.name = "DiscoveryCheckpointFenceError";
  }
}

export function persistDiscoveryPage(
  db: Db,
  input: {
    claim: DiscoveryJobClaim;
    source: DiscoverySourceExecution;
    page: DiscoveryPage;
    cursor: DiscoveryCursorV1;
    hooks?: DiscoveryCheckpointHooks;
  },
): { inserted: number; fetched: number } | null {
  if (
    input.page.items.some(
      (item) =>
        typeof item.externalId !== "string" ||
        item.externalId.trim() === "",
    )
  ) {
    throw new Error("adapter_missing_external_id");
  }

  try {
    return db.transaction((tx) => {
      const { claim, source, page, cursor, hooks } = input;
      if (!sourceClaimIsLive(tx, claim)) {
        throw new DiscoveryCheckpointFenceError();
      }
      const currentSource = tx
        .select({ executionVersion: discoverySources.executionVersion })
        .from(discoverySources)
        .where(
          and(
            eq(discoverySources.workspaceId, claim.workspaceId),
            eq(discoverySources.id, source.id),
            eq(
              discoverySources.executionVersion,
              claim.sourceExecutionVersion,
            ),
          ),
        )
        .get();
      if (!currentSource) throw new DiscoveryCheckpointFenceError();

      let inserted = 0;
      const checkpointAt = Date.now();
      for (const [index, item] of page.items.entries()) {
        const id = randomUUID();
        const urlHash = hashUrl(item.url);
        const contentHash = hashContent(item.title, item.summary);
        const insertedRow = tx
          .insert(discoveredItems)
          .values({
            id,
            workspaceId: claim.workspaceId,
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
            status: "new",
            signalId: null,
            scoredAt: null,
            urlHash,
            contentHash,
            duplicateOfId: null,
            createdAt: checkpointAt,
          })
          .onConflictDoNothing({
            target: [
              discoveredItems.sourceId,
              discoveredItems.externalId,
            ],
          })
          .returning({ id: discoveredItems.id })
          .get();
        hooks?.afterOccurrenceInsert?.(index);
        if (!insertedRow) continue;

        const canonical = findCanonicalItem(
          tx,
          claim.workspaceId,
          urlHash,
          contentHash,
          id,
        );
        if (canonical) {
          tx.update(discoveredItems)
            .set({
              status: "duplicate",
              duplicateOfId: canonical.id,
            })
            .where(eq(discoveredItems.id, id))
            .run();
        }
        inserted += 1;
      }
      hooks?.afterCanonicalization?.();
      hooks?.beforeCursorUpdate?.();

      const sourceUpdated = tx
        .update(discoverySources)
        .set({
          cursorJson: JSON.stringify(cursor),
          status: "active",
          lastError: null,
          lastFetchedAt: checkpointAt,
          lastAttemptedAt: checkpointAt,
          backoffUntil: null,
        })
        .where(
          and(
            eq(discoverySources.workspaceId, claim.workspaceId),
            eq(discoverySources.id, source.id),
            eq(
              discoverySources.executionVersion,
              claim.sourceExecutionVersion,
            ),
          ),
        )
        .run();
      if (sourceUpdated.changes !== 1) {
        throw new DiscoveryCheckpointFenceError();
      }

      const jobUpdated = tx
        .update(discoveryJobs)
        .set({
          fetchedCount: sql`
            ${discoveryJobs.fetchedCount} + ${page.items.length}
          `,
          newCount: sql`${discoveryJobs.newCount} + ${inserted}`,
        })
        .where(
          and(
            eq(discoveryJobs.id, claim.id),
            eq(discoveryJobs.status, "running"),
            eq(discoveryJobs.leaseOwner, claim.leaseOwner),
            eq(discoveryJobs.leaseVersion, claim.leaseVersion),
            gt(discoveryJobs.leaseExpiresAt, DATABASE_NOW_MS),
          ),
        )
        .run();
      if (jobUpdated.changes !== 1) {
        throw new DiscoveryCheckpointFenceError();
      }
      return { inserted, fetched: page.items.length };
    });
  } catch (error) {
    if (error instanceof DiscoveryCheckpointFenceError) return null;
    throw error;
  }
}

function persistPermissionCheckpoint(
  db: Db,
  claim: DiscoveryJobClaim,
  source: DiscoverySourceExecution,
  cursor: DiscoveryCursorV1,
): boolean {
  return db.transaction((tx) => {
    if (!sourceClaimIsLive(tx, claim)) return false;
    return (
      tx
        .update(discoverySources)
        .set({
          cursorJson: JSON.stringify(cursor),
          lastAttemptedAt: Date.now(),
        })
        .where(
          and(
            eq(discoverySources.workspaceId, claim.workspaceId),
            eq(discoverySources.id, source.id),
            eq(
              discoverySources.executionVersion,
              claim.sourceExecutionVersion,
            ),
          ),
        )
        .run().changes === 1
    );
  });
}

const SAFE_EXECUTION_CODES = new Set([
  "lease_lost",
  "source_timeout",
  "tick_budget_exhausted",
  "item_budget_exhausted",
  "page_budget_exhausted",
  "call_budget_exhausted",
  "source_byte_budget_exhausted",
  "response_limit",
  "shutdown",
]);

function executionCodeFromSignal(signal: AbortSignal): string {
  const reason = signal.reason as { code?: unknown } | undefined;
  return typeof reason?.code === "string" &&
    SAFE_EXECUTION_CODES.has(reason.code)
    ? reason.code
    : "source_timeout";
}

function safeExecutionFailure(
  error: unknown,
  source: DiscoverySourceExecution,
  signal: AbortSignal,
): { code: string; persisted: string } {
  if (signal.aborted) {
    const code = executionCodeFromSignal(signal);
    return { code, persisted: code };
  }
  if (error instanceof ConnectedDiscoveryBudgetError) {
    return { code: error.code, persisted: error.code };
  }
  if (error instanceof BoundedJsonError) {
    const code =
      error.code === "response_limit" ? "response_limit" : "source_timeout";
    return { code, persisted: code };
  }
  if (error instanceof RateLimitedError) {
    return { code: "rate_limited", persisted: "rate_limited" };
  }
  if (error instanceof PermissionRequiredError) {
    return {
      code: "permission_required",
      persisted: `permission_required: ${error.message}`.slice(0, 500),
    };
  }
  if (error instanceof DiscoveryReferenceNotFoundError) {
    return {
      code: "related_object_not_found",
      persisted: error.message.slice(0, 500),
    };
  }
  if (
    error instanceof Error &&
    error.message === "adapter_missing_external_id"
  ) {
    return {
      code: "adapter_missing_external_id",
      persisted: "adapter_missing_external_id",
    };
  }
  if (
    error instanceof SafeFetchError ||
    (!source.connectionId && source.type !== "intent")
  ) {
    const safe = serializeSafeFetchError(error);
    return {
      code: safe.code,
      persisted: `${safe.code}: ${safe.message}`,
    };
  }
  if (error instanceof Error && error.message === "connection_disconnected") {
    return {
      code: "connection_disconnected",
      persisted: "connection_disconnected",
    };
  }
  return { code: "provider_failed", persisted: "provider_failed" };
}

function writeSourceFailure(
  db: Db,
  source: DiscoverySourceExecution,
  code: string,
  persistedError = code,
): void {
  if (code === "lease_lost" || code === "shutdown") return;
  const failedAt = Date.now();
  if (code === "rate_limited") {
    db.update(discoverySources)
      .set({
        backoffUntil: failedAt + rateLimitBackoffMs(db, source.id),
        lastAttemptedAt: failedAt,
      })
      .where(
        and(
          eq(discoverySources.workspaceId, source.workspaceId),
          eq(discoverySources.id, source.id),
          eq(discoverySources.executionVersion, source.executionVersion),
        ),
      )
      .run();
    return;
  }
  const isBudget =
    SAFE_EXECUTION_CODES.has(code) && code !== "source_timeout";
  db.update(discoverySources)
    .set({
      status: isBudget ? "active" : "error",
      lastError: persistedError.slice(0, 500),
      lastFetchedAt: failedAt,
      lastAttemptedAt: failedAt,
    })
    .where(
      and(
        eq(discoverySources.workspaceId, source.workspaceId),
        eq(discoverySources.id, source.id),
        eq(discoverySources.executionVersion, source.executionVersion),
      ),
    )
    .run();
}

function resultWithMetrics(
  result: SourceRunResult,
  metrics: DiscoverySourceMetrics,
): SourceRunResult {
  sourceResultMetrics.set(result, metrics);
  return result;
}

export async function runClaimedDiscoverySource(
  deps: DiscoverySourceDependencies,
  claim: DiscoveryJobClaim,
  budget: SourceBudget,
  signal: AbortSignal,
): Promise<SourceRunResult> {
  const initial = getDiscoverySourceExecution(
    deps.db,
    claim.workspaceId,
    claim.sourceId,
  );
  if (!initial) {
    failDiscoveryJob(deps.db, claim, "source_missing");
    return resultWithMetrics(
      {
        sourceId: claim.sourceId,
        name: claim.sourceId,
        fetched: 0,
        new: 0,
        error: "source_missing",
      },
      {
        code: "source_missing",
        calls: 0,
        pages: 0,
        bytes: 0,
        items: 0,
        continuationPending: false,
        replay: claim.attempt > 1,
      },
    );
  }
  if (initial.executionVersion !== claim.sourceExecutionVersion) {
    failDiscoveryJob(deps.db, claim, "source_version_changed");
    return resultWithMetrics(
      {
        sourceId: initial.id,
        name: initial.name,
        fetched: 0,
        new: 0,
        error: "source_version_changed",
      },
      {
        code: "source_version_changed",
        calls: 0,
        pages: 0,
        bytes: 0,
        items: 0,
        continuationPending: false,
        replay: claim.attempt > 1,
      },
    );
  }

  let trackedAccounts: ResolvedTrackedAccount[];
  try {
    trackedAccounts = requireSourceTrackedAccounts(
      deps.db,
      claim.workspaceId,
      initial.type,
      initial.config,
    ).map((account) => ({
      handle: account.handle,
      externalId: account.externalId,
    }));
  } catch (error) {
    const failure = safeExecutionFailure(error, initial, signal);
    writeSourceFailure(
      deps.db,
      initial,
      failure.code,
      failure.persisted,
    );
    failDiscoveryJob(deps.db, claim, failure.persisted);
    return resultWithMetrics(
      {
        sourceId: initial.id,
        name: initial.name,
        fetched: 0,
        new: 0,
        error: failure.persisted,
      },
      {
        code: failure.code,
        calls: 0,
        pages: 0,
        bytes: 0,
        items: 0,
        continuationPending: false,
        replay: claim.attempt > 1,
      },
    );
  }

  const targets = targetsForSource(initial, trackedAccounts);
  const cursor = reconcileTargets(initial.cursorState, targets);
  const pageReader = deps.pageReader ?? defaultDiscoveryPageReader;
  let calls = 0;
  let pages = 0;
  let bytes = 0;
  let admittedItems = 0;
  let insertedItems = 0;
  let permissionFailures = 0;
  let visitedTargets = 0;
  let terminalCode: string | undefined;
  let terminalPersistedError: string | undefined;
  let permissionPersistedError: string | undefined;
  const startingTargetIndex = cursor.nextTargetIndex;

  try {
    for (let offset = 0; offset < targets.length; offset += 1) {
      if (signal.aborted || Date.now() >= budget.deadlineMs) {
        terminalCode = signal.aborted
          ? executionCodeFromSignal(signal)
          : "source_timeout";
        break;
      }
      if (pages >= budget.maxPages) {
        terminalCode = "page_budget_exhausted";
        break;
      }
      if (calls >= budget.maxCalls) {
        terminalCode = "call_budget_exhausted";
        break;
      }
      if (bytes >= budget.maxBytes) {
        terminalCode = "source_byte_budget_exhausted";
        break;
      }
      if (admittedItems >= budget.maxItems) {
        terminalCode = "item_budget_exhausted";
        break;
      }

      const targetIndex =
        (startingTargetIndex + offset) % targets.length;
      const target = targets[targetIndex]!;
      const checkpoint = cursor.targets[target.key]!;
      let page;
      try {
        page = await pageReader({
          db: deps.db,
          source: initial,
          target,
          checkpoint,
          signal,
          maxItems: budget.maxItems - admittedItems,
          maxCalls: budget.maxCalls - calls,
          maxResponseBytes: budget.maxResponseBytes,
          maxBytes: budget.maxBytes - bytes,
          safeFetch: deps.safeFetch,
          intentProvider: deps.intentProvider,
          fabric: deps.fabric,
          trackedAccounts,
        });
      } catch (error) {
        const failedMetrics =
          getConnectedDiscoveryErrorMetrics(error);
        calls += failedMetrics.callsUsed;
        bytes += failedMetrics.decodedBytes;
        if (calls > budget.maxCalls) {
          terminalCode = "call_budget_exhausted";
          break;
        }
        if (bytes > budget.maxBytes) {
          terminalCode = "source_byte_budget_exhausted";
          break;
        }
        if (error instanceof PermissionRequiredError) {
          permissionFailures += 1;
          permissionPersistedError =
            `permission_required: ${error.message}`.slice(0, 500);
          checkpoint.lastSafeError = "permission_required";
          checkpoint.continuation = null;
          cursor.nextTargetIndex = (targetIndex + 1) % targets.length;
          if (!persistPermissionCheckpoint(deps.db, claim, initial, cursor)) {
            terminalCode = "lease_lost";
            break;
          }
          visitedTargets += 1;
          continue;
        }
        throw error;
      }

      const nextCalls = calls + page.callsUsed;
      const nextBytes = bytes + page.decodedBytes;
      if (nextCalls > budget.maxCalls) {
        terminalCode = "call_budget_exhausted";
        break;
      }
      if (nextBytes > budget.maxBytes) {
        terminalCode = "source_byte_budget_exhausted";
        break;
      }
      calls = nextCalls;
      bytes = nextBytes;
      pages += 1;
      visitedTargets += 1;

      const remainingItems = budget.maxItems - admittedItems;
      const admitted = page.items.slice(0, remainingItems);
      const truncated = admitted.length < page.items.length;
      admittedItems += admitted.length;
      const newest = newestItem(admitted);
      if (newest) {
        checkpoint.highWatermark = {
          externalId: newest.externalId,
          publishedAt: newest.publishedAt,
        };
      }
      checkpoint.lastSafeError = null;
      checkpoint.continuation =
        page.exhausted && !truncated
          ? null
          : {
              providerToken: page.nextToken,
              boundaryExternalId:
                checkpoint.highWatermark?.externalId ?? null,
              newestExternalId: newest?.externalId ?? null,
              newestPublishedAt: newest?.publishedAt ?? null,
            };
      cursor.nextTargetIndex = (targetIndex + 1) % targets.length;

      const persisted = persistDiscoveryPage(deps.db, {
        claim,
        source: initial,
        page: { ...page, items: admitted },
        cursor,
      });
      if (!persisted) {
        terminalCode = "lease_lost";
        break;
      }
      insertedItems += persisted.inserted;
      if (truncated) {
        terminalCode = "item_budget_exhausted";
        break;
      }
    }
  } catch (error) {
    const failure = safeExecutionFailure(error, initial, signal);
    terminalCode = failure.code;
    terminalPersistedError = failure.persisted;
  }

  if (!terminalCode && permissionFailures === targets.length) {
    terminalCode = "permission_required";
    terminalPersistedError =
      permissionPersistedError ?? "permission_required";
  }
  const continuationPending =
    Boolean(terminalCode) ||
    visitedTargets < targets.length ||
    Object.values(cursor.targets).some(
      (checkpoint) => checkpoint.continuation !== null,
    );
  let code = terminalCode ?? "completed";

  if (terminalCode) {
    const persistedError = terminalPersistedError ?? terminalCode;
    writeSourceFailure(
      deps.db,
      initial,
      terminalCode,
      persistedError,
    );
    if (!failDiscoveryJob(deps.db, claim, persistedError)) {
      code = "lease_lost";
    }
  } else if (
    !completeDiscoveryJob(deps.db, claim, {
      fetchedCount: admittedItems,
      newCount: insertedItems,
    })
  ) {
    code = "lease_lost";
  }

  const result: SourceRunResult = {
    sourceId: initial.id,
    name: initial.name,
    fetched: admittedItems,
    new: insertedItems,
    ...(code === "completed"
      ? {}
      : {
          error:
            code === "lease_lost"
              ? code
              : terminalPersistedError ?? code,
        }),
  };
  return resultWithMetrics(result, {
    code,
    calls,
    pages,
    bytes,
    items: admittedItems,
    continuationPending,
    replay: claim.attempt > 1,
  });
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
