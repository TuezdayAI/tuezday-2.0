import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type CreateDiscoverySourceInput,
  type DiscoveredItem,
  type DiscoveredItemStatus,
  type DiscoverySource,
  type DiscoverySourceConfig,
  type DiscoverySourceStatus,
  type DiscoverySourceType,
  type Signal,
  type SignalSource,
  type UpdateDiscoverySourceInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  discoveredItems,
  discoverySources,
  type DiscoveredItemRow,
  type DiscoverySourceRow,
} from "../db/schema";
import { fetchSourceItems, isLiveSourceType, type Fetcher } from "../discovery/adapters";
import type { LlmGateway } from "../llm/gateway";
import { getBrain } from "./brain";
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
    createdAt: row.createdAt,
  };
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
    case "x":
      return `X: ${input.config.query}`;
    case "linkedin":
      return `LinkedIn: ${input.config.query}`;
  }
}

export function createDiscoverySource(
  db: Db,
  workspaceId: string,
  input: CreateDiscoverySourceInput,
): DiscoverySource {
  const row: DiscoverySourceRow = {
    id: randomUUID(),
    workspaceId,
    type: input.type,
    name: input.name ?? defaultSourceName(input),
    configJson: JSON.stringify(input.config),
    enabled: true,
    status: isLiveSourceType(input.type) ? "active" : "needs_api_key",
    lastError: null,
    lastFetchedAt: null,
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
  const updated = {
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    configJson: JSON.stringify(input.config ?? existing.config),
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

function rowToItem(row: DiscoveredItemRow): DiscoveredItem {
  return {
    ...row,
    status: row.status as DiscoveredItemStatus,
  };
}

export function listDiscoveredItems(
  db: Db,
  workspaceId: string,
  status?: DiscoveredItemStatus,
): DiscoveredItem[] {
  const where = status
    ? and(eq(discoveredItems.workspaceId, workspaceId), eq(discoveredItems.status, status))
    : eq(discoveredItems.workspaceId, workspaceId);
  return db
    .select()
    .from(discoveredItems)
    .where(where)
    .orderBy(sql`${discoveredItems.score} DESC NULLS LAST`, desc(discoveredItems.createdAt))
    .all()
    .map(rowToItem);
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
  return row ? rowToItem(row) : undefined;
}

const SIGNAL_SOURCE_BY_TYPE: Record<DiscoverySourceType, SignalSource> = {
  reddit: "reddit",
  google_news: "news",
  rss: "rss",
  x: "x",
  linkedin: "linkedin",
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
  });
  db.update(discoveredItems)
    .set({ status: "accepted", signalId: signal.id })
    .where(eq(discoveredItems.id, item.id))
    .run();
  return { item: { ...item, status: "accepted", signalId: signal.id }, signal };
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
  sources: SourceRunResult[];
  scored: number;
}

const SCORE_BATCH_SIZE = 10;
const DIGEST_CHARS_PER_DOC = 600;

function brainDigest(db: Db, workspaceId: string): string {
  const { docs } = getBrain(db, workspaceId);
  return docs
    .filter((d) => ["soul", "icp", "voice", "now"].includes(d.docType) && d.content.trim())
    .map((d) => `${d.docType.toUpperCase()}: ${d.content.trim().slice(0, DIGEST_CHARS_PER_DOC)}`)
    .join("\n\n");
}

interface ScoreEntry {
  index: number;
  score: number;
  personaId: string | null;
  reason: string;
}

/** Pull the first JSON array out of a model response; tolerate fences/noise. */
function parseJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function scoreUnscoredItems(
  db: Db,
  llm: LlmGateway,
  workspaceId: string,
  workspaceName: string,
): Promise<number> {
  const unscored = db
    .select()
    .from(discoveredItems)
    .where(
      and(
        eq(discoveredItems.workspaceId, workspaceId),
        eq(discoveredItems.status, "new"),
        isNull(discoveredItems.score),
      ),
    )
    .all();
  if (unscored.length === 0) return 0;

  const digest = brainDigest(db, workspaceId);
  const personas = listPersonas(db, workspaceId);
  const personaIds = new Set(personas.map((p) => p.id));
  const personaList =
    personas.map((p) => `- ${p.id}: ${p.name}${p.description ? ` (${p.description})` : ""}`).join("\n") ||
    "(no personas yet)";

  let scoredCount = 0;
  for (let offset = 0; offset < unscored.length; offset += SCORE_BATCH_SIZE) {
    const batch = unscored.slice(offset, offset + SCORE_BATCH_SIZE);
    const itemsBlock = batch
      .map(
        (item, i) =>
          `ITEM ${i}: ${item.title}\n${item.summary ? item.summary.slice(0, 300) : "(no summary)"}`,
      )
      .join("\n\n");

    const prompt = [
      `You are the judgment layer of ${workspaceName}'s GTM brain. Discovered items from the outside world need relevance scoring — the brain judges and routes signals, it does not invent them.`,
      `COMPANY BRAIN DIGEST:\n${digest || "(brain not filled yet)"}`,
      `PERSONAS (id: name):\n${personaList}`,
      `DISCOVERED ITEMS:\n${itemsBlock}`,
      `For each item, judge how relevant it is as a GTM signal for this company (0 = noise, 100 = must act on this), and which persona (by id) should respond, or null if none fits.`,
      `Respond with ONLY a JSON array, one entry per item: [{"index": <item number>, "score": <0-100>, "personaId": <id or null>, "reason": "<one short sentence>"}]`,
    ].join("\n\n");

    try {
      const result = await llm.generate({ prompt });
      const entries = parseJsonArray(result.text);
      if (!entries) continue; // scoring assists, never gates: leave unscored
      for (const raw of entries) {
        const entry = raw as Partial<ScoreEntry>;
        if (typeof entry.index !== "number" || typeof entry.score !== "number") continue;
        const item = batch[entry.index];
        if (!item) continue;
        const personaId =
          typeof entry.personaId === "string" && personaIds.has(entry.personaId)
            ? entry.personaId
            : null;
        db.update(discoveredItems)
          .set({
            score: Math.max(0, Math.min(100, Math.round(entry.score))),
            suggestedPersonaId: personaId,
            scoreReason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : null,
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

export async function runDiscovery(
  db: Db,
  llm: LlmGateway,
  fetcher: Fetcher,
  workspaceId: string,
  workspaceName: string,
): Promise<DiscoveryRunResult> {
  const sources = listDiscoverySources(db, workspaceId).filter(
    (s) => s.enabled && s.status !== "needs_api_key",
  );

  const results: SourceRunResult[] = [];
  for (const source of sources) {
    try {
      const fetched = await fetchSourceItems(source.type, source.config, fetcher);
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
      const now = Date.now();
      for (const item of fresh) {
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
            scoreReason: null,
            status: "new",
            signalId: null,
            createdAt: now,
          })
          .run();
      }
      db.update(discoverySources)
        .set({ status: "active", lastError: null, lastFetchedAt: now })
        .where(eq(discoverySources.id, source.id))
        .run();
      results.push({ sourceId: source.id, name: source.name, fetched: fetched.length, new: fresh.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.update(discoverySources)
        .set({ status: "error", lastError: message.slice(0, 500), lastFetchedAt: Date.now() })
        .where(eq(discoverySources.id, source.id))
        .run();
      results.push({ sourceId: source.id, name: source.name, fetched: 0, new: 0, error: message });
    }
  }

  const scored = await scoreUnscoredItems(db, llm, workspaceId, workspaceName);
  return { sources: results, scored };
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
