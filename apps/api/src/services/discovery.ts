import { randomUUID } from "node:crypto";
import { hashContent, hashUrl } from "./discovery-hashing";
import { recordOccurrenceAndResolve } from "./canonical-stories";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  createDiscoverySourceInputSchema,
  isReservedDiscoverySourceType,
  sourceProposalsResponseSchema,
  type CreateDiscoverySourceInput,
  type DiscoveredItem,
  type DiscoveredItemMatch,
  type DiscoveredItemStatus,
  type DiscoveryMatchingState,
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
import { type Db, type DbExecutor, rowsAffected } from "../db";
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
  CursorInvalidError,
  PermissionRequiredError,
  RateLimitedError,
  fetchConnectedSourcePage,
  getConnectedDiscoveryErrorMetrics,
  type ResolvedTrackedAccount,
} from "../discovery/connected-adapters";
import type { IntentProvider } from "../discovery/intent";
import {
  checkpointPage,
  cursorMode,
  readCursor,
  reconcileTargets,
  safeCursorProgress,
  targetsForSource,
  type DiscoveryCursorV1,
  type DiscoveryPage,
  type DiscoveryPageReader,
} from "../discovery/paging";
import { ProviderCapabilityError } from "../discovery/provider-errors";
import { deleteDiscoverySourcePreservingDuplicates } from "./discovery-dedupe";
import { resolveTrackedAccountsForSource } from "./tracked-account-resolver";
import type { LlmGateway } from "../llm/gateway";
import { meteredLlm } from "../llm/metered";
import { generateStructured } from "../llm/structured";
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
  insertSignalMatch,
  listItemMatches,
  listItemMatchesForItems,
  listSignalMatches,
  projectSuggestedRouting,
  revalidateSignalMatches,
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

export async function getDiscoverySourceExecution(
  db: DbExecutor,
  workspaceId: string,
  sourceId: string,
): Promise<DiscoverySourceExecution | undefined> {
  const row = (await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.workspaceId, workspaceId),
        eq(discoverySources.id, sourceId),
      ),
    ))[0];
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

export class DiscoverySourceReservedError extends Error {
  readonly code = "source_reserved";

  constructor(type: DiscoverySourceType) {
    super(`${type} is reserved and has no production provider.`);
    this.name = "DiscoverySourceReservedError";
  }
}

