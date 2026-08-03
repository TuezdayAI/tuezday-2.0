import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  STORY_ENRICHER_VERSION,
  STORY_MATCHER_VERSION,
  type CanonicalStory,
  type DiscoverySourceType,
  type StoryBackfillResult,
  type StoryDetail,
  type StoryEnrichment,
  type StoryEnrichmentPayload,
  type StoryKeyKind,
  type StoryOccurrence,
  type StoryOccurrenceRelationshipKind,
  type StoryStatus,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  canonicalExternalStories,
  canonicalStoryKeys,
  discoveredItems,
  discoverySourceOccurrences,
  discoverySources,
  storyEnrichments,
  storyOccurrences,
  type CanonicalExternalStoryRow,
  type DiscoverySourceOccurrenceRow,
  type StoryEnrichmentRow,
  type StoryOccurrenceRow,
} from "../db/schema";
import { hashContent, hashUrl, sha256 } from "./discovery-hashing";

/** The slice of `actorOf(request)` merge/split need for attribution. */
export interface StoryActor {
  userId: string | null;
}

// Sprint 60 (design §8.1–8.4): the durable intelligence layer behind
// discovery. Immutable source occurrences resolve — by exact identity keys
// only — into canonical stories with reversible membership and versioned
// enrichment. This runs in shadow: nothing here touches discovered-items
// triage, matching, or signals.

export class StoryNotFoundError extends Error {
  constructor() {
    super("story_not_found");
    this.name = "StoryNotFoundError";
  }
}

export class OccurrenceNotFoundError extends Error {
  constructor() {
    super("occurrence_not_found");
    this.name = "OccurrenceNotFoundError";
  }
}

export class StoryMergeSelfError extends Error {
  constructor() {
    super("merge_self");
    this.name = "StoryMergeSelfError";
  }
}

export class StoryArchivedError extends Error {
  constructor() {
    super("story_archived");
    this.name = "StoryArchivedError";
  }
}

/** Provider snapshots stay bounded: joins/filters never read this column. */
const MAX_RAW_METADATA_CHARS = 4_096;

function boundedMetadataJson(value: unknown): string {
  const json = JSON.stringify(value ?? {}) ?? "{}";
  return json.length > MAX_RAW_METADATA_CHARS ? '{"truncated":true}' : json;
}

function providerKeyHash(sourceType: string, providerExternalId: string): string {
  // Namespaced by provider *type*, not source row, so the same story fetched
  // through two sources of one provider converges.
  return sha256(`${sourceType}|${providerExternalId}`);
}

interface DerivedKey {
  kind: StoryKeyKind;
  hash: string;
}

/** Identity keys in resolution-priority order (design §8.2). */
function deriveKeys(occurrence: {
  sourceType: string;
  providerExternalId: string;
  normalizedUrlKey: string | null;
  contentFingerprint: string;
}): DerivedKey[] {
  const keys: DerivedKey[] = [
    {
      kind: "provider_id",
      hash: providerKeyHash(occurrence.sourceType, occurrence.providerExternalId),
    },
  ];
  if (occurrence.normalizedUrlKey) {
    keys.push({ kind: "normalized_url", hash: occurrence.normalizedUrlKey });
  }
  keys.push({ kind: "content_fingerprint", hash: occurrence.contentFingerprint });
  return keys;
}

const RELATIONSHIP_BY_KEY_KIND: Record<
  StoryKeyKind,
  { kind: StoryOccurrenceRelationshipKind; confidence: number }
> = {
  provider_id: { kind: "provider", confidence: 100 },
  normalized_url: { kind: "exact", confidence: 100 },
  // Exact content-fingerprint equality — the same rule Sprint 45 treats as
  // duplicate identity — recorded as `similarity` so URL/provider identity
  // stays distinguishable. Reversible by split if a publisher reuses copy.
  content_fingerprint: { kind: "similarity", confidence: 90 },
};

export interface OccurrenceIngestInput {
  workspaceId: string;
  source: { id: string; type: string; name: string };
  /** discovery_jobs row of the fetch attempt; null for backfilled rows. */
  fetchRunId: string | null;
  item: {
    externalId: string;
    title: string;
    url: string;
    summary: string;
    publishedAt: number | null;
  };
  observedAt: number;
  rawMetadata?: unknown;
}

export interface OccurrenceIngestResult {
  occurrenceCreated: boolean;
  storyCreated: boolean;
  membershipCreated: boolean;
}

