import { GatewayError, type GenerateParams, type GenerateResult, type LlmGateway } from "./gateway";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

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
  constructor(
    private readonly apiKey: string | undefined = process.env.GEMINI_API_KEY,
    private readonly model: string = process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
  ) {}

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
        `Gemini API returned ${res.status}: ${body.error?.message ?? "unknown error"}`,
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
