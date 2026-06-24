import type { ResolvedContext } from "@tuezday/brain";
import type { LlmGateway } from "../llm/gateway";

/**
 * Parse the angle step's raw output into at most `count` distinct one-line
 * angles. Tolerant of the model's formatting: strips an 'ANGLE:' prefix and
 * common list markers, and falls back to blank-line splitting.
 */
export function parseAngles(text: string, count: number): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const stripped = lines
    .map((line) =>
      line
        .replace(/^ANGLE:\s*/i, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);

  return stripped.slice(0, count);
}

/** Generate angle candidates from an already-resolved angle prompt. */
export async function generateAngles(
  llm: LlmGateway,
  resolved: ResolvedContext,
  count: number,
): Promise<{ angles: string[]; model: string; provider: string; durationMs: number }> {
  const result = await llm.generate({ prompt: resolved.prompt });
  return {
    angles: parseAngles(result.text, count),
    model: result.model,
    provider: result.provider,
    durationMs: result.durationMs,
  };
}