/**
 * Record one immutable occurrence and resolve it into a canonical story by
 * exact identity keys. Idempotent on (sourceId, providerExternalId): a
 * conflict means the occurrence — and everything downstream of it — already
 * exists, so the call is a no-op. Runs inside the caller's transaction.
 */
export function recordOccurrenceAndResolve(
  tx: DbExecutor,
  input: OccurrenceIngestInput,
): OccurrenceIngestResult {
  const now = Date.now();
  const occurrenceId = randomUUID();
  const normalizedUrlKey = hashUrl(input.item.url);
  const contentFingerprint = hashContent(input.item.title, input.item.summary);

  const insertedOccurrence = tx
    .insert(discoverySourceOccurrences)
    .values({
      id: occurrenceId,
      workspaceId: input.workspaceId,
      sourceId: input.source.id,
      sourceType: input.source.type,
      sourceName: input.source.name,
      fetchRunId: input.fetchRunId,
      providerExternalId: input.item.externalId,
      title: input.item.title,
      url: input.item.url,
      excerpt: input.item.summary,
      author: null,
      providerPublishedAt: input.item.publishedAt,
      observedAt: input.observedAt,
      normalizedUrlKey,
      contentFingerprint,
      rawMetadataJson: boundedMetadataJson(input.rawMetadata),
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [
        discoverySourceOccurrences.sourceId,
        discoverySourceOccurrences.providerExternalId,
      ],
    })
    .returning({ id: discoverySourceOccurrences.id })
    .get();
  if (!insertedOccurrence) {
    return { occurrenceCreated: false, storyCreated: false, membershipCreated: false };
  }

  const keys = deriveKeys({
    sourceType: input.source.type,
    providerExternalId: input.item.externalId,
    normalizedUrlKey,
    contentFingerprint,
  });

  let storyId: string | null = null;
  let matchedKind: StoryKeyKind | null = null;
  for (const key of keys) {
    const owner = tx
      .select({ storyId: canonicalStoryKeys.storyId })
      .from(canonicalStoryKeys)
      .where(
        and(
          eq(canonicalStoryKeys.workspaceId, input.workspaceId),
          eq(canonicalStoryKeys.keyKind, key.kind),
          eq(canonicalStoryKeys.keyHash, key.hash),
        ),
      )
      .get();
    if (owner) {
      storyId = owner.storyId;
      matchedKind = key.kind;
      break;
    }
  }

  let storyCreated = false;
  let relationship: { kind: StoryOccurrenceRelationshipKind; confidence: number };
  if (storyId && matchedKind) {
    relationship = RELATIONSHIP_BY_KEY_KIND[matchedKind]!;
    tx.update(canonicalExternalStories)
      .set({
        firstObservedAt: sql`MIN(${canonicalExternalStories.firstObservedAt}, ${input.observedAt})`,
        lastObservedAt: sql`MAX(${canonicalExternalStories.lastObservedAt}, ${input.observedAt})`,
        updatedAt: now,
      })
      .where(eq(canonicalExternalStories.id, storyId))
      .run();
  } else {
    storyId = randomUUID();
    storyCreated = true;
    relationship = { kind: "exact", confidence: 100 };
    tx.insert(canonicalExternalStories)
      .values({
        id: storyId,
        workspaceId: input.workspaceId,
        status: "active",
        canonicalUrl: input.item.url,
        title: input.item.title,
        contentFingerprint,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        currentEnrichmentVersion: 0,
        mergedIntoStoryId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Claim any unowned identity keys for this story. Keys already owned by a
  // *different* story stay put — conflicting exact identities never auto-merge
  // stories (ambiguity stays separate rather than guessed).
  for (const key of keys) {
    tx.insert(canonicalStoryKeys)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        storyId,
        keyKind: key.kind,
        keyHash: key.hash,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [
          canonicalStoryKeys.workspaceId,
          canonicalStoryKeys.keyKind,
          canonicalStoryKeys.keyHash,
        ],
      })
      .run();
  }

  tx.insert(storyOccurrences)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      storyId,
      occurrenceId,
      relationshipKind: relationship.kind,
      confidence: relationship.confidence,
      matcherVersion: STORY_MATCHER_VERSION,
      attachedAt: now,
      attachedByUserId: null,
      attachReason: null,
      detachedAt: null,
      detachedByUserId: null,
      detachReason: null,
    })
    .run();

  refreshEnrichment(tx, input.workspaceId, storyId);
  return { occurrenceCreated: true, storyCreated, membershipCreated: true };
}

