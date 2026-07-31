import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import type { Db, DbExecutor } from "../db";
import {
  discoveredItemMatches,
  discoveredItems,
  discoverySources,
  type DiscoveredItemRow,
} from "../db/schema";

export interface DiscoveryDedupeHooks {
  beforeSourceDelete?(): void;
}

function promoteCanonicalBeforeDelete(
  tx: DbExecutor,
  canonical: DiscoveredItemRow,
  survivor: DiscoveredItemRow,
): number {
  tx.delete(discoveredItemMatches)
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, survivor.workspaceId),
        eq(discoveredItemMatches.itemId, survivor.id),
      ),
    )
    .run();
  tx.update(discoveredItemMatches)
    .set({ itemId: survivor.id })
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, canonical.workspaceId),
        eq(discoveredItemMatches.itemId, canonical.id),
      ),
    )
    .run();
  tx.update(discoveredItems)
    .set({
      title: canonical.title,
      url: canonical.url,
      summary: canonical.summary,
      publishedAt: canonical.publishedAt,
      score: canonical.score,
      suggestedPersonaId: canonical.suggestedPersonaId,
      suggestedCampaignId: canonical.suggestedCampaignId,
      scoreReason: canonical.scoreReason,
      status: canonical.status,
      signalId: canonical.signalId,
      scoredAt: canonical.scoredAt,
      matchingState: canonical.matchingState,
      matchingVersion: canonical.matchingVersion,
      matchingInputFingerprint: canonical.matchingInputFingerprint,
      matchingError: canonical.matchingError,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      duplicateOfId: null,
    })
    .where(
      and(
        eq(discoveredItems.workspaceId, survivor.workspaceId),
        eq(discoveredItems.id, survivor.id),
      ),
    )
    .run();
  return tx
    .update(discoveredItems)
    .set({
      duplicateOfId: survivor.id,
      status: "duplicate",
      matchingState: "frozen",
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
    })
    .where(
      and(
        eq(discoveredItems.workspaceId, canonical.workspaceId),
        eq(discoveredItems.duplicateOfId, canonical.id),
        ne(discoveredItems.id, survivor.id),
      ),
    )
    .run().changes;
}

export function deleteDiscoverySourcePreservingDuplicates(
  db: Db,
  workspaceId: string,
  sourceId: string,
  hooks: DiscoveryDedupeHooks = {},
): boolean {
  return db.transaction((tx) => {
    const source = tx
      .select({ id: discoverySources.id })
      .from(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.id, sourceId),
        ),
      )
      .get();
    if (!source) return false;

    const canonicals = tx
      .select()
      .from(discoveredItems)
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.sourceId, sourceId),
          isNull(discoveredItems.duplicateOfId),
        ),
      )
      .all();
    for (const canonical of canonicals) {
      const survivor = tx
        .select()
        .from(discoveredItems)
        .where(
          and(
            eq(discoveredItems.workspaceId, workspaceId),
            eq(discoveredItems.duplicateOfId, canonical.id),
            ne(discoveredItems.sourceId, sourceId),
          ),
        )
        .orderBy(asc(discoveredItems.createdAt), asc(discoveredItems.id))
        .limit(1)
        .get();
      if (survivor) {
        promoteCanonicalBeforeDelete(tx, canonical, survivor);
      }
    }

    hooks.beforeSourceDelete?.();
    return (
      tx
        .delete(discoverySources)
        .where(
          and(
            eq(discoverySources.workspaceId, workspaceId),
            eq(discoverySources.id, sourceId),
          ),
        )
        .run().changes === 1
    );
  });
}

export function repairDanglingDuplicateGroups(
  db: Db,
): { groups: number; promoted: number; repointed: number } {
  return db.transaction((tx) => {
    const rows = tx.select().from(discoveredItems).all();
    const existing = new Set(
      rows.map((row) => JSON.stringify([row.workspaceId, row.id])),
    );
    const dangling = new Map<string, DiscoveredItemRow[]>();
    for (const row of rows) {
      if (!row.duplicateOfId) continue;
      const canonicalKey = JSON.stringify([
        row.workspaceId,
        row.duplicateOfId,
      ]);
      if (existing.has(canonicalKey)) continue;
      const members = dangling.get(canonicalKey) ?? [];
      members.push(row);
      dangling.set(canonicalKey, members);
    }

    let promoted = 0;
    let repointed = 0;
    for (const members of dangling.values()) {
      members.sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
      const survivor = members[0]!;
      const ids = members.map((row) => row.id);
      tx.delete(discoveredItemMatches)
        .where(
          and(
            eq(discoveredItemMatches.workspaceId, survivor.workspaceId),
            inArray(discoveredItemMatches.itemId, ids),
          ),
        )
        .run();
      tx.update(discoveredItems)
        .set({
          score: null,
          suggestedPersonaId: null,
          suggestedCampaignId: null,
          scoreReason: null,
          status: "new",
          signalId: null,
          scoredAt: null,
          matchingState: "pending",
          matchingVersion: sql`${discoveredItems.matchingVersion} + 1`,
          matchingInputFingerprint: null,
          matchingLeaseOwner: null,
          matchingLeaseExpiresAt: null,
          matchingHeartbeatAt: null,
          matchingError: null,
          duplicateOfId: null,
        })
        .where(
          and(
            eq(discoveredItems.workspaceId, survivor.workspaceId),
            eq(discoveredItems.id, survivor.id),
          ),
        )
        .run();
      promoted += 1;

      const remainingIds = ids.slice(1);
      if (remainingIds.length > 0) {
        repointed += tx
          .update(discoveredItems)
          .set({
            status: "duplicate",
            matchingState: "frozen",
            matchingLeaseOwner: null,
            matchingLeaseExpiresAt: null,
            matchingHeartbeatAt: null,
            matchingError: null,
            duplicateOfId: survivor.id,
          })
          .where(
            and(
              eq(discoveredItems.workspaceId, survivor.workspaceId),
              inArray(discoveredItems.id, remainingIds),
            ),
          )
          .run().changes;
      }
    }
    return {
      groups: dangling.size,
      promoted,
      repointed,
    };
  });
}
