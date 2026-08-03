import type { AgentMessage, AgentToolCall } from "@tuezday/contracts";
import {
  GatewayError,
  type AgentStepParams,
  type AgentStepResult,
  type AgentStepStreamEvent,
  type AgentStepUsage,
  type EmbedParams,
  type EmbedResult,
  type GenerateParams,
  type GenerateResult,
  type LlmGateway,
} from "./gateway";
import { EVIDENCE_EMBEDDING_DIMENSIONS } from "../evidence/db-store";

// gemini-2.5-flash with thinking disabled: ~1.5-2s per generation in testing,
// vs 70s+ (and 503s under load) on gemini-3.5-flash. Sandbox UX needs fast
// iterations more than frontier quality; override via GEMINI_MODEL if needed.
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_CHEAP_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_EMBED_MODEL = "gemini-embedding-001";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** Thinking models spend output tokens on reasoning before any text appears —
 * at sandbox-size limits that means slow, truncated copy. Disable where the
 * model family supports the knob. */
function thinkingConfigFor(model: string): { thinkingBudget: number } | undefined {
  return /^gemini-(2\.5|3)/.test(model) ? { thinkingBudget: 0 } : undefined;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
}

interface GeminiEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

/**
 * Gemini implementation of the LLM gateway via the generateContent REST API.
 * No SDK dependency — one endpoint, one body shape.
 */
export class GeminiGateway implements LlmGateway {
  private readonly apiKey: string | undefined;
  public readonly model: string;
  public readonly cheapModel: string;
  public readonly embedModel: string;

  // Blank env values (e.g. an unfilled `GEMINI_MODEL=` line in .env) must
  // fall back to defaults, so use truthiness, not just undefined-checks.
  constructor(apiKey?: string, model?: string, cheapModel?: string) {
    this.apiKey = (apiKey ?? process.env.GEMINI_API_KEY)?.trim() || undefined;
    this.model = (model ?? process.env.GEMINI_MODEL)?.trim() || DEFAULT_MODEL;
    this.cheapModel = (cheapModel ?? process.env.GEMINI_MODEL_CHEAP)?.trim() || DEFAULT_CHEAP_MODEL;
    this.embedModel = process.env.GEMINI_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  }