async function validateSourceConnection(
  db: Db,
  workspaceId: string,
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
  connectionId: string | null,
): Promise<void> {
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
  const connection = await getConnection(db, workspaceId, connectionId);
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

async function requireSourceTrackedAccounts(
  db: DbExecutor,
  workspaceId: string,
  type: DiscoverySourceType,
  config: DiscoverySourceConfig,
): Promise<TrackedSocialAccount[]> {
  const accounts = await requireTrackedAccounts(
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

export async function createDiscoverySource(
  db: Db,
  workspaceId: string,
  input: CreateDiscoverySourceInput,
): Promise<DiscoverySource> {
  if (isReservedDiscoverySourceType(input.type)) {
    throw new DiscoverySourceReservedError(input.type);
  }
  const connectionId = input.connectionId ?? null;
  await validateSourceConnection(db, workspaceId, input.type, input.config, connectionId);
  await requireSourceTrackedAccounts(db, workspaceId, input.type, input.config);
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
  await db.insert(discoverySources).values(row);
  return rowToSource(row);
}

export async function listDiscoverySources(db: Db, workspaceId: string): Promise<DiscoverySource[]> {
  return (await db
    .select()
    .from(discoverySources)
    .where(eq(discoverySources.workspaceId, workspaceId))
    .orderBy(desc(discoverySources.createdAt)))
    .map(rowToSource);
}

export async function getDiscoverySource(
  db: DbExecutor,
  workspaceId: string,
  sourceId: string,
): Promise<DiscoverySource | undefined> {
  const row = (await db
    .select()
    .from(discoverySources)
    .where(and(eq(discoverySources.workspaceId, workspaceId), eq(discoverySources.id, sourceId))))[0];
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
  if (isReservedDiscoverySourceType(type)) {
    return {
      status: "reserved",
      lastError: "source_reserved",
      backoffUntil: null,
    };
  }
  return {
    status: connectionId || isLiveSourceType(type) ? "active" : "needs_api_key",
    lastError: null,
    backoffUntil: null,
  };
}

export async function updateDiscoverySource(
  db: Db,
  workspaceId: string,
  sourceId: string,
  input: UpdateDiscoverySourceInput,
): Promise<DiscoverySource | undefined> {
  const existing = await getDiscoverySource(db, workspaceId, sourceId);
  if (!existing) return undefined;
  if (
    isReservedDiscoverySourceType(existing.type) &&
    input.enabled === true
  ) {
    throw new DiscoverySourceReservedError(existing.type);
  }
  const transition = validateDiscoverySourceTransition(existing, input);
  const nextConnectionId = transition.connectionId ?? null;
  await validateSourceConnection(
    db,
    workspaceId,
    transition.type,
    transition.config,
    nextConnectionId,
  );
  await requireSourceTrackedAccounts(
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
  return await db.transaction(async (tx) => {
    await tx.update(discoverySources)
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
      );
    if (executionChanged) {
      await tx.update(discoveryJobs)
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
        );
    }
    return await getDiscoverySource(tx, workspaceId, sourceId);
  });
}

export async function deleteDiscoverySource(db: Db, workspaceId: string, sourceId: string): Promise<boolean> {
  return await deleteDiscoverySourcePreservingDuplicates(
    db,
    workspaceId,
    sourceId,
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function rowToItem(
  row: DiscoveredItemRow,
  matches: DiscoveredItemMatch[],
  duplicateCount: number,
): DiscoveredItem {
  const {
    matchingVersion: _matchingVersion,
    matchingInputFingerprint: _matchingInputFingerprint,
    matchingLeaseOwner: _matchingLeaseOwner,
    matchingLeaseExpiresAt: _matchingLeaseExpiresAt,
    matchingHeartbeatAt: _matchingHeartbeatAt,
    ...publicRow
  } = row;
  return {
    ...publicRow,
    status: row.status as DiscoveredItemStatus,
    matchingState: row.matchingState as DiscoveryMatchingState,
    matches,
    // Sprint 53: routing is projected from the top match, not read off the row.
    ...projectSuggestedRouting(matches),
    duplicateCount,
  };
}

/** duplicateOfId -> linked-duplicate count, one grouped query per list call. */
async function countDuplicatesByCanonical(db: Db, workspaceId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ duplicateOfId: discoveredItems.duplicateOfId, count: sql<number>`COUNT(*)` })
    .from(discoveredItems)
    .where(
      and(eq(discoveredItems.workspaceId, workspaceId), isNotNull(discoveredItems.duplicateOfId)),
    )
    .groupBy(discoveredItems.duplicateOfId);
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.duplicateOfId) map.set(row.duplicateOfId, row.count);
  }
  return map;
}

export async function listDiscoveredItems(
  db: Db,
  workspaceId: string,
  status?: DiscoveredItemStatus,
): Promise<DiscoveredItem[]> {
  const where = status
    ? and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.status, status))
    : eq(discoveredItems.workspaceId, workspaceId);
  const rows = await db
    .select()
    .from(discoveredItems)
    .where(where)
    .orderBy(sql`${discoveredItems.score} DESC NULLS LAST`, desc(discoveredItems.createdAt));
  const matchesByItem = await listItemMatchesForItems(
    db,
    workspaceId,
    rows.map((r) => r.id),
  );
  const duplicateCounts = await countDuplicatesByCanonical(db, workspaceId);
  return rows.map((row) =>
    rowToItem(row, matchesByItem.get(row.id) ?? [], duplicateCounts.get(row.id) ?? 0),
  );
}

