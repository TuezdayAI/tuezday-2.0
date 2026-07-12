import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  campaignPlanRevisionSchema,
  type CampaignPlanDetail,
  type CampaignPlanRevision,
  type CreateCampaignPlanRevisionInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  audiences,
  campaignLaneRevisions,
  campaignPlanRevisions,
  campaigns,
  connections,
  personas,
  type CampaignPlanRevisionRow,
} from "../db/schema";
import {
  CampaignPlanNotFoundError,
  PlanImmutableError,
  PlanValidationError,
  type CampaignPlanIssue,
} from "./campaign-plan-errors";
import { listLaneRevisionsForPlan } from "./campaign-lanes";

export { CampaignPlanNotFoundError, PlanImmutableError, PlanValidationError } from "./campaign-plan-errors";

export interface PlanActor {
  userId: string | null;
}

function rowToPlan(row: CampaignPlanRevisionRow): CampaignPlanRevision {
  return campaignPlanRevisionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    revision: row.revision,
    status: row.status,
    objective: row.objective,
    kpi: row.kpi,
    timeframe: row.timeframe,
    startAt: row.startAt,
    endAt: row.endAt,
    audienceIds: JSON.parse(row.audienceIdsJson) as string[],
    pillars: JSON.parse(row.pillarsJson) as string[],
    offers: JSON.parse(row.offersJson) as string[],
    ctas: JSON.parse(row.ctasJson) as string[],
    guidance: row.guidance,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
  });
}

function getPlanRow(
  db: Db,
  workspaceId: string,
  campaignId: string,
  planRevisionId: string,
): CampaignPlanRevisionRow | undefined {
  return db
    .select()
    .from(campaignPlanRevisions)
    .where(
      and(
        eq(campaignPlanRevisions.id, planRevisionId),
        eq(campaignPlanRevisions.workspaceId, workspaceId),
        eq(campaignPlanRevisions.campaignId, campaignId),
      ),
    )
    .get();
}

export function createPlanRevision(
  db: Db,
  workspaceId: string,
  campaignId: string,
  input: CreateCampaignPlanRevisionInput,
  actor: PlanActor,
): CampaignPlanRevision {
  const campaign = db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
    .get();
  if (!campaign) throw new CampaignPlanNotFoundError();
  const previous = db
    .select({ revision: campaignPlanRevisions.revision })
    .from(campaignPlanRevisions)
    .where(eq(campaignPlanRevisions.campaignId, campaignId))
    .orderBy(desc(campaignPlanRevisions.revision))
    .get();
  const row: CampaignPlanRevisionRow = {
    id: randomUUID(),
    workspaceId,
    campaignId,
    revision: (previous?.revision ?? 0) + 1,
    status: "draft",
    objective: input.objective,
    kpi: input.kpi,
    timeframe: input.timeframe,
    startAt: input.startAt,
    endAt: input.endAt,
    audienceIdsJson: JSON.stringify(input.audienceIds),
    pillarsJson: JSON.stringify(input.pillars),
    offersJson: JSON.stringify(input.offers),
    ctasJson: JSON.stringify(input.ctas),
    guidance: input.guidance,
    createdBy: actor.userId,
    createdAt: Date.now(),
    activatedAt: null,
  };
  db.insert(campaignPlanRevisions).values(row).run();
  return rowToPlan(row);
}

function validateActivation(db: Db, row: CampaignPlanRevisionRow): CampaignPlanIssue[] {
  const issues: CampaignPlanIssue[] = [];
  const audienceIds = JSON.parse(row.audienceIdsJson) as string[];
  for (const audienceId of audienceIds) {
    const audience = db
      .select({ id: audiences.id })
      .from(audiences)
      .where(and(eq(audiences.id, audienceId), eq(audiences.workspaceId, row.workspaceId)))
      .get();
    if (!audience) {
      issues.push({
        path: "audienceIds",
        code: "audience_not_found",
        message: `Audience ${audienceId} is not available in this workspace.`,
      });
    }
  }
  const lanes = db
    .select()
    .from(campaignLaneRevisions)
    .where(eq(campaignLaneRevisions.planRevisionId, row.id))
    .all();
  for (const lane of lanes.filter((candidate) => candidate.status === "active")) {
    const persona = db
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.id, lane.personaId), eq(personas.workspaceId, row.workspaceId)))
      .get();
    if (!persona) {
      issues.push({
        path: `lanes.${lane.id}.personaId`,
        code: "persona_not_found",
        message: "The lane persona is not available in this workspace.",
      });
    }
    if (lane.publishingConnectionId) {
      const connection = db
        .select({ id: connections.id, status: connections.status })
        .from(connections)
        .where(
          and(
            eq(connections.id, lane.publishingConnectionId),
            eq(connections.workspaceId, row.workspaceId),
          ),
        )
        .get();
      if (!connection || connection.status !== "connected") {
        issues.push({
          path: `lanes.${lane.id}.publishingConnectionId`,
          code: "connection_unavailable",
          message: "The lane publishing connection is not connected.",
        });
      }
    }
  }
  return issues;
}

export function activatePlanRevision(
  db: Db,
  workspaceId: string,
  campaignId: string,
  planRevisionId: string,
): CampaignPlanDetail {
  const row = getPlanRow(db, workspaceId, campaignId, planRevisionId);
  if (!row) throw new CampaignPlanNotFoundError();
  if (row.status !== "draft") throw new PlanImmutableError();
  const issues = validateActivation(db, row);
  if (issues.length > 0) throw new PlanValidationError(issues);
  const activatedAt = Date.now();
  db.transaction((tx) => {
    tx.update(campaignPlanRevisions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(campaignPlanRevisions.campaignId, campaignId),
          eq(campaignPlanRevisions.status, "active"),
        ),
      )
      .run();
    tx.update(campaignPlanRevisions)
      .set({ status: "active", activatedAt })
      .where(eq(campaignPlanRevisions.id, planRevisionId))
      .run();
    tx.update(campaigns)
      .set({ currentPlanRevisionId: planRevisionId, updatedAt: activatedAt })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
      .run();
  });
  return getCurrentCampaignPlan(db, workspaceId, campaignId)!;
}

export function getCurrentCampaignPlan(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignPlanDetail | undefined {
  const campaign = db
    .select({ currentPlanRevisionId: campaigns.currentPlanRevisionId })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
    .get();
  if (!campaign?.currentPlanRevisionId) return undefined;
  const row = getPlanRow(db, workspaceId, campaignId, campaign.currentPlanRevisionId);
  if (!row) return undefined;
  return {
    plan: rowToPlan(row),
    lanes: listLaneRevisionsForPlan(db, workspaceId, row.id),
  };
}

export function listCampaignPlanDetails(
  db: Db,
  workspaceId: string,
  campaignId: string,
): CampaignPlanDetail[] {
  return db
    .select()
    .from(campaignPlanRevisions)
    .where(
      and(
        eq(campaignPlanRevisions.workspaceId, workspaceId),
        eq(campaignPlanRevisions.campaignId, campaignId),
      ),
    )
    .orderBy(desc(campaignPlanRevisions.revision))
    .all()
    .map((row) => ({
      plan: rowToPlan(row),
      lanes: listLaneRevisionsForPlan(db, workspaceId, row.id),
    }));
}