  /** Tier -> model (Sprint 59). Routing is configuration: call sites declare
   * a tier; which concrete model that means lives here (env-overridable). */
  private modelFor(tier?: "cheap" | "frontier"): string {
    return tier === "cheap" ? this.cheapModel : this.model;
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
        "GEMINI_API_KEY is not set. Add it to a .env file in the repo root and restart the dev server.",
      );
    }

    const model = this.modelFor(tier);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
              thinkingConfig: thinkingConfigFor(model),
            },
          }),
          signal,
        },
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      throw new GatewayError(
        "provider_error",
        `Could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      throw new GatewayError(
        "provider_error",
        `Gemini API returned ${res.status} for model "${model}": ${body.error?.message ?? "unknown error"}`,
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
      model,
      provider: "gemini",
      durationMs: Date.now() - started,
      usage: usageFrom(body),
    };
  }

  // -------------------------------------------------------------------------
  // Gateway v2 (Sprint 56): one agent model call with history, tools and
  // constrained JSON output. The loop lives in AgentRunner, not here.
  // -------------------------------------------------------------------------

  async agentStep(params: AgentStepParams): Promise<AgentStepResult> {
    const model = this.modelFor(params.tier);
    const started = Date.now();
    const res = await this.postAgentRequest(":generateContent", params, model);
    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      throw new GatewayError(
        "provider_error",
        `Gemini API returned ${res.status} for model "${model}": ${body.error?.message ?? "unknown error"}`,
      );
    }
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const message = this.assistantMessageFrom(parts, { nextCallId: 1 });
    if (!message.content && !message.toolCalls?.length) {
      throw new GatewayError("provider_error", "Gemini API returned an empty agent response.");
    }
    return {
      message,
      usage: usageFrom(body),
      model,
      provider: "gemini",
      durationMs: Date.now() - started,
    };
  }

  async agentStepStream(
    params: AgentStepParams,
    onEvent: (event: AgentStepStreamEvent) => void,
  ): Promise<AgentStepResult> {
    const model = this.modelFor(params.tier);
    const started = Date.now();
    const res = await this.postAgentRequest(":streamGenerateContent?alt=sse", params, model);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as GeminiResponse;
      throw new GatewayError(
        "provider_error",
        `Gemini API returned ${res.status} for model "${model}": ${body.error?.message ?? "unknown error"}`,
      );
    }

    const idState = { nextCallId: 1 };
    let text = "";
    const toolCalls: AgentToolCall[] = [];
    let usage: AgentStepUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(payload) as GeminiResponse;
        } catch {
          continue; // partial/keepalive line — not a data chunk
        }
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            text += part.text;
            onEvent({ type: "text_delta", text: part.text });
          }
          if (part.functionCall?.name) {
            const call: AgentToolCall = {
              id: `call_${idState.nextCallId++}`,
              name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
            };
            toolCalls.push(call);
            onEvent({ type: "tool_call", call });
          }
        }
        if (chunk.usageMetadata) usage = usageFrom(chunk); // cumulative; last wins
      }
    }

    const trimmed = text.trim();
    if (!trimmed && toolCalls.length === 0) {
      throw new GatewayError("provider_error", "Gemini API returned an empty agent response.");
    }
    const message: AgentMessage = {
      role: "assistant",
      content: trimmed,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    return { message, usage, model, provider: "gemini", durationMs: Date.now() - started };
  }

  private async postAgentRequest(
    pathSuffix: string,
    params: AgentStepParams,
    model: string,
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new GatewayError(
        "missing_api_key",
        "GEMINI_API_KEY is not set. Add it to a .env file in the repo root and restart the dev server.",
      );
    }
    try {
      return await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}${pathSuffix}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(this.agentRequestBody(params, model)),
          signal: params.signal,
        },
      );
    } catch (err) {
      if (params.signal?.aborted) throw params.signal.reason ?? err;
      throw new GatewayError(
        "provider_error",
        `Could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private agentRequestBody(params: AgentStepParams, model: string): Record<string, unknown> {
    return {
      // Single-shot structured calls (Sprint 58) pass system: "" — omit the
      // instruction entirely rather than send an empty text part.
      ...(params.system ? { systemInstruction: { parts: [{ text: params.system }] } } : {}),
      contents: params.messages.map((m) => toGeminiContent(m)),
      ...(params.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: params.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        maxOutputTokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinkingConfig: thinkingConfigFor(model),
        ...(params.responseSchema
          ? { responseMimeType: "application/json", responseSchema: params.responseSchema }
          : {}),
      },
    };
  }

  private assistantMessageFrom(
    parts: GeminiPart[],
    idState: { nextCallId: number },
  ): AgentMessage {
    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    // Gemini does not supply call ids — mint them, unique within the response.
    const toolCalls: AgentToolCall[] = parts.flatMap((p) =>
      p.functionCall?.name
        ? [
            {
              id: `call_${idState.nextCallId++}`,
              name: p.functionCall.name,
              arguments: p.functionCall.args ?? {},
            },
          ]
        : [],
    );
    return { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) };
  }

  async embed({ texts }: EmbedParams): Promise<EmbedResult> {
    if (!this.apiKey) {
      throw new GatewayError(
        "missing_api_key",
        "GEMINI_API_KEY is not set. Add it to a .env file in the repo root and restart the dev server.",
      );
    }

    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.embedModel}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: `models/${this.embedModel}`,
              content: { parts: [{ text }] },
              outputDimensionality: EVIDENCE_EMBEDDING_DIMENSIONS,
            })),
          }),
        },
      );
    } catch (err) {
      throw new GatewayError(
        "provider_error",
        `Could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = (await res.json().catch(() => ({}))) as GeminiEmbedResponse;
    if (!res.ok) {
      throw new GatewayError(
        "provider_error",
        `Gemini API returned ${res.status} for model "${this.embedModel}": ${body.error?.message ?? "unknown error"}`,
      );
    }

    const embeddings = (body.embeddings ?? []).map((e) => e.values ?? []);
    if (embeddings.length !== texts.length || embeddings.some((v) => v.length === 0)) {
      throw new GatewayError(
        "provider_error",
        `Gemini embeddings response had ${embeddings.length} vectors for ${texts.length} inputs.`,
      );
    }

    return {
      embeddings,
      model: this.embedModel,
      provider: "gemini",
      dimensions: EVIDENCE_EMBEDDING_DIMENSIONS,
    };
  }
}

/** Transcript → Gemini contents. Tool results travel as functionResponse
 * parts on a user turn; Gemini requires the response value to be an object. */
function toGeminiContent(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    let response: unknown;
    try {
      response = JSON.parse(message.content);
    } catch {
      response = message.content;
    }
    if (typeof response !== "object" || response === null) {
      response = { result: response };
    }
    return {
      role: "user",
      parts: [{ functionResponse: { name: message.toolName ?? "tool", response } }],
    };
  }
  if (message.role === "assistant") {
    return {
      role: "model",
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          functionCall: { name: call.name, args: call.arguments ?? {} },
        })),
      ],
    };
  }
  return { role: "user", parts: [{ text: message.content }] };
}

function usageFrom(body: GeminiResponse): AgentStepUsage {
  const meta = body.usageMetadata;
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
  };
}