export async function getDiscoveredItem(
  db: DbExecutor,
  workspaceId: string,
  itemId: string,
): Promise<DiscoveredItem | undefined> {
  const row = (await db
    .select()
    .from(discoveredItems)
    .where(and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.id, itemId))))[0];
  if (!row) return undefined;
  const duplicateCount =
    ((await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(discoveredItems)
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.duplicateOfId, itemId),
        ),
      ))[0])?.count ?? 0;
  return rowToItem(
    row,
    await listItemMatches(db, workspaceId, itemId),
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
export async function listItemDuplicates(db: Db, workspaceId: string, itemId: string): Promise<DuplicateItemRef[]> {
  return await db
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
    .orderBy(asc(discoveredItems.createdAt));
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

export class MatchingNotReadyError extends Error {
  constructor() {
    super("matching_not_ready");
    this.name = "MatchingNotReadyError";
  }
}

export interface DiscoveryAcceptanceHooks {
  afterSignalInsert?(): void;
  afterMatchInsert?(index: number): void;
  afterItemUpdate?(): void;
}

async function requireCurrentMatchReferences(
  db: DbExecutor,
  workspaceId: string,
  matches: Array<{
    personaId: string | null;
    campaignId: string | null;
    score: number;
    reason: string;
  }>,
): Promise<void> {
  const current = await revalidateSignalMatches(db, workspaceId, matches);
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

export async function acceptDiscoveredItem(
  db: Db,
  workspaceId: string,
  itemId: string,
  hooks?: DiscoveryAcceptanceHooks,
): Promise<{ item: DiscoveredItem; signal: Signal }> {
  return await db.transaction(async (tx) => {
    const item = await getDiscoveredItem(tx, workspaceId, itemId);
    if (!item) throw new DiscoveryReferenceNotFoundError();
    if (item.status !== "new") throw new ItemNotTriagableError(item.status);
    if (item.matchingState !== "ready") {
      throw new MatchingNotReadyError();
    }
    const source = await getDiscoverySource(tx, workspaceId, item.sourceId);
    if (!source) throw new DiscoveryReferenceNotFoundError();
    const foreignItemMatch = (await tx
      .select({ id: discoveredItemMatches.id })
      .from(discoveredItemMatches)
      .where(
        and(
          eq(discoveredItemMatches.itemId, item.id),
          ne(discoveredItemMatches.workspaceId, workspaceId),
        ),
      ))[0];
    if (foreignItemMatch) throw new DiscoveryReferenceNotFoundError();
    const itemMatches = await tx
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
      );
    // Sprint 53: the item's routing *is* its match rows. `item.suggested*` is a
    // projection of `itemMatches` (join-filtered to live personas/campaigns), so
    // there is nothing left to synthesize — validating the raw rows validates
    // the projection too, and any dangling row still blocks acceptance.
    await requireCurrentMatchReferences(tx, workspaceId, itemMatches);

    const signalInput = {
      content: item.summary ? `${item.title}\n\n${item.summary}` : item.title,
      source: SIGNAL_SOURCE_BY_TYPE[source.type],
      sourceUrl: item.url || undefined,
    };
    const signalRow = await insertSignalRow(tx, workspaceId, signalInput);
    hooks?.afterSignalInsert?.();
    // Sequential inside the transaction — see the same pattern in signals.ts.
    for (const [index, match] of itemMatches.entries()) {
      await insertSignalMatch(tx, workspaceId, signalRow.id, match);
      hooks?.afterMatchInsert?.(index);
    }
    await tx.update(discoveredItems)
      .set({
        status: "accepted",
        signalId: signalRow.id,
        matchingState: "frozen",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
      })
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.id, item.id),
          eq(discoveredItems.status, "new"),
          eq(discoveredItems.matchingState, "ready"),
        ),
      );
    hooks?.afterItemUpdate?.();
    const signal = await readSignal(tx, workspaceId, signalRow.id);
    if (!signal) throw new Error("Accepted discovery signal could not be read.");
    return {
      item: {
        ...item,
        matches: signal.matches,
        ...projectSuggestedRouting(signal.matches),
        status: "accepted",
        signalId: signal.id,
        matchingState: "frozen",
      },
      signal,
    };
  });
}

