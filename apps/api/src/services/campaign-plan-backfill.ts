import { and, asc, eq, gt, notExists, sql } from "drizzle-orm";
import type { Db } from "../db";
import { campaignPlanRevisions, campaigns } from "../db/schema";
import { backfillCampaignControlPlane } from "./orchestration-backfill";

export interface CampaignPlanBackfillFailure {
  workspaceId: string;
  campaignId: string;
  message: string;
}

export interface CampaignPlanBackfillSummary {
  /** Campaigns that had no plan revision at all when the sweep started. */
  scanned: number;
  /** Campaigns that now have an active plan revision. */
  planned: number;
  /**
   * Campaigns whose draft revision could not be activated (a lane connection
   * went stale, an audience vanished). The draft survives for a human to
   * finish in the plan workspace; the sweep never retries it, so it can never
   * pile up duplicate revisions.
   */
  failed: CampaignPlanBackfillFailure[];
}

/** Page size for the campaign sweep. Keyset paging keeps memory flat. */
const BATCH_SIZE = 200;

/**
 * Sprint 53 — give **every** campaign a plan revision.
 *
 * Task 4 removes the legacy `campaigns.*` structured block from
 * `composeCampaignOverlay`, so from that point on the plan is the only place
 * objective / KPI / pillars reach a prompt. Campaigns created before the plan
 * existed still show an "Initialize campaign plan" CTA; without this sweep they
 * would silently lose their strategy from every generation.
 *
 * Idempotent by construction: a campaign is a candidate only while it has **no
 * plan revision row whatsoever**, so re-running can neither duplicate a
 * backfill nor create a spurious revision beside a human-authored draft.
 * (`backfillCampaignControlPlane` short-circuits on an *active* plan; that is
 * not enough on its own, because a failed activation leaves a draft behind and
 * would otherwise be re-created on every boot.)
 *
 * Size-independent: keyset pagination over `campaigns.id`, and one campaign's
 * failure never aborts the sweep.
 */
export async function backfillMissingCampaignPlans(db: Db): Promise<CampaignPlanBackfillSummary> {
  const summary: CampaignPlanBackfillSummary = { scanned: 0, planned: 0, failed: [] };
  let cursor: string | undefined;

  for (;;) {
    const batch = await db
      .select({ id: campaigns.id, workspaceId: campaigns.workspaceId })
      .from(campaigns)
      .where(
        and(
          cursor ? gt(campaigns.id, cursor) : undefined,
          notExists(
            db
              .select({ one: sql`1` })
              .from(campaignPlanRevisions)
              .where(eq(campaignPlanRevisions.campaignId, campaigns.id)),
          ),
        ),
      )
      // Keyset, not offset: the predicate stops matching rows we just handled,
      // so an offset would skip campaigns. The cursor always advances.
      .orderBy(asc(campaigns.id))
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;

    for (const campaign of batch) {
      summary.scanned += 1;
      try {
        await backfillCampaignControlPlane(db, campaign.workspaceId, campaign.id);
        summary.planned += 1;
      } catch (error) {
        summary.failed.push({
          workspaceId: campaign.workspaceId,
          campaignId: campaign.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }

  return summary;
}
