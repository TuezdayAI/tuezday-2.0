import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type {
  Channel,
  Generation,
  GenerationReview,
  OutputRating,
  TaskType,
} from "@tuezday/contracts";
import type { ContextSection, ResolvedContext } from "@tuezday/brain";
import type { Db } from "../db";
import { generations, type GenerationRow } from "../db/schema";

/** A stored generation plus its parsed resolved-section trace. */
export interface GenerationWithTrace extends Generation {
  sections: ContextSection[];
}

function rowToGeneration(row: GenerationRow): GenerationWithTrace {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    taskType: row.taskType as TaskType,
    channel: row.channel as Channel,
    personaId: row.personaId,
    campaignId: row.campaignId,
    leadId: row.leadId,
    mediaContactId: row.mediaContactId,
    prompt: row.prompt,
    output: row.output,
    model: row.model,
    provider: row.provider,
    durationMs: row.durationMs,
    rating: row.rating as OutputRating | null,
    ratedAt: row.ratedAt,
    createdAt: row.createdAt,
    review: row.reviewJson ? (JSON.parse(row.reviewJson) as GenerationReview) : null,
    sections: JSON.parse(row.sectionsJson) as ContextSection[],
  };
}

export interface StoreGenerationInput {
  workspaceId: string;
  taskType: TaskType;
  channel: Channel;
  personaId: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  mediaContactId?: string | null;
  resolved: ResolvedContext;
  output: string;
  model: string;
  provider: string;
  durationMs: number;
}

export function storeGeneration(db: Db, input: StoreGenerationInput): GenerationWithTrace {
  const row: GenerationRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    taskType: input.taskType,
    channel: input.channel,
    personaId: input.personaId,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    mediaContactId: input.mediaContactId ?? null,
    prompt: input.resolved.prompt,
    sectionsJson: JSON.stringify(input.resolved.sections),
    output: input.output,
    model: input.model,
    provider: input.provider,
    durationMs: input.durationMs,
    rating: null,
    ratedAt: null,
    reviewJson: null,
    createdAt: Date.now(),
  };
  db.insert(generations).values(row).run();
  return rowToGeneration(row);
}

export function listGenerations(db: Db, workspaceId: string): GenerationWithTrace[] {
  return db
    .select()
    .from(generations)
    .where(eq(generations.workspaceId, workspaceId))
    .orderBy(desc(generations.createdAt))
    .all()
    .map(rowToGeneration);
}

export function rateGeneration(
  db: Db,
  workspaceId: string,
  generationId: string,
  rating: OutputRating,
): GenerationWithTrace | undefined {
  const row = db
    .select()
    .from(generations)
    .where(and(eq(generations.workspaceId, workspaceId), eq(generations.id, generationId)))
    .get();
  if (!row) return undefined;

  const ratedAt = Date.now();
  db.update(generations)
    .set({ rating, ratedAt })
    .where(eq(generations.id, generationId))
    .run();
  return rowToGeneration({ ...row, rating, ratedAt });
}

export function countGenerationsSince(db: Db, workspaceId: string, sinceMs: number): number {
  return db
    .select()
    .from(generations)
    .where(and(eq(generations.workspaceId, workspaceId), gte(generations.createdAt, sinceMs)))
    .all()
    .length;
}
