import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  campaignLaneRevisionSchema,
  campaignLaneRevisionViewSchema,
  upsertCampaignLaneRevisionInputSchema,
  type CampaignLaneRevision,
  type CampaignLaneRevisionView,
  type Channel,
  type DeliveryMode,
  type LaneSchedule,
  type LaneStatus,
  type ReactivePeriod,
  type UpsertCampaignLaneRevisionInput,
} from "@tuezday/contracts";
import type { Db } from "../db";
import {
  audiences,
  campaignLaneRevisions,
  campaignLanes,
  campaignPlanRevisions,
  connections,
  personas,
  type CampaignLaneRevisionRow,
} from "../db/schema";
import { CampaignPlanNotFoundError, PlanImmutableError } from "./campaign-plan-errors";

function rowToLaneRevision(row: CampaignLaneRevisionRow): CampaignLaneRevision {
  return campaignLaneRevisionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    laneId: row.laneId,
    planRevisionId: row.planRevisionId,
    personaId: row.personaId,
    audienceId: row.audienceId,
    channel: row.channel as Channel,
    format: row.format,
    publishingConnectionId: row.publishingConnectionId,
    providerTarget: row.providerTarget,
    deliveryMode: row.deliveryMode as DeliveryMode,
    plannedQuantity: row.plannedQuantity,
    schedule: row.scheduleJson ? (JSON.parse(row.scheduleJson) as LaneSchedule) : null,
    reactivePeriod: row.reactivePeriod as ReactivePeriod | null,
    reactiveCap: row.reactiveCap,
    status: row.status as LaneStatus,
    createdAt: row.createdAt,
  });
}

export function listLaneRevisionsForPlan(
  db: Db,
  workspaceId: string,
  planRevisionId: string,
): CampaignLaneRevisionView[] {
  return db
    .select({ revision: campaignLaneRevisions, key: campaignLanes.key, name: campaignLanes.name })
    .from(campaignLaneRevisions)
    .innerJoin(campaignLanes, eq(campaignLanes.id, campaignLaneRevisions.laneId))
    .where(
      and(
        eq(campaignLaneRevisions.workspaceId, workspaceId),
        eq(campaignLaneRevisions.planRevisionId, planRevisionId),
      ),
    )
    .all()
    .map(({ revision, key, name }) =>
      campaignLaneRevisionViewSchema.parse({ ...rowToLaneRevision(revision), key, name }),
    );
}

export function upsertLaneRevision(
  db: Db,
  workspaceId: string,
  campaignId: string,
  planRevisionId: string,
  input: UpsertCampaignLaneRevisionInput,
): CampaignLaneRevision {
  const parsed = upsertCampaignLaneRevisionInputSchema.parse(input);
  const plan = db
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
  if (!plan) throw new CampaignPlanNotFoundError();
  if (plan.status !== "draft") throw new PlanImmutableError();

  const persona = db
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, parsed.personaId), eq(personas.workspaceId, workspaceId)))
    .get();
  if (!persona) throw new CampaignPlanNotFoundError("The lane persona is not in this workspace.");
  if (parsed.audienceId) {
    const audience = db
      .select({ id: audiences.id })
      .from(audiences)
      .where(and(eq(audiences.id, parsed.audienceId), eq(audiences.workspaceId, workspaceId)))
      .get();
    if (!audience) {
      throw new CampaignPlanNotFoundError("The lane audience is not in this workspace.");
    }
  }
  if (parsed.publishingConnectionId) {
    const connection = db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, parsed.publishingConnectionId),
          eq(connections.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!connection) {
      throw new CampaignPlanNotFoundError("The publishing connection is not in this workspace.");
    }
  }

  const now = Date.now();
  return db.transaction((tx) => {
    let lane = input.laneId
      ? tx
          .select()
          .from(campaignLanes)
          .where(
            and(
              eq(campaignLanes.id, input.laneId),
              eq(campaignLanes.workspaceId, workspaceId),
              eq(campaignLanes.campaignId, campaignId),
            ),
          )
          .get()
      : tx
          .select()
          .from(campaignLanes)
          .where(and(eq(campaignLanes.campaignId, campaignId), eq(campaignLanes.key, input.key)))
          .get();
    if (input.laneId && !lane) throw new CampaignPlanNotFoundError("The stable lane does not exist.");
    if (!lane) {
      lane = {
        id: randomUUID(),
        workspaceId,
        campaignId,
        key: input.key,
        name: input.name,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(campaignLanes).values(lane).run();
    } else {
      tx.update(campaignLanes)
        .set({ name: input.name, status: input.status, updatedAt: now })
        .where(eq(campaignLanes.id, lane.id))
        .run();
    }

    const existing = tx
      .select()
      .from(campaignLaneRevisions)
      .where(
        and(
          eq(campaignLaneRevisions.laneId, lane.id),
          eq(campaignLaneRevisions.planRevisionId, planRevisionId),
        ),
      )
      .get();
    const columns = {
      personaId: parsed.personaId,
      audienceId: parsed.audienceId,
      channel: parsed.channel,
      format: parsed.format,
      publishingConnectionId: parsed.publishingConnectionId,
      providerTarget: parsed.providerTarget,
      deliveryMode: parsed.deliveryMode,
      plannedQuantity: parsed.plannedQuantity,
      scheduleJson: parsed.schedule ? JSON.stringify(parsed.schedule) : null,
      reactivePeriod: parsed.reactivePeriod,
      reactiveCap: parsed.reactiveCap,
      status: parsed.status,
    };
    if (existing) {
      tx.update(campaignLaneRevisions)
        .set(columns)
        .where(eq(campaignLaneRevisions.id, existing.id))
        .run();
      return rowToLaneRevision({ ...existing, ...columns });
    }
    const row: CampaignLaneRevisionRow = {
      id: randomUUID(),
      workspaceId,
      laneId: lane.id,
      planRevisionId,
      ...columns,
      createdAt: now,
    };
    tx.insert(campaignLaneRevisions).values(row).run();
    return rowToLaneRevision(row);
  });
}
