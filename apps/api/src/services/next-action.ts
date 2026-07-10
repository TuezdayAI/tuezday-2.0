import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  CONNECTOR_PROVIDERS,
  checklistProgress,
  nextActionFor,
  type NextAction,
  type NextActionState,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  approvalDecisions,
  brainDocumentVersions,
  brainDocuments,
  campaigns,
  connections,
  drafts,
  publications,
  workspaceMembers,
} from "../db/schema";

// Providers whose connection satisfies "a publishing channel is connected"
// (spec §5.1 checklist). Derived from the one registry in contracts.
const SOCIAL_PROVIDER_KEYS = CONNECTOR_PROVIDERS.filter((p) => p.categories?.includes("social")).map(
  (p) => p.key,
);

// The onboarding autodraft (Sprint 36) seeds the initial brain doc versions
// with this actor label; any version written by anyone else means a human
// (or the learning loop acting on human decisions) has touched the brain.
const AUTODRAFT_ACTOR_LABEL = "system:onboarding";

function count(db: Db, query: { get(): { count: number } | undefined }): number {
  return query.get()?.count ?? 0;
}

/**
 * Derive the next-action input (spec §5.1) from real workspace state. The
 * priority function itself lives in @tuezday/contracts (nextActionFor) so the
 * guide dot, smart landing, and Home checklist all consume one answer.
 */
export function getNextActionState(db: Db, workspaceId: string): NextActionState {
  const draftCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(drafts)
      .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.state, "pending_review"))),
  );

  // Publications only exist for approved drafts, so a scheduled publication
  // whose target connection is no longer "connected" is the real-state
  // reading of "approved post blocked by a missing channel connection".
  // (Approved drafts that were never scheduled are not blocked — they are
  // simply not queued yet.)
  const blockedPublishCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(publications)
      .innerJoin(connections, eq(publications.connectionId, connections.id))
      .where(
        and(
          eq(publications.workspaceId, workspaceId),
          eq(publications.status, "scheduled"),
          ne(connections.status, "connected"),
        ),
      ),
  );

  // Active campaigns with no content attached: neither a draft nor a
  // generation references the campaign.
  const liveCampaignsWithoutContent = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.workspaceId, workspaceId),
          eq(campaigns.status, "active"),
          sql`not exists (select 1 from drafts d where d.campaign_id = ${campaigns.id})`,
          sql`not exists (select 1 from generations g where g.campaign_id = ${campaigns.id})`,
        ),
      ),
  );

  // Generation is synchronous today (the /generate request holds the LLM
  // call) — there is no background generation queue to read yet, so nothing
  // is ever "generating" between requests. Report 0 until a real queue lands
  // so "system_working" never fires spuriously.
  const generatingCount = 0;

  // Checklist: brain_reviewed = any brain doc version beyond the seeded
  // initial. Workspace creation seeds empty docs with NO version rows and the
  // onboarding autodraft writes the first versions as "system:onboarding", so
  // any version attributed to anyone else is a genuine review/edit.
  const reviewedVersionCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(brainDocumentVersions)
      .innerJoin(brainDocuments, eq(brainDocumentVersions.documentId, brainDocuments.id))
      .where(
        and(
          eq(brainDocuments.workspaceId, workspaceId),
          sql`(${brainDocumentVersions.actor} is null or ${brainDocumentVersions.actor} != ${AUTODRAFT_ACTOR_LABEL})`,
        ),
      ),
  );

  const socialConnectionCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(connections)
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.status, "connected"),
          inArray(connections.providerKey, SOCIAL_PROVIDER_KEYS),
        ),
      ),
  );

  const campaignCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, workspaceId)),
  );

  // "Ever approved" reads the immutable decision log, not current draft
  // state, so a draft that later moved on still counts.
  const approvalCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.workspaceId, workspaceId),
          inArray(approvalDecisions.toState, ["approved", "edited"]),
        ),
      ),
  );

  const memberCount = count(
    db,
    db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId)),
  );

  return {
    draftCount,
    blockedPublishCount,
    liveCampaignsWithoutContent,
    // Insights land in a later slice — until then there is never an
    // "insights available but unconnected" state to detect.
    insightsAvailableUnconnected: false,
    generatingCount,
    checklist: {
      brain_reviewed: reviewedVersionCount > 0,
      channel_connected: socialConnectionCount > 0,
      first_campaign: campaignCount > 0,
      first_approval: approvalCount > 0,
      // Insights are not live yet (see above) — flips when that slice ships.
      insights_live: false,
      team_invited: memberCount > 1,
    },
  };
}

export interface NextActionView {
  state: NextActionState;
  nextAction: NextAction;
  checklist: { done: number; total: number; complete: boolean };
}

/** The one shared answer (§5.1): state + derived action + checklist progress. */
export function getNextActionView(db: Db, workspaceId: string): NextActionView {
  const state = getNextActionState(db, workspaceId);
  return { state, nextAction: nextActionFor(state), checklist: checklistProgress(state) };
}
