import type { AgentStepUsage } from "./gateway";

/** Cents per 1M tokens. Cached-input tokens are billed at the cached rate and
 * excluded from the input rate. */
interface ModelPricing {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
  cachedInputCentsPer1M: number;
}

// Telemetry-grade accounting so every agent run has a cost from day one;
// Sprint 59 hardens this into entitlements and per-workspace budgets.
const PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash": {
    inputCentsPer1M: 30, // $0.30 / 1M input tokens
    outputCentsPer1M: 250, // $2.50 / 1M output tokens
    cachedInputCentsPer1M: 7.5, // $0.075 / 1M cached input tokens
  },
};

/** Cost of one model call in cents (fractional). Unknown models cost 0 —
 * missing pricing must never fail a run. */
export function costCents(model: string, usage: AgentStepUsage): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (billableInput * pricing.inputCentsPer1M +
      usage.cachedTokens * pricing.cachedInputCentsPer1M +
      usage.outputTokens * pricing.outputCentsPer1M) /
    1_000_000
  );
}