export async function skipDiscoveredItem(
  db: Db,
  workspaceId: string,
  item: DiscoveredItem,
): Promise<DiscoveredItem> {
  return await db.transaction(async (tx) => {
    const current = await getDiscoveredItem(tx, workspaceId, item.id);
    if (!current) throw new DiscoveryReferenceNotFoundError();
    if (current.status !== "new") {
      throw new ItemNotTriagableError(current.status);
    }
    await tx.update(discoveredItems)
      .set({
        status: "skipped",
        matchingState: "frozen",
        matchingLeaseOwner: null,
        matchingLeaseExpiresAt: null,
        matchingHeartbeatAt: null,
      })
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.id, item.id),
          eq(discoveredItems.status, "new"),
        ),
      );
    return {
      ...current,
      status: "skipped",
      matchingState: "frozen",
    };
  });
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

// ---------------------------------------------------------------------------
// Cross-source dedup hashing (Sprint 45)
// ---------------------------------------------------------------------------

// Sprint 60: the normalizers live in discovery-hashing.ts so the canonical
// story layer shares them; re-exported here for existing consumers.
export { hashContent, hashUrl } from "./discovery-hashing";

/**
 * The oldest canonical (non-duplicate) workspace item sharing this URL or
 * content hash — the row a fresh cross-source copy should link to.
 */
async function findCanonicalItem(
  db: DbExecutor,
  workspaceId: string,
  urlHash: string | null,
  contentHash: string,
  excludeId?: string,
): Promise<{ id: string } | undefined> {
  const hashMatches = [eq(discoveredItems.contentHash, contentHash)];
  if (urlHash) hashMatches.push(eq(discoveredItems.urlHash, urlHash));
  return (await db
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
    .limit(1))[0];
}

// Rate-limit back-pressure (Sprint 46): consecutive rate_limited failures
// double the source's backoff, so a throttling provider is probed less and
// less often instead of on every run.
export const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;