interface ActiveMember {
  occurrence: DiscoverySourceOccurrenceRow;
  membership: StoryOccurrenceRow;
}

function activeMembers(tx: DbExecutor, storyId: string): ActiveMember[] {
  return tx
    .select({
      occurrence: discoverySourceOccurrences,
      membership: storyOccurrences,
    })
    .from(storyOccurrences)
    .innerJoin(
      discoverySourceOccurrences,
      eq(storyOccurrences.occurrenceId, discoverySourceOccurrences.id),
    )
    .where(and(eq(storyOccurrences.storyId, storyId), isNull(storyOccurrences.detachedAt)))
    .orderBy(asc(discoverySourceOccurrences.observedAt))
    .all();
}

/**
 * Deterministic enricher v1 (no LLM). The story fingerprint covers the active
 * membership's content, so unchanged membership is a no-op and membership
 * changes append a new immutable row (unique on story × fingerprint ×
 * enricher version, design §8.4).
 */
export function refreshEnrichment(
  tx: DbExecutor,
  workspaceId: string,
  storyId: string,
): void {
  const members = activeMembers(tx, storyId);
  if (members.length === 0) return;

  const fingerprints = members
    .map((m) => m.occurrence.contentFingerprint)
    .sort();
  const storyFingerprint = sha256(fingerprints.join("\n"));
  const corroborationCount = new Set(members.map((m) => m.occurrence.sourceId)).size;
  const titleVariants: string[] = [];
  for (const m of members) {
    if (!titleVariants.includes(m.occurrence.title)) titleVariants.push(m.occurrence.title);
    if (titleVariants.length === 5) break;
  }
  const payload: StoryEnrichmentPayload = {
    occurrenceCount: members.length,
    distinctSourceTypes: [...new Set(members.map((m) => m.occurrence.sourceType))].sort(),
    earliestObservedAt: members[0]?.occurrence.observedAt ?? null,
    latestObservedAt: members[members.length - 1]?.occurrence.observedAt ?? null,
    titleVariants,
  };

  const inserted = tx
    .insert(storyEnrichments)
    .values({
      id: randomUUID(),
      workspaceId,
      storyId,
      storyFingerprint,
      enricherVersion: STORY_ENRICHER_VERSION,
      corroborationCount,
      payloadJson: JSON.stringify(payload),
      createdAt: Date.now(),
    })
    .onConflictDoNothing({
      target: [
        storyEnrichments.storyId,
        storyEnrichments.storyFingerprint,
        storyEnrichments.enricherVersion,
      ],
    })
    .returning({ id: storyEnrichments.id })
    .get();
  if (inserted) {
    tx.update(canonicalExternalStories)
      .set({ currentEnrichmentVersion: STORY_ENRICHER_VERSION, updatedAt: Date.now() })
      .where(eq(canonicalExternalStories.id, storyId))
      .run();
  }
}

function getStoryRow(
  tx: DbExecutor,
  workspaceId: string,
  storyId: string,
): CanonicalExternalStoryRow | undefined {
  return tx
    .select()
    .from(canonicalExternalStories)
    .where(
      and(
        eq(canonicalExternalStories.workspaceId, workspaceId),
        eq(canonicalExternalStories.id, storyId),
      ),
    )
    .get();
}

/**
 * Manual merge: every active membership of `storyId` is detached (with actor
 * and reason) and re-attached to `intoStoryId` as `manual`; identity keys are
 * repointed; the emptied story is archived with a mergedInto pointer. Nothing
 * is deleted — split reverses it.
 */
