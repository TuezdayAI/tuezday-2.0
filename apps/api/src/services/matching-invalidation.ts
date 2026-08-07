import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { DbExecutor } from "../db";
import {
  discoveredItemMatches,
  discoveredItems,
} from "../db/schema";

export interface MatchingInvalidation {
  directItemIds: string[];
  includeReadyNoMatch: boolean;
}

/**
 * Reset only canonical, untriaged discovery items whose matching inputs may
 * have changed. Existing match rows remain available as stale display context
 * until a replacement judgment commits.
 */
export async function invalidateMatching(
  db: DbExecutor,
  workspaceId: string,
  input: MatchingInvalidation,
): Promise<number> {
  const targetIds = new Set(input.directItemIds);
  if (input.includeReadyNoMatch) {
    const readyNoMatch = await db
      .select({ id: discoveredItems.id })
      .from(discoveredItems)
      .leftJoin(
        discoveredItemMatches,
        and(
          eq(discoveredItemMatches.itemId, discoveredItems.id),
          eq(discoveredItemMatches.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(discoveredItems.workspaceId, workspaceId),
          eq(discoveredItems.status, "new"),
          isNull(discoveredItems.duplicateOfId),
          eq(discoveredItems.matchingState, "ready"),
          isNull(discoveredItemMatches.id),
        ),
      )
      .all();
    for (const item of readyNoMatch) targetIds.add(item.id);
  }

  if (targetIds.size === 0) return 0;
  return (await db
    .update(discoveredItems)
    .set({
      matchingState: "pending",
      matchingVersion: sql`${discoveredItems.matchingVersion} + 1`,
      matchingInputFingerprint: null,
      matchingLeaseOwner: null,
      matchingLeaseExpiresAt: null,
      matchingHeartbeatAt: null,
      matchingError: null,
    })
    .where(
      and(
        eq(discoveredItems.workspaceId, workspaceId),
        eq(discoveredItems.status, "new"),
        isNull(discoveredItems.duplicateOfId),
        inArray(discoveredItems.id, [...targetIds]),
      ),
    )
    .run()).changes;
}

export async function itemIdsForPersona(
  db: DbExecutor,
  workspaceId: string,
  personaId: string,
): Promise<string[]> {
  return (await db
    .selectDistinct({ itemId: discoveredItemMatches.itemId })
    .from(discoveredItemMatches)
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, workspaceId),
        eq(discoveredItemMatches.personaId, personaId),
      ),
    )
    .all())
    .map((row) => row.itemId);
}

export async function itemIdsForCampaignChange(
  db: DbExecutor,
  workspaceId: string,
  campaignId: string,
  personaIds: string[],
): Promise<string[]> {
  const blastRadius =
    personaIds.length > 0
      ? or(
          eq(discoveredItemMatches.campaignId, campaignId),
          inArray(discoveredItemMatches.personaId, personaIds),
        )
      : eq(discoveredItemMatches.campaignId, campaignId);
  return (await db
    .selectDistinct({ itemId: discoveredItemMatches.itemId })
    .from(discoveredItemMatches)
    .where(
      and(
        eq(discoveredItemMatches.workspaceId, workspaceId),
        blastRadius,
      ),
    )
    .all())
    .map((row) => row.itemId);
}