async function rateLimitBackoffMs(db: Db, sourceId: string): Promise<number> {
  const recent = await db
    .select({ status: discoveryJobs.status, error: discoveryJobs.error })
    .from(discoveryJobs)
    .where(and(eq(discoveryJobs.sourceId, sourceId), inArray(discoveryJobs.status, ["succeeded", "failed"])))
    .orderBy(desc(discoveryJobs.createdAt))
    .limit(10);
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
    const connection = await getConnection(
      input.db,
      input.source.workspaceId,
      input.source.connectionId,
    );
    if (!connection || connection.status !== "connected") {
      throw new Error("connection_disconnected");
    }
    return await fetchConnectedSourcePage({
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
  return await fetchSourcePage({
    source: input.source,
    target: input.target,
    checkpoint: input.checkpoint,
    signal: input.signal,
    maxItems: input.maxItems,
    maxResponseBytes: input.maxResponseBytes,
    safeFetch: input.safeFetch,
  });
}

async function sourceClaimIsLive(
  db: DbExecutor,
  claim: DiscoveryJobClaim,
): Promise<boolean> {
  return Boolean(
    (await db
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
      ))[0],
  );
}

export interface DiscoveryCheckpointHooks {
  afterOccurrenceInsert?(index: number): void;
  /** Sprint 60: after the shadow canonical-story resolution for one item. */
  afterStoryResolution?(index: number): void;
  afterCanonicalization?(): void;
  beforeCursorUpdate?(): void;
}

class DiscoveryCheckpointFenceError extends Error {
  constructor() {
    super("discovery_checkpoint_fence_changed");
    this.name = "DiscoveryCheckpointFenceError";
  }
}

export async function persistDiscoveryPage(
  db: Db,
  input: {
    claim: DiscoveryJobClaim;
    source: DiscoverySourceExecution;
    page: DiscoveryPage;
    cursor: DiscoveryCursorV1;
    hooks?: DiscoveryCheckpointHooks;
  },
): Promise<{ inserted: number; fetched: number } | null> {
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
    return await db.transaction(async (tx) => {
      const { claim, source, page, cursor, hooks } = input;
      if (!await sourceClaimIsLive(tx, claim)) {
        throw new DiscoveryCheckpointFenceError();
      }
      const currentSourceRow = (await tx
        .select()
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
        ))[0];
      if (!currentSourceRow) throw new DiscoveryCheckpointFenceError();
      const currentSource = rowToSourceExecution(currentSourceRow);
      let currentTargets: ReturnType<typeof targetsForSource>;
      try {
        const currentTrackedAccounts = (await requireSourceTrackedAccounts(
          tx,
          claim.workspaceId,
          currentSource.type,
          currentSource.config,
        )).map((account) => ({
          id: account.id,
          handle: account.handle,
          externalId: account.externalId,
          enabled: account.enabled,
          updatedAt: account.updatedAt,
        }));
        currentTargets = targetsForSource(
          currentSource,
          currentTrackedAccounts,
        );
      } catch {
        throw new DiscoveryCheckpointFenceError();
      }
      const currentTarget = currentTargets.find(
        (target) => target.key === page.targetKey,
      );
      const checkpoint = cursor.targets[page.targetKey];
      if (
        !currentTarget ||
        !checkpoint ||
        currentTarget.fingerprint !== checkpoint.targetFingerprint
      ) {
        throw new DiscoveryCheckpointFenceError();
      }

      let inserted = 0;
      const checkpointAt = Date.now();
      for (const [index, item] of page.items.entries()) {
        const id = randomUUID();
        const urlHash = hashUrl(item.url);
        const contentHash = hashContent(item.title, item.summary);
        const insertedRow = (await tx
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
          .returning({ id: discoveredItems.id }))[0];
        hooks?.afterOccurrenceInsert?.(index);

        // Sprint 60 shadow layer: record the immutable occurrence and resolve
        // it into a canonical story in the same transaction. Runs for every
        // item — including re-fetches and Sprint 45 duplicates — because
        // repeated observation is corroboration, not noise; the occurrence
        // unique key makes true re-deliveries a no-op.
        await recordOccurrenceAndResolve(tx, {
          workspaceId: claim.workspaceId,
          source: {
            id: source.id,
            type: currentSourceRow.type,
            name: currentSourceRow.name,
          },
          fetchRunId: claim.id,
          item: {
            externalId: item.externalId,
            title: item.title,
            url: item.url,
            summary: item.summary,
            publishedAt: item.publishedAt,
          },
          observedAt: checkpointAt,
        });
        hooks?.afterStoryResolution?.(index);

        if (!insertedRow) continue;

        const canonical = await findCanonicalItem(
          tx,
          claim.workspaceId,
          urlHash,
          contentHash,
          id,
        );
        if (canonical) {
          await tx.update(discoveredItems)
            .set({
              status: "duplicate",
              duplicateOfId: canonical.id,
              matchingState: "frozen",
              matchingLeaseOwner: null,
              matchingLeaseExpiresAt: null,
              matchingHeartbeatAt: null,
            })
            .where(eq(discoveredItems.id, id));
        }
        inserted += 1;
      }
      hooks?.afterCanonicalization?.();
      hooks?.beforeCursorUpdate?.();

      const sourceUpdated = await tx
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
        );
      if (rowsAffected(sourceUpdated) !== 1) {
        throw new DiscoveryCheckpointFenceError();
      }

      const jobUpdated = await tx
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
        );
      if (rowsAffected(jobUpdated) !== 1) {
        throw new DiscoveryCheckpointFenceError();
      }
      return { inserted, fetched: page.items.length };
    });
  } catch (error) {
    if (error instanceof DiscoveryCheckpointFenceError) return null;
    throw error;
  }
}

