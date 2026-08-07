import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  OPPORTUNITY_DECISION_TARGETS,
  campaignOpportunitySchema,
  canTransitionOpportunity,
  opportunityEventSchema,
  opportunityPolicySchema,
  type CampaignOpportunity,
  type OpportunityDecisionAction,
  type OpportunityDetail,
  type OpportunityEvent,
  type OpportunityStatus,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  campaignOpportunities,
  campaignOpportunityEvents,
  campaignRoutingProfiles,
  campaigns,
  canonicalExternalStories,
  type CampaignOpportunityRow,
} from "../db/schema";
import { rowToRoutingProfile } from "./routing-profiles";

export class OpportunityNotFoundError extends Error {}
export class InvalidOpportunityTransitionError extends Error {
  constructor(
    readonly from: OpportunityStatus,
    readonly to: OpportunityStatus,
  ) {
    super(`Cannot transition an opportunity from ${from} to ${to}.`);
  }
}

export const OPPORTUNITY_LIST_DEFAULT_LIMIT = 50;
export const OPPORTUNITY_LIST_MAX_LIMIT = 200;

interface OpportunityJoinRow {
  opportunity: CampaignOpportunityRow;
  storyTitle: string | null;
  storyUrl: string | null;
  campaignName: string;
}

function projectOpportunity(row: OpportunityJoinRow): CampaignOpportunity {
  const o = row.opportunity;
  return campaignOpportunitySchema.parse({
    id: o.id,
    workspaceId: o.workspaceId,
    canonicalStoryId: o.canonicalStoryId,
    manualSignalId: o.manualSignalId,
    campaignId: o.campaignId,
    planRevisionId: o.planRevisionId,
    routingProfileId: o.routingProfileId,
    status: o.status,
    angle: o.angle,
    angleHash: o.angleHash,
    workspaceRelevance: o.workspaceRelevance,
    campaignFit: o.campaignFit,
    confidence: o.confidence,
    actionability: o.actionability,
    sourceTrust: o.sourceTrust,
    suggestedPersonaId: o.suggestedPersonaId,
    supportedClaims: JSON.parse(o.supportedClaimsJson),
    reason: o.reason,
    matcherVersion: o.matcherVersion,
    policy: opportunityPolicySchema.parse(JSON.parse(o.policyJson)),
    expiresAt: o.expiresAt,
    decidedByUserId: o.decidedByUserId,
    decidedAt: o.decidedAt,
    decisionReason: o.decisionReason,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    storyTitle: row.storyTitle,
    storyUrl: row.storyUrl,
    campaignName: row.campaignName,
  });
}

function joinedSelect(db: DbExecutor) {
  return db
    .select({
      opportunity: campaignOpportunities,
      storyTitle: canonicalExternalStories.title,
      storyUrl: canonicalExternalStories.canonicalUrl,
      campaignName: campaigns.name,
    })
    .from(campaignOpportunities)
    .innerJoin(campaigns, eq(campaignOpportunities.campaignId, campaigns.id))
    .leftJoin(
      canonicalExternalStories,
      eq(campaignOpportunities.canonicalStoryId, canonicalExternalStories.id),
    );
}

export async function listOpportunities(
  db: Db,
  workspaceId: string,
  options: {
    status?: OpportunityStatus;
    campaignId?: string;
    storyId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ opportunities: CampaignOpportunity[]; total: number }> {
  const limit = Math.min(
    Math.max(options.limit ?? OPPORTUNITY_LIST_DEFAULT_LIMIT, 1),
    OPPORTUNITY_LIST_MAX_LIMIT,
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const where = and(
    eq(campaignOpportunities.workspaceId, workspaceId),
    options.status ? eq(campaignOpportunities.status, options.status) : undefined,
    options.campaignId
      ? eq(campaignOpportunities.campaignId, options.campaignId)
      : undefined,
    options.storyId
      ? eq(campaignOpportunities.canonicalStoryId, options.storyId)
      : undefined,
  );
  const rows = await joinedSelect(db)
    .where(where)
    .orderBy(desc(campaignOpportunities.createdAt), asc(campaignOpportunities.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    (await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(campaignOpportunities)
      .where(where)
      .get())?.n ?? 0;
  return { opportunities: rows.map(projectOpportunity), total };
}

async function eventRows(db: DbExecutor, opportunityId: string): Promise<OpportunityEvent[]> {
  return (await db
    .select()
    .from(campaignOpportunityEvents)
    .where(eq(campaignOpportunityEvents.opportunityId, opportunityId))
    .orderBy(
      asc(campaignOpportunityEvents.createdAt),
      // Creation (fromStatus null) precedes the same-millisecond policy
      // disposition written in the same transaction.
      sql`${campaignOpportunityEvents.fromStatus} IS NOT NULL`,
      asc(campaignOpportunityEvents.id),
    )
    .all())
    .map((row) =>
      opportunityEventSchema.parse({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        actorUserId: row.actorUserId,
        reason: row.reason,
        createdAt: row.createdAt,
      }),
    );
}

export async function getOpportunityDetail(
  db: Db,
  workspaceId: string,
  opportunityId: string,
): Promise<OpportunityDetail> {
  const row = await joinedSelect(db)
    .where(
      and(
        eq(campaignOpportunities.id, opportunityId),
        eq(campaignOpportunities.workspaceId, workspaceId),
      ),
    )
    .get();
  if (!row) throw new OpportunityNotFoundError();
  const profileRow = await db
    .select()
    .from(campaignRoutingProfiles)
    .where(eq(campaignRoutingProfiles.id, row.opportunity.routingProfileId))
    .get();
  if (!profileRow) throw new OpportunityNotFoundError();
  return {
    opportunity: projectOpportunity(row),
    profile: rowToRoutingProfile(profileRow),
    events: await eventRows(db, opportunityId),
  };
}

/**
 * Apply an operator decision through the contracts transition machine. The
 * matcher's judgment fields stay immutable — only lifecycle status, the
 * decision attribution, and the audit trail change.
 */
export async function decideOpportunity(
  db: Db,
  workspaceId: string,
  opportunityId: string,
  input: { action: OpportunityDecisionAction; reason?: string; actorUserId: string | null },
): Promise<OpportunityDetail> {
  await db.transaction(async (tx) => {
    const row = await tx
      .select()
      .from(campaignOpportunities)
      .where(
        and(
          eq(campaignOpportunities.id, opportunityId),
          eq(campaignOpportunities.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!row) throw new OpportunityNotFoundError();
    const from = row.status as OpportunityStatus;
    const to = OPPORTUNITY_DECISION_TARGETS[input.action];
    if (!canTransitionOpportunity(from, to)) {
      throw new InvalidOpportunityTransitionError(from, to);
    }
    const now = Date.now();
    await tx.update(campaignOpportunities)
      .set({
        status: to,
        decidedByUserId: input.actorUserId,
        decidedAt: now,
        decisionReason: input.reason ?? null,
        updatedAt: now,
      })
      .where(eq(campaignOpportunities.id, opportunityId))
      .run();
    await tx.insert(campaignOpportunityEvents)
      .values({
        id: randomUUID(),
        workspaceId,
        opportunityId,
        fromStatus: from,
        toStatus: to,
        actorUserId: input.actorUserId,
        reason: input.reason ?? null,
        createdAt: now,
      })
      .run();
  });
  return await getOpportunityDetail(db, workspaceId, opportunityId);
}
