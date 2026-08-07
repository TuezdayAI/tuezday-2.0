import type { LlmPipeline } from "@tuezday/contracts";
import type { Db } from "../db/index";
import { recordLlmUsage } from "../services/usage-ledger";
import { hasPricing } from "./pricing";
import type {
  AgentStepParams,
  AgentStepResult,
  AgentStepStreamEvent,
  EmbedParams,
  EmbedResult,
  GenerateParams,
  GenerateResult,
  LlmGateway,
} from "./gateway";

// Sprint 59: the ONE recording point for LLM cost. Call sites wrap their
// gateway with the pipeline they are — every successful call that reports
// usage lands in the llm_usage_events ledger; calls without usage (older
// fakes) simply go unmetered. Failures record nothing: a throw never bills.

export interface MeterContext {
  workspaceId: string;
  pipeline: LlmPipeline;
  campaignId?: string | null;
  agentRunId?: string | null;
}

const warnedModels = new Set<string>();

async function record(
  db: Db,
  ctx: MeterContext,
  result: { model: string; provider: string; usage?: GenerateResult["usage"] },
): Promise<void> {
  if (!result.usage) return;
  if (!hasPricing(result.model) && !warnedModels.has(result.model)) {
    warnedModels.add(result.model);
    // eslint-disable-next-line no-console
    console.warn(
      `[llm/metered] no pricing entry for model "${result.model}" — its usage is recorded at 0 cents.`,
    );
  }
  await recordLlmUsage(db, {
    workspaceId: ctx.workspaceId,
    pipeline: ctx.pipeline,
    campaignId: ctx.campaignId ?? null,
    agentRunId: ctx.agentRunId ?? null,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  });
}

/** Wrap a gateway so every successful call is recorded in the usage ledger,
 * attributed to a workspace and pipeline. Params pass through verbatim. */
export function meteredLlm(llm: LlmGateway, db: Db, ctx: MeterContext): LlmGateway {
  const metered: LlmGateway = {
    async generate(params: GenerateParams): Promise<GenerateResult> {
      const result = await llm.generate(params);
      await record(db, ctx, result);
      return result;
    },
  };
  if (llm.embed) {
    // Embeddings report no usage today — forwarded untouched for the evidence store.
    metered.embed = (params: EmbedParams): Promise<EmbedResult> => llm.embed!(params);
  }
  if (llm.agentStep) {
    metered.agentStep = async (params: AgentStepParams): Promise<AgentStepResult> => {
      const result = await llm.agentStep!(params);
      await record(db, ctx, result);
      return result;
    };
  }
  if (llm.agentStepStream) {
    metered.agentStepStream = async (
      params: AgentStepParams,
      onEvent: (event: AgentStepStreamEvent) => void,
    ): Promise<AgentStepResult> => {
      const result = await llm.agentStepStream!(params, onEvent);
      await record(db, ctx, result);
      return result;
    };
  }
  return metered;
}
