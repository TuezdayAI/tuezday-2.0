import { GatewayError, type GenerateParams, type GenerateResult, type LlmGateway } from "./gateway";

// One OpenAI-compatible endpoint fronting many models — chosen over wiring
// individual extra providers (umbrella Decision 11). Default rides the same
// model family as the Gemini primary, just via a different pipe.
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_CHEAP_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

/**
 * OpenRouter implementation of the LLM gateway via the chat completions API.
 * No SDK dependency — one endpoint, one body shape, same posture as gemini.ts.
 */
export class OpenRouterGateway implements LlmGateway {
  private readonly apiKey: string | undefined;
  public readonly model: string;
  public readonly cheapModel: string;
  private readonly fetcher: typeof fetch;

  // Blank env values fall back to defaults — truthiness, not undefined-checks.
  constructor(apiKey?: string, model?: string, fetcher: typeof fetch = fetch) {
    this.apiKey = (apiKey ?? process.env.OPENROUTER_API_KEY)?.trim() || undefined;
    this.model = (model ?? process.env.OPENROUTER_MODEL)?.trim() || DEFAULT_MODEL;
    this.cheapModel = process.env.OPENROUTER_MODEL_CHEAP?.trim() || DEFAULT_CHEAP_MODEL;
    this.fetcher = fetcher;
  }

  async generate({
    prompt,
    maxOutputTokens,
    signal,
    tier,
  }: GenerateParams): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new GatewayError(
        "missing_api_key",
        "OPENROUTER_API_KEY is not set. Add it to a .env file in the repo root and restart the dev server.",
      );
    }

    const model = tier === "cheap" ? this.cheapModel : this.model;
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetcher(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          // Attribution headers recommended by OpenRouter — avoids
          // anonymous-traffic throttling.
          "HTTP-Referer": "https://tuezday.com",
          "X-Title": "Tuezday",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      throw new GatewayError(
        "provider_error",
        `Could not reach the OpenRouter API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = (await res.json().catch(() => ({}))) as OpenRouterResponse;
    if (!res.ok) {
      throw new GatewayError(
        "provider_error",
        `OpenRouter API returned ${res.status} for model "${model}": ${body.error?.message ?? "unknown error"}`,
      );
    }

    const text = (body.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      throw new GatewayError("provider_error", "OpenRouter API returned an empty response.");
    }

    return {
      text,
      model: body.model?.trim() || model,
      provider: "openrouter",
      durationMs: Date.now() - started,
      ...(body.usage
        ? {
            usage: {
              inputTokens: body.usage.prompt_tokens ?? 0,
              outputTokens: body.usage.completion_tokens ?? 0,
              cachedTokens: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
            },
          }
        : {}),
    };
  }
}
