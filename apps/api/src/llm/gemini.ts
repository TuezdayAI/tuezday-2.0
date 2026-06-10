import { GatewayError, type GenerateParams, type GenerateResult, type LlmGateway } from "./gateway";

// gemini-2.5-flash with thinking disabled: ~1.5-2s per generation in testing,
// vs 70s+ (and 503s under load) on gemini-3.5-flash. Sandbox UX needs fast
// iterations more than frontier quality; override via GEMINI_MODEL if needed.
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** Thinking models spend output tokens on reasoning before any text appears —
 * at sandbox-size limits that means slow, truncated copy. Disable where the
 * model family supports the knob. */
function thinkingConfigFor(model: string): { thinkingBudget: number } | undefined {
  return /^gemini-(2\.5|3)/.test(model) ? { thinkingBudget: 0 } : undefined;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
}

/**
 * Gemini implementation of the LLM gateway via the generateContent REST API.
 * No SDK dependency — one endpoint, one body shape.
 */
export class GeminiGateway implements LlmGateway {
  private readonly apiKey: string | undefined;
  public readonly model: string;

  // Blank env values (e.g. an unfilled `GEMINI_MODEL=` line in .env) must
  // fall back to defaults, so use truthiness, not just undefined-checks.
  constructor(apiKey?: string, model?: string) {
    this.apiKey = (apiKey ?? process.env.GEMINI_API_KEY)?.trim() || undefined;
    this.model = (model ?? process.env.GEMINI_MODEL)?.trim() || DEFAULT_MODEL;
  }

  async generate({ prompt, maxOutputTokens }: GenerateParams): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new GatewayError(
        "missing_api_key",
        "GEMINI_API_KEY is not set. Add it to a .env file in the repo root and restart the dev server.",
      );
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              thinkingConfig: thinkingConfigFor(this.model),
            },
          }),
        },
      );
    } catch (err) {
      throw new GatewayError(
        "provider_error",
        `Could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      throw new GatewayError(
        "provider_error",
        `Gemini API returned ${res.status} for model "${this.model}": ${body.error?.message ?? "unknown error"}`,
      );
    }

    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new GatewayError("provider_error", "Gemini API returned an empty response.");
    }

    return {
      text,
      model: this.model,
      provider: "gemini",
      durationMs: Date.now() - started,
    };
  }
}
