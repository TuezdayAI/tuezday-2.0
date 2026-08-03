// Provider-agnostic LLM gateway. Routes and services depend only on this
// interface — switching or adding providers must never touch them.

import type { AgentMessage, AgentToolCall } from "@tuezday/contracts";

export interface GenerateParams {
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
}

export interface EmbedParams {
  /** Batch of texts to embed; callers keep batches ≤ 100. */
  texts: string[];
}

export interface EmbedResult {
  /** One vector per input text, same order. */
  embeddings: number[][];
  model: string;
  provider: string;
  dimensions: number;
}

// ---------------------------------------------------------------------------
// Gateway v2 (Sprint 56) — a single agent model call: message history, tools,
// constrained JSON output, usage. The loop lives in AgentRunner (src/agents),
// NOT here, so bounds, persistence and tool dispatch stay provider-agnostic.
// generate() above is untouched — everything existing depends on it.
// ---------------------------------------------------------------------------

/** Plain JSON Schema object, provider-portable. Zod validation of structured
 * output arrives with Sprint 58's generateStructured. */
export type JsonSchema = Record<string, unknown>;

/** What the model is told about a callable tool. The implementation (handler)
 * stays with the runner — the gateway only ships the declaration. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface AgentStepParams {
  /** Stable prefix, kept out of the message list so providers can cache it. */
  system: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  /** Constrain the response to JSON matching this schema (terminal steps). */
  responseSchema?: JsonSchema;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AgentStepUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AgentStepResult {
  /** The assistant message produced: text and/or tool calls. */
  message: AgentMessage;
  usage: AgentStepUsage;
  model: string;
  provider: string;
  durationMs: number;
}

/** Gateway-level stream events. The runner wraps these with step boundaries
 * and tool dispatch events (AgentRunEvent). */
export type AgentStepStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: AgentToolCall };

export interface LlmGateway {
  generate(params: GenerateParams): Promise<GenerateResult>;
  /**
   * Text embeddings (Sprint 47). Optional so fakes and providers without an
   * embedding endpoint stay valid — the consumer (the evidence store) degrades
   * to lexical-only retrieval when absent or failing.
   */
  embed?(params: EmbedParams): Promise<EmbedResult>;
  /**
   * One agent model call (Sprint 56). Optional: existing fakes stay valid;
   * the AgentRunner throws a typed error when its gateway lacks it.
   */
  agentStep?(params: AgentStepParams): Promise<AgentStepResult>;
  /**
   * Streaming variant: emits text deltas and tool calls as they arrive, then
   * resolves with the same result agentStep would return. Optional — the
   * runner degrades to agentStep (one whole-text delta) when absent.
   */
  agentStepStream?(
    params: AgentStepParams,
    onEvent: (event: AgentStepStreamEvent) => void,
  ): Promise<AgentStepResult>;
}

export type GatewayErrorCode = "missing_api_key" | "provider_error";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
