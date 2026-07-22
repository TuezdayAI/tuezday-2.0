// Provider-agnostic LLM gateway. Routes and services depend only on this
// interface — switching or adding providers must never touch them.

export interface GenerateParams {
  prompt: string;
  maxOutputTokens?: number;
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

export interface LlmGateway {
  generate(params: GenerateParams): Promise<GenerateResult>;
  /**
   * Text embeddings (Sprint 47). Optional so fakes and providers without an
   * embedding endpoint stay valid — the consumer (the evidence store) degrades
   * to lexical-only retrieval when absent or failing.
   */
  embed?(params: EmbedParams): Promise<EmbedResult>;
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