export function mergeStories(
  db: Db,
  workspaceId: string,
  input: { storyId: string; intoStoryId: string; actor: StoryActor; reason: string },
): StoryDetail {
  if (input.storyId === input.intoStoryId) throw new StoryMergeSelfError();
  return db.transaction((tx) => {
    const from = getStoryRow(tx, workspaceId, input.storyId);
    const into = getStoryRow(tx, workspaceId, input.intoStoryId);
    if (!from || !into) throw new StoryNotFoundError();
    if (into.status === "archived") throw new StoryArchivedError();

    const now = Date.now();
    const members = activeMembers(tx, from.id);
    for (const member of members) {
      tx.update(storyOccurrences)
        .set({
          detachedAt: now,
          detachedByUserId: input.actor.userId,
          detachReason: input.reason,
        })
        .where(eq(storyOccurrences.id, member.membership.id))
        .run();
      tx.insert(storyOccurrences)
        .values({
          id: randomUUID(),
          workspaceId,
          storyId: into.id,
          occurrenceId: member.occurrence.id,
          relationshipKind: "manual",
          confidence: 100,
          matcherVersion: STORY_MATCHER_VERSION,
          attachedAt: now,
          attachedByUserId: input.actor.userId,
          attachReason: input.reason,
          detachedAt: null,
          detachedByUserId: null,
          detachReason: null,
        })
        .run();
    }

    // Repointing keeps (workspace, kind, hash) untouched, so it can't collide.
    tx.update(canonicalStoryKeys)
      .set({ storyId: into.id })
      .where(
        and(
          eq(canonicalStoryKeys.workspaceId, workspaceId),
          eq(canonicalStoryKeys.storyId, from.id),
        ),
      )
      .run();

    tx.update(canonicalExternalStories)
      .set({
        firstObservedAt: sql`MIN(${canonicalExternalStories.firstObservedAt}, ${from.firstObservedAt})`,
        lastObservedAt: sql`MAX(${canonicalExternalStories.lastObservedAt}, ${from.lastObservedAt})`,
        updatedAt: now,
      })
      .where(eq(canonicalExternalStories.id, into.id))
      .run();

    tx.update(canonicalExternalStories)
      .set({
        status: "archived",
        archivedAt: now,
        mergedIntoStoryId: into.id,
        updatedAt: now,
      })
      .where(eq(canonicalExternalStories.id, from.id))
      .run();

    refreshEnrichment(tx, workspaceId, into.id);
    return storyDetailInTx(tx, workspaceId, into.id);
  });
}

/**
 * Manual split: detach one occurrence into a brand-new story. Identity keys
 * derived from the occurrence move with it only when no remaining member of
 * the old story derives the same key — otherwise the key (and future ingest
 * matching it) stays with the original story; the operator is asserting these
 * are different stories despite shared identity.
 */
