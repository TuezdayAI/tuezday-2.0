import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
  type CreatePipelineDefinitionInput,
  type PipelineDefinition,
  type PipelineDefinitionDetail,
  type PipelineDefinitionStatus,
  type PipelineDefinitionVersion,
  type PipelineSpec,
  type PipelineTaskKey,
  type UpdatePipelineSpecInput,
} from "@tuezday/contracts";
import type { Db, DbExecutor } from "../db";
import {
  pipelineDefinitions,
  pipelineDefinitionVersions,
  type PipelineDefinitionRow,
  type PipelineDefinitionVersionRow,
} from "../db/schema";

/** Who edited a definition — mirrors the brain-doc BrainActor shape. */
export interface PipelineActor {
  userId: string | null;
  label: string;
}

export class PipelineDefinitionNotFoundError extends Error {
  constructor(id: string) {
    super(`Pipeline definition "${id}" not found.`);
    this.name = "PipelineDefinitionNotFoundError";
  }
}

function rowToDefinition(row: PipelineDefinitionRow): PipelineDefinition {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    taskKey: row.taskKey as PipelineTaskKey,
    name: row.name,
    description: row.description,
    campaignId: row.campaignId,
    laneId: row.laneId,
    status: row.status as PipelineDefinitionStatus,
    currentVersion: row.currentVersion,
    spec: JSON.parse(row.specJson) as PipelineSpec,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToVersion(row: PipelineDefinitionVersionRow): PipelineDefinitionVersion {
  return {
    id: row.id,
    definitionId: row.definitionId,
    version: row.version,
    spec: JSON.parse(row.specJson) as PipelineSpec,
    actorLabel: row.actorLabel,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}

async function insertDefinition(
  tx: DbExecutor,
  input: {
    workspaceId: string;
    taskKey: PipelineTaskKey;
    name: string;
    description: string;
    campaignId: string | null;
    laneId: string | null;
    spec: PipelineSpec;
  },
  actor: PipelineActor,
  now: number,
): Promise<PipelineDefinitionRow> {
  const row: PipelineDefinitionRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    taskKey: input.taskKey,
    name: input.name,
    description: input.description,
    campaignId: input.campaignId,
    laneId: input.laneId,
    status: "draft",
    currentVersion: 1,
    specJson: JSON.stringify(input.spec),
    createdByUserId: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
  await tx.insert(pipelineDefinitions).values(row).run();
  await tx.insert(pipelineDefinitionVersions)
    .values({
      id: randomUUID(),
      definitionId: row.id,
      version: 1,
      specJson: row.specJson,
      actorLabel: actor.label,
      actorUserId: actor.userId,
      createdAt: now,
    })
    .run();
  return row;
}

/**
 * Lazily seed the reference signal → social post definition (D-64.11) —
 * version 1, status `draft`; activation is a founder action. Mirrors the
 * ensureBrainDocs pattern.
 */
export async function ensurePipelineDefinitions(db: Db, workspaceId: string): Promise<void> {
  const existing = await db
    .select({ id: pipelineDefinitions.id })
    .from(pipelineDefinitions)
    .where(
      and(
        eq(pipelineDefinitions.workspaceId, workspaceId),
        eq(pipelineDefinitions.taskKey, "signal_social_post"),
      ),
    )
    .get();
  if (existing) return;
  await db.transaction(async (tx) => {
    await insertDefinition(
      tx,
      {
        workspaceId,
        taskKey: "signal_social_post",
        name: "Signal → social post (reference)",
        description:
          "The reference pipeline: research → angle → draft → critique → revise → propose.",
        campaignId: null,
        laneId: null,
        spec: REFERENCE_SIGNAL_SOCIAL_POST_SPEC,
      },
      { userId: null, label: "system" },
      Date.now(),
    );
  });
}

export async function listPipelineDefinitions(db: Db, workspaceId: string): Promise<PipelineDefinition[]> {
  return (await db
    .select()
    .from(pipelineDefinitions)
    .where(eq(pipelineDefinitions.workspaceId, workspaceId))
    .orderBy(desc(pipelineDefinitions.createdAt))
    .all())
    .map(rowToDefinition);
}

export async function getPipelineDefinition(
  db: Db,
  workspaceId: string,
  definitionId: string,
): Promise<PipelineDefinition | undefined> {
  const row = await db
    .select()
    .from(pipelineDefinitions)
    .where(
      and(
        eq(pipelineDefinitions.workspaceId, workspaceId),
        eq(pipelineDefinitions.id, definitionId),
      ),
    )
    .get();
  return row ? rowToDefinition(row) : undefined;
}

export async function getPipelineDefinitionDetail(
  db: Db,
  workspaceId: string,
  definitionId: string,
): Promise<PipelineDefinitionDetail | undefined> {
  const definition = await getPipelineDefinition(db, workspaceId, definitionId);
  if (!definition) return undefined;
  const versions = (await db
    .select()
    .from(pipelineDefinitionVersions)
    .where(eq(pipelineDefinitionVersions.definitionId, definitionId))
    .orderBy(desc(pipelineDefinitionVersions.version))
    .all())
    .map(rowToVersion);
  return { ...definition, versions };
}

export async function createPipelineDefinition(
  db: Db,
  workspaceId: string,
  input: CreatePipelineDefinitionInput,
  actor: PipelineActor,
): Promise<PipelineDefinition> {
  return await db.transaction(async (tx) => {
    const row = await insertDefinition(
      tx,
      {
        workspaceId,
        taskKey: input.taskKey,
        name: input.name,
        description: input.description,
        campaignId: input.campaignId ?? null,
        laneId: input.laneId ?? null,
        spec: input.spec,
      },
      actor,
      Date.now(),
    );
    return rowToDefinition(row);
  });
}

/**
 * Save a new spec version (D-64.1): update the current row, bump
 * currentVersion, append the version row — the brain-doc pattern with a
 * strict unique on (definitionId, version).
 */
export async function updatePipelineSpec(
  db: Db,
  workspaceId: string,
  definitionId: string,
  input: UpdatePipelineSpecInput,
  actor: PipelineActor,
): Promise<PipelineDefinition> {
  return await db.transaction(async (tx) => {
    const row = await tx
      .select()
      .from(pipelineDefinitions)
      .where(
        and(
          eq(pipelineDefinitions.workspaceId, workspaceId),
          eq(pipelineDefinitions.id, definitionId),
        ),
      )
      .get();
    if (!row) throw new PipelineDefinitionNotFoundError(definitionId);
    const now = Date.now();
    const nextVersion = row.currentVersion + 1;
    const specJson = JSON.stringify(input.spec);
    await tx.update(pipelineDefinitions)
      .set({
        name: input.name ?? row.name,
        description: input.description ?? row.description,
        currentVersion: nextVersion,
        specJson,
        updatedAt: now,
      })
      .where(eq(pipelineDefinitions.id, definitionId))
      .run();
    await tx.insert(pipelineDefinitionVersions)
      .values({
        id: randomUUID(),
        definitionId,
        version: nextVersion,
        specJson,
        actorLabel: actor.label,
        actorUserId: actor.userId,
        createdAt: now,
      })
      .run();
    return rowToDefinition({
      ...row,
      name: input.name ?? row.name,
      description: input.description ?? row.description,
      currentVersion: nextVersion,
      specJson,
      updatedAt: now,
    });
  });
}

/**
 * Change a definition's status. Activation demotes any other active
 * definition in the same exact scope to `draft` (D-64.2) so at most one
 * definition is active per (workspace, taskKey, campaign, lane).
 */
export async function setPipelineStatus(
  db: Db,
  workspaceId: string,
  definitionId: string,
  status: PipelineDefinitionStatus,
): Promise<PipelineDefinition> {
  return await db.transaction(async (tx) => {
    const row = await tx
      .select()
      .from(pipelineDefinitions)
      .where(
        and(
          eq(pipelineDefinitions.workspaceId, workspaceId),
          eq(pipelineDefinitions.id, definitionId),
        ),
      )
      .get();
    if (!row) throw new PipelineDefinitionNotFoundError(definitionId);
    const now = Date.now();
    if (status === "active") {
      const siblings = (await tx
        .select()
        .from(pipelineDefinitions)
        .where(
          and(
            eq(pipelineDefinitions.workspaceId, workspaceId),
            eq(pipelineDefinitions.taskKey, row.taskKey),
            eq(pipelineDefinitions.status, "active"),
          ),
        )
        .all())
        .filter(
          (candidate) =>
            candidate.id !== row.id &&
            candidate.campaignId === row.campaignId &&
            candidate.laneId === row.laneId,
        );
      for (const sibling of siblings) {
        await tx.update(pipelineDefinitions)
          .set({ status: "draft", updatedAt: now })
          .where(eq(pipelineDefinitions.id, sibling.id))
          .run();
      }
    }
    await tx.update(pipelineDefinitions)
      .set({ status, updatedAt: now })
      .where(eq(pipelineDefinitions.id, definitionId))
      .run();
    return rowToDefinition({ ...row, status, updatedAt: now });
  });
}

/**
 * Most specific active definition wins (D-64.2): lane match, then campaign
 * match (no lane binding), then the workspace-scoped default.
 */
export async function resolvePipelineDefinition(
  db: Db,
  input: {
    workspaceId: string;
    taskKey: PipelineTaskKey;
    campaignId?: string | null;
    laneId?: string | null;
  },
): Promise<PipelineDefinition | undefined> {
  const active = await db
    .select()
    .from(pipelineDefinitions)
    .where(
      and(
        eq(pipelineDefinitions.workspaceId, input.workspaceId),
        eq(pipelineDefinitions.taskKey, input.taskKey),
        eq(pipelineDefinitions.status, "active"),
      ),
    )
    .all();
  const byLane = input.laneId
    ? active.find((row) => row.laneId === input.laneId)
    : undefined;
  if (byLane) return rowToDefinition(byLane);
  const byCampaign = input.campaignId
    ? active.find((row) => row.laneId === null && row.campaignId === input.campaignId)
    : undefined;
  if (byCampaign) return rowToDefinition(byCampaign);
  const workspaceDefault = active.find(
    (row) => row.campaignId === null && row.laneId === null,
  );
  return workspaceDefault ? rowToDefinition(workspaceDefault) : undefined;
}