async function persistPermissionCheckpoint(
  db: Db,
  claim: DiscoveryJobClaim,
  source: DiscoverySourceExecution,
  cursor: DiscoveryCursorV1,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!await sourceClaimIsLive(tx, claim)) return false;
    return (
      rowsAffected((await tx
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
        ))) === 1
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
  if (error instanceof ProviderCapabilityError) {
    return {
      code: error.code,
      persisted: `${error.code}: ${error.message}`.slice(0, 500),
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

async function writeSourceFailure(
  db: Db,
  source: DiscoverySourceExecution,
  code: string,
  persistedError = code,
): Promise<void> {
  if (code === "lease_lost" || code === "shutdown") return;
  const failedAt = Date.now();
  if (code === "rate_limited") {
    await db.update(discoverySources)
      .set({
        backoffUntil: failedAt + await rateLimitBackoffMs(db, source.id),
        lastAttemptedAt: failedAt,
      })
      .where(
        and(
          eq(discoverySources.workspaceId, source.workspaceId),
          eq(discoverySources.id, source.id),
          eq(discoverySources.executionVersion, source.executionVersion),
        ),
      );
    return;
  }
  const isBudget =
    SAFE_EXECUTION_CODES.has(code) && code !== "source_timeout";
  await db.update(discoverySources)
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
    );
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
  const initial = await getDiscoverySourceExecution(
    deps.db,
    claim.workspaceId,
    claim.sourceId,
  );
  if (!initial) {
    await failDiscoveryJob(deps.db, claim, "source_missing");
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
    await failDiscoveryJob(deps.db, claim, "source_version_changed");
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

  let calls = 0;
  let pages = 0;
  let bytes = 0;
  let admittedItems = 0;
  let insertedItems = 0;
  let permissionFailures = 0;
  let trackedAccounts: ResolvedTrackedAccount[];
  try {
    let referencedAccounts = await requireSourceTrackedAccounts(
      deps.db,
      claim.workspaceId,
      initial.type,
      initial.config,
    );
    if (initial.connectionId) {
      const resolutionMetrics = { calls: 0, bytes: 0 };
      try {
        referencedAccounts = await resolveTrackedAccountsForSource(
          { db: deps.db, fabric: deps.fabric },
          {
            source: initial,
            accounts: referencedAccounts,
            connectionId: initial.connectionId,
            runtime: {
              signal,
              maxCalls: budget.maxCalls,
              maxBytes: budget.maxBytes,
              maxResponseBytes: budget.maxResponseBytes,
              metrics: resolutionMetrics,
            },
          },
        );
      } finally {
        calls += resolutionMetrics.calls;
        bytes += resolutionMetrics.bytes;
      }
    }
    trackedAccounts = referencedAccounts.map((account) => ({
      id: account.id,
      handle: account.handle,
      externalId: account.externalId,
      enabled: account.enabled,
      updatedAt: account.updatedAt,
    }));
  } catch (error) {
    const failure = safeExecutionFailure(error, initial, signal);
    await writeSourceFailure(
      deps.db,
      initial,
      failure.code,
      failure.persisted,
    );
    await failDiscoveryJob(deps.db, claim, failure.persisted);
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
        calls,
        pages: 0,
        bytes,
        items: 0,
        continuationPending: false,
        replay: claim.attempt > 1,
      },
    );
  }

  const targets = targetsForSource(initial, trackedAccounts);
  let cursor = reconcileTargets(initial.cursorState, targets);
  const pageReader = deps.pageReader ?? defaultDiscoveryPageReader;
  const visitedTargets = new Set<string>();
  const completedTargets = new Set<string>();
  const replayedTargets = new Set<string>();
  let terminalCode: string | undefined;
  let terminalPersistedError: string | undefined;
  let permissionPersistedError: string | undefined;

  try {
    while (completedTargets.size < targets.length) {
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

      let targetIndex = -1;
      for (let offset = 0; offset < targets.length; offset += 1) {
        const candidate =
          (cursor.nextTargetIndex + offset) % targets.length;
        if (!completedTargets.has(targets[candidate]!.key)) {
          targetIndex = candidate;
          break;
        }
      }
      if (targetIndex < 0) break;
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
        if (error instanceof CursorInvalidError) {
          if (
            checkpoint.continuation === null ||
            replayedTargets.has(target.key)
          ) {
            throw error;
          }
          replayedTargets.add(target.key);
          checkpoint.continuation = null;
          checkpoint.lastSafeError = "cursor_replay";
          cursor.nextTargetIndex = targetIndex;
          if (
            !await persistPermissionCheckpoint(
              deps.db,
              claim,
              initial,
              cursor,
            )
          ) {
            terminalCode = "lease_lost";
            break;
          }
          continue;
        }
        if (error instanceof PermissionRequiredError) {
          permissionFailures += 1;
          permissionPersistedError =
            `permission_required: ${error.message}`.slice(0, 500);
          checkpoint.lastSafeError = "permission_required";
          checkpoint.continuation = null;
          cursor.nextTargetIndex = (targetIndex + 1) % targets.length;
          if (!await persistPermissionCheckpoint(deps.db, claim, initial, cursor)) {
            terminalCode = "lease_lost";
            break;
          }
          visitedTargets.add(target.key);
          completedTargets.add(target.key);
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
      visitedTargets.add(target.key);

      const remainingItems = budget.maxItems - admittedItems;
      const admitted = page.items.slice(0, remainingItems);
      const truncated = admitted.length < page.items.length;
      admittedItems += admitted.length;
      const admittedPage = {
        ...page,
        items: admitted,
        exhausted: page.exhausted && !truncated,
      };
      cursor = checkpointPage({
        cursor,
        target,
        page: admittedPage,
        nextTargetIndex: (targetIndex + 1) % targets.length,
      });

      const persisted = await persistDiscoveryPage(deps.db, {
        claim,
        source: initial,
        page: admittedPage,
        cursor,
      });
      if (!persisted) {
        terminalCode = "lease_lost";
        break;
      }
      insertedItems += persisted.inserted;
      if (admittedPage.reachedBoundary || admittedPage.exhausted) {
        completedTargets.add(target.key);
      }
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
    visitedTargets.size < targets.length ||
    Object.values(cursor.targets).some(
      (checkpoint) => checkpoint.continuation !== null,
    );
  let code = terminalCode ?? "completed";

  if (terminalCode) {
    const persistedError = terminalPersistedError ?? terminalCode;
    await writeSourceFailure(
      deps.db,
      initial,
      terminalCode,
      persistedError,
    );
    if (!await failDiscoveryJob(deps.db, claim, persistedError)) {
      code = "lease_lost";
    }
  } else if (
    !await completeDiscoveryJob(deps.db, claim, {
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
  const digest = await brainDigest(db, workspaceId);
  const personas = await listPersonas(db, workspaceId);
  const personaList = personas.map((p) => `- ${p.name}: ${p.description}`).join("\n") || "(none)";

  const prompt = [
    `You help ${workspaceName} propose discovery sources — places in the outside world where GTM signals for this company appear. Propose concrete, specific sources, not generic ones.`,
    `COMPANY BRAIN DIGEST:\n${digest || "(brain not filled yet)"}`,
    `PERSONAS:\n${personaList}`,
    `Propose 3 to 6 sources. Allowed types: "google_news" (config: {"query": "..."}), "reddit" (config: {"subreddit": "..."} and/or {"query": "..."}), "rss" (config: {"feedUrl": "..."} — only if you are confident the feed URL is real).`,
    `Respond with ONLY a JSON array: [{"type": "...", "name": "<short label>", "config": {...}, "reason": "<why this serves the company/personas>"}]`,
  ].join("\n\n");

  const metered = meteredLlm(llm, db, { workspaceId, pipeline: "source_suggestions" });
  const result = await generateStructured(metered, sourceProposalsResponseSchema, {
    prompt,
    tier: "cheap",
  });
  return result.value.slice(0, 6).map((entry) => ({
    type: entry.type,
    name: entry.name.slice(0, 200),
    config: {
      feedUrl: entry.config.feedUrl,
      query: entry.config.query,
      subreddit: entry.config.subreddit?.replace(/^r\//, ""),
    },
    reason: entry.reason?.slice(0, 500) ?? "",
  }));
}
