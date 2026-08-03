import { anglesResponseSchema } from "@tuezday/contracts";
import type { ResolvedContext } from "@tuezday/brain";
import type { LlmGateway } from "../llm/gateway";
import { generateStructured } from "../llm/structured";

/**
 * Generate at most `count` distinct one-line angles from an already-resolved
 * angle prompt (schema-constrained since Sprint 58). Failures — gateway or
 * post-repair malformed output — propagate; the routes degrade to a plain
 * generation without angles.
 */
export async function generateAngles(
  llm: LlmGateway,
  resolved: ResolvedContext,
  count: number,
): Promise<{ angles: string[]; model: string; provider: string; durationMs: number }> {
  const result = await generateStructured(llm, anglesResponseSchema, {
    prompt: resolved.prompt,
  });
  return {
    angles: result.value.map((angle) => angle.trim()).filter(Boolean).slice(0, count),
    model: result.model,
    provider: result.provider,
    durationMs: result.durationMs,
  };
}
