import type { AgentStepUsage } from "./gateway";

/** Cents per 1M tokens. Cached-input tokens are billed at the cached rate and
 * excluded from the input rate. */
interface ModelPricing {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
  cachedInputCentsPer1M: number;
}

// Billing-grade accounting (Sprint 59): the ledger sums these into the
// per-workspace budget, so every routable model needs an entry.
const PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash": {
    inputCentsPer1M: 30, // $0.30 / 1M input tokens
    outputCentsPer1M: 250, // $2.50 / 1M output tokens
    cachedInputCentsPer1M: 7.5, // $0.075 / 1M cached input tokens
  },
  "gemini-2.5-flash-lite": {
    inputCentsPer1M: 10, // $0.10 / 1M input tokens
    outputCentsPer1M: 40, // $0.40 / 1M output tokens
    cachedInputCentsPer1M: 2.5, // $0.025 / 1M cached input tokens
  },
};

/** Flat ledger cost for one design-daemon generation (carousel/ad image) —
 * their LLM runs in the OpenDesign daemon, outside our gateway, so they are
 * metered at an estimated flat rate instead of per token. Founder-tunable. */
export const DESIGN_RENDER_FLAT_CENTS = 1;

/** OpenRouter ids are "vendor/model" — price by the model segment. */
function normalizeModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/** True when a model has a pricing entry; metering warns (once) when not. */
export function hasPricing(model: string): boolean {
  return normalizeModel(model) in PRICING;
}

/** Cost of one model call in cents (fractional). Unknown models cost 0 —
 * missing pricing must never fail a run. */
export function costCents(model: string, usage: AgentStepUsage): number {
  const pricing = PRICING[normalizeModel(model)];
  if (!pricing) return 0;
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (billableInput * pricing.inputCentsPer1M +
      usage.cachedTokens * pricing.cachedInputCentsPer1M +
      usage.outputTokens * pricing.outputCentsPer1M) /
    1_000_000
  );
}
