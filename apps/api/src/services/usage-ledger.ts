import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { LlmPipeline, PipelineSpend } from "@tuezday/contracts";
import type { Db } from "../db/index";
import { llmUsageEvents } from "../db/schema";
import type { AgentStepUsage } from "../llm/gateway";
import { costCents } from "../llm/pricing";

// The LLM usage ledger (Sprint 59): one row per successful model call, the
// single authority for workspace spend, /billing spend-by-pipeline and the
// cache-hit-rate metric. Rows are written by the meteredLlm gateway proxy
// (llm/metered.ts) plus the flat design-daemon events; everything else only
// reads sums.

export interface LlmUsageEventInput {
  workspaceId: string;
  pipeline: LlmPipeline;
  campaignId?: string | null;
  agentRunId?: string | null;
  model: string;
  provider: string;
  usage: AgentStepUsage;
  /** Override for non-token events (design_render flat cost); defaults to
   * the pricing-table cost of `usage` on `model`. */
  costCentsOverride?: number;
}

export function recordLlmUsage(db: Db, event: LlmUsageEventInput): void {
  db.insert(llmUsageEvents)
    .values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      pipeline: event.pipeline,
      campaignId: event.campaignId ?? null,
      agentRunId: event.agentRunId ?? null,
      model: event.model,
      provider: event.provider,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      cachedTokens: event.usage.cachedTokens,
      costCents: event.costCentsOverride ?? costCents(event.model, event.usage),
      createdAt: Date.now(),
    })
    .run();
}

/** Rolling-window spend in cents — the number the budget gate compares. */
export function sumLlmSpendCents(db: Db, workspaceId: string, sinceMs: number): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${llmUsageEvents.costCents}), 0)` })
    .from(llmUsageEvents)
    .where(and(eq(llmUsageEvents.workspaceId, workspaceId), gte(llmUsageEvents.createdAt, sinceMs)))
    .get();
  return row?.total ?? 0;
}

export interface SpendRollup {
  spentCents: number;
  inputTokens: number;
  cachedTokens: number;
  /** sum(cached) / sum(input); null when the window has no input tokens. */
  cacheHitRate: number | null;
  byPipeline: PipelineSpend[];
}

/** Spend + cache-hit-rate rollup for /billing, grouped by pipeline (desc cost). */
export function spendRollup(db: Db, workspaceId: string, sinceMs: number): SpendRollup {
  const rows = db
    .select({
      pipeline: llmUsageEvents.pipeline,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${llmUsageEvents.cachedTokens}), 0)`,
      costCents: sql<number>`coalesce(sum(${llmUsageEvents.costCents}), 0)`,
    })
    .from(llmUsageEvents)
    .where(and(eq(llmUsageEvents.workspaceId, workspaceId), gte(llmUsageEvents.createdAt, sinceMs)))
    .groupBy(llmUsageEvents.pipeline)
    .all();

  const byPipeline = rows
    .map((r) => ({
      pipeline: r.pipeline as PipelineSpend["pipeline"],
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedTokens: r.cachedTokens,
      costCents: r.costCents,
    }))
    .sort((a, b) => b.costCents - a.costCents);

  const spentCents = byPipeline.reduce((sum, r) => sum + r.costCents, 0);
  const inputTokens = byPipeline.reduce((sum, r) => sum + r.inputTokens, 0);
  const cachedTokens = byPipeline.reduce((sum, r) => sum + r.cachedTokens, 0);
  return {
    spentCents,
    inputTokens,
    cachedTokens,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : null,
    byPipeline,
  };
}