export function splitOccurrence(
  db: Db,
  workspaceId: string,
  input: { occurrenceId: string; actor: StoryActor; reason: string },
): StoryDetail {
  return db.transaction((tx) => {
    const occurrence = tx
      .select()
      .from(discoverySourceOccurrences)
      .where(
        and(
          eq(discoverySourceOccurrences.workspaceId, workspaceId),
          eq(discoverySourceOccurrences.id, input.occurrenceId),
        ),
      )
      .get();
    if (!occurrence) throw new OccurrenceNotFoundError();
    const membership = tx
      .select()
      .from(storyOccurrences)
      .where(
        and(
          eq(storyOccurrences.occurrenceId, occurrence.id),
          isNull(storyOccurrences.detachedAt),
        ),
      )
      .get();
    if (!membership) throw new OccurrenceNotFoundError();

    const now = Date.now();
    tx.update(storyOccurrences)
      .set({
        detachedAt: now,
        detachedByUserId: input.actor.userId,
        detachReason: input.reason,
      })
      .where(eq(storyOccurrences.id, membership.id))
      .run();

    const newStoryId = randomUUID();
    tx.insert(canonicalExternalStories)
      .values({
        id: newStoryId,
        workspaceId,
        status: "active",
        canonicalUrl: occurrence.url,
        title: occurrence.title,
        contentFingerprint: occurrence.contentFingerprint,
        firstObservedAt: occurrence.observedAt,
        lastObservedAt: occurrence.observedAt,
        currentEnrichmentVersion: 0,
        mergedIntoStoryId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(storyOccurrences)
      .values({
        id: randomUUID(),
        workspaceId,
        storyId: newStoryId,
        occurrenceId: occurrence.id,
        relationshipKind: "manual",
        confidence: 100,
        matcherVersion: STORY_MATCHER_VERSION,
        attachedAt: now,
        attachedByUserId: input.actor.userId,
        attachReason: input.reason,
        detachedAt: null,
        detachedByUserId: null,
        detachReason: null,
      })
      .run();

    const remaining = activeMembers(tx, membership.storyId);
    const remainingKeyHashes = new Set(
      remaining.flatMap((m) => deriveKeys(m.occurrence).map((k) => `${k.kind}:${k.hash}`)),
    );
    for (const key of deriveKeys(occurrence)) {
      if (remainingKeyHashes.has(`${key.kind}:${key.hash}`)) continue;
      const moved = tx
        .update(canonicalStoryKeys)
        .set({ storyId: newStoryId })
        .where(
          and(
            eq(canonicalStoryKeys.workspaceId, workspaceId),
            eq(canonicalStoryKeys.keyKind, key.kind),
            eq(canonicalStoryKeys.keyHash, key.hash),
            eq(canonicalStoryKeys.storyId, membership.storyId),
          ),
        )
        .run();
      if (moved.changes === 0) {
        // Key owned by another story (or missing): claim only if unowned.
        tx.insert(canonicalStoryKeys)
          .values({
            id: randomUUID(),
            workspaceId,
            storyId: newStoryId,
            keyKind: key.kind,
            keyHash: key.hash,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [
              canonicalStoryKeys.workspaceId,
              canonicalStoryKeys.keyKind,
              canonicalStoryKeys.keyHash,
            ],
          })
          .run();
      }
    }

    if (remaining.length === 0) {
      tx.update(canonicalExternalStories)
        .set({ status: "archived", archivedAt: now, updatedAt: now })
        .where(eq(canonicalExternalStories.id, membership.storyId))
        .run();
    } else {
      tx.update(canonicalExternalStories)
        .set({
          firstObservedAt: remaining[0]!.occurrence.observedAt,
          lastObservedAt: remaining[remaining.length - 1]!.occurrence.observedAt,
          updatedAt: now,
        })
        .where(eq(canonicalExternalStories.id, membership.storyId))
        .run();
      refreshEnrichment(tx, workspaceId, membership.storyId);
    }

    refreshEnrichment(tx, workspaceId, newStoryId);
    return storyDetailInTx(tx, workspaceId, newStoryId);
  });
}

export function setStoryStatus(
  db: Db,
  workspaceId: string,
  storyId: string,
  status: StoryStatus,
): CanonicalStory {
  return db.transaction((tx) => {
    const story = getStoryRow(tx, workspaceId, storyId);
    if (!story) throw new StoryNotFoundError();
    const now = Date.now();
    tx.update(canonicalExternalStories)
      .set({
        status,
        archivedAt: status === "archived" ? (story.archivedAt ?? now) : null,
        updatedAt: now,
      })
      .where(eq(canonicalExternalStories.id, storyId))
      .run();
    return projectStory(tx, getStoryRow(tx, workspaceId, storyId)!);
  });
}

/**
 * Backfill existing discovered items into the shadow layer (design §15 step
 * 3). Idempotent by the occurrence unique key; ordered oldest-first so
 * founding stories match the "oldest is canonical" convention. Duplicate
 * groups converge via shared identity keys — `duplicateOfId` is never read,
 * so dangling groups (P1.9) backfill cleanly too.
 */
export function backfillCanonicalStories(
  db: Db,
  workspaceId: string,
): StoryBackfillResult {
  return db.transaction((tx) => {
    const rows = tx
      .select({ item: discoveredItems, source: discoverySources })
      .from(discoveredItems)
      .innerJoin(discoverySources, eq(discoveredItems.sourceId, discoverySources.id))
      .where(eq(discoveredItems.workspaceId, workspaceId))
      .orderBy(asc(discoveredItems.createdAt))
      .all();
    const result: StoryBackfillResult = {
      scanned: rows.length,
      occurrencesCreated: 0,
      storiesCreated: 0,
      membershipsCreated: 0,
    };
    for (const { item, source } of rows) {
      const outcome = recordOccurrenceAndResolve(tx, {
        workspaceId,
        source: { id: source.id, type: source.type, name: source.name },
        fetchRunId: null,
        item: {
          externalId: item.externalId,
          title: item.title,
          url: item.url,
          summary: item.summary,
          publishedAt: item.publishedAt,
        },
        observedAt: item.createdAt,
      });
      if (outcome.occurrenceCreated) result.occurrencesCreated += 1;
      if (outcome.storyCreated) result.storiesCreated += 1;
      if (outcome.membershipCreated) result.membershipsCreated += 1;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

function projectStory(
  tx: DbExecutor,
  row: CanonicalExternalStoryRow,
): CanonicalStory {
  const counts = tx
    .select({
      occurrenceCount: sql<number>`COUNT(*)`,
      corroborationCount: sql<number>`COUNT(DISTINCT ${discoverySourceOccurrences.sourceId})`,
    })
    .from(storyOccurrences)
    .innerJoin(
      discoverySourceOccurrences,
      eq(storyOccurrences.occurrenceId, discoverySourceOccurrences.id),
    )
    .where(and(eq(storyOccurrences.storyId, row.id), isNull(storyOccurrences.detachedAt)))
    .get();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as CanonicalStory["status"],
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    currentEnrichmentVersion: row.currentEnrichmentVersion,
    mergedIntoStoryId: row.mergedIntoStoryId,
    occurrenceCount: counts?.occurrenceCount ?? 0,
    corroborationCount: counts?.corroborationCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listStories(
  db: Db,
  workspaceId: string,
  options: { status?: StoryStatus; limit?: number; offset?: number } = {},
): { stories: CanonicalStory[]; total: number } {
  const limit = Math.min(Math.max(options.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const where = and(
    eq(canonicalExternalStories.workspaceId, workspaceId),
    options.status ? eq(canonicalExternalStories.status, options.status) : undefined,
  );
  const rows = db
    .select()
    .from(canonicalExternalStories)
    .where(where)
    .orderBy(desc(canonicalExternalStories.lastObservedAt))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(canonicalExternalStories)
      .where(where)
      .get()?.n ?? 0;
  return { stories: rows.map((row) => projectStory(db, row)), total };
}

function projectOccurrence(
  occurrence: DiscoverySourceOccurrenceRow,
  membership: StoryOccurrenceRow,
): StoryOccurrence {
  return {
    id: occurrence.id,
    sourceId: occurrence.sourceId,
    sourceType: occurrence.sourceType as DiscoverySourceType,
    sourceName: occurrence.sourceName,
    fetchRunId: occurrence.fetchRunId,
    providerExternalId: occurrence.providerExternalId,
    title: occurrence.title,
    url: occurrence.url,
    excerpt: occurrence.excerpt,
    author: occurrence.author,
    providerPublishedAt: occurrence.providerPublishedAt,
    observedAt: occurrence.observedAt,
    relationship: {
      kind: membership.relationshipKind as StoryOccurrenceRelationshipKind,
      confidence: membership.confidence,
      matcherVersion: membership.matcherVersion,
      attachedAt: membership.attachedAt,
      attachedByUserId: membership.attachedByUserId,
      attachReason: membership.attachReason,
      detachedAt: membership.detachedAt,
      detachedByUserId: membership.detachedByUserId,
      detachReason: membership.detachReason,
    },
  };
}

function projectEnrichment(row: StoryEnrichmentRow): StoryEnrichment {
  let payload: StoryEnrichmentPayload;
  try {
    payload = JSON.parse(row.payloadJson) as StoryEnrichmentPayload;
  } catch {
    payload = {
      occurrenceCount: 0,
      distinctSourceTypes: [],
      earliestObservedAt: null,
      latestObservedAt: null,
      titleVariants: [],
    };
  }
  return {
    id: row.id,
    storyId: row.storyId,
    storyFingerprint: row.storyFingerprint,
    enricherVersion: row.enricherVersion,
    corroborationCount: row.corroborationCount,
    payload,
  createdAt: row.createdAt,
  };
}

function storyDetailInTx(
  tx: DbExecutor,
  workspaceId: string,
  storyId: string,
): StoryDetail {
  const row = getStoryRow(tx, workspaceId, storyId);
  if (!row) throw new StoryNotFoundError();
  const memberships = tx
    .select({
      occurrence: discoverySourceOccurrences,
      membership: storyOccurrences,
    })
    .from(storyOccurrences)
    .innerJoin(
      discoverySourceOccurrences,
      eq(storyOccurrences.occurrenceId, discoverySourceOccurrences.id),
    )
    .where(eq(storyOccurrences.storyId, storyId))
    .orderBy(asc(discoverySourceOccurrences.observedAt))
    .all();
  const enrichmentRow = tx
    .select()
    .from(storyEnrichments)
    .where(eq(storyEnrichments.storyId, storyId))
    .orderBy(desc(storyEnrichments.createdAt))
    .limit(1)
    .get();
  return {
    story: projectStory(tx, row),
    occurrences: memberships
      .filter((m) => m.membership.detachedAt === null)
      .map((m) => projectOccurrence(m.occurrence, m.membership)),
    history: memberships
      .filter((m) => m.membership.detachedAt !== null)
      .sort((a, b) => (b.membership.detachedAt ?? 0) - (a.membership.detachedAt ?? 0))
      .map((m) => projectOccurrence(m.occurrence, m.membership)),
    enrichment: enrichmentRow ? projectEnrichment(enrichmentRow) : null,
  };
}

export function getStoryDetail(
  db: Db,
  workspaceId: string,
  storyId: string,
): StoryDetail {
  return storyDetailInTx(db, workspaceId, storyId);
}
