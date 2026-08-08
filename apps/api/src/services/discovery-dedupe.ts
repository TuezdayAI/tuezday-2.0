import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { type Db, type DbExecutor, rowsAffected } from "../db";
import {
  discoveredItemMatches,
  discoveredItems,
  discoverySources,
  type DiscoveredItemRow,
} from "../db/schema";

export interface DiscoveryDedupeHooks {
  beforeSourceDelete?(): void;
}

async function promoteCanonicalBeforeDelete(
  tx: DbExecutor,
  canonical: DiscoveredItemRow,
  survivor: DiscoveredItemRow,
): Promise<number> {
  await tx.delete(discoveredItemMatches)
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, survivor.workspaceId),
        eq(discoveredItemMatches.itemId, survivor.id),
      ),
    );
  await tx.update(discoveredItemMatches)
    .set({ itemId: survivor.id })
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, canonical.workspaceId),
        eq(discoveredItemMatches.itemId, canonical.id),
      ),
    );
  await tx.update(discoveredItems)
    .set({
      title: canonical.title,
      url: canonical.url,
      summary: canonical.summary,
      publishedAt: canonical.publishedAt,
      score: canonical.score,
      // Sprint 53: routing rides on the match rows repointed above, so there is
      // no suggested* pair left to copy across the collapse.
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
    );
  return rowsAffected((await tx
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
    )));
}

export async function deleteDiscoverySourcePreservingDuplicates(
  db: Db,
  workspaceId: string,
  sourceId: string,
  hooks: DiscoveryDedupeHooks = {},
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const source = (await tx
      .select({ id: discoverySources.id })
      .from(discoverySources)
      .where(
        and(
          eq(discoverySources.workspaceId, workspaceId),
          eq(discoverySources.id, sourceId),
        ),
      ))[0];
    if (!source) return false;

    const canonicals = await tx
      .select()
      .from(discoveredItems)
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.sourceId, sourceId),
          isNull(discoveredItems.duplicateOfId),
        ),
      );
    for (const canonical of canonicals) {
      const survivor = (await tx
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
        .limit(1))[0];
      if (survivor) {
        await promoteCanonicalBeforeDelete(tx, canonical, survivor);
      }
    }

    hooks.beforeSourceDelete?.();
    return (
      rowsAffected((await tx
        .delete(discoverySources)
        .where(
          and(
            eq(discoverySources.workspaceId, workspaceId),
            eq(discoverySources.id, sourceId),
          ),
        ))) === 1
    );
  });
}

export async function repairDanglingDuplicateGroups(
  db: Db,
): Promise<{ groups: number; promoted: number; repointed: number }> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(discoveredItems);
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
      await tx.delete(discoveredItemMatches)
        .where(
          and(
            eq(discoveredItemMatches.workspaceId, survivor.workspaceId),
            inArray(discoveredItemMatches.itemId, ids),
          ),
        );
      await tx.update(discoveredItems)
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
        );
      promoted += 1;

      const remainingIds = ids.slice(1);
      if (remainingIds.length > 0) {
        repointed += rowsAffected((await tx
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
          )));
      }
    }
    return {
      groups: dangling.size,
      promoted,
      repointed,
    };
  });
}
