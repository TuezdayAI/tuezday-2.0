import type { LlmGateway } from "./gateway";
import { GeminiGateway } from "./gemini";
import { OpenRouterGateway } from "./openrouter";
import { FallbackGateway } from "./fallback";

/**
 * Deploy-level provider selection (Sprint 41 Part 1). LLM_PROVIDER picks the
 * primary ("gemini" default); if the other provider's key is also present the
 * pair is wrapped in a FallbackGateway, so single-provider deploys keep
 * working with no new env vars. Provider credentials are always Tuezday's own
 * — never a subscriber's (umbrella Decision 10).
 */
export function createLlmGatewayFromEnv(): LlmGateway {
  const provider = process.env.LLM_PROVIDER?.trim() || "gemini";
  if (provider !== "gemini" && provider !== "openrouter") {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}" — expected "gemini" or "openrouter".`,
    );
  }

  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY?.trim());

  if (provider === "openrouter") {
    const primary = new OpenRouterGateway();
    return hasGeminiKey ? new FallbackGateway(primary, new GeminiGateway()) : primary;
  }
  const primary = new GeminiGateway();
  return hasOpenRouterKey ? new FallbackGateway(primary, new OpenRouterGateway()) : primary;
}
